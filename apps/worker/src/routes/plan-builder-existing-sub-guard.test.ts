import { afterEach, describe, expect, it, vi } from 'vitest';
import { sheetMasterRows } from '../furim/__fixtures__/master-fixture.js';
import { handlePlanApplyMessage } from '../furim/plan-apply.js';
import { planBuilder } from './plan-builder.js';

// 既存会員が新規の決済に進めてしまう経路を塞ぐ（TB-1028・根拠は TB-1025 の 5 節）。
// 1. 支払い失敗中（past_due）は active でないため既存会員と判定されず、新規の決済 URL が届いていた
// 2. LINE 外で開くと /plan-builder/checkout が既存サブスクを確かめずに新規 Checkout を作っていた
// 3. 旧プラン会員（metadata source が plan-builder でない）は今の契約が読めないまま下げる変更に進めていた

function makeDb() {
  const inserts: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...a: unknown[]) { args = a; return this; },
        async first() {
          if (/FROM furim_customers WHERE line_user_id/.test(sql)) return { line_user_id: 'U1', stripe_customer_id: 'cus_1' };
          if (/FROM friends WHERE line_user_id/.test(sql)) return { metadata: '{}' };
          if (/FROM plan_builder_intents/.test(sql)) return { payload: JSON.stringify({ packages: ['m_semi'], features: [], multiChannelSites: [] }) };
          return null;
        },
        async all() {
          if (/FROM furim_master WHERE active = 1 AND kind IN \('feature', 'package'\)/.test(sql)) {
            return { results: sheetMasterRows().filter((r) => r.active === 1 && (r.kind === 'feature' || r.kind === 'package')).map((r) => ({ kind: r.kind, key: r.key, payload: r.payload })) };
          }
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO plan_builder_intents/.test(sql)) inserts.push(args);
          return { meta: { changes: 1 } };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, inserts };
}

function sub(status: string, metadata: Record<string, string> = { source: 'plan-builder', packages: 'm_semi', features: '', multiChannelSites: '' }) {
  return {
    id: `sub_${status}`,
    status,
    customer: 'cus_1',
    current_period_end: 1767193200,
    metadata,
    items: { data: [{ id: 'si_1', price: { unit_amount: 5980 }, quantity: 1 }] },
  };
}

function mockStripe(subs: Array<Record<string, unknown>> | 'error') {
  const sessions: URLSearchParams[] = [];
  const listQueries: URLSearchParams[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body?: URLSearchParams }) => {
    const u = new URL(url);
    const path = u.pathname.replace('/v1/', '');
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (path === 'subscriptions') {
      listQueries.push(u.searchParams);
      return subs === 'error' ? json({ error: { message: 'boom' } }, 500) : json({ data: subs });
    }
    if (path.startsWith('subscriptions/')) return json({ discounts: [] });
    if (path === 'invoices/upcoming') return json({ amount_due: 1234 });
    if (path === 'tax_rates') return json({ data: [{ id: 'txr_1', percentage: 10, inclusive: false }] });
    if (path.startsWith('coupons/')) return json({ id: path.slice(8), valid: true });
    if (path.startsWith('customers/')) return json({ id: 'cus_1' });
    if (path === 'checkout/sessions') {
      sessions.push(new URLSearchParams(init.body));
      return json({ url: 'https://checkout.stripe.com/c/pay/cs_test' });
    }
    return json({ error: { message: `unexpected ${path}` } }, 404);
  }));
  return { sessions, listQueries };
}

const env = (db: D1Database) => ({ STRIPE_SECRET_KEY: 'sk_test', WORKER_PUBLIC_URL: 'https://w', DB: db });

async function post(path: string, body: unknown, db: D1Database) {
  const res = await planBuilder.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env(db));
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}

async function getCurrent(db: D1Database) {
  const res = await planBuilder.request('/plan-builder/current?lineUserId=U1', {}, env(db));
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}

const selection = { packages: ['m_full'], features: [], multiChannelSites: [], lineUserId: 'U1' };

afterEach(() => vi.unstubAllGlobals());

describe('支払い失敗中の会員に新しいサブスクを作らない（TB-1028 の 1）', () => {
  it.each(['past_due', 'unpaid'])('%s: 申込コードを出さず、カード更新へ案内する', async (status) => {
    const { sessions, listQueries } = mockStripe([sub(status)]);
    const { db, inserts } = makeDb();

    const { status: code, data } = await post('/plan-builder/intent', selection, db);

    expect(code).toBe(409);
    expect(data.blocked).toBe('payment');
    expect(data.error).toContain('月額会員ページ');
    expect(inserts).toHaveLength(0);
    expect(sessions).toHaveLength(0);
    // active だけでなく全状態を読む
    expect(listQueries[0].get('status')).toBe('all');
  });

  it('trialing など active 以外の有効サブスクも有人へ回す', async () => {
    mockStripe([sub('trialing')]);
    const { db, inserts } = makeDb();

    const { status, data } = await post('/plan-builder/intent', selection, db);

    expect(status).toBe(409);
    expect(data.blocked).toBe('status');
    expect(inserts).toHaveLength(0);
  });

  it('画面を開いた時点で理由を返す（今の契約は読み込まない）', async () => {
    mockStripe([sub('past_due')]);
    const { data } = await getCurrent(makeDb().db);

    expect(data.hasSubscription).toBe(true);
    expect(data.blocked).toBe('payment');
    expect(data.blockedMessage).toContain('月額会員ページ');
    expect(data.packages).toBeUndefined();
  });

  it('古い申込コードが届いても Checkout を作らない（plan-apply）', async () => {
    const { sessions } = mockStripe([sub('past_due')]);
    const { db } = makeDb();
    const replies: Array<Array<{ text?: string }>> = [];
    const lineClient = { replyMessage: async (_t: string, msgs: Array<{ text?: string }>) => { replies.push(msgs); } };

    await handlePlanApplyMessage(db, lineClient as never, 'U1', 'rt', '【プラン申し込み】PB-ABC123', env(db) as never);

    expect(sessions).toHaveLength(0);
    expect(replies[0][0].text).toContain('月額会員ページ');
  });
});

