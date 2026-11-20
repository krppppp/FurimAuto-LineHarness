import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// vite 5 は node:sqlite を組み込みと見なさず解決に失敗するので require で読む
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

vi.mock('@line-crm/db', () => ({ jstNow: () => '2026-11-21T10:00:00.000+09:00' }));
const pushMessage = vi.fn();
vi.mock('@line-crm/line-sdk', () => ({ LineClient: vi.fn().mockImplementation(() => ({ pushMessage })) }));
vi.mock('../services/push-notify.js', () => ({ sendPushToAll: vi.fn() }));

const ap = await import('./annual-prepay.js');
const {
  itemAmount, quoteSubscription, checkoutBlock, checkoutExpiresAt, addMonths, buildCheckoutParams, applyBlock, verifyApplied,
  createAnnualCheckout, applyAnnualCoupon, recordAnnualPayment, ensureAnnualCoupon, annualPricing,
} = ap;
type AnnualSub = import('./annual-prepay.js').AnnualSub;

const migration = (name: string) => readFileSync(fileURLToPath(new URL(`../../../../packages/db/migrations/${name}`, import.meta.url).href), 'utf8');

function asD1(sqlite: DatabaseSync): D1Database {
  const prepare = (sql: string) => {
    const bound = (args: unknown[]) => ({
      run: async () => {
        const r = sqlite.prepare(sql).run(...(args as never[]));
        return { meta: { changes: Number(r.changes) } };
      },
      first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
    });
    return { bind: (...args: unknown[]) => bound(args), ...bound([]) };
  };
  return { prepare } as unknown as D1Database;
}

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(migration('068_furim_customers.sql'));
  sqlite.exec('ALTER TABLE furim_customers ADD COLUMN subscription_id TEXT');
  sqlite.exec('CREATE TABLE friends (id TEXT PRIMARY KEY, line_user_id TEXT, display_name TEXT)');
  sqlite.exec("CREATE TABLE messages_log (id TEXT PRIMARY KEY, friend_id TEXT, direction TEXT, message_type TEXT, content TEXT, created_at TEXT)");
  sqlite.exec(migration('092_furim_annual_prepay.sql'));
  sqlite.exec(migration('093_furim_annual_prepay_price_months.sql'));
  sqlite.prepare("INSERT INTO furim_customers (line_user_id, stripe_customer_id, subscription_id, created_at, updated_at) VALUES ('U1', 'cus_1', 'sub_1', 'x', 'x')").run();
  sqlite.prepare("INSERT INTO friends VALUES ('f1', 'U1', 'テスト太郎')").run();
  const rows = () => sqlite.prepare('SELECT * FROM furim_annual_prepay').all() as Array<Record<string, unknown>>;
  return { sqlite, db: asD1(sqlite), rows };
}

const PERIOD_END = Math.floor(Date.parse('2026-12-05T10:00:00+09:00') / 1000);
const NOW = Date.parse('2026-11-21T10:00:00+09:00');

const combo = { id: 'di_combo', end: null, coupon: { id: 'combo-f1-s0', amount_off: 1500, percent_off: null, duration: 'forever' } };
function sub(over: Partial<AnnualSub> = {}): AnnualSub {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    cancel_at: null,
    current_period_end: PERIOD_END,
    metadata: { source: 'plan-builder' },
    items: {
      data: [
        { quantity: 1, price: { id: 'price_full', unit_amount: 5980, billing_scheme: 'per_unit' } },
        { quantity: 1, price: { id: 'price_semi', unit_amount: 4500, billing_scheme: 'per_unit' } },
      ],
    },
    discounts: [combo],
    ...over,
  };
}

