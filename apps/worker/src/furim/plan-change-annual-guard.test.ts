import { afterEach, describe, expect, it, vi } from 'vitest';
import { sheetMasterRows } from './__fixtures__/master-fixture.js';
import { handlePlanChangeMessage } from './plan-change.js';

// 年払い中（TB-3929）の定期契約はプラン変更を受けない。今のコードは forever 以外の割引を一度外して付け直すため、
// 年払いクーポン（repeating）だと 12 か月が数え直しになり、付け直しに失敗すると翌月から月払いが復活する

function makeDb() {
  const updates: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...a: unknown[]) { args = a; return this; },
        async first() {
          if (/FROM plan_builder_intents WHERE id = \? AND line_user_id/.test(sql)) {
            return {
              payload: JSON.stringify({ type: 'change', kind: 'upgrade', subscriptionId: 'sub_1', prorationDate: 1767000000, amountDueNow: 1000, packages: ['m_full'], features: [], multiChannelSites: [], total: 5980 }),
              used_at: null,
              created_at: 'x',
            };
          }
          if (/SELECT stage FROM plan_builder_intents/.test(sql)) return { stage: 'loaded' };
          return null;
        },
        async all() {
          if (/FROM furim_master WHERE active = 1 AND kind IN \('feature', 'package'\)/.test(sql)) {
            return { results: sheetMasterRows().filter((r) => r.active === 1 && (r.kind === 'feature' || r.kind === 'package')).map((r) => ({ kind: r.kind, key: r.key, payload: r.payload })) };
          }
          return { results: [] };
        },
        async run() {
          updates.push({ sql, args });
          return { meta: { changes: 1 } };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, updates };
}

function mockStripe(discounts: Array<{ id: string; coupon: { id: string; duration: string } }>) {
  const posts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    const u = new URL(url);
    const path = u.pathname.replace('/v1/', '');
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if ((init?.method ?? 'GET') === 'POST') posts.push(path);
    if (path === 'subscriptions/sub_1') {
      return json({ id: 'sub_1', status: 'active', customer: 'cus_1', current_period_end: 1767193200, metadata: { source: 'plan-builder' }, items: { data: [{ id: 'si_1', price: { id: 'price_semi' }, quantity: 1 }] }, discounts });
    }
    if (path.startsWith('coupons/')) return json({ id: path.slice(8), valid: true });
    return json({});
  }));
  return posts;
}

afterEach(() => vi.unstubAllGlobals());

describe('プラン変更のガード（年払い中）', () => {
  it('年払いクーポンが付いていたら Stripe を書き換えず「担当が承ります」と返し、intent を使わずに残す', async () => {
    const posts = mockStripe([
      { id: 'di_combo', coupon: { id: 'combo-f1-s0', duration: 'forever' } },
      { id: 'di_ap', coupon: { id: 'annual-prepay-12m', duration: 'repeating' } },
    ]);
    const { db, updates } = makeDb();
    const replies: Array<Array<{ text?: string }>> = [];
    const pushes: Array<{ to: string; msgs: Array<{ text?: string }> }> = [];
    const lineClient = {
      replyMessage: async (_t: string, msgs: Array<{ text?: string }>) => { replies.push(msgs); },
      pushMessage: async (to: string, msgs: Array<{ text?: string }>) => { pushes.push({ to, msgs }); },
    };

    await handlePlanChangeMessage(db, lineClient as never, 'U1', 'rt', '【プラン変更】PB-ABC123', { STRIPE_SECRET_KEY: 'sk_test', DB: db });

    expect(posts).toEqual([]);
    expect(replies[0][0].text).toContain('年払いプランの期間中');
    expect(replies[0][0].text).toContain('担当者が承ります');
    expect(pushes[0].msgs[0].text).toContain('年払い中の人からプラン変更の申込');
    expect(updates.some((u) => /SET used_at/.test(u.sql))).toBe(false);
    expect(updates.some((u) => u.args[0] === 'blocked_annual_prepay')).toBe(true);
  });

  it('年払いでなければ今までどおり定期契約を書き換える', async () => {
    const posts = mockStripe([{ id: 'di_combo', coupon: { id: 'combo-f1-s0', duration: 'forever' } }]);
    const { db } = makeDb();
    const lineClient = { replyMessage: async () => {}, pushMessage: async () => {} };

    await handlePlanChangeMessage(db, lineClient as never, 'U1', 'rt', '【プラン変更】PB-ABC123', { STRIPE_SECRET_KEY: 'sk_test', DB: db });

    expect(posts).toContain('subscriptions/sub_1');
  });
});
