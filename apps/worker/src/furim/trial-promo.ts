// 掘り起こし用の期間限定「全機能無料開放」（LINE ボタン「1週間無料プレゼント」「無料開放プレゼント」）。
// GAS grantOneWeekTrial.js の移植（Capsec #250・2026-09-14）。GAS 版は 7967211 で getTopPlanInfo が消えて
// 動かなくなっていた（キャンペーン終了後だったので実害なし）。
//
// - キャンペーンは TRIAL_PROMOS に 1 行足すだけで増やせる。keyCodePrefix はキャンペーンごとに必ず変える
//   （1 回きりの判定にこの接頭語を使う。友だち登録時に配る 2weektrial_ は使えない）
// - 期限はキャンペーン終了日時（押した時点からの N 日ではない）
// - プラン名は書き換えない（解約履歴を消さない・getKeyCodeSet は終了日時で判定）
// - 全機能開放 = マスタの全機能キー＋既存フラグキーを ON・在庫管理シートを ON・自動併売は全サイト
import { formatJstDateTime, getFurimCustomer, parseJstDateTime, upsertFurimCustomer } from './customer-store.js';
import { upsertFeatureFlags } from './customer-sync.js';
import { ALWAYS_ENABLED_FEATURE_KEYS, INVENTORY_PATROL_ALL_SITES, ensureFurimMaster } from './feature-flags.js';
import { invalidateExtCache, type ExtCache } from './ext-auth.js';

export type TrialPromo = { keyCodePrefix: string; endAt: string; label: string };

export const TRIAL_PROMOS: Record<string, TrialPromo> = {
  '2026-08': { keyCodePrefix: '1wtrial423_', endAt: '2026-08-31T12:00:00+09:00', label: '無料開放(2026-08)' },
};
export const ACTIVE_TRIAL_PROMO = '2026-08';

const CANCELLED_PLAN_NAME = 'キャンセル済み';

export type TrialPromoResult =
  | { success: true; promoId: string; keyCode: string; expiry: string; expiryJst: string; flags: Record<string, string>; previousKeyCode: string | null }
  | { success: false; reason: 'noPromo' | 'expired' | 'notFound' | 'paid' | 'already' | 'error'; promoId?: string; keyCode?: string; planName?: string; message?: string };

function randomSuffix(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

/** 'yyyy/MM/dd HH:mm'（JST・顧客向け文面用） */
function expiryText(ms: number): string {
  const s = new Date(ms + 9 * 60 * 60_000).toISOString();
  return `${s.slice(0, 4)}/${s.slice(5, 7)}/${s.slice(8, 10)} ${s.slice(11, 16)}`;
}

/** キーコードの接頭語からキャンペーン ID を引く（無料アカウント台帳の照合と同じ規則） */
export function trialPromoIdForKeyCode(keyCode: string | null | undefined): string {
  const kc = String(keyCode ?? '').trim();
  if (!kc) return '';
  for (const [id, p] of Object.entries(TRIAL_PROMOS)) if (kc.startsWith(p.keyCodePrefix)) return id;
  return '';
}

export async function grantTrialPromo(
  db: D1Database,
  kv: ExtCache | undefined,
  gasDeployId: string | undefined,
  lineUserId: string,
  opts: { promoId?: string; nowMs?: number } = {},
): Promise<TrialPromoResult> {
  const promoId = opts.promoId || ACTIVE_TRIAL_PROMO;
  const promo = TRIAL_PROMOS[promoId];
  if (!promo) return { success: false, reason: 'noPromo', message: '不明なキャンペーン: ' + promoId };
  const nowMs = opts.nowMs ?? Date.now();
  const endMs = Date.parse(promo.endAt);
  if (!(endMs > nowMs)) return { success: false, reason: 'expired', promoId };

  const customer = await getFurimCustomer(db, lineUserId);
  if (!customer) return { success: false, reason: 'notFound', message: '該当レコードなし' };

  // 継続中の有料会員だけ対象外（キーコード刷新・終了日時の上書きが不利益）。解約済み＝本命なので通す
  const planName = (customer.plan_label ?? '').trim();
  const expiryMs = parseJstDateTime(customer.subscription_end_at) ?? 0;
  const isCancelled = !planName || planName.startsWith(CANCELLED_PLAN_NAME);
  if (!isCancelled && expiryMs > nowMs) return { success: false, reason: 'paid', planName };

  // 1 キャンペーンにつき 1 回きり（接頭語で判定）
  const existing = (customer.key_code ?? '').trim();
  if (existing.startsWith(promo.keyCodePrefix)) return { success: false, reason: 'already', keyCode: existing, promoId };

  const master = await ensureFurimMaster(db, gasDeployId);
  const existingFlags = await db.prepare('SELECT feature_key FROM furim_feature_flags WHERE line_user_id = ?').bind(lineUserId).all<{ feature_key: string }>();
  const keys = new Set<string>([...master.features.map((f) => f.feature_key), ...(existingFlags.results ?? []).map((r) => r.feature_key), ...ALWAYS_ENABLED_FEATURE_KEYS, 'InventorySheet', 'AutoMultiChannel']);
  const flags: Record<string, string> = {};
  for (const k of keys) flags[k] = k === 'AutoMultiChannel' ? INVENTORY_PATROL_ALL_SITES : '1';

  const keyCode = promo.keyCodePrefix + randomSuffix();
  const expiryJst = formatJstDateTime(endMs);
  await upsertFurimCustomer(db, lineUserId, {
    subscription_end_at: expiryJst,
    key_code: keyCode,
    key_code_issued: 1,
    device_code: null,
    device_activated: 0,
  });
  await upsertFeatureFlags(db, lineUserId, flags, 'promo');
  await invalidateExtCache(kv, existing || null);
  await invalidateExtCache(kv, keyCode);
  console.log('[furim/trial-promo] granted', JSON.stringify({ promoId, lineUserId, keyCode, expiry: expiryJst }));
  return { success: true, promoId, keyCode, expiry: expiryText(endMs), expiryJst, flags, previousKeyCode: existing || null };
}