describe('年払い額の計算（annual_quote.py と同じ決まり）', () => {
  it('段階料金は tier ごとに足す（〜2 サイト定額・3 サイト目から 1 サイトごと）', () => {
    const tiers = [{ up_to: 2, flat_amount: 2980, unit_amount: null }, { up_to: null, flat_amount: null, unit_amount: 1980 }];
    const p = { id: 'price_mc', billing_scheme: 'tiered', tiers };
    expect(itemAmount({ quantity: 1, price: p })).toBe(2980);
    expect(itemAmount({ quantity: 2, price: p })).toBe(2980);
    expect(itemAmount({ quantity: 4, price: p })).toBe(2980 + 1980 * 2);
    expect(() => itemAmount({ quantity: 1, price: { id: 'price_mc', billing_scheme: 'tiered' } })).toThrow(/tiers not expanded/);
  });

  it('月額 = 全品目 − forever の割引。once・repeating は入れない。年払い = 月額 × 月数（決算セール 10・常設 11）', () => {
    const once = { id: 'di_once', coupon: { id: 'L5kbS7Pt', amount_off: 1000, duration: 'once' } };
    const q = quoteSubscription(sub({ discounts: [combo, once] }), 10);
    expect(q).toEqual({ gross: 10480, foreverOff: 1500, monthly: 8980, annual: 89800, otherDiscounts: ['L5kbS7Pt'] });
    expect(quoteSubscription(sub(), 11).annual).toBe(98780);
    const pct = { id: 'di_pct', coupon: { id: 'pct', percent_off: 10, duration: 'forever' } };
    expect(quoteSubscription(sub({ discounts: [pct] }), 10).monthly).toBe(10480 - 1048);
  });

  it('discounts が展開されていなければ止める（金額を間違えて出さない）', () => {
    expect(() => quoteSubscription(sub({ discounts: ['di_combo'] }), 10)).toThrow(/not expanded/);
  });
});

describe('Checkout を出してよいか', () => {
  const ok = { couponId: 'annual-prepay-12m', openInvoiceCount: 0, monthly: 8980 };
  it('active・解約予約なし・未払いなし・年払い前なら出す', () => {
    expect(checkoutBlock(sub(), ok)).toBeNull();
  });
  it('支払い遅れ・解約予約・未払いの請求書・年払い済み・1 円の契約は出さない', () => {
    expect(checkoutBlock(sub({ status: 'past_due' }), ok)?.reason).toBe('not_active');
    expect(checkoutBlock(sub({ cancel_at_period_end: true }), ok)?.reason).toBe('cancel_scheduled');
    expect(checkoutBlock(sub({ cancel_at: PERIOD_END }), ok)?.reason).toBe('cancel_scheduled');
    expect(checkoutBlock(sub(), { ...ok, openInvoiceCount: 1 })?.reason).toBe('open_invoice');
    const annual = { id: 'di_a', coupon: { id: 'annual-prepay-12m', percent_off: 100, duration: 'repeating' } };
    expect(checkoutBlock(sub({ discounts: [combo, annual] }), ok)?.reason).toBe('already_annual');
    expect(checkoutBlock(sub(), { ...ok, monthly: 1 })?.reason).toBe('too_small');
  });
});

describe('Checkout の期限', () => {
  const deadline = '2026-12-01T00:00:00+09:00';
  it('発行から 24 時間', () => {
    expect(checkoutExpiresAt(NOW, deadline)).toBe(NOW / 1000 + 86400);
  });
  it('12/1 0:00 JST を超えない（11/30 15:00 に出すと 12/1 0:00 まで）', () => {
    expect(checkoutExpiresAt(Date.parse('2026-11-30T15:00:00+09:00'), deadline)).toBe(Date.parse(deadline) / 1000);
  });
  it('締切まで 30 分を切ったら・過ぎたら出さない', () => {
    expect(checkoutExpiresAt(Date.parse('2026-11-30T23:40:00+09:00'), deadline)).toBeNull();
    expect(checkoutExpiresAt(Date.parse('2026-12-01T09:00:00+09:00'), deadline)).toBeNull();
  });
});

describe('×10（決算セール）と ×11（常設）の分かれ目', () => {
  const dl = { saleReplyDeadlineIso: '2026-11-27T19:00:00+09:00', saleCheckoutDeadlineIso: '2026-12-01T00:00:00+09:00' };
  it('「年払い」の返信が 11/27 19:00 より前なら ×10。期限は 24 時間かつ 12/1 0:00 まで', () => {
    const now = Date.parse('2026-11-28T10:00:00+09:00');
    const r = annualPricing({ ...dl, nowMs: now, replyAt: '2026-11-27T18:59:59.999+09:00' });
    expect(r).toMatchObject({ kind: 'sale', priceMonths: 10, expiresAt: now / 1000 + 86400 });
    const late = annualPricing({ ...dl, nowMs: Date.parse('2026-11-30T15:00:00+09:00'), replyAt: '2026-11-27T10:00:00.000+09:00' });
    expect(late).toMatchObject({ kind: 'sale', expiresAt: Date.parse('2026-12-01T00:00:00+09:00') / 1000 });
  });
  it('返信が 11/27 19:00 ちょうど以降なら ×11（常設・24 時間）', () => {
    const now = Date.parse('2026-11-27T20:00:00+09:00');
    expect(annualPricing({ ...dl, nowMs: now, replyAt: '2026-11-27T19:00:00.000+09:00' })).toMatchObject({ kind: 'standard', priceMonths: 11, expiresAt: now / 1000 + 86400 });
  });
  it('返信の記録が無ければ発行した時刻で決める', () => {
    expect(annualPricing({ ...dl, nowMs: NOW, replyAt: null }).priceMonths).toBe(10);
    expect(annualPricing({ ...dl, nowMs: Date.parse('2026-11-27T19:00:00+09:00'), replyAt: null }).priceMonths).toBe(11);
  });
  it('締切前に返信していても、決算セールの Checkout が出せなくなったら（11/30 23:30 以降）×11', () => {
    const now = Date.parse('2026-11-30T23:40:00+09:00');
    expect(annualPricing({ ...dl, nowMs: now, replyAt: '2026-11-27T10:00:00.000+09:00' })).toMatchObject({ kind: 'standard', priceMonths: 11, expiresAt: now / 1000 + 86400 });
  });
});

