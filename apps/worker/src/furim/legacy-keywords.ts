// 旧来のキーワード 2 本を D1 で完結させる（段階4・Capsec #246。段階2.5 で漏れていた LINE 起点）。
// - 【キーワード】登録URL発行 <プラン名>: GAS getLIFFCheckoutUrl（プラン一覧の PriceID＋Stripe顧客ID で LIFF の決済 URL）
// - 【キーワード】無料お試し1週間<YYYYMMDD>: GAS setKeyCodeExpiry（登録日時=今・終了日時=14 日後・試用キーコード・試用プランの機能フラグ）
// プラン一覧は furim_master（kind='plan'・payload に PriceID / キーコード接頭語 / features）に取り込み済み（#252）
import { formatJstDateTime, generateTrialKeyCode, getFurimCustomer, parseJstDateTime, upsertFurimCustomer, TRIAL_KEYCODE_PREFIX } from './customer-store.js';
import { upsertFeatureFlags } from './customer-sync.js';
import { ALWAYS_ENABLED_FEATURE_KEYS, INVENTORY_PATROL_ALL_SITES, isInventoryPromoActive } from './feature-flags.js';
import { invalidateExtCache, type ExtCache } from './ext-auth.js';

export const TRIAL_PLAN_NAME = '友達登録2週間トライアルプラン';
const TRIAL_DAYS = 14;

type PlanPayload = { PriceID?: unknown; 'キーコード接頭語'?: unknown; features?: Record<string, unknown> };

export async function loadPlanPayload(db: D1Database, planName: string): Promise<PlanPayload | null> {
  const row = await db.prepare("SELECT payload FROM furim_master WHERE kind = 'plan' AND key = ? LIMIT 1").bind(planName).first<{ payload: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.payload || '{}') as PlanPayload;
  } catch {
    return null;
  }
}

/** プラン一覧の features（true/false/文字列）→ furim_feature_flags の値。コピー出品は常時 1・在庫プロモ中は付与 */
export function planFeaturesToFlags(features: Record<string, unknown> | undefined, nowMs = Date.now()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(features ?? {})) {
    if (k === 'AutoMultiChannel') out[k] = v && v !== true ? String(v) : '';
    else out[k] = v === true || v === 'TRUE' || v === '1' || v === 1 ? '1' : '0';
  }
  for (const k of ALWAYS_ENABLED_FEATURE_KEYS) out[k] = '1';
  if (isInventoryPromoActive(nowMs)) {
    out.InventorySheet = '1';
    out.AutoMultiChannel = INVENTORY_PATROL_ALL_SITES;
  }
  return out;
}

/** 登録URL発行: プラン名 → LIFF の決済 URL。プランが無ければ null（旧 GAS は '該当なし'） */
export async function buildLegacyCheckoutUrl(
  db: D1Database,
  opts: { liffUrl: string; isDev: boolean; lineUserId: string; planName: string; stripeCustomerId: string | null; nowMs?: number },
): Promise<string | null> {
  const plan = await loadPlanPayload(db, opts.planName);
  const priceId = plan?.PriceID == null ? '' : String(plan.PriceID).trim();
  if (!plan || !priceId) return null;
  const expired = (opts.nowMs ?? Date.now()) + 60 * 60_000;
  return `${opts.liffUrl}?price_id=${encodeURIComponent(priceId)}&customer_id=${encodeURIComponent(opts.stripeCustomerId ?? '')}&expired=${expired}&env=${opts.isDev ? 'dev' : 'prod'}`;
}

export type TrialCampaignResult =
  | { success: true; keyCode: string; reissued: boolean; startAt: string; endAt: string; mirror: Record<string, unknown>; flags: Record<string, string> | null }
  | { success: false; message: string };

/**
 * 無料お試し1週間<YYYYMMDD>: GAS setKeyCodeExpiry の移植。
 * - expiryDate（YYYYMMDD）より後にサブスク登録日時がある人は対象外（既にご登録済み）
 * - 登録日時=今・終了日時=14 日後（2026-08-27 くろさん決定で 7→14 日）
 * - キーコードは接頭語 2weektrial_ ならそのまま（同一プランの更新は不変）。違えば試用キーコードを発行し端末判定をクリアし
 *   試用プランの機能フラグを書く（GAS setKeyCode と同じ）
 */
export async function applyTrialCampaign(
  db: D1Database,
  kv: ExtCache | undefined,
  lineUserId: string,
  expiryDate: string | null,
  nowMs = Date.now(),
): Promise<TrialCampaignResult> {
  const customer = await getFurimCustomer(db, lineUserId);
  if (!customer) return { success: false, message: '指定されたLINEUserIDが見つかりません' };
  if (expiryDate && /^\d{8}$/.test(expiryDate)) {
    const limit = Date.parse(`${expiryDate.slice(0, 4)}-${expiryDate.slice(4, 6)}-${expiryDate.slice(6, 8)}T00:00:00+09:00`);
    const registered = parseJstDateTime(customer.subscription_start_at);
    if (registered != null && registered > limit) return { success: false, message: '既にご登録済みの方のみ対象となります' };
  }
  const startAt = formatJstDateTime(nowMs);
  const endAt = formatJstDateTime(nowMs + TRIAL_DAYS * 24 * 60 * 60_000);
  const current = (customer.key_code ?? '').trim();
  const reissued = !current.startsWith(TRIAL_KEYCODE_PREFIX);
  const keyCode = reissued ? generateTrialKeyCode() : current;
  const mirror: Record<string, unknown> = { 'サブスク登録日時': startAt, 'サブスク終了日時': endAt };
  let flags: Record<string, string> | null = null;
  const patch: Parameters<typeof upsertFurimCustomer>[2] = { subscription_start_at: startAt, subscription_end_at: endAt };
  if (reissued) {
    patch.key_code = keyCode;
    patch.device_code = null;
    patch.device_activated = 0;
    mirror['キーコード'] = keyCode;
    mirror['端末判定文字列'] = '';
    const plan = await loadPlanPayload(db, TRIAL_PLAN_NAME);
    if (plan?.features) {
      flags = planFeaturesToFlags(plan.features, nowMs);
      await upsertFeatureFlags(db, lineUserId, flags, 'plan');
    }
  }
  await upsertFurimCustomer(db, lineUserId, patch);
  await invalidateExtCache(kv, current || null);
  if (reissued) await invalidateExtCache(kv, keyCode);
  console.log('[furim/trial-campaign]', JSON.stringify({ lineUserId, keyCode, reissued, startAt, endAt, flags: flags ? Object.keys(flags).length : 0 }));
  return { success: true, keyCode, reissued, startAt, endAt, mirror, flags };
}
