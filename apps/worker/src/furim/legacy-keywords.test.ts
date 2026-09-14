import { describe, it, expect, vi } from 'vitest';

vi.mock('./gas-client.js', () => ({ gasGet: vi.fn(), gasPost: vi.fn(), getGasErrorFromResponse: () => null }));

const { planFeaturesToFlags, buildLegacyCheckoutUrl, applyTrialCampaign } = await import('./legacy-keywords.js');

type Write = { sql: string; args: unknown[] };

function makeDb(opts: { customer?: Record<string, unknown> | null; plans?: Record<string, Record<string, unknown>> } = {}) {
  const writes: Write[] = [];
  const plans = opts.plans ?? {};
  const db = {
    prepare(sql: string) {
      const make = (args: unknown[]) => ({
        sql,
        args,
        run: async () => { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
        first: async () => {
          if (/FROM furim_master WHERE kind = 'plan'/.test(sql)) { const p = plans[String(args[0])]; return p ? { payload: JSON.stringify(p) } : null; }
          if (/FROM furim_customers WHERE line_user_id/.test(sql)) return opts.customer === undefined ? null : opts.customer;
          return null;
        },
        all: async () => ({ results: [] }),
      });
      return { bind: (...args: unknown[]) => make(args), ...make([]) };
    },
    async batch(stmts: Array<{ sql: string; args: unknown[] }>) {
      for (const s of stmts) writes.push({ sql: s.sql, args: s.args });
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  } as unknown as D1Database;
  return { db, writes };
}

const AFTER_PROMO = Date.parse('2026-10-01T00:00:00+09:00');
const TRIAL_PLAN = { 'プラン名': '友達登録2週間トライアルプラン', PriceID: 'なし', 'キーコード接頭語': '2weektrial_', features: { mChangePrice: true, rRelist: false, AutoMultiChannel: '' } };

describe('planFeaturesToFlags', () => {
  it('プラン一覧の features を 1/0 にし、コピー出品は常に 1・AutoMultiChannel は文字列', () => {
    expect(planFeaturesToFlags(TRIAL_PLAN.features, AFTER_PROMO)).toMatchObject({ mChangePrice: '1', rRelist: '0', AutoMultiChannel: '', mCopyRakumaListing: '1' });
  });
});

describe('buildLegacyCheckoutUrl（登録URL発行）', () => {
  it('プランの PriceID・Stripe顧客ID・1 時間の期限・env を付けた LIFF URL', async () => {
    const { db } = makeDb({ plans: { 'メルカリ 基本プラン': { PriceID: 'price_123' } } });
    const url = await buildLegacyCheckoutUrl(db, { liffUrl: 'https://liff.line.me/1-x', isDev: false, lineUserId: 'U1', planName: 'メルカリ 基本プラン', stripeCustomerId: 'cus_1', nowMs: 1_000_000 });
    expect(url).toBe('https://liff.line.me/1-x?price_id=price_123&customer_id=cus_1&expired=4600000&env=prod');
  });

  it('プランが無い・PriceID が空なら null', async () => {
    const { db } = makeDb({ plans: { 'x': { PriceID: '' } } });
    expect(await buildLegacyCheckoutUrl(db, { liffUrl: 'l', isDev: true, lineUserId: 'U1', planName: 'x', stripeCustomerId: null })).toBeNull();
    expect(await buildLegacyCheckoutUrl(db, { liffUrl: 'l', isDev: true, lineUserId: 'U1', planName: 'nope', stripeCustomerId: null })).toBeNull();
  });
});

describe('applyTrialCampaign（無料お試し1週間）', () => {
  const now = Date.parse('2026-09-14T12:00:00+09:00');

  it('登録日時が期限日より後なら対象外', async () => {
    const { db } = makeDb({ customer: { line_user_id: 'U1', key_code: null, subscription_start_at: '2026-09-10 10:00:00' } });
    const r = await applyTrialCampaign(db, undefined, 'U1', '20260901', now);
    expect(r).toEqual({ success: false, message: '既にご登録済みの方のみ対象となります' });
  });

  it('試用キーコード以外なら発行して端末判定クリア・試用プランのフラグを書き、期限は 14 日後', async () => {
    const { db, writes } = makeDb({ customer: { line_user_id: 'U1', key_code: 'pb_old', subscription_start_at: '2026-08-01 10:00:00' }, plans: { '友達登録2週間トライアルプラン': TRIAL_PLAN } });
    const r = await applyTrialCampaign(db, undefined, 'U1', '20260930', now);
    if (!r.success) throw new Error('expected success');
    expect(r.keyCode).toMatch(/^2weektrial_[0-9a-z]{8}$/);
    expect(r.reissued).toBe(true);
    expect(r.startAt).toBe('2026-09-14 12:00:00');
    expect(r.endAt).toBe('2026-09-28 12:00:00');
    expect(r.mirror).toEqual({ 'サブスク登録日時': '2026-09-14 12:00:00', 'サブスク終了日時': '2026-09-28 12:00:00', 'キーコード': r.keyCode, '端末判定文字列': '' });
    expect(r.flags?.mChangePrice).toBe('1');
    const upsert = writes.find((w) => /INSERT INTO furim_customers/.test(w.sql));
    expect(upsert?.sql).toMatch(/device_code = excluded.device_code/);
    expect(writes.some((w) => /INSERT INTO furim_feature_flags/.test(w.sql))).toBe(true);
  });

  it('既に試用キーコードなら据え置き（期限だけ更新・フラグは触らない）', async () => {
    const { db, writes } = makeDb({ customer: { line_user_id: 'U1', key_code: '2weektrial_keep', subscription_start_at: null } });
    const r = await applyTrialCampaign(db, undefined, 'U1', null, now);
    if (!r.success) throw new Error('expected success');
    expect(r.keyCode).toBe('2weektrial_keep');
    expect(r.reissued).toBe(false);
    expect(r.mirror).toEqual({ 'サブスク登録日時': '2026-09-14 12:00:00', 'サブスク終了日時': '2026-09-28 12:00:00' });
    expect(writes.some((w) => /furim_feature_flags/.test(w.sql))).toBe(false);
  });

  it('顧客行が無ければ失敗', async () => {
    const { db } = makeDb({ customer: null });
    expect((await applyTrialCampaign(db, undefined, 'U1', null, now)).success).toBe(false);
  });
});
