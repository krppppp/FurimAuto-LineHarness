import { toJstString } from '@line-crm/db';
import { formatJstIso } from './customer-store.js';

export const BACKFILL_INVOICES_STAFF_NAME = 'system:backfill-stripe-invoices';
export const FIX_SHARED_STAFF_NAME = 'system:fix-shared-customers';

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 100;
export const MAX_CUSTOMER_IDS = 50;
const MAX_PAGES_PER_CUSTOMER = 20;
const SAMPLE_LIMIT = 10;
const IN_CHUNK = 90;
const ROWS_PER_BATCH = 50;
const RETRY_WAIT_MS = [1000, 2000];

export const SHARED_CUSTOMER_FIXES = [
  { stripeCustomerId: 'cus_SSWEsjgl1UUrXh', keepLineUserId: 'U3d122688270fa8d77e7ada198f587037', dropLineUserId: 'Ua238c852d9e11470115c63347946cfd4' },
  { stripeCustomerId: 'cus_TumHYr79ZtCPtv', keepLineUserId: 'Uf8042fb798d84c65d4efc63dcab3ae1f', dropLineUserId: 'U47dcda3068d3cfb03e663791431521c5' },
] as const;

type IdRef = string | { id: string } | null | undefined;
const idOf = (v: IdRef) => (typeof v === 'string' ? v : v?.id ?? '');

export type StripeListInvoice = {
  id: string;
  livemode?: boolean;
  customer?: IdRef;
  amount_paid?: number | null;
  tax?: number | null;
  total_taxes?: Array<{ amount?: number }> | null;
  total_discount_amounts?: Array<{ amount?: number }> | null;
  billing_reason?: string | null;
  customer_email?: string | null;
  subscription?: IdRef;
  parent?: { subscription_details?: { subscription?: IdRef } | null } | null;
  created?: number;
  status_transitions?: { paid_at?: number | null } | null;
};

export type StripeSubscription = {
  plan?: { nickname?: string | null; amount?: number | null } | null;
  items?: { data?: Array<{ price?: { unit_amount?: number | null }; quantity?: number | null }> };
  metadata?: Record<string, string>;
};

