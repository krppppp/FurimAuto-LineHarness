import { describe, it, expect, vi } from 'vitest';

const createAffiliate = vi.fn();
const getAffiliateByFriendId = vi.fn();
vi.mock('@line-crm/db', () => ({
  jstNow: () => '2026-09-13T23:30:00.000+09:00',
  createAffiliate,
  getAffiliateByFriendId,
}));

const { generateAmbassadorCode, getOrCreateAmbassadorAffiliate, countReferrals, recordReferral, markRewardApplied } = await import('./referral-store.js');

type Write = { sql: string; args: unknown[] };

function makeDb(opts: { firstRows?: Record<string, unknown>[]; runThrows?: string; changes?: number } = {}) {
  const writes: Write[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            run: async () => {
              writes.push({ sql, args });
              if (opts.runThrows) throw new Error(opts.runThrows);
              return { meta: { changes: opts.changes ?? 1 } };
            },
            first: async () => (opts.firstRows ?? []).shift() ?? null,
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, writes };
}

describe('generateAmbassadorCode', () => {
  it('GAS getAmbassadorInfo と同じ英大文字＋数字 8 桁', () => {
    for (let i = 0; i < 30; i++) expect(generateAmbassadorCode()).toMatch(/^[A-Z0-9]{8}$/);
  });
});

describe('getOrCreateAmbassadorAffiliate', () => {
  it('既存の affiliate があればそれを返す（LIFF 自己登録の code もそのまま）', async () => {
    getAffiliateByFriendId.mockResolvedValueOnce({ id: 'aff1', code: 'abc123', friend_id: 'f1' });
    const { db } = makeDb();
    const a = await getOrCreateAmbassadorAffiliate(db, 'f1', 'テスト');
    expect(a.code).toBe('abc123');
    expect(createAffiliate).not.toHaveBeenCalled();
  });

  it('無ければ 8 桁コードで作る。code 衝突は引き直す', async () => {
    getAffiliateByFriendId.mockResolvedValueOnce(null);
    createAffiliate
      .mockRejectedValueOnce(new Error('UNIQUE constraint failed: affiliates.code'))
      .mockImplementationOnce(async (_db: unknown, input: { code: string; friendId: string }) => ({ id: 'aff2', code: input.code, friend_id: input.friendId }));
    const { db } = makeDb();
    const a = await getOrCreateAmbassadorAffiliate(db, 'f1', null);
    expect(a.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(createAffiliate).toHaveBeenCalledTimes(2);
  });
});

describe('recordReferral / countReferrals / markRewardApplied', () => {
  it('紹介台帳に 1 行入れて id を返す。被紹介者の UNIQUE 衝突なら null', async () => {
    const { db, writes } = makeDb();
    const id = await recordReferral(db, { affiliateId: 'aff1', ambassadorFriendId: 'fa', introducedFriendId: 'fi', source: 'keyword', rewardCouponName: 'アンバサダー1500円引きクーポン', rewardCouponId: 'Tb8WoYb4', introducedCouponId: 'IDLf7QBx', trialExtendedDays: 7 });
    expect(id).toBeTruthy();
    expect(writes[0].sql).toContain('INSERT INTO furim_referrals');
    expect(writes[0].args).toContain('keyword');
    const { db: db2 } = makeDb({ runThrows: 'UNIQUE constraint failed: furim_referrals.introduced_friend_id' });
    expect(await recordReferral(db2, { affiliateId: 'aff1', ambassadorFriendId: 'fa', introducedFriendId: 'fi', source: 'url' })).toBeNull();
  });

  it('紹介数は台帳の COUNT（紹介・付与・適用）', async () => {
    const { db } = makeDb({ firstRows: [{ total: 12, rewarded: 10, applied: 9 }] });
    expect(await countReferrals(db, 'aff1')).toEqual({ total: 12, rewarded: 10, applied: 9 });
  });

  it('markRewardApplied は未適用のときだけ true', async () => {
    const { db } = makeDb({ changes: 1 });
    expect(await markRewardApplied(db, 'r1')).toBe(true);
    const { db: db0 } = makeDb({ changes: 0 });
    expect(await markRewardApplied(db0, 'r1')).toBe(false);
  });
});
