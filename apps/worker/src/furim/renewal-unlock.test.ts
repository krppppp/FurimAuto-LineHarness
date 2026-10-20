import { describe, it, expect, vi } from 'vitest';
import {
  cycleKey,
  isEligibleCustomer,
  isInGrantWindow,
  isSendHour,
  isStartedFor,
  nextStage,
  overlayUnlockFlags,
  renewalAtMs,
  unlockFlagsFromMaster,
  runRenewalUnlock,
} from './renewal-unlock.js';

const DAY = 24 * 60 * 60_000;
const at = (iso: string) => Date.parse(iso);

const base = {
  line_user_id: 'U1',
  subscription_id: 'sub_1',
  subscription_end_at: '2026-10-13T10:00:00.000+09:00',
  packages: 'm_full',
  features: null,
  key_code: 'pb_abc',
  plan_label: 'PBプラン:メルカリ 全自動化プラン',
};

describe('対象の判定', () => {
  it('PB 有料の下位プランだけ通す（premium・trial・パッケージ無し・試用キーコードは外す）', () => {
    expect(isEligibleCustomer(base)).toBe(true);
    expect(isEligibleCustomer({ ...base, packages: 'm_full,r_semi' })).toBe(true);
    expect(isEligibleCustomer({ ...base, packages: 'premium' })).toBe(false);
    expect(isEligibleCustomer({ ...base, packages: 'trial' })).toBe(false);
    expect(isEligibleCustomer({ ...base, packages: '' })).toBe(false);
    expect(isEligibleCustomer({ ...base, subscription_id: null })).toBe(false);
    expect(isEligibleCustomer({ ...base, plan_label: 'キャンセル済み' })).toBe(false);
    expect(isEligibleCustomer({ ...base, key_code: '2weektrial_x' })).toBe(false);
  });

  it('機能単品（features だけ）の PB 有料会員も通す（TB-1906）。試用・解約済み・subscription 無しは外したまま', () => {
    const single = { ...base, packages: '', features: 'mChangePrice', plan_label: 'PBプラン:メルカリ 値下げ' };
    expect(isEligibleCustomer(single)).toBe(true);
    expect(isEligibleCustomer({ ...single, packages: null, features: 'mChangePrice,rChangePrice' })).toBe(true);
    expect(isEligibleCustomer({ ...base, packages: 'm_full', features: 'rChangePrice' })).toBe(true);
    expect(isEligibleCustomer({ ...single, features: '' })).toBe(false);
    expect(isEligibleCustomer({ ...single, features: ' , ' })).toBe(false);
    expect(isEligibleCustomer({ ...single, packages: 'premium' })).toBe(false);
    expect(isEligibleCustomer({ ...single, packages: 'trial' })).toBe(false);
    expect(isEligibleCustomer({ ...single, subscription_id: null })).toBe(false);
    expect(isEligibleCustomer({ ...single, plan_label: 'キャンセル済み' })).toBe(false);
    expect(isEligibleCustomer({ ...single, key_code: '2weektrial_x' })).toBe(false);
  });

  it('機能単品の人は 11/1（JST）以降の更新から。パッケージのある人は日付で外さない（TB-1021 の決定）', () => {
    const single = { ...base, packages: '', features: 'mChangePrice' };
    expect(isStartedFor(single, at('2026-10-31T23:59:59+09:00'))).toBe(false);
    expect(isStartedFor(single, at('2026-11-01T00:00:00+09:00'))).toBe(true);
    expect(isStartedFor(base, at('2026-10-25T10:00:00+09:00'))).toBe(true);
  });

  it('更新日時は subscription_end_at の 24h 前。窓は 7 日前〜2 日前', () => {
    const renewal = renewalAtMs(base.subscription_end_at)!;
    expect(renewal).toBe(at('2026-10-12T10:00:00+09:00'));
    expect(isInGrantWindow(renewal, renewal - 7 * DAY)).toBe(true);
    expect(isInGrantWindow(renewal, renewal - 7 * DAY - 1)).toBe(false);
    expect(isInGrantWindow(renewal, renewal - 2 * DAY)).toBe(false);
    expect(cycleKey('sub_1', renewal)).toBe('sub_1:2026-10-12');
  });

  it('送るのは 9〜23 時 JST', () => {
    expect(isSendHour(at('2026-10-05T08:59:00+09:00'))).toBe(false);
    expect(isSendHour(at('2026-10-05T09:00:00+09:00'))).toBe(true);
    expect(isSendHour(at('2026-10-05T22:59:00+09:00'))).toBe(true);
    expect(isSendHour(at('2026-10-05T23:00:00+09:00'))).toBe(false);
  });
});

describe('フラグの上乗せ', () => {
  it('trial パッケージを展開した値を重ね、契約の ON は消さない', () => {
    const master = {
      features: [],
      packages: [{ package_key: 'trial', features: 'mChangePrice,rChangePrice,InventorySheet,AutoMultiChannel=メルカリ/ラクマ' }],
    };
    const unlock = unlockFlagsFromMaster(master);
    expect(unlock).toEqual({ mChangePrice: '1', rChangePrice: '1', InventorySheet: '1', AutoMultiChannel: 'メルカリ/ラクマ' });
    const merged = overlayUnlockFlags({ mChangePrice: '1', mBackup: '1', rChangePrice: '0', AutoMultiChannel: '' }, unlock);
    expect(merged).toEqual({ mChangePrice: '1', mBackup: '1', rChangePrice: '1', InventorySheet: '1', AutoMultiChannel: 'メルカリ/ラクマ' });
  });
});