describe('月の足し算（更新日の数え方）', () => {
  it('同じ日・同じ時刻で月を進め、日が無い月は月末に寄せる', () => {
    const jan31 = Date.UTC(2027, 0, 31, 1) / 1000;
    expect(new Date(addMonths(jan31, 1) * 1000).toISOString()).toBe('2027-02-28T01:00:00.000Z');
    expect(new Date(addMonths(PERIOD_END, 12) * 1000).toISOString()).toBe('2027-12-05T01:00:00.000Z');
  });
});

describe('Checkout の中身', () => {
  const p = buildCheckoutParams({
    annualPrepayId: 'ap_1', customerId: 'cus_1', subscriptionId: 'sub_1', lineUserId: 'U1', monthly: 8980, annual: 89800, priceMonths: 10,
    taxRateId: 'txr_1', expiresAt: 1, periodEndSec: PERIOD_END, workerPublicUrl: 'https://w',
  });
  it('一括払い（mode=payment）・既存の顧客・都度の金額・10% 外税', () => {
    expect(p.mode).toBe('payment');
    expect(p.customer).toBe('cus_1');
    expect(p['line_items[0][price_data][unit_amount]']).toBe('89800');
    expect(p['line_items[0][price_data][tax_behavior]']).toBe('exclusive');
    expect(p['line_items[0][tax_rates][0]']).toBe('txr_1');
  });
  it('請求書は作らない・新しい顧客を作らない（invoice_creation・customer_creation を付けない）', () => {
    expect(Object.keys(p).some((k) => k.startsWith('invoice_creation'))).toBe(false);
    expect(p.customer_creation).toBeUndefined();
    expect(p.customer_email).toBeUndefined();
  });
  it('PaymentIntent の metadata で定期契約と結ぶ', () => {
    expect(p['payment_intent_data[metadata][purchaseType]']).toBe('annual_prepay');
    expect(p['payment_intent_data[metadata][annualPrepayId]']).toBe('ap_1');
    expect(p['payment_intent_data[metadata][subscriptionId]']).toBe('sub_1');
    expect(p['payment_intent_data[metadata][annualExclTax]']).toBe('89800');
  });
  it('期間（次回の更新日から 12 か月）を決済画面に出す', () => {
    expect(p['custom_text[submit][message]']).toContain('2026/12/05');
    expect(p['custom_text[submit][message]']).toContain('2027/12/04');
  });
  it('決算セールは「2か月分無料」、常設は「11か月分のお支払い」と出す。月数は metadata にも入れる', () => {
    expect(p['line_items[0][price_data][product_data][name]']).toContain('決算セール 2か月分無料');
    expect(p['custom_text[submit][message]']).toContain('12か月分を10か月分のお支払い（決算セール・2か月分無料）');
    expect(p['payment_intent_data[metadata][priceMonths]']).toBe('10');
    const std = buildCheckoutParams({
      annualPrepayId: 'ap_2', customerId: 'cus_1', subscriptionId: 'sub_1', lineUserId: 'U1', monthly: 8980, annual: 98780, priceMonths: 11,
      taxRateId: 'txr_1', expiresAt: 1, periodEndSec: PERIOD_END,
    });
    expect(std['line_items[0][price_data][product_data][name]']).toBe('FurimAuto 年払いプラン（12か月）');
    expect(std['custom_text[submit][message]']).toContain('12か月分を11か月分のお支払い（1か月分無料）');
    expect(std['payment_intent_data[metadata][priceMonths]']).toBe('11');
  });
});

