// スプレッドシート（顧客マスター）⇄ D1 furim_customers の初期投入と差分検知（Capsec #243・2026-09-13）。
//
// - backfillFurimCustomers: getData 全件を furim_customers に upsert（初回投入・復旧用。dryRun 既定）
// - reconcileFurimCustomers: 30 分毎（JST :15 / :45）にシート全件と D1 を突き合わせ、
//     1. シートが正の列（device_activated=端末判定文字列）を D1 に取り込む
//     2. D1 が正の列のズレを furim_sync_diffs に記録し、30 分以上続くものをスタッフへ 1 回だけ通知する
//   自動修正はしない（判断はくろさん／秘書経由で D1 を更新）。
// サブリクエスト上限対策で、D1 は全件 1 クエリで読み、変化行だけ batch で書く。
import { jstNow } from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import { gasGet, getGasErrorFromResponse } from './gas-client.js';
import { buildUpsertStatement, formatJstIso, parseJstDateTime, type FurimCustomer, type FurimCustomerPatch } from './customer-store.js';
import { notifyStaff } from './staff-notify.js';
import { isJstMinuteWindow } from './cron-window.js';
import type { PushEnv } from '../services/push-notify.js';

export const MASTER_SHEET = '顧客情報-サブスク情報-キーコード';
const GAS_TIMEOUT_MS = 120_000;
const CHUNK = 100;
export const DIFF_GRACE_MINUTES = 30;
// 通知本文に載せる件数の上限
const NOTIFY_DETAIL_LIMIT = 5;

export type SheetRow = Record<string, unknown>;

// D1 が正の列（ズレたら diff として記録・通知）
export const D1_OWNED_FIELDS = [
  'key_code',
  'key_code_issued',
  'stripe_customer_id',
  'survey_answer',
  'free30_ticket',
  'youtube_coupon',
  'extend_keyword',
] as const;
type D1OwnedField = (typeof D1_OWNED_FIELDS)[number];

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function bool01(v: unknown): number {
  if (v === true) return 1;
  const s = String(v ?? '').trim().toUpperCase();
  return s === 'TRUE' || s === '1' ? 1 : 0;
}

function jstText(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const t = parseJstDateTime(s);
  return t == null ? s : formatJstIso(t);
}

