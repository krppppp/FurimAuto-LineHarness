import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMocks = {
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
  jstNow: () => '2026-09-14T12:00:00.000+09:00',
  toJstString: (d: Date) => new Date(d.getTime() + 9 * 60 * 60_000).toISOString().slice(0, -1) + '+09:00',
};
vi.mock('@line-crm/db', () => dbMocks);

const worker = (await import('../index.js')).default;
const { fillPaymentsFromStripe, makeStripeInvoiceFetcher, stripeValues, FILL_PAYMENTS_STAFF_NAME, FILL_COLUMNS } = await import('./fill-payments-from-stripe.js');
type InvoiceFetch = import('./fill-payments-from-stripe.js').InvoiceFetch;

type Row = Record<string, unknown>;
const NOW = '2026-09-14T12:00:00.000+09:00';
const blank = (v: unknown) => v == null || v === '';

function makeDb(payments: Row[]) {
  const tables: { furim_payments: Row[]; furim_admin_audit: Row[] } = { furim_payments: payments, furim_admin_audit: [] };
  const writes: string[] = [];
  let lastChanges = 0;
  const anyBlank = (r: Row) => FILL_COLUMNS.some((c) => blank(r[c]));
  const select = (sql: string, args: unknown[]): Row[] => {
    if (sql.startsWith('SELECT invoice_id, paid_at FROM furim_payments WHERE (invoice_id IS NULL')) {
      return tables.furim_payments.filter((r) => blank(r.invoice_id) && anyBlank(r));
    }
    if (sql.startsWith('SELECT invoice_id, paid_at, subscription_id, billing_reason, customer_email FROM furim_payments WHERE invoice_id > ?')) {
      const [cursor, limit] = args as [string, number];
      return tables.furim_payments
        .filter((r) => !blank(r.invoice_id) && String(r.invoice_id) > cursor && anyBlank(r))
        .sort((a, b) => (String(a.invoice_id) < String(b.invoice_id) ? -1 : 1))
        .slice(0, limit);
    }
    if (sql.startsWith('SELECT SUM(CASE WHEN')) {
      return [Object.fromEntries(FILL_COLUMNS.map((c) => [c, tables.furim_payments.filter((r) => blank(r[c])).length]))];
    }
    throw new Error(`unexpected select: ${sql}`);
  };
  const apply = (sql: string, args: unknown[]): number => {
    writes.push(sql);
    const up = sql.match(/^UPDATE furim_payments SET (\w+) = \? WHERE invoice_id = \? AND \((\w+) IS NULL OR (\w+) = ''\)$/);
    if (up) {
      const col = up[1];
      const hits = tables.furim_payments.filter((r) => r.invoice_id === args[1] && blank(r[col]));
      for (const r of hits) r[col] = args[0];
      lastChanges = hits.length;
      return hits.length;
    }
    if (sql.startsWith('INSERT INTO furim_admin_audit') && sql.endsWith('WHERE changes() = 1')) {
      if (lastChanges !== 1) return 0;
      const [id, staff_id, staff_name, table_name, row_id, column_name, old_value, new_value, created_at] = args;
      tables.furim_admin_audit.push({ id, staff_id, staff_name, table_name, row_id, column_name, old_value, new_value, created_at });
      return 1;
    }
    throw new Error(`unexpected write: ${sql}`);
  };
  const stmt = (sql: string, args: unknown[]) => ({
    sql,
    args,
    bind: (...a: unknown[]) => stmt(sql, a),
    all: async () => ({ results: select(sql, args) }),
    first: async () => select(sql, args)[0] ?? null,
    run: async () => ({ meta: { changes: apply(sql, args) } }),
  });
  const db = {
    prepare: (sql: string) => stmt(sql, []),
    batch: async (stmts: Array<{ sql: string; args: unknown[] }>) => stmts.map((s) => ({ meta: { changes: apply(s.sql, s.args) } })),
  } as unknown as D1Database;
  return { db, tables, writes };
}

const pay = (id: string, extra: Row = {}): Row => ({ invoice_id: id, paid_at: '2025-06-16T10:00:00.000+09:00', subscription_id: null, billing_reason: null, customer_email: null, ...extra });

