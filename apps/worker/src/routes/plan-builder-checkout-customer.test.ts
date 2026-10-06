import { afterEach, describe, expect, it, vi } from 'vitest';
import { sheetMasterRows, type MasterRow } from '../furim/__fixtures__/master-fixture.js';
import { createPlanBuilderCheckout } from './plan-builder.js';

// プランビルダーの Checkout が既存の Stripe 顧客に紐づくこと（TB-949）。
// DB を渡していなかったため furim_customers を見られず、friends.metadata に無い人は新しい顧客ができていた

function makeDb(rows: MasterRow[], opts: { furimCustomerId?: string | null; friendMeta?: string }) {
  const db = {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async first() {
          if (/FROM furim_customers WHERE line_user_id/.test(sql)) {
            return opts.furimCustomerId ? { line_user_id: 'U1', stripe_customer_id: opts.furimCustomerId } : null;
          }
          if (/FROM friends WHERE line_user_id/.test(sql)) return { metadata: opts.friendMeta ?? '{}' };
          return null;
        },
        async all() {
          if (/FROM furim_master WHERE active = 1 AND kind IN \('feature', 'package'\)/.test(sql)) {
            return { results: rows.filter((r) => r.active === 1 && (r.kind === 'feature' || r.kind === 'package')).map((r) => ({ kind: r.kind, key: r.key, payload: r.payload })) };
          }
          return { results: [] };
        },
        async run() { return { meta: { changes: 1 } }; },
      };
    },
  };
  return db as unknown as D1Database;
}

function mockStripe(customer: Record<string, unknown> | 'error') {
  const sessions: URLSearchParams[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body?: URLSearchParams }) => {
    const path = new URL(url).pathname.replace('/v1/', '');
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (path === 'tax_rates') return json({ data: [{ id: 'txr_1', percentage: 10, inclusive: false }] });
    if (path.startsWith('coupons/')) return json({ id: path.slice(8), valid: true });
    if (path.startsWith('customers/')) return customer === 'error' ? json({ error: { message: 'boom' } }, 500) : json(customer);
    if (path === 'checkout/sessions') {
      sessions.push(new URLSearchParams(init.body));
      return json({ url: 'https://checkout.stripe.com/c/pay/cs_test' });
    }
    return json({ error: { message: `unexpected ${path}` } }, 404);
  }));
  return sessions;
}

const env = (db: D1Database, gas?: string) => ({ STRIPE_SECRET_KEY: 'sk_test', WORKER_PUBLIC_URL: 'https://w', DB: db, GAS_DEPLOY_ID: gas });

afterEach(() => vi.unstubAllGlobals());

describe('プランビルダーの Checkout を既存の Stripe 顧客で開く（TB-949）', () => {
  it('friends.metadata に無くても furim_customers の顧客で開く', async () => {
    const sessions = mockStripe({ id: 'cus_FC' });
    await createPlanBuilderCheckout(env(makeDb(sheetMasterRows(), { furimCustomerId: 'cus_FC' }), 'gas'), { packages: ['m_full'], lineUserId: 'U1' });
    expect(sessions[0].get('customer')).toBe('cus_FC');
  });

  it('GAS_DEPLOY_ID が無くても既存顧客で開く', async () => {
    const sessions = mockStripe({ id: 'cus_FC' });
    await createPlanBuilderCheckout(env(makeDb(sheetMasterRows(), { furimCustomerId: 'cus_FC' })), { packages: ['m_full'], lineUserId: 'U1' });
    expect(sessions[0].get('customer')).toBe('cus_FC');
  });

  it('Stripe の顧客取得が落ちても顧客は外さない', async () => {
    const sessions = mockStripe('error');
    await createPlanBuilderCheckout(env(makeDb(sheetMasterRows(), { furimCustomerId: 'cus_FC' }), 'gas'), { packages: ['m_full'], lineUserId: 'U1' });
    expect(sessions[0].get('customer')).toBe('cus_FC');
  });

  it('furim_customers に無ければ friends.metadata の顧客で開く', async () => {
    const sessions = mockStripe({ id: 'cus_META' });
    await createPlanBuilderCheckout(env(makeDb(sheetMasterRows(), { friendMeta: '{"stripeCustomerId":"cus_META"}' }), 'gas'), { packages: ['m_full'], lineUserId: 'U1' });
    expect(sessions[0].get('customer')).toBe('cus_META');
  });

  it('furim_customers の顧客に付いた顧客クーポンを効かせ、併用割引は metadata に退避する', async () => {
    const sessions = mockStripe({ id: 'cus_FC', discount: { coupon: { name: '50%', percent_off: null } } });
    await createPlanBuilderCheckout(env(makeDb(sheetMasterRows(), { furimCustomerId: 'cus_FC' }), 'gas'), { packages: ['m_full', 'm_semi'], lineUserId: 'U1' });
    const s = sessions[0];
    expect(s.get('customer')).toBe('cus_FC');
    expect(s.get('discounts[0][coupon]')).toBeNull();
    expect(s.get('subscription_data[metadata][pendingComboCoupon]')).toBeTruthy();
  });
});
