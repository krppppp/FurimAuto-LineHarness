// FurimAuto 顧客状態の D1 ストア（migration 068・Capsec #243・2026-09-13）。
//
// LINE のタップ操作（キーコード発行・月額会員ページ・限定特典GET・チケット注文）は
// ここだけを読む。GAS/スプレッドシートを同期で待たない（30日で顧客向けエラー23件の主因）。
// 書き手の分担:
//   - LINE 起点の状態（キーコード発行済み・アンケート・Free30・Youtubeクーポン・延長KW）: Worker が先に書き、
//     GAS へは非同期で鏡写し
//   - Stripe 起点（pb_ 再発行・解約クリア・Stripe顧客ID）: GAS 応答 / webhook から absorb で取り込む
//   - 端末判定文字列（拡張が GAS 経由で書く）: 段階1 ではシートが正。GAS からの通知と差分検知 cron で取り込む
import { jstNow } from '@line-crm/db';

export type FurimCustomer = {
  line_user_id: string;
  stripe_customer_id: string | null;
  key_code: string | null;
  key_code_issued: number;
  device_activated: number;
  survey_answer: string | null;
  free30_ticket: number;
  youtube_coupon: string | null;
  extend_keyword: string | null;
  sheet_synced_at: string | null;
  // 段階2（migration 069）
  subscription_id: string | null;
  subscription_start_at: string | null;
  subscription_end_at: string | null;   // JST 'YYYY-MM-DD HH:MM:SS'（拡張の期限判定・+24h バッファ込み）
  subscription_price: number | null;
  plan_label: string | null;
  plan_label_legacy: string | null;
  packages: string | null;
  features: string | null;
  multi_channel_sites: string | null;
  subscription_source: string | null;
  subscription_status: string | null;
  copy_tickets: number | null;
  mercari_url: string | null;
  customer_email: string | null;
  last_invoice_id: string | null;
  canceled_at: string | null;
  // 段階3（migration 071）: 拡張の認証・ログを Worker が受ける
  device_code: string | null;              // 端末判定文字列（Worker が発行。旧拡張の間はシートから取り込む）
  shops_url: string | null;
  rakuma_url: string | null;
  yahoo_flea_url: string | null;
  inventory_sheet_url: string | null;
  inventory_sheet_created_at: string | null;
  ext_last_seen_at: string | null;         // Worker 経由の最終認証。NULL = 旧拡張（GAS 経路）のまま
  gas_last_seen_at: string | null;         // 旧拡張（GAS getKeyCodeSet）からの最終認証（段階2.5・#245(b) 廃止日の判断材料）
  created_at: string;
  updated_at: string;
};

export type FurimCustomerPatch = Partial<Omit<FurimCustomer, 'line_user_id' | 'created_at' | 'updated_at'>>;

const PATCHABLE = [
  'stripe_customer_id',
  'key_code',
  'key_code_issued',
  'device_activated',
  'survey_answer',
  'free30_ticket',
  'youtube_coupon',
  'extend_keyword',
  'sheet_synced_at',
  'subscription_id',
  'subscription_start_at',
  'subscription_end_at',
  'subscription_price',
  'plan_label',
  'plan_label_legacy',
  'packages',
  'features',
  'multi_channel_sites',
  'subscription_source',
  'subscription_status',
  'copy_tickets',
  'mercari_url',
  'customer_email',
  'last_invoice_id',
  'canceled_at',
  'device_code',
  'shops_url',
  'rakuma_url',
  'yahoo_flea_url',
  'inventory_sheet_url',
  'inventory_sheet_created_at',
  'ext_last_seen_at',
  'gas_last_seen_at',
] as const;