describe('LINE 外の /plan-builder/checkout でも既存サブスクを確かめる（TB-1028 の 2）', () => {
  it.each(['active', 'past_due'])('%s のサブスクがあれば新規 Checkout を作らない', async (status) => {
    const { sessions } = mockStripe([sub(status)]);

    const { status: code, data } = await post('/plan-builder/checkout', selection, makeDb().db);

    expect(code).toBe(409);
    expect(data.success).toBe(false);
    expect(data.error).toBeTruthy();
    expect(sessions).toHaveLength(0);
  });

  it('解約済みのサブスクしか無い人は今までどおり新規 Checkout を作る', async () => {
    const { sessions } = mockStripe([sub('canceled'), sub('incomplete_expired')]);

    const { status, data } = await post('/plan-builder/checkout', selection, makeDb().db);

    expect(status).toBe(200);
    expect(data.url).toContain('checkout.stripe.com');
    expect(sessions).toHaveLength(1);
  });

  it('Stripe を読めなければ新規 Checkout に倒さない', async () => {
    const { sessions } = mockStripe('error');

    const { status } = await post('/plan-builder/checkout', selection, makeDb().db);

    expect(status).toBe(500);
    expect(sessions).toHaveLength(0);
  });
});

describe('旧プラン会員を下げる変更に進めない（TB-1028 の 3）', () => {
  const legacy = () => sub('active', { plan: 'old' });

  it('画面には「読み込めない」理由を返し、今の契約を読み込んだことにしない', async () => {
    mockStripe([legacy()]);
    const { data } = await getCurrent(makeDb().db);

    expect(data.blocked).toBe('legacy');
    expect(data.blockedMessage).toContain('読み込めない');
    expect(data.packages).toBeUndefined();
  });

  it('申込コードを出さない（プラン変更 intent を作らない）', async () => {
    mockStripe([legacy()]);
    const { db, inserts } = makeDb();

    const { status, data } = await post('/plan-builder/intent', { ...selection, packages: ['m_semi'] }, db);

    expect(status).toBe(409);
    expect(data.blocked).toBe('legacy');
    expect(inserts).toHaveLength(0);
  });
});

describe('新規の申し込みと、プラン診断の会員の変更は今と同じに動く', () => {
  it('サブスクが無い人は【プラン申し込み】コードが出る', async () => {
    mockStripe([]);
    const { db, inserts } = makeDb();

    const { status, data } = await post('/plan-builder/intent', selection, db);

    expect(status).toBe(200);
    expect(data.message).toContain('【プラン申し込み】');
    expect(data.change).toBeUndefined();
    expect(inserts).toHaveLength(1);
  });

  it('プラン診断の会員が上げる変更をすると【プラン変更】になり、差額が出る', async () => {
    mockStripe([sub('canceled'), sub('active')]);
    const { db, inserts } = makeDb();

    const { status, data } = await post('/plan-builder/intent', selection, db);

    expect(status).toBe(200);
    expect(data.message).toContain('【プラン変更】');
    expect(data.change.kind).toBe('upgrade');
    expect(data.change.amountDueNow).toBe(1234);
    expect(JSON.parse(String(inserts[0][2])).subscriptionId).toBe('sub_active');
  });

  it('プラン診断の会員が下げる変更をすると予約になる', async () => {
    mockStripe([{ ...sub('active'), items: { data: [{ id: 'si_1', price: { unit_amount: 8980 }, quantity: 1 }] }, metadata: { source: 'plan-builder', packages: 'm_full', features: '', multiChannelSites: '' } }]);
    const { db } = makeDb();

    const { status, data } = await post('/plan-builder/intent', { ...selection, packages: ['m_semi'] }, db);

    expect(status).toBe(200);
    expect(data.change.kind).toBe('downgrade');
  });

  it('プラン診断の会員は画面に今の契約が読み込まれる', async () => {
    mockStripe([sub('active')]);
    const { data } = await getCurrent(makeDb().db);

    expect(data.blocked).toBeUndefined();
    expect(data.isPlanBuilder).toBe(true);
    expect(data.packages).toEqual(['m_semi']);
  });
});