function stripe(invoices: Record<string, InvoiceFetch>) {
  const calls: string[] = [];
  const fn = async (id: string): Promise<InvoiceFetch> => {
    calls.push(id);
    return invoices[id] ?? { status: 'not_found' };
  };
  return { fn, calls };
}
const ok = (id: string, sub: string | null, reason: string | null, email: string | null, basil = false): InvoiceFetch => ({
  status: 'ok',
  invoice: basil
    ? { id, livemode: true, parent: { subscription_details: { subscription: sub } }, billing_reason: reason, customer_email: email }
    : { id, livemode: true, subscription: sub, billing_reason: reason, customer_email: email },
});

const run = (db: D1Database, fetchInvoice: (id: string) => Promise<InvoiceFetch>, dryRun: boolean, cursor?: string | null, limit?: number) =>
  fillPaymentsFromStripe(db, fetchInvoice, { dryRun, staffId: 'staff-1', cursor, limit, now: NOW });

beforeEach(() => {
  dbMocks.getStaffByApiKey.mockReset();
});

describe('stripeValues', () => {
  it('invoice.subscription と basil 以降の parent.subscription_details.subscription の両方を読む', () => {
    expect(stripeValues({ id: 'in_1', subscription: 'sub_a', billing_reason: 'subscription_cycle', customer_email: 'x@example.com' })).toEqual({ subscription_id: 'sub_a', billing_reason: 'subscription_cycle', customer_email: 'x@example.com' });
    expect(stripeValues({ id: 'in_2', parent: { subscription_details: { subscription: 'sub_b' } } }).subscription_id).toBe('sub_b');
    expect(stripeValues({ id: 'in_3', subscription: { id: 'sub_c' } }).subscription_id).toBe('sub_c');
  });
});

