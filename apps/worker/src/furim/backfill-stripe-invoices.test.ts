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
const {
  backfillStripeInvoices,
  fixSharedCustomers,
  makeStripeApi,
  invoiceToPaymentValues,
  parseSince,
  PAYMENT_COLUMNS,
  SHARED_CUSTOMER_FIXES,
  BACKFILL_INVOICES_STAFF_NAME,
  FIX_SHARED_STAFF_NAME,
} = await import('./backfill-stripe-invoices.js');
type StripeListInvoice = import('./backfill-stripe-invoices.js').StripeListInvoice;
type StripeSubscription = import('./backfill-stripe-invoices.js').StripeSubscription;

type Row = Record<string, unknown>;
const NOW = '2026-09-14T12:00:00.000+09:00';

function makeDb(init: { furim_payments?: Row[]; furim_customers?: Row[] }) {
  const tables = { furim_payments: init.furim_payments ?? [], furim_customers: init.furim_customers ?? [], furim_admin_audit: [] as Row[] };
  const writes: string[] = [];
  let lastChanges = 0;
  const select = (sql: string, args: unknown[]): Row[] => {
    if (sql.startsWith('SELECT invoice_id FROM furim_payments WHERE invoice_id IN (')) {
      return tables.furim_payments.filter((r) => args.includes(r.invoice_id)).map((r) => ({ invoice_id: r.invoice_id }));
    }
    if (sql.startsWith('SELECT line_user_id, stripe_customer_id FROM furim_customers WHERE stripe_customer_id IN (')) {
      return tables.furim_customers.filter((r) => args.includes(r.stripe_customer_id)).map((r) => ({ line_user_id: r.line_user_id, stripe_customer_id: r.stripe_customer_id }));
    }
    if (sql === 'SELECT line_user_id, stripe_customer_id FROM furim_customers WHERE line_user_id IN (?, ?)') {
      return tables.furim_customers.filter((r) => args.includes(r.line_user_id)).map((r) => ({ line_user_id: r.line_user_id, stripe_customer_id: r.stripe_customer_id }));
    }
    if (sql === 'SELECT invoice_id, line_user_id FROM furim_payments WHERE stripe_customer_id = ? AND (line_user_id IS NULL OR line_user_id != ?)') {
      return tables.furim_payments.filter((r) => r.stripe_customer_id === args[0] && (r.line_user_id == null || r.line_user_id !== args[1])).map((r) => ({ invoice_id: r.invoice_id, line_user_id: r.line_user_id }));
    }
    throw new Error(`unexpected select: ${sql}`);
  };
  const apply = (sql: string, args: unknown[]): number => {
    writes.push(sql);
    if (sql.startsWith('INSERT OR IGNORE INTO furim_payments (')) {
      if (tables.furim_payments.some((r) => r.invoice_id === args[0])) return (lastChanges = 0);
      tables.furim_payments.push(Object.fromEntries(PAYMENT_COLUMNS.map((c, i) => [c, args[i]])));
      return (lastChanges = 1);
    }
    if (sql === 'UPDATE furim_customers SET stripe_customer_id = ?, updated_at = ? WHERE line_user_id = ? AND stripe_customer_id IS ?') {
      const hits = tables.furim_customers.filter((r) => r.line_user_id === args[2] && (r.stripe_customer_id ?? null) === args[3]);
      for (const r of hits) Object.assign(r, { stripe_customer_id: args[0], updated_at: args[1] });
      return (lastChanges = hits.length);
    }
    if (sql === 'UPDATE furim_payments SET line_user_id = ? WHERE invoice_id = ? AND line_user_id IS ?') {
      const hits = tables.furim_payments.filter((r) => r.invoice_id === args[1] && (r.line_user_id ?? null) === args[2]);
      for (const r of hits) r.line_user_id = args[0];
      return (lastChanges = hits.length);
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

const PAID_AT = Date.parse('2025-06-16T10:00:00+09:00') / 1000;
const inv = (id: string, customer: string, amount: number, extra: Partial<StripeListInvoice> = {}): StripeListInvoice => ({
  id,
  livemode: true,
  customer,
  amount_paid: amount,
  total_taxes: [{ amount: Math.floor(amount / 11) }],
  billing_reason: 'subscription_update',
  customer_email: 'x@example.com',
  parent: { subscription_details: { subscription: 'sub_1' } },
  created: PAID_AT - 60,
  status_transitions: { paid_at: PAID_AT },
  ...extra,
});

function fakeApi(invoices: StripeListInvoice[], subs: Record<string, StripeSubscription> = {}) {
  const listCalls: Array<Record<string, unknown>> = [];
  const subCalls: string[] = [];
  const api = {
    async listPaidInvoices(p: { customer?: string; createdGte?: number; startingAfter?: string; limit: number }) {
      listCalls.push(p);
      let pool = invoices.filter((i) => (!p.customer || i.customer === p.customer) && (p.createdGte == null || (i.created ?? 0) >= p.createdGte));
      if (p.startingAfter) pool = pool.slice(pool.findIndex((i) => i.id === p.startingAfter) + 1);
      return { data: pool.slice(0, p.limit), has_more: pool.length > p.limit };
    },
    async getSubscription(id: string) {
      subCalls.push(id);
      return subs[id] ?? null;
    },
  };
  return { api, listCalls, subCalls };
}

const U1 = 'U' + '1'.repeat(32);
const U2 = 'U' + '2'.repeat(32);
const customers = (): Row[] => [
  { line_user_id: U1, stripe_customer_id: 'cus_a' },
  { line_user_id: U2, stripe_customer_id: 'cus_b' },
];

beforeEach(() => {
  dbMocks.getStaffByApiKey.mockReset();
});

describe('invoiceToPaymentValues', () => {
  it('stripe-processor と同じ列の対応で 1 行を作る（サブスク ID・請求理由・メールアドレスも埋める）', () => {
    const sub: StripeSubscription = { plan: { nickname: 'スタンダード', amount: 1 }, items: { data: [{ price: { unit_amount: 3000 }, quantity: 1 }, { price: { unit_amount: 980 }, quantity: 2 }] } };
    const v = invoiceToPaymentValues(inv('in_x', 'cus_a', 1100, { total_discount_amounts: [{ amount: 100 }, { amount: 50 }] }), sub, U1, NOW);
    expect(Object.fromEntries(PAYMENT_COLUMNS.map((c, i) => [c, v[i]]))).toEqual({
      invoice_id: 'in_x',
      stripe_event_id: null,
      line_user_id: U1,
      stripe_customer_id: 'cus_a',
      subscription_id: 'sub_1',
      plan_name: 'スタンダード',
      billing_reason: 'subscription_update',
      subscription_price: 4960,
      discount_amount: 150,
      price_excl_tax: 1000,
      tax_amount: 100,
      actual_paid_amount: 1100,
      customer_email: 'x@example.com',
      paid_at: '2025-06-16T10:00:00.000+09:00',
      created_at: NOW,
    });
  });

  it('invoice.tax と invoice.subscription（旧 API の形）も読み、plan-builder はラベルを作る', () => {
    const sub: StripeSubscription = { items: { data: [{ price: { unit_amount: 5000 } }] }, metadata: { source: 'plan-builder', packages: 'premium', features: 'mRelist' } };
    const v = invoiceToPaymentValues(inv('in_y', 'cus_a', 500, { tax: 45, total_taxes: undefined, parent: null, subscription: 'sub_old', customer_email: null }), sub, U1, NOW);
    const row = Object.fromEntries(PAYMENT_COLUMNS.map((c, i) => [c, v[i]]));
    expect(row).toMatchObject({ subscription_id: 'sub_old', plan_name: 'PBプラン:premium+mRelist', subscription_price: 5000, tax_amount: 45, price_excl_tax: 455, customer_email: null });
  });
});

describe('parseSince', () => {
  it('日付だけは JST 0 時・空は null・読めなければ invalid', () => {
    expect(parseSince('2025-06-16')).toBe(Date.parse('2025-06-16T00:00:00+09:00') / 1000);
    expect(parseSince(undefined)).toBeNull();
    expect(parseSince('abc')).toBe('invalid');
  });
});

describe('backfillStripeInvoices', () => {
  const run = (db: D1Database, api: ReturnType<typeof fakeApi>['api'], dryRun: boolean, extra: Record<string, unknown> = {}) =>
    backfillStripeInvoices(db, api, { dryRun, staffId: 'staff-1', now: NOW, ...extra });

  it('¥0 は入れず・既存は上書きせず・解決できない請求は入れず、新しい請求だけ入れて監査を残す。2 回目は 0 件', async () => {
    const existing = { invoice_id: 'in_old', line_user_id: U2, stripe_customer_id: 'cus_b', actual_paid_amount: 9856, plan_name: 'そのまま' };
    const { db, tables, writes } = makeDb({ furim_payments: [existing], furim_customers: customers() });
    const { api, subCalls } = fakeApi(
      [inv('in_new1', 'cus_a', 896), inv('in_zero', 'cus_a', 0), inv('in_old', 'cus_b', 1), inv('in_nobody', 'cus_zzz', 449), inv('in_new2', 'cus_b', 1042, { status_transitions: { paid_at: Date.parse('2025-09-12T09:00:00+09:00') / 1000 } })],
      { sub_1: { plan: { nickname: 'P', amount: 3000 } } },
    );

    const dry = await run(db, api, true);
    expect(dry).toMatchObject({ dryRun: true, livemode: true, scanned: 5, candidates: 3, candidateUsers: 2, inserted: 0, skippedZero: 1, skippedExisting: 1, unresolvedCustomer: 1, unresolvedAmount: 449, totalAmount: 896 + 449 + 1042, nextCursor: null });
    expect(dry.samples).toEqual([
      { invoice: 'in_new1', date: '2025-06-16', amount: 896, resolved: true, existing: false },
      { invoice: 'in_nobody', date: '2025-06-16', amount: 449, resolved: false, existing: false },
      { invoice: 'in_new2', date: '2025-09-12', amount: 1042, resolved: true, existing: false },
    ]);
    expect(writes).toHaveLength(0);
    expect(subCalls).toHaveLength(0);

    const r = await run(db, api, false);
    expect(r).toMatchObject({ inserted: 2, auditRows: 2, insertedAmount: 896 + 1042, unresolvedCustomer: 1 });
    expect(tables.furim_payments.map((p) => p.invoice_id).sort()).toEqual(['in_new1', 'in_new2', 'in_old']);
    expect(tables.furim_payments.find((p) => p.invoice_id === 'in_old')).toEqual(existing);
    expect(tables.furim_payments.find((p) => p.invoice_id === 'in_new1')).toMatchObject({ line_user_id: U1, stripe_customer_id: 'cus_a', actual_paid_amount: 896, subscription_id: 'sub_1', billing_reason: 'subscription_update', customer_email: 'x@example.com', plan_name: 'P' });
    expect(tables.furim_payments.find((p) => p.invoice_id === 'in_new2')).toMatchObject({ line_user_id: U2, paid_at: '2025-09-12T09:00:00.000+09:00' });
    expect(tables.furim_admin_audit.map((a) => [a.staff_name, a.table_name, a.row_id, a.column_name, a.old_value, a.new_value, a.staff_id])).toEqual([
      [BACKFILL_INVOICES_STAFF_NAME, 'furim_payments', 'in_new1', 'actual_paid_amount', null, '896', 'staff-1'],
      [BACKFILL_INVOICES_STAFF_NAME, 'furim_payments', 'in_new2', 'actual_paid_amount', null, '1042', 'staff-1'],
    ]);
    expect(subCalls).toEqual(['sub_1']);
    expect(writes.every((w) => w.startsWith('INSERT OR IGNORE INTO furim_payments') || w.startsWith('INSERT INTO furim_admin_audit'))).toBe(true);

    const again = await run(db, api, false);
    expect(again).toMatchObject({ candidates: 1, inserted: 0, auditRows: 0, skippedExisting: 3, unresolvedCustomer: 1 });
  });

  it('1 つの Stripe 顧客 ID を 2 人が持っていたら解決できない扱いで入れない', async () => {
    const { db, tables } = makeDb({ furim_customers: [...customers(), { line_user_id: 'U' + '3'.repeat(32), stripe_customer_id: 'cus_a' }] });
    const { api } = fakeApi([inv('in_s', 'cus_a', 100)]);
    expect(await run(db, api, false)).toMatchObject({ candidates: 1, inserted: 0, unresolvedCustomer: 1 });
    expect(tables.furim_payments).toHaveLength(0);
  });

  it('cursor／limit のページングで全件を回れる', async () => {
    const all = Array.from({ length: 250 }, (_, i) => inv(`in_${String(i).padStart(3, '0')}`, i % 2 ? 'cus_a' : 'cus_b', i % 10 === 0 ? 0 : 100 + i));
    const { db, tables } = makeDb({ furim_customers: customers() });
    const { api } = fakeApi(all);
    let cursor: string | null = null;
    let pages = 0;
    const sum = { scanned: 0, inserted: 0, skippedZero: 0 };
    do {
      const r = await run(db, api, false, { cursor, limit: 100 });
      sum.scanned += r.scanned;
      sum.inserted += r.inserted;
      sum.skippedZero += r.skippedZero;
      cursor = r.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(sum).toEqual({ scanned: 250, inserted: 225, skippedZero: 25 });
    expect(tables.furim_payments).toHaveLength(225);
  });

  it('customerIds を渡すとその顧客だけを全ページ読み、since を created[gte] に渡す', async () => {
    const { db } = makeDb({ furim_customers: customers() });
    const { api, listCalls } = fakeApi([inv('in_1', 'cus_a', 10), inv('in_2', 'cus_b', 10), inv('in_3', 'cus_a', 10, { created: 1 })]);
    const r = await run(db, api, true, { customerIds: ['cus_a'], since: 100, limit: 1 });
    expect(r).toMatchObject({ scanned: 1, candidates: 1, nextCursor: null });
    expect(listCalls.every((c) => c.customer === 'cus_a' && c.createdGte === 100)).toBe(true);
  });
});

describe('makeStripeApi', () => {
  const res = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
  const noWait = async () => undefined;

  it('status=paid・limit・customer・created[gte]・starting_after を付けて一覧を読み、429 は待って再試行する', async () => {
    const f = vi.fn().mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200, { data: [{ id: 'in_1' }], has_more: true }));
    const api = makeStripeApi('sk', f as unknown as typeof fetch, noWait);
    expect(await api.listPaidInvoices({ customer: 'cus_a', createdGte: 5, startingAfter: 'in_0', limit: 100 })).toEqual({ data: [{ id: 'in_1' }], has_more: true });
    const url = new URL(f.mock.calls[1][0] as string);
    expect(url.pathname).toBe('/v1/invoices');
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: 'paid', limit: '100', customer: 'cus_a', 'created[gte]': '5', starting_after: 'in_0' });
    expect(f.mock.calls[1][1]).toEqual({ headers: { Authorization: 'Bearer sk' } });
  });

  it('一覧の失敗は例外（何も書かない）・サブスクの取得失敗は null', async () => {
    const f = vi.fn().mockResolvedValue(res(401));
    const api = makeStripeApi('sk', f as unknown as typeof fetch, noWait);
    await expect(api.listPaidInvoices({ limit: 1 })).rejects.toThrow('401');
    expect(await api.getSubscription('sub_x')).toBeNull();
  });
});