describe('付与の前の確かめ', () => {
  const pi = { status: 'succeeded', amount: 98780, amount_received: 98780, customer: 'cus_1', metadata: { purchaseType: 'annual_prepay', lineUserId: 'U1', subscriptionId: 'sub_1', annualExclTax: '89800' } };
  const row = { line_user_id: 'U1', subscription_id: 'sub_1', stripe_customer_id: 'cus_1', annual_excl_tax: 89800, price_months: 10, amount_total: 98780 };
  const q = { annual: 89800, otherDiscounts: [] as string[] };
  const base = { pi, row, lineUserId: 'U1', sub: sub(), quote: q };
  it('入金済み・金額一致・契約一致なら付けてよい', () => {
    expect(applyBlock(base)).toBeNull();
  });
  it('未入金・別人・台帳なし・別の契約・金額違い・発行後の月額変更・once 残りは付けない', () => {
    expect(applyBlock({ ...base, pi: { ...pi, status: 'processing' } })?.reason).toBe('not_paid');
    expect(applyBlock({ ...base, lineUserId: 'U2' })?.reason).toBe('line_mismatch');
    expect(applyBlock({ ...base, row: null })?.reason).toBe('no_record');
    expect(applyBlock({ ...base, sub: sub({ id: 'sub_2' }) })?.reason).toBe('sub_mismatch');
    expect(applyBlock({ ...base, sub: sub({ customer: 'cus_2' }) })?.reason).toBe('customer_mismatch');
    expect(applyBlock({ ...base, pi: { ...pi, amount_received: 1000 } })?.reason).toBe('amount_mismatch');
    expect(applyBlock({ ...base, pi: { ...pi, metadata: { ...pi.metadata, priceMonths: '11' } } })?.reason).toBe('amount_mismatch');
    expect(applyBlock({ ...base, quote: { ...q, annual: 79800 } })?.reason).toBe('plan_changed');
    expect(applyBlock({ ...base, sub: sub({ cancel_at_period_end: true }) })?.reason).toBe('cancel_scheduled');
    expect(applyBlock({ ...base, quote: { ...q, otherDiscounts: ['L5kbS7Pt'] } })?.reason).toBe('once_pending');
  });
});

describe('付けた後の確かめ', () => {
  const couponId = 'annual-prepay-12m';
  const applyAt = Date.parse('2026-11-21T10:00:00+09:00') / 1000;
  const annual = { id: 'di_a', end: addMonths(applyAt, 12), coupon: { id: couponId, percent_off: 100, duration: 'repeating' } };
  it('end が 12 回目と 13 回目の更新の間・継続割が残る・次回 0 円なら ok', () => {
    const v = verifyApplied({ before: [combo], after: sub({ discounts: [combo, annual] }), couponId, periodEndSec: PERIOD_END, upcomingAmountDue: 0 });
    expect(v).toMatchObject({ ok: true, problems: [] });
  });
  it('継続割が消えた・次回 0 円でない・期間がずれたら ng', () => {
    const v = verifyApplied({ before: [combo], after: sub({ discounts: [{ ...annual, end: addMonths(PERIOD_END, 12) + 1 }] }), couponId, periodEndSec: PERIOD_END, upcomingAmountDue: 1650 });
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).toMatch(/前からの割引が消えた: combo-f1-s0/);
    expect(v.problems.join('\n')).toMatch(/1650 円/);
    expect(v.problems.join('\n')).toMatch(/12 回目/);
  });
});

// ── Stripe を fetch の差し替えで再現して、API の流れを通す ──

