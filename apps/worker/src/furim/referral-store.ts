// 友だち紹介（アンバサダー制度）の D1 ストア（Capsec #244 段階2・2026-09-13）。
// GAS の getAmbassadorInfo / stackLINEIntroductionInfo / updateIntroductionCoupon の置き換え。
// - アンバサダー本体 = affiliates（code＝アンバサダーコード。URL 紹介の affiliate_links もここにぶら下がる）
// - 紹介台帳 = furim_referrals（introduced_friend_id UNIQUE で「1 人 1 回」を構造で保証）
// - クーポン名→Stripe ID = furim_coupons
// カウンタ列は持たない（紹介数・付与数・適用数は COUNT で出す）
import { jstNow, getAffiliateByFriendId, createAffiliate, type Affiliate } from '@line-crm/db';

export const INTRODUCED_COUPON_NAME = 'お友達紹介初回月額プラン半額クーポン';
// アンバサダー報酬クーポンは 10 枚まで（GAS stackLINEIntroductionInfo と同じ）
export const REWARD_COUPON_LIMIT = 10;

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** GAS getAmbassadorInfo と同じ形（英大文字＋数字 8 桁）。衝突は affiliates.code UNIQUE で検出して引き直す */
export function generateAmbassadorCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += CODE_CHARS[b % CODE_CHARS.length];
  return s;
}

export async function getCouponId(db: D1Database, name: string): Promise<string | null> {
  const row = await db.prepare('SELECT coupon_id FROM furim_coupons WHERE name = ? AND is_active = 1').bind(name).first<{ coupon_id: string }>();
  return row?.coupon_id ?? null;
}

/**
 * アンバサダーの affiliate を返す。無ければアンバサダーコードを発番して作る。
 * LIFF の自己登録で先に affiliate ができている場合はその code をそのまま使う（1 friend = 1 affiliate）
 */
export async function getOrCreateAmbassadorAffiliate(db: D1Database, friendId: string, displayName: string | null): Promise<Affiliate> {
  const existing = await getAffiliateByFriendId(db, friendId);
  if (existing) return existing;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateAmbassadorCode();
    try {
      return await createAffiliate(db, { name: `Ambassador ${code}`, code, friendId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE constraint failed/i.test(msg) && /affiliates\.code/i.test(msg)) continue;
      // friend_id の UNIQUE（同時押し）→ 既存を引き直す
      const again = await getAffiliateByFriendId(db, friendId);
      if (again) return again;
      throw err;
    }
  }
  throw new Error('ambassador code generation failed');
}

export type ReferralCounts = { total: number; rewarded: number; applied: number };

export async function countReferrals(db: D1Database, affiliateId: string): Promise<ReferralCounts> {
  const row = await db
    .prepare(
      `SELECT count(*) AS total,
              sum(reward_coupon_name IS NOT NULL) AS rewarded,
              sum(reward_applied_at IS NOT NULL) AS applied
         FROM furim_referrals WHERE affiliate_id = ?`,
    )
    .bind(affiliateId)
    .first<{ total: number; rewarded: number | null; applied: number | null }>();
  return { total: row?.total ?? 0, rewarded: row?.rewarded ?? 0, applied: row?.applied ?? 0 };
}

export type NewReferral = {
  affiliateId: string;
  ambassadorFriendId: string | null;
  introducedFriendId: string;
  refCode?: string | null;
  source: 'url' | 'keyword' | 'retry';
  ambassadorPlanName?: string | null;
  rewardCouponName?: string | null;
  rewardCouponId?: string | null;
  introducedCouponId?: string | null;
  trialExtendedDays?: number;
};

/** 紹介台帳に 1 行。被紹介者が既に台帳にあれば null（= already） */
export async function recordReferral(db: D1Database, r: NewReferral): Promise<string | null> {
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO furim_referrals (id, affiliate_id, ambassador_friend_id, introduced_friend_id, ref_code, source, ambassador_plan_name,
           reward_coupon_name, reward_coupon_id, reward_applied_at, introduced_coupon_id, trial_extended_days, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .bind(
        id, r.affiliateId, r.ambassadorFriendId, r.introducedFriendId, r.refCode ?? null, r.source, r.ambassadorPlanName ?? null,
        r.rewardCouponName ?? null, r.rewardCouponId ?? null, r.introducedCouponId ?? null, r.trialExtendedDays ?? 0, jstNow(),
      )
      .run();
    return id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(msg)) return null;
    throw err;
  }
}

export async function findReferralByIntroduced(db: D1Database, introducedFriendId: string): Promise<{ id: string; affiliate_id: string } | null> {
  return db.prepare('SELECT id, affiliate_id FROM furim_referrals WHERE introduced_friend_id = ?').bind(introducedFriendId).first<{ id: string; affiliate_id: string }>();
}

export type PendingReward = { id: string; reward_coupon_name: string; reward_coupon_id: string };

/** アンバサダーの未適用の報酬クーポンを古い順に 1 枚返す（GAS updateIntroductionCoupon の選択条件と同じ） */
export async function findUnappliedReward(db: D1Database, ambassadorFriendId: string): Promise<PendingReward | null> {
  return db
    .prepare(
      `SELECT id, reward_coupon_name, reward_coupon_id FROM furim_referrals
        WHERE ambassador_friend_id = ? AND reward_coupon_id IS NOT NULL AND reward_applied_at IS NULL
        ORDER BY created_at LIMIT 1`,
    )
    .bind(ambassadorFriendId)
    .first<PendingReward>();
}

/** Stripe 適用に成功してから呼ぶ（GAS は先にフラグを立てていたため割引ロストが起きていた） */
export async function markRewardApplied(db: D1Database, referralId: string): Promise<boolean> {
  const res = await db
    .prepare('UPDATE furim_referrals SET reward_applied_at = ? WHERE id = ? AND reward_applied_at IS NULL')
    .bind(jstNow(), referralId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