describe('fixSharedCustomers', () => {
  const [A, B] = SHARED_CUSTOMER_FIXES;
  const seed = () =>
    makeDb({
      furim_customers: [
        { line_user_id: A.keepLineUserId, stripe_customer_id: A.stripeCustomerId, updated_at: 'x' },
        { line_user_id: A.dropLineUserId, stripe_customer_id: A.stripeCustomerId, updated_at: 'x' },
        { line_user_id: B.keepLineUserId, stripe_customer_id: B.stripeCustomerId, updated_at: 'x' },
        { line_user_id: B.dropLineUserId, stripe_customer_id: B.stripeCustomerId, updated_at: 'x' },
        { line_user_id: U1, stripe_customer_id: 'cus_a', updated_at: 'x' },
      ],
      furim_payments: [
        { invoice_id: 'in_a1', stripe_customer_id: A.stripeCustomerId, line_user_id: A.keepLineUserId },
        { invoice_id: 'in_b1', stripe_customer_id: B.stripeCustomerId, line_user_id: B.keepLineUserId },
        { invoice_id: 'in_b2', stripe_customer_id: B.stripeCustomerId, line_user_id: B.dropLineUserId },
        { invoice_id: 'in_b3', stripe_customer_id: B.stripeCustomerId, line_user_id: null },
        { invoice_id: 'in_u1', stripe_customer_id: 'cus_a', line_user_id: U1 },
      ],
    });

  it('外す側の stripe_customer_id を NULL にし、決済を支払い側に付け直して監査を残す。2 回目は 0 件', async () => {
    const { db, tables, writes } = seed();
    const dry = await fixSharedCustomers(db, { dryRun: true, staffId: 'staff-1', now: NOW });
    expect(dry).toMatchObject({ candidates: 4, updated: 0, missingKeepRow: 0 });
    expect(writes).toHaveLength(0);

    const r = await fixSharedCustomers(db, { dryRun: false, staffId: 'staff-1', now: NOW });
    expect(r).toMatchObject({ candidates: 4, updated: 4, auditRows: 4 });
    const cust = Object.fromEntries(tables.furim_customers.map((c) => [c.line_user_id, c.stripe_customer_id]));
    expect(cust).toEqual({ [A.keepLineUserId]: A.stripeCustomerId, [A.dropLineUserId]: null, [B.keepLineUserId]: B.stripeCustomerId, [B.dropLineUserId]: null, [U1]: 'cus_a' });
    expect(tables.furim_customers.find((c) => c.line_user_id === U1)?.updated_at).toBe('x');
    expect(Object.fromEntries(tables.furim_payments.map((p) => [p.invoice_id, p.line_user_id]))).toEqual({ in_a1: A.keepLineUserId, in_b1: B.keepLineUserId, in_b2: B.keepLineUserId, in_b3: B.keepLineUserId, in_u1: U1 });
    expect(tables.furim_admin_audit.map((a) => [a.staff_name, a.table_name, a.row_id, a.column_name, a.old_value, a.new_value])).toEqual([
      [FIX_SHARED_STAFF_NAME, 'furim_customers', A.dropLineUserId, 'stripe_customer_id', A.stripeCustomerId, null],
      [FIX_SHARED_STAFF_NAME, 'furim_customers', B.dropLineUserId, 'stripe_customer_id', B.stripeCustomerId, null],
      [FIX_SHARED_STAFF_NAME, 'furim_payments', 'in_b2', 'line_user_id', B.dropLineUserId, B.keepLineUserId],
      [FIX_SHARED_STAFF_NAME, 'furim_payments', 'in_b3', 'line_user_id', null, B.keepLineUserId],
    ]);

    const again = await fixSharedCustomers(db, { dryRun: false, staffId: 'staff-1', now: NOW });
    expect(again).toMatchObject({ candidates: 0, updated: 0, auditRows: 0 });
  });

  it('dryRun と実行の間に値が変わった行は書かない（変更前の値が条件）', async () => {
    const { db, tables } = seed();
    const origBatch = db.batch.bind(db);
    (db as unknown as { batch: typeof db.batch }).batch = async (stmts) => {
      tables.furim_customers.find((c) => c.line_user_id === A.dropLineUserId)!.stripe_customer_id = 'cus_other';
      return origBatch(stmts);
    };
    const r = await fixSharedCustomers(db, { dryRun: false, staffId: 'staff-1', now: NOW });
    expect(r).toMatchObject({ candidates: 4, updated: 3, auditRows: 3 });
    expect(tables.furim_customers.find((c) => c.line_user_id === A.dropLineUserId)?.stripe_customer_id).toBe('cus_other');
  });

  it('付ける側の行が無ければその組は触らない', async () => {
    const { db, tables } = makeDb({ furim_customers: [{ line_user_id: A.dropLineUserId, stripe_customer_id: A.stripeCustomerId }] });
    const r = await fixSharedCustomers(db, { dryRun: false, staffId: 'staff-1', now: NOW });
    expect(r).toMatchObject({ missingKeepRow: 2, updated: 0 });
    expect(tables.furim_customers[0].stripe_customer_id).toBe(A.stripeCustomerId);
  });
});

