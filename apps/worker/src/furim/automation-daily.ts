import { EXCLUDED_LINE_IDS } from './segments.js';

/**
 * 管理画面トップ「自動化の日別件数と人数」（Capsec #296・2026-09-17 統括承認）。
 *
 * - 件数: furim_execution_logs の行数（シート取り込みと拡張の直接送信は dedupe 済み）
 * - 人数: line_user_id の異なり数。LINE ID の無い行（シート由来・キーコードも無い）は件数にだけ入れ、
 *   「人を特定できない N 件」として別に返す
 * - 社内・検証用（EXCLUDED_LINE_IDS）は除く
 * - 今日は途中なので棒に入れない。シート分は 6 時間ごとの取り込みで最大 6 時間遅れるため、判定にも使わない。
 *   代わりに「直近 7 日の同じ時刻までの累計の平均」と並べて参考に出す
 * - 判定は前日の確定分で、03 時の取り込みのあと（03:10 以降）に行う。それより前は前々日を見る。
 *   件数か人数が、判定日の前 7 日の中央値の 85% 未満で黄・70% 未満で赤
 * - 毎日の入れ替わり（11〜15 人）は平常の幅なので判定に使わない
 */

export const SERIES_DAYS = 14;
export const MEDIAN_DAYS = 7;
export const DROP_YELLOW_RATIO = 0.85;
export const DROP_RED_RATIO = 0.7;
export const CONFIRM_AFTER_HHMM = '03:10';
export const SHEET_SYNC_HEARTBEAT_ID = 'sheet_execution_sync';
export const SHEET_SYNC_STALE_HOURS = 7;

const EXCLUDED = [...EXCLUDED_LINE_IDS];
const dayCol = "substr(replace(created_at, ' ', 'T'), 1, 10)";
const timeCol = "substr(replace(created_at, ' ', 'T'), 12, 8)";
const notExcluded = `(line_user_id IS NULL OR line_user_id NOT IN (${EXCLUDED.map(() => '?').join(',')}))`;

export type AutomationDay = { t: string; runs: number; people: number; unidentified: number };

export type AutomationSummary = {
  series: AutomationDay[];
  target: AutomationDay & {
    medianRuns: number | null;
    medianPeople: number | null;
    byService: Array<{ service: string; runs: number; people: number }>;
  };
  today: { t: string; asOf: string; runs: number; people: number; sameTimeAvg: number | null };
  sheetSync: { lastRunAt: string | null; note: string | null };
};

export type AutomationDrop = {
  severity: 'red' | 'yellow';
  runsRatio: number | null;
  peopleRatio: number | null;
  /** 中央値に対して何 % 減ったか（深いほど大きい。確認済みの再表示の判定に使う） */
  depthPercent: number;
};