describe('fillPaymentsFromStripe', () => {
  it('dryRun は書かない → 実行で空欄だけ埋めて監査に残す → 2 回目は 0 件', async () => {
    const { db, tables, writes } = makeDb([pay('in_a'), pay('in_b', { billing_reason: 'manual', customer_email: '' })]);
    const s = stripe({ in_a: ok('in_a', 'sub_a', 'subscription_create', 'a@example.com'), in_b: ok('in_b', 'sub_b', 'subscription_cycle', 'b@example.com', true) });

    const dry = await run(db, s.fn, true);
    expect(dry).toMatchObject({ dryRun: true, scanned: 2, candidates: { subscription_id: 2, billing_reason: 1, customer_email: 2 }, updated: { subscription_id: 0, billing_reason: 0, customer_email: 0 }, auditRows: 0, nextCursor: null, stripeLivemode: true });
    expect(dry.remainingBlank).toEqual({ subscription_id: 2, billing_reason: 1, customer_email: 2 });
    expect(writes).toHaveLength(0);

    const r = await run(db, s.fn, false);
    expect(r).toMatchObject({ updated: { subscription_id: 2, billing_reason: 1, customer_email: 2 }, auditRows: 5, remainingBlank: { subscription_id: 0, billing_reason: 0, customer_email: 0 } });
    expect(tables.furim_payments[1]).toMatchObject({ subscription_id: 'sub_b', billing_reason: 'manual', customer_email: 'b@example.com' });
    expect(tables.furim_admin_audit).toHaveLength(5);
    expect(tables.furim_admin_audit.find((a) => a.row_id === 'in_b' && a.column_name === 'customer_email')).toMatchObject({ staff_id: 'staff-1', staff_name: FILL_PAYMENTS_STAFF_NAME, table_name: 'furim_payments', old_value: '', new_value: 'b@example.com', created_at: NOW });
    expect(tables.furim_admin_audit.find((a) => a.row_id === 'in_a' && a.column_name === 'subscription_id')).toMatchObject({ old_value: null, new_value: 'sub_a' });
    expect(tables.furim_admin_audit.some((a) => a.row_id === 'in_b' && a.column_name === 'billing_reason')).toBe(false);

    const again = await run(db, s.fn, false);
    expect(again).toMatchObject({ scanned: 0, candidates: { subscription_id: 0, billing_reason: 0, customer_email: 0 }, updated: { subscription_id: 0, billing_reason: 0, customer_email: 0 }, auditRows: 0 });
    expect(tables.furim_admin_audit).toHaveLength(5);
  });

  it('値が入っている列は Stripe と違っても上書きしない', async () => {
    const { db, tables } = makeDb([pay('in_a', { subscription_id: 'sub_keep' })]);
    const s = stripe({ in_a: ok('in_a', 'sub_other', 'subscription_cycle', 'a@example.com') });
    const r = await run(db, s.fn, false);
    expect(r.updated).toEqual({ subscription_id: 0, billing_reason: 1, customer_email: 1 });
    expect(tables.furim_payments[0].subscription_id).toBe('sub_keep');
    expect(tables.furim_admin_audit.map((a) => a.column_name).sort()).toEqual(['billing_reason', 'customer_email']);
  });

  it('読んだ後に値が入った列は更新されず、監査にも残らない', async () => {
    const { db, tables } = makeDb([pay('in_a')]);
    const s = stripe({ in_a: ok('in_a', 'sub_a', 'subscription_cycle', 'a@example.com') });
    const origBatch = db.batch.bind(db);
    (db as unknown as { batch: typeof db.batch }).batch = async (stmts) => {
      tables.furim_payments[0].subscription_id = 'sub_webhook';
      return origBatch(stmts);
    };
    const r = await run(db, s.fn, false);
    expect(r.candidates.subscription_id).toBe(1);
    expect(r.updated.subscription_id).toBe(0);
    expect(tables.furim_payments[0].subscription_id).toBe('sub_webhook');
    expect(tables.furim_admin_audit.some((a) => a.column_name === 'subscription_id')).toBe(false);
  });

  it('invoice_id の無い行と Stripe に無い行は埋めず、件数と例（請求書 ID の先頭と日付）だけ返す。メールは応答に出さない', async () => {
    const { db, tables } = makeDb([
      pay('', { paid_at: '2023-11-02T09:00:00.000+09:00' }),
      pay('in_1NotFoundInStripe', { paid_at: '2024-01-05T09:00:00.000+09:00' }),
      pay('in_err', { paid_at: '2024-02-05T09:00:00.000+09:00' }),
      pay('in_ok'),
    ]);
    const s = stripe({ in_ok: ok('in_ok', null, 'manual', 'secret@example.com'), in_err: { status: 'error', code: 500 } });
    const r = await run(db, s.fn, false);
    expect(r).toMatchObject({
      noInvoiceId: 1,
      noInvoiceIdSamples: [{ invoice: '', date: '2023-11-02' }],
      notFound: 1,
      notFoundSamples: [{ invoice: 'in_1NotFound', date: '2024-01-05' }],
      stripeErrors: 1,
      stripeErrorSamples: [{ invoice: 'in_err', date: '2024-02-05', code: 500 }],
      noValueInStripe: { subscription_id: 1, billing_reason: 0, customer_email: 0 },
      updated: { subscription_id: 0, billing_reason: 1, customer_email: 1 },
    });
    expect(s.calls).not.toContain('');
    expect(tables.furim_payments[1]).toMatchObject({ subscription_id: null, billing_reason: null, customer_email: null });
    expect(JSON.stringify(r)).not.toContain('@example.com');
  });

  it('cursor と limit でページングし、nextCursor をたどると全件を回れる', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `in_${String(i).padStart(2, '0')}`);
    const { db, tables } = makeDb(ids.map((id) => pay(id)));
    const s = stripe(Object.fromEntries(ids.map((id) => [id, ok(id, `sub_${id}`, 'subscription_cycle', `${id}@example.com`)])));
    const pages: Array<{ scanned: number; nextCursor: string | null; noInvoiceId?: number }> = [];
    let cursor: string | null = null;
    do {
      const r = await run(db, s.fn, true, cursor, 3);
      pages.push(r);
      cursor = r.nextCursor;
    } while (cursor);
    expect(pages.map((p) => p.scanned)).toEqual([3, 3, 1]);
    expect(pages[0].noInvoiceId).toBe(0);
    expect(pages[1].noInvoiceId).toBeUndefined();
    expect(s.calls).toEqual(ids);

    s.calls.length = 0;
    cursor = null;
    let updated = 0;
    do {
      const r = await run(db, s.fn, false, cursor, 3);
      updated += r.updated.subscription_id;
      cursor = r.nextCursor;
    } while (cursor);
    expect(updated).toBe(7);
    expect(s.calls).toEqual(ids);
    expect(tables.furim_admin_audit).toHaveLength(21);
  });

  it('limit は 1〜100 に丸める', async () => {
    const { db } = makeDb([pay('in_a')]);
    const s = stripe({});
    expect((await run(db, s.fn, true, null, 1000)).limit).toBe(100);
    expect((await run(db, s.fn, true, null, 0)).limit).toBe(50);
    expect((await run(db, s.fn, true, null, -5)).limit).toBe(1);
  });
});