type Call = { method: string; path: string; params: URLSearchParams; headers: Record<string, string> };
function mockStripe(state: { sub: AnnualSub; pi?: Record<string, unknown>; openInvoices?: number; upcoming?: number; coupon?: Record<string, unknown> | null }) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; body?: URLSearchParams; headers?: Record<string, string> }) => {
    const u = new URL(url);
    const path = u.pathname.replace('/v1/', '');
    const method = init.method ?? 'GET';
    const params = method === 'GET' ? u.searchParams : new URLSearchParams(init.body?.toString() ?? '');
    calls.push({ method, path, params, headers: init.headers ?? {} });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (path === 'subscriptions/sub_1' && method === 'GET') return json(state.sub);
    if (path === 'subscriptions/sub_1' && method === 'POST') {
      // 割引のスタック: 既存の discount ID は残し、coupon は新しい discount として足す
      const next: unknown[] = [];
      const cur = (state.sub.discounts ?? []) as Array<{ id: string }>;
      for (let i = 0; params.has(`discounts[${i}][discount]`) || params.has(`discounts[${i}][coupon]`); i++) {
        const did = params.get(`discounts[${i}][discount]`);
        if (did) next.push(cur.find((d) => d.id === did));
        const cid = params.get(`discounts[${i}][coupon]`);
        if (cid) next.push({ id: `di_${cid}`, end: addMonths(Math.floor(NOW / 1000), 12), coupon: { id: cid, percent_off: 100, duration: 'repeating' } });
      }
      state.sub = { ...state.sub, discounts: next as AnnualSub['discounts'] };
      return json(state.sub);
    }
    if (path === 'invoices' && method === 'GET') return json({ data: Array.from({ length: state.openInvoices ?? 0 }, (_, i) => ({ id: `in_${i}` })) });
    if (path === 'invoices/upcoming') return json({ amount_due: state.upcoming ?? 0 });
    if (path === 'tax_rates') return json({ data: [{ id: 'txr_incl', percentage: 10, inclusive: true }, { id: 'txr_10', percentage: 10, inclusive: false }] });
    if (path === 'checkout/sessions' && method === 'POST') return json({ id: `cs_${calls.length}`, url: `https://checkout.stripe.com/c/${calls.length}`, amount_total: Math.round(Number(params.get('line_items[0][price_data][unit_amount]')) * 1.1) });
    if (path.startsWith('payment_intents/')) return json(state.pi);
    if (path.startsWith('coupons/') && method === 'GET') return state.coupon ? json(state.coupon) : json({ error: { message: `No such coupon: '${path.slice(8)}'` } }, 404);
    if (path === 'coupons' && method === 'POST') return json({ id: params.get('id'), percent_off: 100, duration: 'repeating', duration_in_months: 12 });
    return json({ error: { message: `unexpected ${method} ${path}` } }, 500);
  }));
  return calls;
}

