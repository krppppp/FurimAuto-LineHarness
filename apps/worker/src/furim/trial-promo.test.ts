import { describe, it, expect, vi } from 'vitest';

vi.mock('./gas-client.js', () => ({ gasGet: vi.fn(), gasPost: vi.fn(), getGasErrorFromResponse: () => null }));

const { grantTrialPromo, TRIAL_PROMOS, trialPromoIdForKeyCode } = await import('./trial-promo.js');

type Write = { sql: string; args: unknown[] };

function makeDb(customer: Record<string, unknown> | null, flagKeys: string[] = []) {
  const writes: Write[] = [];
  const db = {
    prepare(sql: string) {
      const make = (args: unknown[]) => ({
        sql,
        args,
        run: async () => { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
        first: async () => (/FROM furim_customers WHERE line_user_id/.test(sql) ? customer : null),
        all: async () => (/SELECT feature_key FROM furim_feature_flags/.test(sql) ? { results: flagKeys.map((k) => ({ feature_key: k })) } : { results: [] }),
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

const BEFORE_END = Date.parse('2026-08-20T10:00:00+09:00');
const AFTER_END = Date.parse('2026-09-14T10:00:00+09:00');

describe('grantTrialPromo（GAS grantOneWeekTrial の移植）', () => {
  it('終了済みキャンペーンは expired', async () => {
    const { db } = makeDb({ line_user_id: 'U1', key_code: null, plan_label: null, subscription_end_at: null });
    expect(await grantTrialPromo(db, undefined, 'U1', { nowMs: AFTER_END })).toEqual({ success: false, reason: 'expired', promoId: '2026-08' });
  });

  it('顧客行が無ければ notFound', async () => {
    const { db } = makeDb(null);
    expect((await grantTrialPromo(db, undefined, 'U1', { nowMs: BEFORE_END })).success).toBe(false);
  });

  it('継続中の有料会員は paid（解約済みは通す）', async () => {
    const { db } = makeDb({ line_user_id: 'U1', key_code: 'pb_x', plan_label: 'PBプラン:メルカリ', subscription_end_at: '2026-12-01 00:00:00' });
    expect(await grantTrialPromo(db, undefined, 'U1', { nowMs: BEFORE_END })).toMatchObject({ success: false, reason: 'paid' });
    const { db: db2 } = makeDb({ line_user_id: 'U1', key_code: null, plan_label: 'キャンセル済み(商材が合わない)', subscription_end_at: '2026-12-01 00:00:00' });
    expect((await grantTrialPromo(db2, undefined, 'U1', { nowMs: BEFORE_END })).success).toBe(true);
  });

  it('同じキャンペーンの接頭語なら already', async () => {
    const { db } = makeDb({ line_user_id: 'U1', key_code: '1wtrial423_abcdefgh', plan_label: '', subscription_end_at: '2026-08-31 12:00:00' });
    expect(await grantTrialPromo(db, undefined, 'U1', { nowMs: BEFORE_END })).toMatchObject({ success: false, reason: 'already', keyCode: '1wtrial423_abcdefgh' });
  });

  it('付与: 期限＝キャンペーン終了日時・キーコード刷新・端末判定クリア・全機能 ON（自動併売は全サイト）', async () => {
    const { db, writes } = makeDb({ line_user_id: 'U1', key_code: '2weektrial_old', plan_label: '', subscription_end_at: '2026-08-10 00:00:00' }, ['mChangePrice', 'AutoMultiChannel', 'yfRelist']);
    const r = await grantTrialPromo(db, undefined, 'U1', { nowMs: BEFORE_END });
    if (!r.success) throw new Error('expected success');
    expect(r.keyCode).toMatch(/^1wtrial423_[0-9a-z]{8}$/);
    expect(r.expiry).toBe('2026/08/31 12:00');
    expect(r.expiryJst).toBe('2026-08-31 12:00:00');
    expect(r.flags).toMatchObject({ mChangePrice: '1', yfRelist: '1', InventorySheet: '1', AutoMultiChannel: 'メルカリ/Shops/ラクマ/ヤフオク/ヤフフリ', mCopyRakumaListing: '1' });
    const upsert = writes.find((w) => /INSERT INTO furim_customers/.test(w.sql));
    expect(upsert?.args).toContain('2026-08-31T12:00:00.000+09:00');
    expect(upsert?.sql).toMatch(/device_code = excluded.device_code/);
    expect(writes.filter((w) => /INSERT INTO furim_feature_flags/.test(w.sql)).length).toBe(Object.keys(r.flags).length);
  });
});

describe('trialPromoIdForKeyCode', () => {
  it('接頭語からキャンペーンを引く', () => {
    expect(trialPromoIdForKeyCode('1wtrial423_abc')).toBe('2026-08');
    expect(trialPromoIdForKeyCode('pb_abc')).toBe('');
    expect(TRIAL_PROMOS['2026-08'].keyCodePrefix).toBe('1wtrial423_');
  });
});
