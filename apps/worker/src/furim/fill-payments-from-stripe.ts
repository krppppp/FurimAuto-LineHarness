import { toJstString } from '@line-crm/db';

export const FILL_PAYMENTS_STAFF_NAME = 'system:fill-payments-from-stripe';
export const FILL_COLUMNS = ['subscription_id', 'billing_reason', 'customer_email'] as const;
export type FillColumn = (typeof FILL_COLUMNS)[number];

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
const CONCURRENCY = 5;
const SAMPLE_LIMIT = 5;
const ROWS_PER_BATCH = 50;
const RETRY_WAIT_MS = [1000, 2000];

const BLANK = (col: string) => `(${col} IS NULL OR ${col} = '')`;
const ANY_BLANK = FILL_COLUMNS.map(BLANK).join(' OR ');

type PaymentRow = { invoice_id: string; paid_at: string | null } & Record<FillColumn, string | null>;

export type StripeInvoice = {
  id: string;
  livemode?: boolean;
  subscription?: string | { id: string } | null;
  parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null;
  billing_reason?: string | null;
  customer_email?: string | null;
};

export type InvoiceFetch = { status: 'ok'; invoice: StripeInvoice } | { status: 'not_found' } | { status: 'error'; code: number | string };

export type FillSample = { invoice: string; date: string };

export type FillResult = {
  dryRun: boolean;
  cursor: string | null;
  limit: number;
  scanned: number;
  nextCursor: string | null;
  candidates: Record<FillColumn, number>;
  updated: Record<FillColumn, number>;
  auditRows: number;
  notFound: number;
  notFoundSamples: FillSample[];
  noValueInStripe: Record<FillColumn, number>;
  stripeErrors: number;
  stripeErrorSamples: Array<FillSample & { code: number | string }>;
  noInvoiceId?: number;
  noInvoiceIdSamples?: FillSample[];
  remainingBlank: Record<FillColumn, number>;
  stripeLivemode: boolean | null;
};

const zero = (): Record<FillColumn, number> => ({ subscription_id: 0, billing_reason: 0, customer_email: 0 });
const sample = (invoiceId: string | null, paidAt: string | null): FillSample => ({ invoice: String(invoiceId ?? '').slice(0, 12), date: String(paidAt ?? '').slice(0, 10) });
const idOf = (v: string | { id: string } | null | undefined) => (typeof v === 'string' ? v : v?.id ?? '');