const env = { STRIPE_SECRET_KEY: 'sk_test_x', LINE_CHANNEL_ACCESS_TOKEN: 'tok', WORKER_PUBLIC_URL: 'https://w' };

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST checkout の流れ', () => {
  it('既存の顧客にひもづく Checkout を作り、台帳に 1 行書く。2 回目は同じリンクを返す（払えるリンクを 2 本にしない）', async () => {
    const { db, rows } = setup();
    const calls = mockStripe({ sub: sub() });
    const r = await createAnnualCheckout(db, env, { lineUserId: 'U1', nowMs: NOW });
    expect(r).toMatchObject({ ok: true, reused: false, monthly: 8980, annual: 89800, amountTotal: 98780, subscriptionId: 'sub_1' });
    const cs = calls.find((c) => c.path === 'checkout/sessions')!;
    expect(cs.params.get('customer')).toBe('cus_1');
    expect(cs.params.get('line_items[0][tax_rates][0]')).toBe('txr_10');
    expect(cs.params.get('expires_at')).toBe(String(NOW / 1000 + 86400));
    expect(cs.headers['Idempotency-Key']).toMatch(/^annual-checkout-ap_/);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ line_user_id: 'U1', stripe_customer_id: 'cus_1', subscription_id: 'sub_1', annual_excl_tax: 89800, price_months: 10, reply_at: null, amount_total: 98780 });

    const again = await createAnnualCheckout(db, env, { lineUserId: 'U1', nowMs: NOW + 60_000 });
    expect(again).toMatchObject({ ok: true, reused: true, url: (r as { url: string }).url });
    expect(calls.filter((c) => c.path === 'checkout/sessions')).toHaveLength(1);
  });

  it('入金済みの定期契約・支払い遅れ・未払いの請求書がある人には出さない（Stripe に Checkout を作らない）', async () => {
    const { db, sqlite } = setup();
    sqlite.prepare("INSERT INTO furim_annual_prepay (id, line_user_id, stripe_customer_id, subscription_id, monthly_excl_tax, annual_excl_tax, created_at, paid_at) VALUES ('ap_old', 'U1', 'cus_1', 'sub_1', 8980, 89800, 'x', 'y')").run();
    let calls = mockStripe({ sub: sub() });
    expect(await createAnnualCheckout(db, env, { lineUserId: 'U1', nowMs: NOW })).toMatchObject({ ok: false, reason: 'already_paid' });
    expect(calls.some((c) => c.path === 'checkout/sessions')).toBe(false);

    const s2 = setup();
    calls = mockStripe({ sub: sub({ status: 'past_due' }) });
    expect(await createAnnualCheckout(s2.db, env, { lineUserId: 'U1', nowMs: NOW })).toMatchObject({ ok: false, reason: 'not_active' });
    calls = mockStripe({ sub: sub(), openInvoices: 1 });
    expect(await createAnnualCheckout(s2.db, env, { lineUserId: 'U1', nowMs: NOW })).toMatchObject({ ok: false, reason: 'open_invoice' });
    expect(calls.some((c) => c.path === 'checkout/sessions')).toBe(false);
  });

  it('「年払い」の返信が 11/27 19:00 より前なら、発行が 11/28 でも ×10（返信の日時は messages_log の最初の 1 件）', async () => {
    const { db, sqlite, rows } = setup();
    const log = sqlite.prepare("INSERT INTO messages_log VALUES (?, 'f1', ?, 'text', ?, ?)");
    log.run('m0', 'outgoing', '年払いのご案内', '2026-11-21T09:00:00.000+09:00');
    log.run('m1', 'incoming', '年払い', '2026-11-27T18:30:00.000+09:00');
    log.run('m2', 'incoming', '年払いの内容に同意して申し込みます', '2026-11-28T09:00:00.000+09:00');
    const calls = mockStripe({ sub: sub() });
    const now = Date.parse('2026-11-28T10:00:00+09:00');
    const r = await createAnnualCheckout(db, env, { lineUserId: 'U1', nowMs: now });
    expect(r).toMatchObject({ ok: true, kind: 'sale', priceMonths: 10, replyAt: '2026-11-27T18:30:00.000+09:00', annual: 89800 });
    expect(calls.find((c) => c.path === 'checkout/sessions')!.params.get('expires_at')).toBe(String(now / 1000 + 86400));
    expect(rows()[0]).toMatchObject({ price_months: 10, reply_at: '2026-11-27T18:30:00.000+09:00' });
  });

  it('返信が 11/27 19:00 以降なら常設の ×11（期限は 24 時間・12/1 を過ぎても出す）', async () => {
    const { db, sqlite, rows } = setup();
    sqlite.prepare("INSERT INTO messages_log VALUES ('m1', 'f1', 'incoming', 'text', '年払いでお願いします', '2026-11-27T19:00:00.000+09:00')").run();
    const calls = mockStripe({ sub: sub() });
    const r = await createAnnualCheckout(db, env, { lineUserId: 'U1', nowMs: NOW });
    expect(r).toMatchObject({ ok: true, kind: 'standard', priceMonths: 11, monthly: 8980, annual: 98780, amountTotal: 108658 });
    expect(rows()[0]).toMatchObject({ price_months: 11, annual_excl_tax: 98780 });

    const s2 = setup();
    const dec = Date.parse('2026-12-03T10:00:00+09:00');
    const r2 = await createAnnualCheckout(s2.db, env, { lineUserId: 'U1', nowMs: dec });
    expect(r2).toMatchObject({ ok: true, kind: 'standard', priceMonths: 11, replyAt: null });
    expect(calls.filter((c) => c.path === 'checkout/sessions').at(-1)!.params.get('expires_at')).toBe(String(dec / 1000 + 86400));
  });

  it('×10 の未払いリンクがあっても、×11 に変わったら同じリンクは返さない（金額の違うリンクを返さない）', async () => {
    const { db } = setup();
    const calls = mockStripe({ sub: sub() });
    await createAnnualCheckout(db, env, { lineUserId: 'U1', nowMs: Date.parse('2026-11-27T18:00:00+09:00') });
    const r = await createAnnualCheckout(db, env, { lineUserId: 'U1', nowMs: Date.parse('2026-11-27T19:30:00+09:00') });
    expect(r).toMatchObject({ ok: true, reused: false, priceMonths: 11 });
    expect(calls.filter((c) => c.path === 'checkout/sessions')).toHaveLength(2);
  });

  it('顧客マスターの契約と別の顧客の定期契約を指定されたら止める', async () => {
    const { db } = setup();
    mockStripe({ sub: sub({ customer: 'cus_other' }) });
    expect(await createAnnualCheckout(db, env, { lineUserId: 'U1', nowMs: NOW })).toMatchObject({ ok: false, reason: 'customer_mismatch' });
  });
});