function int(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** シート 1 行 → furim_customers の列。派生式は GAS getLimitedGiftStatus.js と同じ */
export function sheetRowToPatch(row: SheetRow): FurimCustomerPatch {
  return {
    stripe_customer_id: str(row['Stripe顧客ID']),
    key_code: str(row['キーコード']),
    key_code_issued: bool01(row['初回発行']),
    device_activated: str(row['端末判定文字列']) ? 1 : 0,
    survey_answer: str(row['アンケート回答']),
    free30_ticket: bool01(row['Free30チケット']),
    youtube_coupon: str(row['Youtubeクーポン']),
    extend_keyword: str(row['延長キーワード']),
    // 段階2（migration 069）: サブスク・拡張が読む値
    subscription_id: str(row['サブスクID']),
    subscription_start_at: jstText(row['サブスク登録日時']),
    subscription_end_at: jstText(row['サブスク終了日時']),
    subscription_price: int(row['サブスク価格']),
    plan_label: str(row['プラン名']),
    copy_tickets: int(row['コピー出品チケット']),
    mercari_url: str(row['メルカリURL']),
    // 段階3（migration 071）: 拡張の認証・ログを Worker が受ける
    device_code: str(row['端末判定文字列']),
    shops_url: str(row['ShopsURL']),
    rakuma_url: str(row['ラクマURL']),
    yahoo_flea_url: str(row['ヤフフリURL']),
    inventory_sheet_url: str(row['在庫管理シート']),
  };
}

// 機能フラグ列の見出しは「日本語名\n(機能キー)」。mChangePrice の列から右を機能列とみなす（GAS getKeyCodeSet と同じ）
const FEATURE_KEY_RE = /\(([A-Za-z]+)\)/;
const FIRST_FEATURE_KEY = 'mChangePrice';

/** シート 1 行 → furim_feature_flags の値（'1' / '0' / 文字列）。機能列が無ければ空 */
export function sheetRowToFeatureFlags(row: SheetRow): Record<string, string> {
  const out: Record<string, string> = {};
  let started = false;
  for (const header of Object.keys(row)) {
    const m = String(header).match(FEATURE_KEY_RE);
    if (!m) continue;
    if (!started) {
      if (m[1] !== FIRST_FEATURE_KEY) continue;
      started = true;
    }
    const v = row[header];
    if (v === true) out[m[1]] = '1';
    else if (v === false) out[m[1]] = '0';
    else {
      // 文字列列（AutoMultiChannel = 巡回サイト）は空文字も含めそのまま。GAS も空セルを "" で返していた
      const s = v == null ? '' : String(v).trim();
      const upper = s.toUpperCase();
      out[m[1]] = upper === 'TRUE' ? '1' : upper === 'FALSE' ? '0' : s;
    }
  }
  return out;
}

function buildFeatureFlagUpserts(db: D1Database, lineUserId: string, flags: Record<string, string>, now: string, source = 'sheet'): D1PreparedStatement[] {
  return Object.entries(flags).map(([key, value]) =>
    db
      .prepare(
        `INSERT INTO furim_feature_flags (line_user_id, feature_key, value, source, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(line_user_id, feature_key) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at
         WHERE furim_feature_flags.locked = 0`,
      )
      .bind(lineUserId, key, value, source, now),
  );
}

/** Worker が値を決めて書く機能フラグ（在庫管理シート無料お試しなど）。GAS がシートに書く値と同じものを D1 に先に置く */
export async function upsertFeatureFlags(db: D1Database, lineUserId: string, flags: Record<string, string>, source = 'worker'): Promise<void> {
  await runBatches(db, buildFeatureFlagUpserts(db, lineUserId, flags, jstNow(), source));
}

const FLAG_PULL_TIMEOUT_MS = 8_000;

/**
 * 1 顧客分の機能フラグをシートから取り込む（段階3・Capsec #245）。
 * GAS の syncFeaturesFromSubscription / enableInventorySheet が機能列を書いた直後に呼び、拡張の認証（D1 読み）に
 * 30 分待たせない。失敗しても投げない（30 分毎の差分検知 cron が保険）
 */
export async function pullFeatureFlagsFromSheet(db: D1Database, gasDeployId: string | undefined, lineUserId: string | null | undefined): Promise<boolean> {
  if (!gasDeployId || !lineUserId) return false;
  try {
    const res = await gasGet(
      gasDeployId,
      { method: 'getData', sheet: MASTER_SHEET, headerRow: '3', filterCol: 'LINE_ID', filterVal: lineUserId },
      { timeoutMs: FLAG_PULL_TIMEOUT_MS },
    );
    const failure = getGasErrorFromResponse(res);
    if (failure) throw new Error(failure);
    const rows = (res as { rows?: SheetRow[] })?.rows;
    const row = Array.isArray(rows) ? rows.find((r) => sheetRowLineUserId(r) === lineUserId) : undefined;
    if (!row) return false;
    const flags = sheetRowToFeatureFlags(row);
    if (!Object.keys(flags).length) return false;
    await runBatches(db, buildFeatureFlagUpserts(db, lineUserId, flags, jstNow()));
    console.log('[furim/customer-sync] feature flags pulled:', lineUserId, Object.keys(flags).length);
    return true;
  } catch (e) {
    console.warn('[furim/customer-sync] pullFeatureFlagsFromSheet failed (cron が取り込む):', lineUserId, String(e));
    return false;
  }
}

// 旧拡張（GAS 経路）の間だけシートが正の列: 差分検知 cron が D1 に取り込む。
// Worker 経由で 1 度でも認証した顧客（ext_last_seen_at が非 NULL）は D1 だけが正（段階3・Capsec #245）。
// copy_tickets は段階2.5（#254）から D1 が正（旧拡張の消費は GAS updateCopyCredit → /api/furim/ticket-consumed で届く）
const SHEET_OWNED_FIELDS = ['device_activated', 'device_code', 'mercari_url', 'shops_url', 'rakuma_url', 'yahoo_flea_url'] as const;

// LINE ユーザーID の形式（U + 32 桁 hex）。getData はヘッダーより上のテンプレ行・型注記行
// （LINE_ID="String"）も返すので、形式で弾く
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/;

export function sheetRowLineUserId(row: SheetRow): string {
  const id = String(row['LINE_ID'] ?? '').trim();
  return LINE_USER_ID_RE.test(id) ? id : '';
}

export async function fetchMasterRows(gasDeployId: string): Promise<SheetRow[]> {
  const res = await gasGet(gasDeployId, { method: 'getData', sheet: MASTER_SHEET, headerRow: '3' }, { timeoutMs: GAS_TIMEOUT_MS });
  const failure = getGasErrorFromResponse(res);
  if (failure) throw new Error(`getData(${MASTER_SHEET}) failed: ${failure}`);
  const data = res as { success?: boolean; rows?: SheetRow[] };
  if (data?.success !== true || !Array.isArray(data.rows)) throw new Error(`getData(${MASTER_SHEET}) unexpected response`);
  return data.rows;
}

async function runBatches(db: D1Database, stmts: D1PreparedStatement[]): Promise<number> {
  let changes = 0;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    const results = await db.batch(stmts.slice(i, i + CHUNK));
    changes += results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
  }
  return changes;
}

