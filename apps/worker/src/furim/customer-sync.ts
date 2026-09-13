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
import { buildUpsertStatement, formatJstDateTime, parseJstDateTime, type FurimCustomer, type FurimCustomerPatch } from './customer-store.js';
import { notifyStaff } from './staff-notify.js';
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
  return t == null ? s : formatJstDateTime(t);
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
    customer_email: str(row['Email']),
  };
}

// 段階2 でもシートが正の列（拡張が GAS 経由で書く）: 差分検知 cron が D1 に取り込む
const SHEET_OWNED_FIELDS = ['device_activated', 'copy_tickets', 'mercari_url'] as const;

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
  observedDiffs: number;
  newDiffs: number;
  resolvedDiffs: number;
  notified: number;
};

/** 5 分 cron の JST :15 / :45 の tick だけ true（:00 セグメント同期・:30 GAS 認可チェックを避ける） */
export function isReconcileTick(now = Date.now()): boolean {
  const m = new Date(now + 9 * 60 * 60_000).getUTCMinutes();
  return m === 15 || m === 45;
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

  const stmts: D1PreparedStatement[] = [];
  const observed: ObservedDiff[] = [];
  const seenSheet = new Set<string>();
  let pulled = 0;

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
    // 1. シートが正の列を取り込む（端末判定文字列・チケット残数・メルカリURL は拡張が GAS 経由で書く。段階3 で Worker に移る）
    {
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
    // 2. D1 が正の列のズレ
    observed.push(...diffCustomerRow(lineUserId, patch, cur));
  }
  for (const lineUserId of d1.keys()) {
    if (!seenSheet.has(lineUserId)) observed.push({ lineUserId, field: 'row_missing_in_sheet', d1Value: d1.get(lineUserId)?.key_code ?? '(row)', sheetValue: null });
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

  const result: ReconcileResult = { sheetRows: rows.length, d1Rows: d1.size, pulled, observedDiffs: observed.length, newDiffs, resolvedDiffs, notified };
  console.log('[furim/customer-sync]', JSON.stringify(result));
  return result;
}