describe('POST apply の流れ', () => {
  async function paid() {
    const s = setup();
    const state: Parameters<typeof mockStripe>[0] = { sub: sub() };
    const calls = mockStripe(state);
    const r = (await createAnnualCheckout(s.db, env, { lineUserId: 'U1', nowMs: NOW })) as { annualPrepayId: string };
    state.pi = {
      id: 'pi_1', status: 'succeeded', amount: 98780, amount_received: 98780, customer: 'cus_1',
      metadata: { purchaseType: 'annual_prepay', annualPrepayId: r.annualPrepayId, lineUserId: 'U1', subscriptionId: 'sub_1', monthlyExclTax: '8980', annualExclTax: '89800' },
    };
    return { ...s, state, calls };
  }

  it('継続割を残したまま年払いクーポンを足す（coupon= で付けない）。次回 0 円を確かめて台帳に記録する', async () => {
    const { db, rows, calls, state } = await paid();
    const r = await applyAnnualCoupon(db, env, { lineUserId: 'U1', paymentIntentId: 'pi_1' });
    expect(r).toMatchObject({ ok: true, alreadyApplied: false, discountId: 'di_annual-prepay-12m', firstFreeRenewalAt: '2026-12-05T10:00:00.000+09:00', upcomingAmountDue: 0 });
    const post = calls.find((c) => c.method === 'POST' && c.path === 'subscriptions/sub_1')!;
    expect(post.params.get('discounts[0][discount]')).toBe('di_combo');
    expect(post.params.get('discounts[1][coupon]')).toBe('annual-prepay-12m');
    expect(post.params.has('coupon')).toBe(false);
    expect(post.headers['Stripe-Version']).toBe('2026-05-27.dahlia');
    expect(post.headers['Idempotency-Key']).toBe('annual-apply-pi_1');
    expect((state.sub.discounts as Array<{ id: string }>).map((d) => d.id)).toEqual(['di_combo', 'di_annual-prepay-12m']);
    expect(rows()[0]).toMatchObject({ payment_intent_id: 'pi_1', amount_paid: 98780, discount_id: 'di_annual-prepay-12m', first_free_renewal_at: '2026-12-05T10:00:00.000+09:00' });
    expect(rows()[0].applied_at).toBeTruthy();
  });

  it('同じ PaymentIntent で 2 回目を呼んでも付けない（Stripe に書き込まない）', async () => {
    const { db, calls } = await paid();
    await applyAnnualCoupon(db, env, { lineUserId: 'U1', paymentIntentId: 'pi_1' });
    const before = calls.filter((c) => c.method === 'POST').length;
    expect(await applyAnnualCoupon(db, env, { lineUserId: 'U1', paymentIntentId: 'pi_1' })).toMatchObject({ ok: true, alreadyApplied: true });
    expect(calls.filter((c) => c.method === 'POST').length).toBe(before);
  });

  it('Stripe には付いたが台帳の記録の前に落ちたときは、付け直さずに確かめ直して記録する', async () => {
    const { db, rows, calls, state } = await paid();
    state.sub = { ...state.sub, discounts: [combo, { id: 'di_prev', end: addMonths(Math.floor(NOW / 1000), 12), coupon: { id: 'annual-prepay-12m', percent_off: 100, duration: 'repeating' } }] };
    const before = calls.filter((c) => c.method === 'POST').length;
    expect(await applyAnnualCoupon(db, env, { lineUserId: 'U1', paymentIntentId: 'pi_1' })).toMatchObject({ ok: true, alreadyApplied: true, discountId: 'di_prev' });
    expect(calls.filter((c) => c.method === 'POST').length).toBe(before);
    expect(rows()[0].applied_at).toBeTruthy();
  });

  it('未入金・金額違いは付けない。付けた後に次回 0 円でなければ ng を返し applied にしない', async () => {
    let s = await paid();
    s.state.pi = { ...s.state.pi, status: 'requires_payment_method' };
    expect(await applyAnnualCoupon(s.db, env, { lineUserId: 'U1', paymentIntentId: 'pi_1' })).toMatchObject({ ok: false, reason: 'not_paid' });
    s.state.pi = { ...s.state.pi, status: 'succeeded', amount_received: 50000 };
    expect(await applyAnnualCoupon(s.db, env, { lineUserId: 'U1', paymentIntentId: 'pi_1' })).toMatchObject({ ok: false, reason: 'amount_mismatch' });
    expect(s.calls.some((c) => c.method === 'POST' && c.path === 'subscriptions/sub_1')).toBe(false);

    s = await paid();
    s.state.upcoming = 9878;
    const r = await applyAnnualCoupon(s.db, env, { lineUserId: 'U1', paymentIntentId: 'pi_1' });
    expect(r).toMatchObject({ ok: false, reason: 'verify_failed' });
    expect(s.rows()[0].applied_at).toBeNull();
    expect(String(s.rows()[0].apply_error)).toMatch(/9878/);
  });

  it('once の割引が残っている人は次回の更新が終わるまで付けない', async () => {
    const s = await paid();
    s.state.sub = { ...s.state.sub, discounts: [combo, { id: 'di_once', coupon: { id: 'L5kbS7Pt', amount_off: 1000, duration: 'once' } }] };
    expect(await applyAnnualCoupon(s.db, env, { lineUserId: 'U1', paymentIntentId: 'pi_1' })).toMatchObject({ ok: false, reason: 'once_pending' });
  });
});

