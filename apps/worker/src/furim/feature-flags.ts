// plan-builder の契約内容 → 機能フラグ・プラン名・pb_ キーコードを Worker が決めて D1 に先に書く
// （GAS syncFeaturesFromSubscription の判定部の移植・Capsec #244 段階2 の残・2026-09-14）。
//
// - マスタ（機能/パッケージ）は D1 furim_master に持ち、GAS getFeatureMaster から refresh する（段階4 で GAS を消す）
// - 機能フラグは furim_feature_flags に書く（拡張の認証 /api/ext/v1/key-code-set が読む）
// - キーコードの再発行は packages/features/multiChannelSites の集合比較で判定する（#238: ラベル文字列の
//   形式差で「プラン変化」と誤判定して全員再入力になる穴を塞ぐ）。D1 に集合が無い顧客（段階2 以前の
//   契約）は初回は記録だけ行い、trial/旧接頭語のキーコードだけ再発行する
// - GAS には決めた値（keyCode / keyCodeIssued / planLabel / flags）を渡して書かせる（getKeyCodeSet 廃止まで
//   旧拡張がシートを読むため）。GAS 側の判定ロジックは使わない
import { jstNow } from '@line-crm/db';
import { gasGet, getGasErrorFromResponse } from './gas-client.js';
import { getFurimCustomer, upsertFurimCustomer, type FurimCustomer, type FurimCustomerPatch } from './customer-store.js';
import { upsertFeatureFlags } from './customer-sync.js';
import { invalidateExtCache, type ExtCache } from './ext-auth.js';

export type MasterFeature = {
  feature_key: string;
  site?: string;
  display_name?: string;
  billing_type?: string;
  monthly_price?: number | string;
  stripe_price_id?: string;
  active?: unknown;
  [k: string]: unknown;
};
export type MasterPackage = {
  package_key: string;
  display_name?: string;
  features?: string;
  monthly_price?: number | string;
  stripe_price_id?: string;
  active?: unknown;
  [k: string]: unknown;
};
export type FurimMaster = { features: MasterFeature[]; packages: MasterPackage[] };

// コピー出品は「チケット制」なので契約内容に関わらず常に有効（GAS ALWAYS_ENABLED_FEATURE_KEYS と同じ）
export const ALWAYS_ENABLED_FEATURE_KEYS = ['mCopyMShopsListing', 'mCopyRakumaListing', 'mCopyYahooAuctionListing', 'mCopyYahooFleamarketListing'] as const;
// AutoMultiChannel の巡回サイト文字列（拡張 js/inventory.js の NAME_TO_KEY 準拠・"/" 区切り）
export const INVENTORY_PATROL_ALL_SITES = 'メルカリ/Shops/ラクマ/ヤフオク/ヤフフリ';
// 在庫管理シート無料プロモ（月額会員向け・2026-09-15 まで）。GAS sheetHelper.isInventoryPromoActive と同値
export function isInventoryPromoActive(nowMs = Date.now()): boolean {
  return nowMs < Date.parse('2026-09-16T00:00:00+09:00');
}

const MASTER_GAS_TIMEOUT_MS = 45_000;

// ── マスタ（furim_master） ──