export function stripeValues(inv: StripeInvoice): Record<FillColumn, string> {
  return {
    subscription_id: idOf(inv.subscription) || idOf(inv.parent?.subscription_details?.subscription),
    billing_reason: inv.billing_reason ?? '',
    customer_email: inv.customer_email ?? '',
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makeStripeInvoiceFetcher(secretKey: string, fetchImpl: typeof fetch = fetch, wait: (ms: number) => Promise<unknown> = sleep) {
  return async (invoiceId: string): Promise<InvoiceFetch> => {
    let code: number | string = 0;
    for (let attempt = 0; attempt <= RETRY_WAIT_MS.length; attempt++) {
      if (attempt > 0) await wait(RETRY_WAIT_MS[attempt - 1]);
      try {
        const res = await fetchImpl(`https://api.stripe.com/v1/invoices/${encodeURIComponent(invoiceId)}`, { headers: { Authorization: `Bearer ${secretKey}` } });
        if (res.ok) return { status: 'ok', invoice: (await res.json()) as StripeInvoice };
        if (res.status === 404) return { status: 'not_found' };
        code = res.status;
        if (res.status !== 429 && res.status < 500) break;
      } catch (e) {
        code = String(e).slice(0, 80);
      }
    }
    return { status: 'error', code };
  };
}

export function buildFillPaymentStatements(db: D1Database, invoiceId: string, column: FillColumn, oldValue: string | null, newValue: string, staffId: string, now: string): D1PreparedStatement[] {
  return [
    db.prepare(`UPDATE furim_payments SET ${column} = ? WHERE invoice_id = ? AND ${BLANK(column)}`).bind(newValue, invoiceId),
    db
      .prepare(
        'INSERT INTO furim_admin_audit (id, staff_id, staff_name, table_name, row_id, column_name, old_value, new_value, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1',
      )
      .bind(crypto.randomUUID(), staffId, FILL_PAYMENTS_STAFF_NAME, 'furim_payments', invoiceId, column, oldValue, newValue, now),
  ];
}

async function countRemaining(db: D1Database): Promise<Record<FillColumn, number>> {
  const row = await db
    .prepare(`SELECT ${FILL_COLUMNS.map((c) => `SUM(CASE WHEN ${BLANK(c)} THEN 1 ELSE 0 END) AS ${c}`).join(', ')} FROM furim_payments`)
    .first<Record<FillColumn, number | null>>();
  const out = zero();
  for (const c of FILL_COLUMNS) out[c] = Number(row?.[c] ?? 0);
  return out;
}

export async function fillPaymentsFromStripe(
  db: D1Database,
  fetchInvoice: (invoiceId: string) => Promise<InvoiceFetch>,
  opts: { dryRun: boolean; staffId: string; cursor?: string | null; limit?: number; now?: string },
): Promise<FillResult> {
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
  const cursor = opts.cursor ? String(opts.cursor) : null;
  const now = opts.now ?? toJstString(new Date());
  const result: FillResult = {
    dryRun: opts.dryRun,
    cursor,
    limit,
    scanned: 0,
    nextCursor: null,
    candidates: zero(),
    updated: zero(),
    auditRows: 0,
    notFound: 0,
    notFoundSamples: [],
    noValueInStripe: zero(),
    stripeErrors: 0,
    stripeErrorSamples: [],
    remainingBlank: zero(),
    stripeLivemode: null,
  };

  if (!cursor) {
    const noId = (
      await db
        .prepare(`SELECT invoice_id, paid_at FROM furim_payments WHERE (invoice_id IS NULL OR invoice_id = '') AND (${ANY_BLANK}) ORDER BY paid_at`)
        .all<{ invoice_id: string | null; paid_at: string | null }>()
    ).results ?? [];
    result.noInvoiceId = noId.length;
    result.noInvoiceIdSamples = noId.slice(0, SAMPLE_LIMIT).map((r) => sample(r.invoice_id, r.paid_at));
  }

  const rows = (
    await db
      .prepare(`SELECT invoice_id, paid_at, ${FILL_COLUMNS.join(', ')} FROM furim_payments WHERE invoice_id > ? AND (${ANY_BLANK}) ORDER BY invoice_id LIMIT ?`)
      .bind(cursor ?? '', limit + 1)
      .all<PaymentRow>()
  ).results ?? [];
  const page = rows.slice(0, limit);
  result.scanned = page.length;
  if (rows.length > limit) result.nextCursor = page[page.length - 1].invoice_id;

  const fills: Array<{ invoiceId: string; column: FillColumn; oldValue: string | null; newValue: string }> = [];
  for (let i = 0; i < page.length; i += CONCURRENCY) {
    const chunk = page.slice(i, i + CONCURRENCY);
    const fetched = await Promise.all(chunk.map((r) => fetchInvoice(r.invoice_id)));
    chunk.forEach((row, idx) => {
      const f = fetched[idx];
      if (f.status === 'not_found') {
        result.notFound++;
        if (result.notFoundSamples.length < SAMPLE_LIMIT) result.notFoundSamples.push(sample(row.invoice_id, row.paid_at));
        return;
      }
      if (f.status === 'error') {
        result.stripeErrors++;
        if (result.stripeErrorSamples.length < SAMPLE_LIMIT) result.stripeErrorSamples.push({ ...sample(row.invoice_id, row.paid_at), code: f.code });
        return;
      }
      if (result.stripeLivemode === null && typeof f.invoice.livemode === 'boolean') result.stripeLivemode = f.invoice.livemode;
      const values = stripeValues(f.invoice);
      for (const column of FILL_COLUMNS) {
        const old = row[column];
        if (old != null && old !== '') continue;
        if (!values[column]) {
          result.noValueInStripe[column]++;
          continue;
        }
        result.candidates[column]++;
        fills.push({ invoiceId: row.invoice_id, column, oldValue: old, newValue: values[column] });
      }
    });
  }

  if (!opts.dryRun && fills.length) {
    for (let i = 0; i < fills.length; i += ROWS_PER_BATCH) {
      const chunk = fills.slice(i, i + ROWS_PER_BATCH);
      const results = await db.batch(chunk.flatMap((f) => buildFillPaymentStatements(db, f.invoiceId, f.column, f.oldValue, f.newValue, opts.staffId, now)));
      results.forEach((r, idx) => {
        const n = r.meta?.changes ?? 0;
        if (idx % 2 === 0) result.updated[chunk[idx / 2].column] += n;
        else result.auditRows += n;
      });
    }
    console.log(
      '[furim/fill-payments-from-stripe]',
      JSON.stringify({ cursor, scanned: result.scanned, updated: result.updated, auditRows: result.auditRows, notFound: result.notFound, stripeErrors: result.stripeErrors }),
    );
  }

  result.remainingBlank = await countRemaining(db);
  return result;
}