// ── 初期投入 ──────────────────────────────────────────────

export type BackfillResult = {
  dryRun: boolean;
  totalRows: number;
  targetCount: number;
  upserted: number;
  sample: Array<{ lineUserId: string } & FurimCustomerPatch>;
};

export async function backfillFurimCustomers(
  db: D1Database,
  gasDeployId: string,
  opts: { dryRun: boolean },
): Promise<BackfillResult> {
  const rows = await fetchMasterRows(gasDeployId);
  const targets = rows
    .map((row) => ({ lineUserId: sheetRowLineUserId(row), ...sheetRowToPatch(row) }))
    .filter((t) => t.lineUserId);
  if (opts.dryRun) {
    return { dryRun: true, totalRows: rows.length, targetCount: targets.length, upserted: 0, sample: targets.slice(0, 5) };
  }
  const now = jstNow();
  const stmts = targets.map(({ lineUserId, ...patch }) => buildUpsertStatement(db, lineUserId, { ...patch, sheet_synced_at: now }));
  const upserted = await runBatches(db, stmts);
  console.log('[furim/backfill-customers]', JSON.stringify({ totalRows: rows.length, targetCount: targets.length, upserted }));
  return { dryRun: false, totalRows: rows.length, targetCount: targets.length, upserted, sample: targets.slice(0, 5) };
}

export type BackfillExtResult = {
  dryRun: boolean;
  totalRows: number;
  targetCount: number;
  customersUpserted: number;
  flagsUpserted: number;
  sample: Array<{ lineUserId: string; patch: FurimCustomerPatch; flagCount: number }>;
};

/**
 * 段階3 の初期投入（Capsec #245）: シートから「拡張の認証が読む列」だけを D1 に写す。
 * 端末判定文字列・各サイト URL・在庫管理シート・機能フラグ。D1 が正の列（キーコード・期限・チケット残）は触らない。
 * 端末判定文字列とメルカリURL は Worker 経由で認証済みの顧客（ext_last_seen_at あり）には書かない
 */