describe('webhook の記録（payment_intent.succeeded）', () => {
  const meta = { purchaseType: 'annual_prepay', lineUserId: 'U1', subscriptionId: 'sub_1', monthlyExclTax: '8980', annualExclTax: '89800' };
  it('発行の記録がある行を入金済みにしてスタッフに 1 回だけ知らせる（再送では知らせない）', async () => {
    const { db, sqlite, rows } = setup();
    sqlite.prepare("INSERT INTO furim_annual_prepay (id, line_user_id, stripe_customer_id, subscription_id, monthly_excl_tax, annual_excl_tax, created_at) VALUES ('ap_1', 'U1', 'cus_1', 'sub_1', 8980, 89800, 'x')").run();
    const input = { eventId: 'evt_1', paymentIntentId: 'pi_1', amount: 98780, customer: 'cus_1', metadata: { ...meta, annualPrepayId: 'ap_1' } };
    expect(await recordAnnualPayment(db, env, input)).toEqual({ recorded: true });
    expect(rows()[0]).toMatchObject({ id: 'ap_1', payment_intent_id: 'pi_1', amount_paid: 98780, stripe_event_id: 'evt_1', applied_at: null });
    expect(pushMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(pushMessage.mock.calls[0][1])).toContain('テスト太郎');
    expect(await recordAnnualPayment(db, env, input)).toEqual({ recorded: false });
    expect(pushMessage).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
  });

  it('API を通さずに作った Checkout でも metadata から 1 行起こす', async () => {
    const { db, rows } = setup();
    await recordAnnualPayment(db, env, { eventId: 'evt_2', paymentIntentId: 'pi_2', amount: 98780, customer: 'cus_1', metadata: meta });
    expect(rows()[0]).toMatchObject({ id: 'pi:pi_2', line_user_id: 'U1', subscription_id: 'sub_1', annual_excl_tax: 89800, price_months: null, paid_at: '2026-11-21T10:00:00.000+09:00' });
  });

  it('常設（×11）の入金は通知に「×11 常設」と出す', async () => {
    const { db, rows } = setup();
    await recordAnnualPayment(db, env, { eventId: 'evt_3', paymentIntentId: 'pi_3', amount: 108658, customer: 'cus_1', metadata: { ...meta, annualExclTax: '98780', priceMonths: '11' } });
    expect(rows()[0]).toMatchObject({ price_months: 11 });
    expect(JSON.stringify(pushMessage.mock.calls[0][1])).toContain('月額×11 常設');
  });
});

describe('年払いクーポン', () => {
  it('dryRun では作らない・無ければ 100%・repeating・12 か月で作る・あれば作らない', async () => {
    let calls = mockStripe({ sub: sub(), coupon: null });
    expect(await ensureAnnualCoupon(env, true)).toEqual({ status: 'would-create' });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect((await ensureAnnualCoupon(env, false)).status).toBe('created');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(Object.fromEntries(post.params)).toMatchObject({ id: 'annual-prepay-12m', percent_off: '100', duration: 'repeating', duration_in_months: '12' });

    calls = mockStripe({ sub: sub(), coupon: { id: 'annual-prepay-12m', percent_off: 100, duration: 'repeating', duration_in_months: 12 } });
    expect((await ensureAnnualCoupon(env, false)).status).toBe('existing');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