function toInt(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** GAS getFeatureMaster（active=TRUE の行だけ返る）→ furim_master。応答に無いキーは active=0 に落とす */
export async function refreshFurimMaster(db: D1Database, gasDeployId: string): Promise<{ features: number; packages: number }> {
  const res = await gasGet(gasDeployId, { method: 'getFeatureMaster' }, { timeoutMs: MASTER_GAS_TIMEOUT_MS });
  const failure = getGasErrorFromResponse(res);
  if (failure) throw new Error(`getFeatureMaster failed: ${failure}`);
  const data = res as { success?: boolean; features?: MasterFeature[]; packages?: MasterPackage[] };
  if (data?.success !== true || !Array.isArray(data.features)) throw new Error('getFeatureMaster unexpected response');
  const features = data.features.filter((f) => f && f.feature_key);
  const packages = (Array.isArray(data.packages) ? data.packages : []).filter((p) => p && p.package_key);
  const now = jstNow();
  const stmts: D1PreparedStatement[] = [];
  const upsert = (kind: string, key: string, row: Record<string, unknown>) =>
    db
      .prepare(
        `INSERT INTO furim_master (kind, key, display_name, stripe_price_id, monthly_price, active, payload, fetched_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(kind, key) DO UPDATE SET display_name = excluded.display_name, stripe_price_id = excluded.stripe_price_id,
           monthly_price = excluded.monthly_price, active = 1, payload = excluded.payload, fetched_at = excluded.fetched_at`,
      )
      .bind(kind, key, row.display_name == null ? null : String(row.display_name), row.stripe_price_id == null ? null : String(row.stripe_price_id), toInt(row.monthly_price), JSON.stringify(row), now);
  for (const f of features) stmts.push(upsert('feature', String(f.feature_key), f));
  for (const p of packages) stmts.push(upsert('package', String(p.package_key), p));
  const deactivate = (kind: string, keys: string[]) => {
    if (!keys.length) return db.prepare('UPDATE furim_master SET active = 0 WHERE kind = ?').bind(kind);
    return db.prepare(`UPDATE furim_master SET active = 0 WHERE kind = ? AND key NOT IN (${keys.map(() => '?').join(',')})`).bind(kind, ...keys);
  };
  stmts.push(deactivate('feature', features.map((f) => String(f.feature_key))));
  stmts.push(deactivate('package', packages.map((p) => String(p.package_key))));
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  console.log('[furim/master] refreshed', JSON.stringify({ features: features.length, packages: packages.length }));
  return { features: features.length, packages: packages.length };
}

export async function loadFurimMaster(db: D1Database): Promise<FurimMaster> {
  const rows = await db.prepare("SELECT kind, key, payload FROM furim_master WHERE active = 1 AND kind IN ('feature', 'package')").all<{ kind: string; key: string; payload: string }>();
  const master: FurimMaster = { features: [], packages: [] };
  for (const r of rows.results ?? []) {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(r.payload || '{}') as Record<string, unknown>; } catch { /* 壊れた行は空で扱う */ }
    if (r.kind === 'feature') master.features.push({ ...payload, feature_key: r.key } as MasterFeature);
    else master.packages.push({ ...payload, package_key: r.key } as MasterPackage);
  }
  return master;
}

/** D1 のマスタを返す。空なら GAS から取り込んでから返す（gasDeployId が無ければ空のまま） */
export async function ensureFurimMaster(db: D1Database, gasDeployId?: string): Promise<FurimMaster> {
  const master = await loadFurimMaster(db);
  if (master.features.length > 0 || !gasDeployId) return master;
  await refreshFurimMaster(db, gasDeployId);
  return loadFurimMaster(db);
}

// ── 契約内容の展開 ──

export type PlanSelection = { packages: string; features: string; multiChannelSites: string };

