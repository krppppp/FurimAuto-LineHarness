import { toJstString } from '@line-crm/db';
import { buildInsertStatements, fetchSheetRows, getSheetSpec, jst, loadResolveContext, mapSheetRows, type SheetRow } from './sheet-backfill.js';

/**
 * シート「自動化処理履歴」→ D1 furim_execution_logs の差分取り込み（Capsec #296・2026-09-17）。
 *
 * 【なぜ要るか】拡張 4.3.1 以降は実行ログを D1 に直接送るが、旧版の会員（9/17 時点で 36 人）は
 * まだシートに送っている。切り替え時の一括取り込み（sheet-backfill）が 9/14 で終わったため、
 * 以降の旧版の会員の実行が D1 に入らない。シートだけでも D1 だけでも件数を数え間違える
 * （9/13〜9/16 に「3 日連続減少」と誤報した）。D1 を完全にして、トップも巡回も D1 だけで数えられるようにする。
 *
 * 【移行が終わるまでの一時的な仕組み】旧経路の会員が 0 人になったら何もしない（終わりの条件）。
 *
 * 【権限管理課経由で動かす】くろさんの決定（2026-09-17）。広告費の取り込みの例外には当たらない
 * （例外は専用テーブルへの書き込みで、これは既存の実行ログの表に書くため）。6 時間ごとの cron に載せてあり、
 * デプロイは権限管理課が行う。
 *
 * 重複は起きない: 行ごとに「重複防止キー」（無ければ行のハッシュ）を dedupe_key にして
 * INSERT OR IGNORE する（sheet-backfill と同じ対応表を使う）。何度流しても増えない。
 */

/** 旧経路の会員とみなす: 直近この日数に GAS への接続があり、拡張の新経路への接続が一度も無い */
export const LEGACY_ACTIVE_DAYS = 7;
/** 取り込む範囲の基本: 処理日時がこの日数以内の行（全 1.3 万行を毎回流さない） */
export const SYNC_LOOKBACK_DAYS = 2;
/** 取り込み済みの最新からさかのぼる余裕。止まっていた間の抜けも、次の回で自動で埋まる */
export const SYNC_WATERMARK_BUFFER_HOURS = 24;

export type ExecutionSyncResult =
  | { stopped: true; reason: string; legacyMembers: number }
  | { stopped: false; dryRun: boolean; since: string; legacyMembers: number; sheetRows: number; inRange: number; mapped: number; statements: number };

/** 旧経路（シートに書く版）の会員が何人残っているか */
export async function countLegacyMembers(db: D1Database, nowMs: number): Promise<number> {
  const since = toJstString(new Date(nowMs - LEGACY_ACTIVE_DAYS * 86400_000)).slice(0, 19);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM furim_customers
       WHERE ext_last_seen_at IS NULL
         AND gas_last_seen_at IS NOT NULL
         AND substr(replace(gas_last_seen_at, ' ', 'T'), 1, 19) >= ?`,
    )
    .bind(since)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * 取り込む範囲の下限（JST の 'YYYY-MM-DDTHH:MM:SS'）。
 * 「直近 2 日」と「D1 に取り込み済みのシート由来の最新 − 24 時間」の、古い方を使う。
 * 取り込みが止まっていた期間（2026-09-14 08:52 以降など）があっても、次の回で抜けを埋める。
 */
export function syncSince(nowMs: number, lastImportedJst: string | null): string {
  const byDays = toJstString(new Date(nowMs - SYNC_LOOKBACK_DAYS * 86400_000)).slice(0, 19);
  if (!lastImportedJst) return byDays;
  const lastMs = Date.parse(lastImportedJst.replace(' ', 'T').slice(0, 19) + '+09:00');
  if (Number.isNaN(lastMs)) return byDays;
  const byWatermark = toJstString(new Date(lastMs - SYNC_WATERMARK_BUFFER_HOURS * 3600_000)).slice(0, 19);
  return byWatermark < byDays ? byWatermark : byDays;
}

/** D1 に取り込み済みのシート由来の行の最新時刻 */
export async function lastImportedSheetRow(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT MAX(substr(replace(created_at, ' ', 'T'), 1, 19)) AS last FROM furim_execution_logs WHERE client = 'sheet'")
    .first<{ last: string | null }>();
  return row?.last ?? null;
}

/**
 * 取り込みが完走した印を心拍の表に残す（Capsec #296）。トップが「7 時間止まったら黄」に使う。
 * 移行完了で何もしなかった回も「動いた」として書く（止まったのではないので）
 */
export async function recordSheetSyncHeartbeat(db: D1Database, result: ExecutionSyncResult, nowJst: string = toJstString(new Date())): Promise<void> {
  await db
    .prepare(
      `INSERT INTO furim_health_heartbeat (id, last_run_at, mode, note) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_run_at = excluded.last_run_at, mode = excluded.mode, note = excluded.note`,
    )
    .bind('sheet_execution_sync', nowJst, result.stopped ? 'stopped' : 'sync', JSON.stringify(result).slice(0, 500))
    .run();
}

/** 処理日時が since 以降の行だけ残す（処理日時が読めない行は安全側で残す。重複は dedupe_key が防ぐ） */
export function filterRecentRows(rows: SheetRow[], since: string): SheetRow[] {
  return rows.filter((r) => {
    const at = jst(r['処理日時']);
    return at === null || at.replace(' ', 'T').slice(0, 19) >= since;
  });
}

export async function syncExecutionLogsFromSheet(
  db: D1Database,
  gasDeployId: string,
  opts: { dryRun: boolean; nowMs?: number },
): Promise<ExecutionSyncResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const legacyMembers = await countLegacyMembers(db, nowMs);
  if (legacyMembers === 0) {
    return { stopped: true, reason: '旧経路の会員が 0 人になったので取り込みは不要（移行完了）', legacyMembers };
  }

  const spec = getSheetSpec('execution-logs');
  if (!spec) throw new Error('execution-logs の対応表が見つからない');

  const since = syncSince(nowMs, await lastImportedSheetRow(db));
  const rows = await fetchSheetRows(gasDeployId, spec);
  const recent = filterRecentRows(rows, since);
  const ctx = await loadResolveContext(db, toJstString(new Date(nowMs)));
  const mapped = await mapSheetRows(spec, recent, ctx);
  const stmts = buildInsertStatements(db, mapped.rows);

  if (!opts.dryRun && stmts.length) {
    for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  }
  console.log('[furim/sheet-execution-sync]', JSON.stringify({ dryRun: opts.dryRun, since, legacyMembers, sheetRows: rows.length, inRange: recent.length, mapped: mapped.rows.length }));
  return { stopped: false, dryRun: opts.dryRun, since, legacyMembers, sheetRows: rows.length, inRange: recent.length, mapped: mapped.rows.length, statements: stmts.length };
}