describe('案内の段階', () => {
  const until = at('2026-10-12T10:00:00+09:00');
  const row = { until_ms: until, msg1_sent_at: null, msg2_sent_at: null, msg3_sent_at: null };
  it('1 通目 → 4 日前に 2 通目 → 前日に 3 通目', () => {
    expect(nextStage(row, until - 7 * DAY)).toBe(1);
    const sent1 = { ...row, msg1_sent_at: '2026-10-05T10:00:00.000+09:00' };
    expect(nextStage(sent1, until - 5 * DAY)).toBe(null);
    expect(nextStage(sent1, until - 4 * DAY)).toBe(2);
    const sent2 = { ...sent1, msg2_sent_at: '2026-10-08T10:00:00.000+09:00' };
    expect(nextStage(sent2, until - 2 * DAY)).toBe(null);
    expect(nextStage(sent2, until - DAY)).toBe(3);
    expect(nextStage({ ...sent2, msg3_sent_at: 'x' }, until - 1000)).toBe(null);
    expect(nextStage(sent2, until)).toBe(null);
  });
  it('1 通目から 1 日たたないうちは 2 通目を送らない。前日まで来たら 2 通目は飛ばして 3 通目', () => {
    const late = { ...row, msg1_sent_at: '2026-10-09T10:00:00.000+09:00' };
    expect(nextStage(late, at('2026-10-09T20:00:00+09:00'))).toBe(null);
    expect(nextStage(late, until - DAY + 1)).toBe(3);
  });
});

describe('runRenewalUnlock のゲート', () => {
  it('FURIM_RENEWAL_UNLOCK が on でなければ cron では何もしない', async () => {
    const db = { prepare: () => { throw new Error('should not query'); } } as unknown as D1Database;
    const r = await runRenewalUnlock(db, null, undefined, {}, { nowMs: at('2026-10-05T10:00:00+09:00') });
    expect(r.skipped).toBe('disabled');
  });
  it('23 時〜9 時は手動でも動かない', async () => {
    const db = { prepare: () => { throw new Error('should not query'); } } as unknown as D1Database;
    const r = await runRenewalUnlock(db, null, undefined, { FURIM_RENEWAL_UNLOCK: 'on' }, { nowMs: at('2026-10-05T23:30:00+09:00'), manual: true });
    expect(r.skipped).toBe('outsideHours');
  });
});

describe('外す subscription（TB-1014）', () => {
  function fakeDb(customers: unknown[], unlockRows: unknown[]) {
    const writes: string[] = [];
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind: () => stmt,
          all: async () => ({ results: /FROM furim_customers/.test(sql) ? customers : /FROM furim_renewal_unlocks/.test(sql) ? unlockRows : [] }),
          first: async () => null,
          run: async () => { writes.push(sql); return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    } as unknown as D1Database;
    return { db, writes };
  }
  const env = { FURIM_RENEWAL_UNLOCK: 'on', FURIM_RENEWAL_UNLOCK_EXCLUDE_SUBS: 'sub_x, sub_y' };
  const now = at('2026-10-08T10:00:00+09:00');

  it('外す人には開けない（dryRun でも excluded として出す）', async () => {
    const { db } = fakeDb([{ ...base, line_user_id: 'Ux', subscription_id: 'sub_x' }], []);
    const r = await runRenewalUnlock(db, null, undefined, env, { nowMs: now, manual: true, dryRun: true, skipStripeCheck: true });
    expect(r.granted).toEqual([]);
    expect(r.rejected).toEqual([{ lineUserId: 'Ux', reason: 'excluded' }]);
  });
  it('機能単品の人は 11/1 以降の更新だけ開ける（10/30 更新は beforeStart）', async () => {
    const single = { ...base, packages: '', features: 'mChangePrice' };
    const nowOct28 = at('2026-10-28T10:00:00+09:00');
    const nov = fakeDb([{ ...single, line_user_id: 'Unov', subscription_end_at: '2026-11-02T10:00:00.000+09:00' }], []);
    const r1 = await runRenewalUnlock(nov.db, null, undefined, env, { nowMs: nowOct28, manual: true, dryRun: true, skipStripeCheck: true, onlyLineUserId: 'Unov' });
    expect(r1.granted).toEqual(['Unov']);
    const oct = fakeDb([{ ...single, line_user_id: 'Uoct', subscription_end_at: '2026-10-31T18:00:00.000+09:00' }], []);
    const r2 = await runRenewalUnlock(oct.db, null, undefined, env, { nowMs: nowOct28, manual: true, dryRun: true, skipStripeCheck: true, onlyLineUserId: 'Uoct' });
    expect(r2.granted).toEqual([]);
    expect(r2.rejected).toEqual([{ lineUserId: 'Uoct', reason: 'beforeStart' }]);
  });
  it('開放の記録が既にあっても、外す人には案内を送らない', async () => {
    const push = vi.fn();
    const row = { id: 'r1', line_user_id: 'Uy', cycle: 'sub_y:2026-10-13', until_ms: at('2026-10-13T10:00:00+09:00'), granted_at: '', msg1_sent_at: null, msg2_sent_at: null, msg3_sent_at: null };
    const { db, writes } = fakeDb([], [row]);
    const r = await runRenewalUnlock(db, { pushMessage: push }, undefined, env, { nowMs: now, manual: true, push: true });
    expect(push).not.toHaveBeenCalled();
    expect(r.sent).toEqual([]);
    expect(writes).toEqual([]);
  });
});