function csv(s: string | null | undefined): string[] {
  return String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

/** GAS の featureSet と同じ: 値は true か "key=値" の値文字列。パッケージはマスタの features 列で展開 */
export function expandFeatureSet(master: FurimMaster, sel: PlanSelection): Record<string, true | string> {
  const set: Record<string, true | string> = {};
  const add = (raw: string) => {
    const s = raw.trim();
    if (!s) return;
    const eq = s.indexOf('=');
    if (eq > 0) set[s.slice(0, eq)] = s.slice(eq + 1);
    else set[s] = true;
  };
  csv(sel.features).forEach(add);
  const pkgByKey = new Map(master.packages.map((p) => [p.package_key, p]));
  for (const key of csv(sel.packages)) {
    const pkg = pkgByKey.get(key);
    if (!pkg) throw new Error(`不明なパッケージ: ${key}`);
    csv(pkg.features).forEach(add);
  }
  if (set['AutoMultiChannel'] === true) set['AutoMultiChannel'] = String(sel.multiChannelSites ?? '');
  return set;
}

/**
 * 顧客 1 人分の機能フラグ（furim_feature_flags の値）。GAS syncFeaturesFromSubscription の rowValues と同じ規則で、
 * 列（キー）の集合は マスタの機能キー ∪ 既存の D1 フラグキー ∪ 契約に含まれるキー。
 * clearAll（解約）は常時有効のコピー出品だけ残して全 OFF
 */
export function computeFeatureFlags(
  master: FurimMaster,
  existingKeys: Iterable<string>,
  sel: PlanSelection,
  opts: { clearAll?: boolean; nowMs?: number } = {},
): Record<string, string> {
  const featureSet = opts.clearAll ? {} : expandFeatureSet(master, sel);
  const keys = new Set<string>([...master.features.map((f) => f.feature_key), ...existingKeys, ...Object.keys(featureSet), ...ALWAYS_ENABLED_FEATURE_KEYS, 'InventorySheet', 'AutoMultiChannel']);
  const promoGrant = isInventoryPromoActive(opts.nowMs) && !opts.clearAll;
  const out: Record<string, string> = {};
  for (const key of keys) {
    if ((ALWAYS_ENABLED_FEATURE_KEYS as readonly string[]).includes(key)) { out[key] = '1'; continue; }
    const v = featureSet[key];
    if (key === 'AutoMultiChannel') {
      // 文字列列（巡回サイト or 空）。プロモ中は全サイトを付与し直す（GAS と同値・9/15 まで）
      out[key] = promoGrant ? INVENTORY_PATROL_ALL_SITES : (v && v !== true ? String(v) : '');
      continue;
    }
    if (key === 'InventorySheet') { out[key] = promoGrant || v === true ? '1' : '0'; continue; }
    out[key] = v === true ? '1' : '0';
  }
  return out;
}

// ── プラン名 ──

const PLAN_LABEL_SITE_NAMES: Record<string, string> = { mercari: 'メルカリ', mercariShops: 'メルカリShops', rakuma: 'ラクマ', yahooFlea: 'ヤフフリ' };

/** "PBプラン:名前+名前+…"（GAS buildPlanLabel_ と同じ）。withSitePrefix=false は旧形式（比較用） */
export function buildPlanLabel(master: FurimMaster, sel: PlanSelection, withSitePrefix = true): string {
  const names: string[] = [];
  const pkgByKey = new Map(master.packages.map((p) => [p.package_key, p]));
  const featByKey = new Map(master.features.map((f) => [f.feature_key, f]));
  for (const key of csv(sel.packages)) {
    const hit = pkgByKey.get(key);
    names.push(hit?.display_name ? String(hit.display_name) : key);
  }
  for (const raw of csv(sel.features)) {
    const eq = raw.indexOf('=');
    const key = eq > 0 ? raw.slice(0, eq) : raw;
    const hit = featByKey.get(key);
    let nm = hit?.display_name ? String(hit.display_name) : key;
    if (withSitePrefix && hit?.site && PLAN_LABEL_SITE_NAMES[String(hit.site)]) nm = PLAN_LABEL_SITE_NAMES[String(hit.site)] + nm;
    if (key === 'AutoMultiChannel' && sel.multiChannelSites) nm += '(' + sel.multiChannelSites + ')';
    names.push(nm);
  }
  return names.length ? 'PBプラン:' + names.join('+') : '';
}

// ── キーコード ──

export function generatePbKeyCode(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return 'pb_' + s;
}

function sameSet(a: string | null | undefined, b: string | null | undefined, sep: string): boolean {
  const norm = (s: string | null | undefined) => String(s ?? '').split(sep).map((x) => x.trim()).filter(Boolean).sort().join(sep);
  return norm(a) === norm(b);
}

export type KeyCodeDecision = { keyCode: string; issued: boolean; reissued: boolean; reason: 'none' | 'new' | 'trial' | 'legacy' | 'plan_change' };

/**
 * pb_ キーコードの発行/再発行判定（GAS syncFeaturesFromSubscription の 2026-07-14 改訂ルールを集合比較に置き換え）。
 * - 未発行 → 新規発行
 * - trial コードのまま有料 PB 加入 → 再発行（端末判定リセット）
 * - pb_ でも trial でもない旧接頭語 → 一度だけ再発行
 * - D1 に記録済みの集合（packages/features/multiChannelSites）と違う → 再発行
 * - 集合が未記録（段階2 以前の契約）→ 記録だけ（ラベル文字列では判定しない）
 * - 同一内容の更新課金 → そのまま
 */
export function decidePlanBuilderKeyCode(
  customer: Pick<FurimCustomer, 'key_code' | 'packages' | 'features' | 'multi_channel_sites'> | null,
  sel: PlanSelection,
  opts: { clearAll?: boolean; generate?: () => string } = {},
): KeyCodeDecision {
  const current = (customer?.key_code ?? '').trim();
  if (opts.clearAll) return { keyCode: current, issued: false, reissued: false, reason: 'none' };
  const gen = opts.generate ?? generatePbKeyCode;
  if (!current) return { keyCode: gen(), issued: true, reissued: false, reason: 'new' };
  const isTrial = current.toLowerCase().includes('trial');
  const isLegacy = !current.startsWith('pb_') && !isTrial;
  const recorded = customer?.packages != null || customer?.features != null || customer?.multi_channel_sites != null;
  const changed = recorded && !(sameSet(customer?.packages, sel.packages, ',') && sameSet(customer?.features, sel.features, ',') && sameSet(customer?.multi_channel_sites, sel.multiChannelSites, '/'));
  if (isTrial) return { keyCode: gen(), issued: true, reissued: true, reason: 'trial' };
  if (isLegacy) return { keyCode: gen(), issued: true, reissued: true, reason: 'legacy' };
  if (changed) return { keyCode: gen(), issued: true, reissued: true, reason: 'plan_change' };
  return { keyCode: current, issued: false, reissued: false, reason: 'none' };
}

// ── まとめて適用 ──

export type PlanSyncInput = PlanSelection & {
  lineUserId: string;
  stripeCustomerId?: string | null;
  subscriptionId?: string | null;
  planLabel?: string | null;       // マスタで合成できない時のフォールバック（stripe-processor の pbLabel）
  clearAll?: boolean;
  grantPremiumTickets?: boolean;
  invoiceId?: string | null;       // プレミアムチケット +200 の冪等キー
  nowMs?: number;                  // プロモ判定の基準時刻（テスト用）
};

export type PlanSyncResult = {
  keyCode: string;
  keyCodeIssued: boolean;
  keyCodeReissued: boolean;
  previousKeyCode: string | null;
  planLabel: string;
  flags: Record<string, string>;
  ticketsGranted: number;
};

export const PREMIUM_MONTHLY_TICKETS = 200;

/**
 * 契約内容を D1 に適用する（furim_customers・furim_feature_flags・furim_ticket_ledger・KV）。冪等。
 * 返り値をそのまま GAS syncFeaturesFromSubscription に渡す（gasSyncArgs）
 */
export async function applyPlanBuilderSync(db: D1Database, kv: ExtCache | undefined, gasDeployId: string | undefined, input: PlanSyncInput): Promise<PlanSyncResult> {
  const master = await ensureFurimMaster(db, gasDeployId);
  if (!input.clearAll && input.packages && master.packages.length === 0) throw new Error('furim_master にパッケージが無い（refresh-master 未実行）');
  const customer = await getFurimCustomer(db, input.lineUserId);
  const existing = await db.prepare('SELECT feature_key FROM furim_feature_flags WHERE line_user_id = ?').bind(input.lineUserId).all<{ feature_key: string }>();
  const sel: PlanSelection = { packages: input.packages ?? '', features: input.features ?? '', multiChannelSites: input.multiChannelSites ?? '' };
  const flags = computeFeatureFlags(master, (existing.results ?? []).map((r) => r.feature_key), sel, { clearAll: input.clearAll, nowMs: input.nowMs });
  const planLabel = input.clearAll ? '' : (buildPlanLabel(master, sel, true) || input.planLabel || '');
  const decision = decidePlanBuilderKeyCode(customer, sel, { clearAll: input.clearAll });

  const patch: FurimCustomerPatch = {};
  if (input.clearAll) {
    patch.packages = null;
    patch.features = null;
    patch.multi_channel_sites = null;
  } else {
    patch.packages = sel.packages;
    patch.features = sel.features;
    patch.multi_channel_sites = sel.multiChannelSites;
    if (planLabel) patch.plan_label = planLabel;
    if (input.subscriptionId) patch.subscription_id = input.subscriptionId;
    if (input.stripeCustomerId) patch.stripe_customer_id = input.stripeCustomerId;
    if (decision.issued) {
      patch.key_code = decision.keyCode;
      patch.key_code_issued = 1;
      if (decision.reissued) {
        patch.device_code = null;
        patch.device_activated = 0;
      }
    }
  }
  await upsertFurimCustomer(db, input.lineUserId, patch);
  await upsertFeatureFlags(db, input.lineUserId, flags, input.clearAll ? 'clear' : 'plan');

  let ticketsGranted = 0;
  if (input.grantPremiumTickets && !input.clearAll && input.invoiceId) {
    const { applyTicketDelta } = await import('./ticket-ledger.js');
    const r = await applyTicketDelta(db, kv, { line_user_id: input.lineUserId, key_code: decision.keyCode || customer?.key_code || null }, {
      delta: PREMIUM_MONTHLY_TICKETS,
      reason: 'premium_monthly',
      idempotencyKey: `premium_monthly:${input.invoiceId}`,
      invoiceId: input.invoiceId,
    });
    ticketsGranted = r.applied ? PREMIUM_MONTHLY_TICKETS : 0;
  }

  await invalidateExtCache(kv, customer?.key_code);
  if (decision.keyCode && decision.keyCode !== customer?.key_code) await invalidateExtCache(kv, decision.keyCode);

  console.log('[furim/plan-sync]', JSON.stringify({ lineUserId: input.lineUserId, clearAll: !!input.clearAll, keyCode: decision.keyCode, reason: decision.reason, planLabel, flags: Object.keys(flags).length, ticketsGranted }));
  return {
    keyCode: decision.keyCode,
    keyCodeIssued: decision.issued,
    keyCodeReissued: decision.reissued,
    previousKeyCode: customer?.key_code ?? null,
    planLabel,
    flags,
    ticketsGranted,
  };
}

/** GAS syncFeaturesFromSubscription に渡す「Worker が決めた値」（GAS はこれを書くだけ） */
export function gasSyncArgs(result: PlanSyncResult): { keyCode: string; keyCodeIssued: boolean; planLabel: string; flags: Record<string, string> } {
  return { keyCode: result.keyCode, keyCodeIssued: result.keyCodeIssued, planLabel: result.planLabel, flags: result.flags };
}