export async function backfillFurimExtColumns(
  db: D1Database,
  gasDeployId: string,
  opts: { dryRun: boolean },
): Promise<BackfillExtResult> {
  const rows = await fetchMasterRows(gasDeployId);
  const d1All = await db.prepare('SELECT line_user_id, ext_last_seen_at FROM furim_customers').all<{ line_user_id: string; ext_last_seen_at: string | null }>();
  const seen = new Map<string, string | null>();
  for (const r of d1All.results ?? []) seen.set(r.line_user_id, r.ext_last_seen_at);

  const targets: Array<{ lineUserId: string; patch: FurimCustomerPatch; flags: Record<string, string> }> = [];
  for (const row of rows) {
    const lineUserId = sheetRowLineUserId(row);
    if (!lineUserId || !seen.has(lineUserId)) continue;
    const full = sheetRowToPatch(row);
    const patch: FurimCustomerPatch = {
      shops_url: full.shops_url ?? null,
      rakuma_url: full.rakuma_url ?? null,
      yahoo_flea_url: full.yahoo_flea_url ?? null,
      inventory_sheet_url: full.inventory_sheet_url ?? null,
    };
    if (!seen.get(lineUserId)) {
      patch.device_code = full.device_code ?? null;
      patch.device_activated = full.device_activated;
      patch.mercari_url = full.mercari_url ?? null;
    }
    targets.push({ lineUserId, patch, flags: sheetRowToFeatureFlags(row) });
  }
  const sample = targets.slice(0, 5).map((t) => ({ lineUserId: t.lineUserId, patch: t.patch, flagCount: Object.keys(t.flags).length }));
  if (opts.dryRun) {
    return { dryRun: true, totalRows: rows.length, targetCount: targets.length, customersUpserted: 0, flagsUpserted: 0, sample };
  }
  const now = jstNow();
  const customersUpserted = await runBatches(db, targets.map((t) => buildUpsertStatement(db, t.lineUserId, t.patch)));
  const flagStmts: D1PreparedStatement[] = [];
  for (const t of targets) flagStmts.push(...buildFeatureFlagUpserts(db, t.lineUserId, t.flags, now));
  const flagsUpserted = await runBatches(db, flagStmts);
  console.log('[furim/backfill-ext-columns]', JSON.stringify({ totalRows: rows.length, targetCount: targets.length, customersUpserted, flagsUpserted }));
  return { dryRun: false, totalRows: rows.length, targetCount: targets.length, customersUpserted, flagsUpserted, sample };
}

// ── 差分検知 ──────────────────────────────────────────────

type DiffRow = {
  id: string;
  line_user_id: string;
  field: string;
  d1_value: string | null;
  sheet_value: string | null;
  first_seen_at: string;
  last_seen_at: string;
  notified_at: string | null;
  resolved_at: string | null;
};

export type ObservedDiff = { lineUserId: string; field: string; d1Value: string | null; sheetValue: string | null };

function fieldToText(v: unknown): string | null {
  if (v == null) return null;
  return String(v);
}

/** シート行と D1 行を比べて、D1 が正の列のズレを返す（純粋関数・テスト対象） */
export function diffCustomerRow(lineUserId: string, sheetPatch: FurimCustomerPatch, d1: FurimCustomer): ObservedDiff[] {
  const out: ObservedDiff[] = [];
  for (const f of D1_OWNED_FIELDS) {
    const a = fieldToText(d1[f as D1OwnedField]);
    const b = fieldToText(sheetPatch[f as D1OwnedField]);
    if ((a ?? '') !== (b ?? '')) out.push({ lineUserId, field: f, d1Value: a, sheetValue: b });
  }
  return out;
}

export type ReconcileResult = {
  skipped?: 'gate';
  sheetRows: number;
  d1Rows: number;
  pulled: number;
  flagsPulled?: number;
  observedDiffs: number;
  newDiffs: number;
  resolvedDiffs: number;
  notified: number;
};

/** 5 分 cron の JST :15 / :45 の tick だけ true（:00 セグメント同期・:30 GAS 認可チェックを避ける） */
export function isReconcileTick(now = Date.now()): boolean {
  return isJstMinuteWindow(now, 15) || isJstMinuteWindow(now, 45);
}

export const RECONCILE_STALL_MINUTES = 45;
export const RECONCILE_LAST_COMPLETED_KEY = 'furim:customer-sync:last-completed-at';
export const RECONCILE_STALL_NOTIFIED_KEY = 'furim:customer-sync:stall-notified-at';
type StallKv = Pick<KVNamespace, 'get' | 'put' | 'delete'>;