describe('POST /api/furim/backfill-stripe-invoices', () => {
  const realFetch = globalThis.fetch;
  function call(db: D1Database, workerName: string, body: unknown, stripeKey: string | undefined = 'sk_test') {
    const env = { DB: db, API_KEY: 'owner-key', WORKER_NAME: workerName, STRIPE_SECRET_KEY: stripeKey, LINE_LOGIN_CHANNEL_ID: '2000000000', WORKER_URL: 'https://worker.example.com' } as unknown as import('../index.js').Env['Bindings'];
    return worker.fetch(
      new Request('https://worker.example.com/api/furim/backfill-stripe-invoices', {
        method: 'POST',
        headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
  }
  function mockStripe() {
    const f = vi.fn(async (url: string) => {
      if (String(url).startsWith('https://api.stripe.com/v1/invoices?')) return new Response(JSON.stringify({ data: [inv('in_r1', 'cus_a', 396)], has_more: false }), { status: 200 });
      if (String(url).startsWith('https://api.stripe.com/v1/subscriptions/')) return new Response(JSON.stringify({ plan: { nickname: 'P', amount: 3000 } }), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = f as unknown as typeof fetch;
    return f;
  }

  it('本番 worker で confirmProd なしの実行は 403 で Stripe も呼ばず何も書かない（両 mode）', async () => {
    const { db, writes } = makeDb({ furim_customers: customers() });
    const f = mockStripe();
    try {
      expect((await call(db, 'line-harness-prod', { dryRun: false })).status).toBe(403);
      expect((await call(db, 'line-harness-prod', { mode: 'fix-shared-customers', dryRun: false })).status).toBe(403);
      expect(writes).toHaveLength(0);
      expect(f).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('dryRun が既定・本番で confirmProd なら入れる。呼ぶ外部は Stripe の請求一覧とサブスクだけ（タグ・GAS・期限は触らない）', async () => {
    const { db, tables, writes } = makeDb({ furim_customers: customers() });
    const f = mockStripe();
    try {
      const dry = await call(db, 'line-harness-prod', {});
      expect(await dry.json()).toMatchObject({ success: true, mode: 'invoices', dryRun: true, candidates: 1, inserted: 0 });
      expect(writes).toHaveLength(0);
      const res = await call(db, 'line-harness-prod', { dryRun: false, confirmProd: true, since: '2025-01-01', limit: 50 });
      expect(await res.json()).toMatchObject({ success: true, dryRun: false, inserted: 1, auditRows: 1 });
      expect(tables.furim_payments).toHaveLength(1);
      expect(tables.furim_customers).toEqual(customers());
      expect(f.mock.calls.map((c) => String(c[0]).split('?')[0])).toEqual(['https://api.stripe.com/v1/invoices', 'https://api.stripe.com/v1/invoices', 'https://api.stripe.com/v1/subscriptions/sub_1']);
      expect(writes.every((w) => w.startsWith('INSERT OR IGNORE INTO furim_payments') || w.startsWith('INSERT INTO furim_admin_audit'))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('入力の不正は 400', async () => {
    const { db } = makeDb({});
    mockStripe();
    try {
      expect((await call(db, 'line-harness', { since: 'abc' })).status).toBe(400);
      expect((await call(db, 'line-harness', { customerIds: ['x'] })).status).toBe(400);
      expect((await call(db, 'line-harness', { mode: 'other' })).status).toBe(400);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('mode=fix-shared-customers は dev では confirmProd なしで実行でき、Stripe を呼ばない', async () => {
    const [A] = SHARED_CUSTOMER_FIXES;
    const { db, tables } = makeDb({
      furim_customers: [
        { line_user_id: A.keepLineUserId, stripe_customer_id: A.stripeCustomerId },
        { line_user_id: A.dropLineUserId, stripe_customer_id: A.stripeCustomerId },
      ],
    });
    const f = mockStripe();
    try {
      const res = await call(db, 'line-harness', { mode: 'fix-shared-customers', dryRun: false });
      expect(await res.json()).toMatchObject({ success: true, mode: 'fix-shared-customers', updated: 1, auditRows: 1 });
      expect(tables.furim_customers[1].stripe_customer_id).toBeNull();
      expect(f).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