/** 'YYYY-MM-DD HH:MM:SS'（JST）。シートへ鏡写しする専用。D1 には formatJstIso で書く */
export function formatJstDateTime(ms: number): string {
  return new Date(ms + 9 * 60 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
}

/** 'YYYY-MM-DDTHH:MM:SS.sss+09:00'（jstNow と同じ形式）。D1 に日時を書くとき */
export function formatJstIso(ms: number): string {
  return new Date(ms + 9 * 60 * 60_000).toISOString().slice(0, -1) + '+09:00';
}

/** JST の 'YYYY-MM-DD HH:MM:SS' / ISO(Z, +09:00) を epoch ms に。解釈できなければ null */
export function parseJstDateTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  const t = Date.parse(hasTz ? iso : `${iso}+09:00`);
  return Number.isNaN(t) ? null : t;
}

/**
 * 無料試用の期限を days 日延ばす（紹介成立の +7 日。GAS stackLINEIntroductionInfo と同じ「現在の終了日時 + 日数」）。
 * 期限が無い行は延ばさず null を返す。返り値はシートへ鏡写しする文字列
 */
export async function extendSubscriptionEnd(db: D1Database, lineUserId: string, days: number): Promise<string | null> {
  const c = await getFurimCustomer(db, lineUserId);
  const base = parseJstDateTime(c?.subscription_end_at);
  if (base == null) return null;
  const nextMs = base + days * 24 * 60 * 60_000;
  await upsertFurimCustomer(db, lineUserId, { subscription_end_at: formatJstIso(nextMs) });
  return formatJstDateTime(nextMs);
}

// 試用キーコードの接頭語。GAS プラン一覧「友達登録2週間トライアルプラン」の「キーコード接頭語」と同値
// （setKeyCode.js が接頭語の前方一致で「同一プラン」を判定するため、必ず一致させる）
export const TRIAL_KEYCODE_PREFIX = '2weektrial_';

export async function getFurimCustomer(db: D1Database, lineUserId: string): Promise<FurimCustomer | null> {
  return db.prepare('SELECT * FROM furim_customers WHERE line_user_id = ?').bind(lineUserId).first<FurimCustomer>();
}

export async function getFurimCustomerByStripeId(db: D1Database, stripeCustomerId: string): Promise<FurimCustomer | null> {
  return db.prepare('SELECT * FROM furim_customers WHERE stripe_customer_id = ? ORDER BY updated_at DESC LIMIT 1').bind(stripeCustomerId).first<FurimCustomer>();
}

/** 指定した列だけを上書きする upsert。行が無ければ作る。空 patch は created_at/updated_at だけ整える */
export async function upsertFurimCustomer(db: D1Database, lineUserId: string, patch: FurimCustomerPatch): Promise<void> {
  const stmt = buildUpsertStatement(db, lineUserId, patch);
  await stmt.run();
}

export function buildUpsertStatement(db: D1Database, lineUserId: string, patch: FurimCustomerPatch): D1PreparedStatement {
  const now = jstNow();
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const k of PATCHABLE) {
    if (patch[k] !== undefined) {
      cols.push(k);
      vals.push(patch[k]);
    }
  }
  const insertCols = ['line_user_id', ...cols, 'created_at', 'updated_at'];
  const placeholders = insertCols.map(() => '?').join(', ');
  const updates = [...cols.map((c) => `${c} = excluded.${c}`), 'updated_at = excluded.updated_at'].join(', ');
  return db
    .prepare(
      `INSERT INTO furim_customers (${insertCols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(line_user_id) DO UPDATE SET ${updates}`,
    )
    .bind(lineUserId, ...vals, now, now);
}

/**
 * 試用キーコードを生成する。GAS setKeyCode.js の「接頭語 + Math.random().toString(36).slice(-8)」の移植。
 * 乱数だけ crypto に替える（GAS 版は "0." が混入する実データがある。拡張は等値比較しかしないので無害）
 */
export function generateTrialKeyCode(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return TRIAL_KEYCODE_PREFIX + s;
}