describe('makeStripeInvoiceFetcher', () => {
  const res = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
  const noWait = async () => {};

  it('200 は請求書・404 は not_found・429 と 5xx は再試行してから error', async () => {
    const f = vi.fn();
    f.mockResolvedValueOnce(res(200, { id: 'in_a', billing_reason: 'manual' }));
    expect(await makeStripeInvoiceFetcher('sk', f as unknown as typeof fetch, noWait)('in_a')).toEqual({ status: 'ok', invoice: { id: 'in_a', billing_reason: 'manual' } });
    expect(f.mock.calls[0][0]).toBe('https://api.stripe.com/v1/invoices/in_a');
    expect(f.mock.calls[0][1]).toEqual({ headers: { Authorization: 'Bearer sk' } });

    f.mockReset();
    f.mockResolvedValueOnce(res(404));
    expect(await makeStripeInvoiceFetcher('sk', f as unknown as typeof fetch, noWait)('in_x')).toEqual({ status: 'not_found' });
    expect(f).toHaveBeenCalledTimes(1);

    f.mockReset();
    f.mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200, { id: 'in_b' }));
    expect(await makeStripeInvoiceFetcher('sk', f as unknown as typeof fetch, noWait)('in_b')).toMatchObject({ status: 'ok' });

    f.mockReset();
    f.mockResolvedValue(res(503));
    expect(await makeStripeInvoiceFetcher('sk', f as unknown as typeof fetch, noWait)('in_c')).toEqual({ status: 'error', code: 503 });
    expect(f).toHaveBeenCalledTimes(3);

    f.mockReset();
    f.mockResolvedValue(res(401));
    expect(await makeStripeInvoiceFetcher('sk', f as unknown as typeof fetch, noWait)('in_d')).toEqual({ status: 'error', code: 401 });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/furim/fill-payments-from-stripe', () => {
  const realFetch = globalThis.fetch;
  function envWith(db: D1Database, workerName: string, stripeKey: string | undefined = 'sk_test') {
    return { DB: db, API_KEY: 'owner-key', WORKER_NAME: workerName, STRIPE_SECRET_KEY: stripeKey, LINE_LOGIN_CHANNEL_ID: '2000000000', WORKER_URL: 'https://worker.example.com' } as unknown as import('../index.js').Env['Bindings'];
  }
  function call(db: D1Database, workerName: string, body: unknown, stripeKey?: string) {
    return worker.fetch(
      new Request('https://worker.example.com/api/furim/fill-payments-from-stripe', {
        method: 'POST',
        headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      envWith(db, workerName, stripeKey),
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
  }
  function mockStripe() {
    const stripeFetch = vi.fn(async (url: string) => new Response(JSON.stringify({ id: url.split('/').pop(), livemode: false, subscription: 'sub_a', billing_reason: 'subscription_cycle', customer_email: 'a@example.com' }), { status: 200 }));
    globalThis.fetch = stripeFetch as unknown as typeof fetch;
    return stripeFetch;
  }

  it('本番 worker で confirmProd なしの実行は 403 で Stripe も呼ばず何も書かない', async () => {
    const { db, writes } = makeDb([pay('in_a')]);
    const stripeFetch = mockStripe();
    try {
      const res = await call(db, 'line-harness-prod', { dryRun: false });
      expect(res.status).toBe(403);
      expect(writes).toHaveLength(0);
      expect(stripeFetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('dryRun は既定で true・本番でも読むだけ', async () => {
    const { db, writes } = makeDb([pay('in_a')]);
    mockStripe();
    try {
      const res = await call(db, 'line-harness-prod', {});
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true, dryRun: true, scanned: 1, candidates: { subscription_id: 1, billing_reason: 1, customer_email: 1 }, auditRows: 0 });
      expect(writes).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('本番で confirmProd: true なら埋めて、認証スタッフの id で監査を残す', async () => {
    const { db, tables } = makeDb([pay('in_a')]);
    mockStripe();
    try {
      const res = await call(db, 'line-harness-prod', { dryRun: false, confirmProd: true, limit: 10 });
      expect(await res.json()).toMatchObject({ success: true, dryRun: false, updated: { subscription_id: 1, billing_reason: 1, customer_email: 1 }, auditRows: 3, nextCursor: null });
      expect(tables.furim_admin_audit[0]).toMatchObject({ staff_id: 'env-owner', staff_name: FILL_PAYMENTS_STAFF_NAME });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('STRIPE_SECRET_KEY が無ければ 500', async () => {
    const { db } = makeDb([pay('in_a')]);
    const res = await call(db, 'line-harness', {}, '');
    expect(res.status).toBe(500);
  });
});
