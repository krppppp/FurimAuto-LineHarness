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
 * 【まだ動かさない】本番 D1 に定期的に書き込むため、「広告費の取り込み」とは別に、くろさんの判断
 * （例外として認めるか・権限管理課経由にするか）が出るまで、実行も定期実行への登録もしない。
 * この関数を cron に載せるのは判断が出てから。
 *
 * 重複は起きない: 行ごとに「重複防止キー」（無ければ行のハッシュ）を dedupe_key にして
 * INSERT OR IGNORE する（sheet-backfill と同じ対応表を使う）。何度流しても増えない。
 */

/** 旧経路の会員とみなす: 直近この日数に GAS への接続があり、拡張の新経路への接続が一度も無い */
export const LEGACY_ACTIVE_DAYS = 7;
/** 取り込む範囲: 処理日時がこの日数以内の行だけ（全 1.3 万行を毎回流さない） */
export const SYNC_LOOKBACK_DAYS = 2;

export type ExecutionSyncResult =
  | { stopped: true; reason: string; legacyMembers: number }
  | { stopped: false; dryRun: boolean; legacyMembers: number; sheetRows: number; inRange: number; mapped: number; statements: number };

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

/** 処理日時が範囲内の行だけ残す（処理日時が読めない行は安全側で残す。重複は dedupe_key が防ぐ） */
export function filterRecentRows(rows: SheetRow[], nowMs: number): SheetRow[] {
  const since = toJstString(new Date(nowMs - SYNC_LOOKBACK_DAYS * 86400_000)).slice(0, 19);
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

  const rows = await fetchSheetRows(gasDeployId, spec);
  const recent = filterRecentRows(rows, nowMs);
  const ctx = await loadResolveContext(db, toJstString(new Date(nowMs)));
  const mapped = await mapSheetRows(spec, recent, ctx);
  const stmts = buildInsertStatements(db, mapped.rows);

  if (!opts.dryRun && stmts.length) {
    for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  }
  console.log('[furim/sheet-execution-sync]', JSON.stringify({ dryRun: opts.dryRun, legacyMembers, sheetRows: rows.length, inRange: recent.length, mapped: mapped.rows.length }));
  return { stopped: false, dryRun: opts.dryRun, legacyMembers, sheetRows: rows.length, inRange: recent.length, mapped: mapped.rows.length, statements: stmts.length };
}