export type StripeApi = {
  listPaidInvoices(params: { customer?: string; createdGte?: number; startingAfter?: string; limit: number }): Promise<{ data: StripeListInvoice[]; has_more: boolean }>;
  getSubscription(id: string): Promise<StripeSubscription | null>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makeStripeApi(secretKey: string, fetchImpl: typeof fetch = fetch, wait: (ms: number) => Promise<unknown> = sleep): StripeApi {
  const get = async (path: string): Promise<Response> => {
    let last: Response | null = null;
    for (let attempt = 0; attempt <= RETRY_WAIT_MS.length; attempt++) {
      if (attempt > 0) await wait(RETRY_WAIT_MS[attempt - 1]);
      last = await fetchImpl(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${secretKey}` } });
      if (last.ok || (last.status !== 429 && last.status < 500)) return last;
    }
    return last as Response;
  };
  return {
    async listPaidInvoices({ customer, createdGte, startingAfter, limit }) {
      const q = new URLSearchParams({ status: 'paid', limit: String(limit) });
      if (customer) q.set('customer', customer);
      if (createdGte != null) q.set('created[gte]', String(createdGte));
      if (startingAfter) q.set('starting_after', startingAfter);
      const res = await get(`invoices?${q.toString()}`);
      if (!res.ok) throw new Error(`stripe invoices.list failed: ${res.status}`);
      const body = (await res.json()) as { data?: StripeListInvoice[]; has_more?: boolean };
      return { data: body.data ?? [], has_more: body.has_more === true };
    },
    async getSubscription(id) {
      const res = await get(`subscriptions/${encodeURIComponent(id)}`);
      if (!res.ok) return null;
      return (await res.json()) as StripeSubscription;
    },
  };
}

export function parseSince(v: unknown): number | null | 'invalid' {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00+09:00` : s;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 'invalid' : Math.floor(ms / 1000);
}

export const PAYMENT_COLUMNS = [
  'invoice_id', 'stripe_event_id', 'line_user_id', 'stripe_customer_id', 'subscription_id', 'plan_name', 'billing_reason',
  'subscription_price', 'discount_amount', 'price_excl_tax', 'tax_amount', 'actual_paid_amount', 'customer_email', 'paid_at', 'created_at',
] as const;

export function invoiceToPaymentValues(inv: StripeListInvoice, sub: StripeSubscription | null, lineUserId: string, now: string): unknown[] {
  const subscriptionId = idOf(inv.subscription) || idOf(inv.parent?.subscription_details?.subscription);
  let planName = sub?.plan?.nickname ?? '';
  if (!planName && sub?.metadata?.source === 'plan-builder') planName = 'PBプラン:' + [sub.metadata.packages ?? '', sub.metadata.features].filter(Boolean).join('+');
  const itemsTotal = (sub?.items?.data ?? []).reduce((t, it) => t + (it.price?.unit_amount ?? 0) * (it.quantity ?? 1), 0);
  const subscriptionPrice = itemsTotal || (sub?.plan?.amount ?? 0);
  const discountAmount = (inv.total_discount_amounts ?? []).reduce((t, d) => t + (d.amount ?? 0), 0);
  const taxAmount = inv.tax ?? (inv.total_taxes ?? []).reduce((t, x) => t + (x.amount ?? 0), 0);
  const actualPaidAmount = inv.amount_paid ?? 0;
  const paidSec = inv.status_transitions?.paid_at ?? inv.created ?? null;
  return [
    inv.id, null, lineUserId, idOf(inv.customer), subscriptionId || null, planName || null, inv.billing_reason ?? '',
    subscriptionPrice, discountAmount, actualPaidAmount - taxAmount, taxAmount, actualPaidAmount, inv.customer_email ?? null,
    paidSec ? formatJstIso(paidSec * 1000) : now, now,
  ];
}

export type BackfillInvoiceSample = { invoice: string; date: string; amount: number; resolved: boolean; existing: boolean };

export type BackfillInvoicesResult = {
  mode: 'invoices';
  dryRun: boolean;
  livemode: boolean | null;
  scanned: number;
  candidates: number;
  candidateUsers: number;
  inserted: number;
  auditRows: number;
  skippedZero: number;
  skippedExisting: number;
  unresolvedCustomer: number;
  unresolvedAmount: number;
  totalAmount: number;
  insertedAmount: number;
  nextCursor: string | null;
  samples: BackfillInvoiceSample[];
};

async function selectIn<T>(db: D1Database, sqlFor: (ph: string) => string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const rows = (await db.prepare(sqlFor(chunk.map(() => '?').join(', '))).bind(...chunk).all<T>()).results ?? [];
    out.push(...rows);
  }
  return out;
}

export async function backfillStripeInvoices(
  db: D1Database,
  api: StripeApi,
  opts: { dryRun: boolean; staffId: string; since?: number | null; customerIds?: string[]; cursor?: string | null; limit?: number; now?: string },
): Promise<BackfillInvoicesResult> {
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
  const now = opts.now ?? toJstString(new Date());
  const createdGte = opts.since ?? undefined;
  const result: BackfillInvoicesResult = {
    mode: 'invoices', dryRun: opts.dryRun, livemode: null, scanned: 0, candidates: 0, candidateUsers: 0, inserted: 0, auditRows: 0,
    skippedZero: 0, skippedExisting: 0, unresolvedCustomer: 0, unresolvedAmount: 0, totalAmount: 0, insertedAmount: 0, nextCursor: null, samples: [],
  };

  const invoices: StripeListInvoice[] = [];
  if (opts.customerIds?.length) {
    for (const customer of opts.customerIds) {
      let startingAfter: string | undefined;
      for (let page = 0; page < MAX_PAGES_PER_CUSTOMER; page++) {
        const r = await api.listPaidInvoices({ customer, createdGte, startingAfter, limit });
        invoices.push(...r.data);
        if (!r.has_more || r.data.length === 0) break;
        startingAfter = r.data[r.data.length - 1].id;
      }
    }
  } else {
    const r = await api.listPaidInvoices({ createdGte, startingAfter: opts.cursor ?? undefined, limit });
    invoices.push(...r.data);
    if (r.has_more && r.data.length) result.nextCursor = r.data[r.data.length - 1].id;
  }
  result.scanned = invoices.length;
  if (invoices.length && typeof invoices[0].livemode === 'boolean') result.livemode = invoices[0].livemode;

  const positive = invoices.filter((inv) => (inv.amount_paid ?? 0) > 0);
  result.skippedZero = invoices.length - positive.length;
  const existing = new Set(
    (await selectIn<{ invoice_id: string }>(db, (ph) => `SELECT invoice_id FROM furim_payments WHERE invoice_id IN (${ph})`, positive.map((inv) => inv.id))).map((r) => r.invoice_id),
  );
  const missing = positive.filter((inv) => !existing.has(inv.id));
  result.skippedExisting = positive.length - missing.length;
  result.candidates = missing.length;

  const customerIds = [...new Set(missing.map((inv) => idOf(inv.customer)).filter(Boolean))];
  const owners = new Map<string, Set<string>>();
  for (const r of await selectIn<{ line_user_id: string; stripe_customer_id: string }>(
    db,
    (ph) => `SELECT line_user_id, stripe_customer_id FROM furim_customers WHERE stripe_customer_id IN (${ph})`,
    customerIds,
  )) {
    let s = owners.get(r.stripe_customer_id);
    if (!s) owners.set(r.stripe_customer_id, (s = new Set()));
    s.add(r.line_user_id);
  }

  const toInsert: Array<{ inv: StripeListInvoice; lineUserId: string }> = [];
  const users = new Set<string>();
  for (const inv of missing) {
    const amount = inv.amount_paid ?? 0;
    result.totalAmount += amount;
    const set = owners.get(idOf(inv.customer));
    const lineUserId = set && set.size === 1 ? [...set][0] : null;
    if (!lineUserId) {
      result.unresolvedCustomer++;
      result.unresolvedAmount += amount;
    } else {
      users.add(lineUserId);
      toInsert.push({ inv, lineUserId });
    }
    if (result.samples.length < SAMPLE_LIMIT) {
      const sec = inv.status_transitions?.paid_at ?? inv.created ?? null;
      result.samples.push({ invoice: inv.id.slice(0, 12), date: sec ? formatJstIso(sec * 1000).slice(0, 10) : '', amount, resolved: lineUserId !== null, existing: false });
    }
  }
  result.candidateUsers = users.size;
  if (opts.dryRun || toInsert.length === 0) return result;

  const subs = new Map<string, StripeSubscription | null>();
  const statements: Array<{ amount: number; stmts: D1PreparedStatement[] }> = [];
  for (const { inv, lineUserId } of toInsert) {
    const subId = idOf(inv.subscription) || idOf(inv.parent?.subscription_details?.subscription);
    if (subId && !subs.has(subId)) subs.set(subId, await api.getSubscription(subId).catch(() => null));
    const values = invoiceToPaymentValues(inv, subId ? subs.get(subId) ?? null : null, lineUserId, now);
    statements.push({
      amount: inv.amount_paid ?? 0,
      stmts: [
        db
          .prepare(`INSERT OR IGNORE INTO furim_payments (${PAYMENT_COLUMNS.join(', ')}) VALUES (${PAYMENT_COLUMNS.map(() => '?').join(', ')})`)
          .bind(...values),
        db
          .prepare(
            'INSERT INTO furim_admin_audit (id, staff_id, staff_name, table_name, row_id, column_name, old_value, new_value, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1',
          )
          .bind(crypto.randomUUID(), opts.staffId, BACKFILL_INVOICES_STAFF_NAME, 'furim_payments', inv.id, 'actual_paid_amount', null, String(inv.amount_paid ?? 0), now),
      ],
    });
  }
  for (let i = 0; i < statements.length; i += ROWS_PER_BATCH) {
    const chunk = statements.slice(i, i + ROWS_PER_BATCH);
    const results = await db.batch(chunk.flatMap((s) => s.stmts));
    results.forEach((r, idx) => {
      const n = r.meta?.changes ?? 0;
      if (idx % 2 === 0) {
        result.inserted += n;
        if (n) result.insertedAmount += chunk[idx / 2].amount;
      } else result.auditRows += n;
    });
  }
  console.log('[furim/backfill-stripe-invoices]', JSON.stringify({ scanned: result.scanned, candidates: result.candidates, inserted: result.inserted, auditRows: result.auditRows, unresolved: result.unresolvedCustomer, nextCursor: result.nextCursor }));
  return result;
}

export type SharedFixChange = { table: 'furim_customers' | 'furim_payments'; column: string; rowId: string; oldValue: string | null; newValue: string | null };

export type FixSharedResult = {
  mode: 'fix-shared-customers';
  dryRun: boolean;
  candidates: number;
  updated: number;
  auditRows: number;
  missingKeepRow: number;
  changes: Array<{ table: string; column: string; row: string; old: string | null; new: string | null }>;
};

const mask = (v: string | null) => (v && v.startsWith('U') ? v.slice(0, 9) : v);

export async function fixSharedCustomers(db: D1Database, opts: { dryRun: boolean; staffId: string; now?: string }): Promise<FixSharedResult> {
  const now = opts.now ?? toJstString(new Date());
  const result: FixSharedResult = { mode: 'fix-shared-customers', dryRun: opts.dryRun, candidates: 0, updated: 0, auditRows: 0, missingKeepRow: 0, changes: [] };
  const changes: SharedFixChange[] = [];
  for (const fix of SHARED_CUSTOMER_FIXES) {
    const rows =
      (
        await db
          .prepare('SELECT line_user_id, stripe_customer_id FROM furim_customers WHERE line_user_id IN (?, ?)')
          .bind(fix.keepLineUserId, fix.dropLineUserId)
          .all<{ line_user_id: string; stripe_customer_id: string | null }>()
      ).results ?? [];
    const keep = rows.find((r) => r.line_user_id === fix.keepLineUserId);
    const drop = rows.find((r) => r.line_user_id === fix.dropLineUserId);
    if (!keep) {
      result.missingKeepRow++;
      continue;
    }
    if (keep.stripe_customer_id !== fix.stripeCustomerId) {
      changes.push({ table: 'furim_customers', column: 'stripe_customer_id', rowId: keep.line_user_id, oldValue: keep.stripe_customer_id, newValue: fix.stripeCustomerId });
    }
    if (drop && drop.stripe_customer_id === fix.stripeCustomerId) {
      changes.push({ table: 'furim_customers', column: 'stripe_customer_id', rowId: drop.line_user_id, oldValue: drop.stripe_customer_id, newValue: null });
    }
    const pays =
      (
        await db
          .prepare('SELECT invoice_id, line_user_id FROM furim_payments WHERE stripe_customer_id = ? AND (line_user_id IS NULL OR line_user_id != ?)')
          .bind(fix.stripeCustomerId, fix.keepLineUserId)
          .all<{ invoice_id: string; line_user_id: string | null }>()
      ).results ?? [];
    for (const p of pays) changes.push({ table: 'furim_payments', column: 'line_user_id', rowId: p.invoice_id, oldValue: p.line_user_id, newValue: fix.keepLineUserId });
  }
  result.candidates = changes.length;
  result.changes = changes.map((c) => ({ table: c.table, column: c.column, row: mask(c.rowId) ?? '', old: mask(c.oldValue), new: mask(c.newValue) }));
  if (opts.dryRun || changes.length === 0) return result;

  const stmts = changes.flatMap((c) => [
    c.table === 'furim_customers'
      ? db.prepare('UPDATE furim_customers SET stripe_customer_id = ?, updated_at = ? WHERE line_user_id = ? AND stripe_customer_id IS ?').bind(c.newValue, now, c.rowId, c.oldValue)
      : db.prepare('UPDATE furim_payments SET line_user_id = ? WHERE invoice_id = ? AND line_user_id IS ?').bind(c.newValue, c.rowId, c.oldValue),
    db
      .prepare(
        'INSERT INTO furim_admin_audit (id, staff_id, staff_name, table_name, row_id, column_name, old_value, new_value, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1',
      )
      .bind(crypto.randomUUID(), opts.staffId, FIX_SHARED_STAFF_NAME, c.table, c.rowId, c.column, c.oldValue, c.newValue, now),
  ]);
  const results = await db.batch(stmts);
  results.forEach((r, idx) => {
    const n = r.meta?.changes ?? 0;
    if (idx % 2 === 0) result.updated += n;
    else result.auditRows += n;
  });
  console.log('[furim/fix-shared-customers]', JSON.stringify({ candidates: result.candidates, updated: result.updated, auditRows: result.auditRows }));
  return result;
}