function toJstIso(ms: number): string {
  return new Date(ms + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
}

export async function recordReconcileCompleted(kv: StallKv, completedAt: number): Promise<void> {
  await kv.put(RECONCILE_LAST_COMPLETED_KEY, toJstIso(completedAt));
  if (await kv.get(RECONCILE_STALL_NOTIFIED_KEY)) await kv.delete(RECONCILE_STALL_NOTIFIED_KEY);
}

export async function checkReconcileStall(
  kv: StallKv,
  db: D1Database,
  lineClient: LineClient | null,
  env: PushEnv & { GAS_DEPLOY_ID?: string },
  now: number,
): Promise<'skipped' | 'baseline' | 'ok' | 'notified' | 'already-notified'> {
  if (!env.GAS_DEPLOY_ID) return 'skipped';
  const last = await kv.get(RECONCILE_LAST_COMPLETED_KEY);
  const lastMs = last ? Date.parse(last) : NaN;
  if (!Number.isFinite(lastMs)) {
    await kv.put(RECONCILE_LAST_COMPLETED_KEY, toJstIso(now));
    return 'baseline';
  }
  const minutes = Math.floor((now - lastMs) / 60_000);
  if (minutes < RECONCILE_STALL_MINUTES) return 'ok';
  if (await kv.get(RECONCILE_STALL_NOTIFIED_KEY)) return 'already-notified';
  await notifyStaff(
    db,
    lineClient,
    env,
    {
      title: '顧客マスターの差分検知が止まっています',
      body: `最後の完走 ${last}（${minutes} 分前）`,
      url: '/friends',
      lineText: [
        `顧客マスター⇄D1 の差分検知（JST :15/:45）が ${minutes} 分完走していません`,
        `最後の完走: ${last}`,
        'シートからの取り込み（端末判定・メルカリURL・機能フラグ）と差分の通知も止まっています。wrangler tail の [furim/customer-sync] と [cron] furim customer-sync error を確認してください。',
      ].join('\n'),
    },
    'furim/customer-sync',
  );
  await kv.put(RECONCILE_STALL_NOTIFIED_KEY, toJstIso(now));
  console.warn(`[furim/customer-sync] stall alert sent: last=${last} minutes=${minutes}`);
  return 'notified';
}

export async function reconcileFurimCustomers(
  db: D1Database,
  lineClient: LineClient | null,
  env: PushEnv & { GAS_DEPLOY_ID?: string },
  opts: { force?: boolean; now?: number } = {},
): Promise<ReconcileResult> {
  const empty: ReconcileResult = { sheetRows: 0, d1Rows: 0, pulled: 0, observedDiffs: 0, newDiffs: 0, resolvedDiffs: 0, notified: 0 };
  if (!env.GAS_DEPLOY_ID) return empty;
  if (!opts.force && !isReconcileTick(opts.now)) return { ...empty, skipped: 'gate' };

  const nowMs = opts.now ?? Date.now();
  const nowJst = jstNow();
  const rows = await fetchMasterRows(env.GAS_DEPLOY_ID);
  const d1All = await db.prepare('SELECT * FROM furim_customers').all<FurimCustomer>();
  const d1 = new Map<string, FurimCustomer>();
  for (const r of d1All.results ?? []) d1.set(r.line_user_id, r);
  const flagRows = await db.prepare('SELECT line_user_id, feature_key, value, locked FROM furim_feature_flags').all<{ line_user_id: string; feature_key: string; value: string; locked: number | null }>();
  const flagsByUser = new Map<string, Record<string, string>>();
  const lockedByUser = new Map<string, Set<string>>();
  for (const f of flagRows.results ?? []) {
    let m = flagsByUser.get(f.line_user_id);
    if (!m) { m = {}; flagsByUser.set(f.line_user_id, m); }
    m[f.feature_key] = f.value;
    if (f.locked) {
      let l = lockedByUser.get(f.line_user_id);
      if (!l) { l = new Set(); lockedByUser.set(f.line_user_id, l); }
      l.add(f.feature_key);
    }
  }

  const stmts: D1PreparedStatement[] = [];
  const observed: ObservedDiff[] = [];
  const seenSheet = new Set<string>();
  let pulled = 0;
  let flagsPulled = 0;

  for (const row of rows) {
    const lineUserId = sheetRowLineUserId(row);
    if (!lineUserId || seenSheet.has(lineUserId)) continue;
    seenSheet.add(lineUserId);
    const patch = sheetRowToPatch(row);
    const cur = d1.get(lineUserId);
    if (!cur) {
      observed.push({ lineUserId, field: 'row_missing_in_d1', d1Value: null, sheetValue: patch.key_code ?? '(row)' });
      continue;
    }
    // 1. 旧拡張（GAS 経路）の顧客だけ、シートが正の列を取り込む（端末判定文字列・チケット残数・メルカリURL）。
    //    Worker 経由で認証済み（ext_last_seen_at あり）の顧客は Worker が書いた D1 の値を上書きしない
    if (!cur.ext_last_seen_at) {
      const pull: FurimCustomerPatch = {};
      for (const f of SHEET_OWNED_FIELDS) {
        const sheetVal = patch[f] ?? null;
        const d1Val = cur[f] ?? null;
        if (String(sheetVal ?? '') !== String(d1Val ?? '')) (pull as Record<string, unknown>)[f] = sheetVal;
      }
      if (Object.keys(pull).length) {
        stmts.push(buildUpsertStatement(db, lineUserId, { ...pull, sheet_synced_at: nowJst }));
        pulled++;
      }
    }
    // 1'. 機能フラグ: 旧プラン（プラン一覧ベース）の顧客は GAS setKeyCode がシートにしか書かないので変化分を取り込む（段階3・Capsec #245）。
    //     plan-builder 契約の顧客は Worker が D1 に先に書く（段階2.5・feature-flags.ts）ので、鏡写しの遅れで巻き戻さないよう取り込まない
    if (cur.subscription_source !== 'plan-builder') {
      const sheetFlags = sheetRowToFeatureFlags(row);
      const d1Flags = flagsByUser.get(lineUserId) ?? {};
      const changed: Record<string, string> = {};
      const locked = lockedByUser.get(lineUserId);
      for (const [k, v] of Object.entries(sheetFlags)) if (d1Flags[k] !== v && !locked?.has(k)) changed[k] = v;
      if (Object.keys(changed).length) {
        stmts.push(...buildFeatureFlagUpserts(db, lineUserId, changed, nowJst));
        flagsPulled++;
      }
    }
    // 2. D1 が正の列のズレ
    observed.push(...diffCustomerRow(lineUserId, patch, cur));
  }
  for (const lineUserId of d1.keys()) {
    if (!seenSheet.has(lineUserId)) observed.push({ lineUserId, field: 'row_missing_in_sheet', d1Value: d1.get(lineUserId)?.key_code ?? '(row)', sheetValue: null });
  }

  // 「D1 が正しく、シート側の誤り」と人が判断して受け入れた差分（notified_at が 'accepted:' 始まり）は、
  // シートの値が同じままなら数え直さない。シートは凍結で直せないため、解決済みにしても次の回で
  // 新しい行として出直していた（2026-09-17 テストリセット後の行・他人の Stripe 顧客 ID・Capsec #289）。
  // シートの値が変われば別の差分として出る
  const acceptedRes = await db
    .prepare("SELECT line_user_id, field, sheet_value FROM furim_sync_diffs WHERE resolved_at IS NOT NULL AND notified_at LIKE 'accepted:%'")
    .all<{ line_user_id: string; field: string; sheet_value: string | null }>();
  const accepted = new Set((acceptedRes.results ?? []).map((a) => `${a.line_user_id}|${a.field}|${a.sheet_value ?? ''}`));
  if (accepted.size) {
    for (let i = observed.length - 1; i >= 0; i--) {
      const o = observed[i];
      if (accepted.has(`${o.lineUserId}|${o.field}|${o.sheetValue ?? ''}`)) observed.splice(i, 1);
    }
  }

  // 未解決の diff と突き合わせ: 継続は last_seen 更新、新規は INSERT、消えたものは resolved
  const openRes = await db.prepare('SELECT * FROM furim_sync_diffs WHERE resolved_at IS NULL').all<DiffRow>();
  const open = new Map<string, DiffRow>();
  for (const r of openRes.results ?? []) open.set(`${r.line_user_id}|${r.field}`, r);
  const stillOpen = new Set<string>();
  let newDiffs = 0;
  for (const o of observed) {
    const key = `${o.lineUserId}|${o.field}`;
    stillOpen.add(key);
    const ex = open.get(key);
    if (ex) {
      stmts.push(
        db.prepare('UPDATE furim_sync_diffs SET d1_value = ?, sheet_value = ?, last_seen_at = ? WHERE id = ?').bind(o.d1Value, o.sheetValue, nowJst, ex.id),
      );
    } else {
      newDiffs++;
      stmts.push(
        db
          .prepare('INSERT INTO furim_sync_diffs (id, line_user_id, field, d1_value, sheet_value, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), o.lineUserId, o.field, o.d1Value, o.sheetValue, nowJst, nowJst),
      );
    }
  }
  let resolvedDiffs = 0;
  for (const [key, r] of open) {
    if (!stillOpen.has(key)) {
      resolvedDiffs++;
      stmts.push(db.prepare('UPDATE furim_sync_diffs SET resolved_at = ? WHERE id = ?').bind(nowJst, r.id));
    }
  }
  if (stmts.length) await runBatches(db, stmts);

  // 3. 猶予（鏡写しジョブの遅れ）を超えて続く未通知の diff を 1 回だけ通知
  const cutoff = new Date(nowMs - DIFF_GRACE_MINUTES * 60_000 + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
  const dueRes = await db
    .prepare('SELECT * FROM furim_sync_diffs WHERE resolved_at IS NULL AND notified_at IS NULL AND first_seen_at <= ? ORDER BY first_seen_at LIMIT 200')
    .bind(cutoff)
    .all<DiffRow>();
  const due = dueRes.results ?? [];
  let notified = 0;
  if (due.length > 0) {
    const ids = [...new Set(due.map((d) => d.line_user_id))].slice(0, NOTIFY_DETAIL_LIMIT);
    const names = new Map<string, string>();
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const nameRows = await db.prepare(`SELECT line_user_id, display_name FROM friends WHERE line_user_id IN (${placeholders})`).bind(...ids).all<{ line_user_id: string; display_name: string | null }>();
      for (const n of nameRows.results ?? []) names.set(n.line_user_id, n.display_name ?? '');
    }
    const lines = due.slice(0, NOTIFY_DETAIL_LIMIT).map((d) => {
      const name = names.get(d.line_user_id) || d.line_user_id.slice(0, 8);
      return `• ${name} / ${d.field}: D1=${d.d1_value ?? '(空)'} / シート=${d.sheet_value ?? '(空)'}`;
    });
    const text = [
      `⚠️ 顧客マスターと D1 の差分 ${due.length} 件（${DIFF_GRACE_MINUTES} 分以上継続）`,
      ...lines,
      due.length > NOTIFY_DETAIL_LIMIT ? `…他 ${due.length - NOTIFY_DETAIL_LIMIT} 件` : null,
      '自動修正はしません。D1（furim_customers）を正として確認し、直す場合は秘書/課経由で D1 を更新してください。',
    ].filter(Boolean).join('\n');
    await notifyStaff(db, lineClient, env, { title: '顧客マスターと D1 の差分', body: `${due.length} 件（${DIFF_GRACE_MINUTES}分以上継続）`, url: '/friends', lineText: text }, 'furim/customer-sync');
    await runBatches(db, due.map((d) => db.prepare('UPDATE furim_sync_diffs SET notified_at = ? WHERE id = ?').bind(nowJst, d.id)));
    notified = due.length;
    console.warn(`[furim/customer-sync] diff alert sent: ${due.length} 件`);
  }

  const result: ReconcileResult = { sheetRows: rows.length, d1Rows: d1.size, pulled, flagsPulled, observedDiffs: observed.length, newDiffs, resolvedDiffs, notified };
  console.log('[furim/customer-sync]', JSON.stringify(result));
  return result;
}