export function addDays(day: string, n: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`) + n * 86400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 判定の対象日。03:10 より前は前日の取り込みが揃っていないので前々日 */
export function judgeTargetDay(nowJst: string): string {
  const today = nowJst.slice(0, 10);
  const hhmm = nowJst.slice(11, 16);
  return addDays(today, hhmm >= CONFIRM_AFTER_HHMM ? -1 : -2);
}

export function judgeAutomationDrop(
  target: Pick<AutomationDay, 'runs' | 'people'>,
  medianRuns: number | null,
  medianPeople: number | null,
): AutomationDrop | null {
  const ratio = (v: number, m: number | null) => (m && m > 0 ? v / m : null);
  const runsRatio = ratio(target.runs, medianRuns);
  const peopleRatio = ratio(target.people, medianPeople);
  const worst = Math.min(runsRatio ?? Infinity, peopleRatio ?? Infinity);
  if (!Number.isFinite(worst) || worst >= DROP_YELLOW_RATIO) return null;
  return {
    severity: worst < DROP_RED_RATIO ? 'red' : 'yellow',
    runsRatio,
    peopleRatio,
    depthPercent: Math.round((1 - worst) * 100),
  };
}

const n = (v: unknown): number => Number(v ?? 0);

export async function summarizeAutomationDaily(db: D1Database, nowJst: string): Promise<AutomationSummary> {
  const today = nowJst.slice(0, 10);
  const asOf = nowJst.slice(11, 19);
  const target = judgeTargetDay(nowJst);
  const seriesFrom = addDays(target, -(SERIES_DAYS - 1));
  const medianFrom = addDays(target, -MEDIAN_DAYS);
  const from = seriesFrom < medianFrom ? seriesFrom : medianFrom;

  const daily = await db
    .prepare(
      `SELECT ${dayCol} AS t, COUNT(*) AS runs,
              COUNT(DISTINCT NULLIF(line_user_id, '')) AS people,
              SUM(CASE WHEN line_user_id IS NULL OR line_user_id = '' THEN 1 ELSE 0 END) AS unidentified
       FROM furim_execution_logs
       WHERE ${dayCol} BETWEEN ? AND ? AND ${notExcluded}
       GROUP BY t`,
    )
    .bind(from, today, ...EXCLUDED)
    .all<{ t: string; runs: number; people: number; unidentified: number }>();
  const byDay = new Map((daily.results ?? []).map((r) => [r.t, { t: r.t, runs: n(r.runs), people: n(r.people), unidentified: n(r.unidentified) }]));
  const dayOf = (t: string): AutomationDay => byDay.get(t) ?? { t, runs: 0, people: 0, unidentified: 0 };

  const series: AutomationDay[] = [];
  for (let d = seriesFrom; d <= target; d = addDays(d, 1)) series.push(dayOf(d));

  const history: AutomationDay[] = [];
  for (let d = medianFrom; d < target; d = addDays(d, 1)) history.push(dayOf(d));

  const services = await db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(service), ''), '(不明)') AS service, COUNT(*) AS runs,
              COUNT(DISTINCT NULLIF(line_user_id, '')) AS people
       FROM furim_execution_logs
       WHERE ${dayCol} = ? AND ${notExcluded}
       GROUP BY service ORDER BY runs DESC`,
    )
    .bind(target, ...EXCLUDED)
    .all<{ service: string; runs: number; people: number }>();

  const sameTime = await db
    .prepare(
      `SELECT ${dayCol} AS t, COUNT(*) AS runs
       FROM furim_execution_logs
       WHERE ${dayCol} BETWEEN ? AND ? AND ${timeCol} <= ? AND ${notExcluded}
       GROUP BY t`,
    )
    .bind(addDays(today, -MEDIAN_DAYS), addDays(today, -1), asOf, ...EXCLUDED)
    .all<{ t: string; runs: number }>();
  const sameTimeTotal = (sameTime.results ?? []).reduce((a, r) => a + n(r.runs), 0);

  let sheetSync: AutomationSummary['sheetSync'] = { lastRunAt: null, note: null };
  try {
    const hb = await db
      .prepare('SELECT last_run_at, note FROM furim_health_heartbeat WHERE id = ?')
      .bind(SHEET_SYNC_HEARTBEAT_ID)
      .first<{ last_run_at: string; note: string | null }>();
    if (hb) sheetSync = { lastRunAt: hb.last_run_at, note: hb.note };
  } catch (e) {
    console.log('[automation-daily] heartbeat skipped:', e);
  }

  const t = dayOf(target);
  const td = dayOf(today);
  return {
    series,
    target: {
      ...t,
      medianRuns: median(history.map((h) => h.runs)),
      medianPeople: median(history.map((h) => h.people)),
      byService: (services.results ?? []).map((r) => ({ service: r.service, runs: n(r.runs), people: n(r.people) })),
    },
    today: { t: today, asOf: asOf.slice(0, 5), runs: td.runs, people: td.people, sameTimeAvg: Math.round(sameTimeTotal / MEDIAN_DAYS) },
    sheetSync,
  };
}

/** シート取り込みが何時間止まっているか。心拍がまだ無い（初回の実行前）は null で判定しない */
export function sheetSyncStaleHours(lastRunAt: string | null, nowJst: string): number | null {
  if (!lastRunAt) return null;
  const last = Date.parse(lastRunAt.replace(' ', 'T').slice(0, 19) + '+09:00');
  const now = Date.parse(nowJst.slice(0, 19) + '+09:00');
  if (Number.isNaN(last) || Number.isNaN(now)) return null;
  return Math.floor((now - last) / 3600_000);
}