/**
 * GAS 応答からキーコード関連の状態を取り込む（2 規則）:
 *  (1) resp.keyCode が D1 と異なる → key_code を更新し device_activated=0（GAS は再発行時に必ず端末判定をクリアする）
 *  (2) resp.keyCodeIssued===true → key_code_issued=1・device_activated=0（syncFeatures は発行時に「初回発行」を書く）
 * 応答に keyCode が無い / エラーコード文字列なら何もしない。失敗しても呼び出し元の処理は止めない
 */
export async function absorbGasKeyCode(db: D1Database | undefined, lineUserId: string | null | undefined, resp: unknown): Promise<void> {
  if (!db || !lineUserId || !resp || typeof resp !== 'object') return;
  const r = resp as { keyCode?: unknown; keyCodeIssued?: unknown };
  const keyCode = typeof r.keyCode === 'string' ? r.keyCode.trim() : '';
  const issued = r.keyCodeIssued === true;
  if (!keyCode || keyCode.includes('エラーコード')) return;
  try {
    const current = await getFurimCustomer(db, lineUserId);
    const patch: FurimCustomerPatch = {};
    if (current?.key_code !== keyCode) {
      patch.key_code = keyCode;
      patch.device_activated = 0;
      patch.device_code = null;
    }
    if (issued) {
      patch.key_code_issued = 1;
      patch.device_activated = 0;
      patch.device_code = null;
    }
    if (Object.keys(patch).length === 0) return;
    await upsertFurimCustomer(db, lineUserId, patch);
  } catch (e) {
    console.error('[furim/customer-store] absorbGasKeyCode failed:', lineUserId, e);
  }
}

/** 解約（customer.subscription.deleted）: GAS deleteSubscription と同じくキーコードと端末判定を消す */
export async function clearFurimCustomerKeyCode(db: D1Database, lineUserId: string): Promise<void> {
  await upsertFurimCustomer(db, lineUserId, { key_code: null, device_activated: 0, device_code: null });
}

// ── 限定特典GET の 6 フラグ（GAS getLimitedGiftStatus.js と同じ派生式） ──
export type GiftStatus = {
  hasCompletedSurvey: boolean;
  hasIssuedKeycode: boolean;
  hasActivatedKeycode: boolean;
  hasFree30Ticket: boolean;
  hasYoutubeCoupon: boolean;
  hasExtendKeyword: boolean;
};

export function deriveGiftStatus(c: FurimCustomer | null): GiftStatus {
  if (!c) {
    return { hasCompletedSurvey: false, hasIssuedKeycode: false, hasActivatedKeycode: false, hasFree30Ticket: false, hasYoutubeCoupon: false, hasExtendKeyword: false };
  }
  const survey = (c.survey_answer ?? '').trim();
  return {
    hasCompletedSurvey: !!survey && survey !== 'サブアカウント',
    hasIssuedKeycode: c.key_code_issued === 1,
    hasActivatedKeycode: c.device_activated === 1,
    hasFree30Ticket: c.free30_ticket === 1,
    hasYoutubeCoupon: (c.youtube_coupon ?? '').trim() !== '',
    hasExtendKeyword: c.extend_keyword === '1w' || c.extend_keyword === '3d',
  };
}

/** friends.metadata.stripeCustomerId（友だち追加時の create_stripe_customer が書く）を読む */
export async function getStripeCustomerIdFromFriendMeta(db: D1Database, lineUserId: string): Promise<string | null> {
  const row = await db.prepare('SELECT metadata FROM friends WHERE line_user_id = ?').bind(lineUserId).first<{ metadata: string }>();
  if (!row) return null;
  try {
    const meta = JSON.parse(row.metadata || '{}') as { stripeCustomerId?: string };
    return meta.stripeCustomerId || null;
  } catch {
    return null;
  }
}

/** furim_customers → friends.metadata の順で Stripe 顧客IDを解決する */
export async function resolveStripeCustomerId(db: D1Database, lineUserId: string): Promise<string | null> {
  const c = await getFurimCustomer(db, lineUserId);
  if (c?.stripe_customer_id) return c.stripe_customer_id;
  return getStripeCustomerIdFromFriendMeta(db, lineUserId);
}
