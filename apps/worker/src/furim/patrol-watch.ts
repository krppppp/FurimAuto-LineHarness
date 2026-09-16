import type { LineClient } from '@line-crm/line-sdk';
import { jstNow } from '@line-crm/db';

/**
 * 日次ヘルス巡回そのものが止まったら気づく（Capsec #292・2026-09-17）。
 *
 * 巡回は Mac の launchd で動く。2026-09-09 を最後に 1 週間止まり、誰も気づかなかった。
 * 気づくのが遅れると証拠も消える（Firebase Storage のセッションログは 3 日で削除。
 * 9/10〜9/13 の停止検知は永久に追えない）。
 *
 * 見張りはこの Worker に置く。巡回自身に見張らせると死んだときに鳴らないし、
 * Mac 上の別ジョブにしても電源断・スリープで一緒に死ぬ（9/10 がまさにそれ）。
 *
 * 巡回は完走のたびに furim_health_heartbeat へ心拍を upsert する。ここはその古さだけを見る。
 */

const STAFF_LINE_USER_ID = 'U5d35c3e6b2be0a6ec699b2a1de2aba93';

/** 段階（時間）。巡回は毎時動くので 3 時間空いたら異常 */
export const PATROL_ALERT_STEPS = [
  { level: 1, hours: 3, label: '3 時間' },
  { level: 2, hours: 24, label: '24 時間' },
  { level: 3, hours: 48, label: '48 時間' },
] as const;

export type HeartbeatRow = {
  id: string;
  last_run_at: string;
  mode: string | null;
  detections: number | null;
  alert_level: number | null;
};

/** JST の ISO+09:00 / 空白区切り のどちらでも epoch に直す */
export function parseJst(value: string): number | null {
  const s = String(value ?? '').replace(' ', 'T').slice(0, 19);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}+09:00`);
  return Number.isNaN(ms) ? null : ms;
}

/** 経過時間から鳴らすべき段階を決める。まだ段階が上がっていなければ null */
export function nextAlertLevel(hoursSince: number, current: number): { level: number; label: string } | null {
  let target = 0;
  let label = '';
  for (const step of PATROL_ALERT_STEPS) {
    if (hoursSince >= step.hours) {
      target = step.level;
      label = step.label;
    }
  }
  if (target === 0 || target <= current) return null;
  return { level: target, label };
}

export async function watchPatrolHeartbeat(
  db: D1Database,
  lineClient: LineClient,
  opts: { nowMs?: number } = {},
): Promise<void> {
  const row = await db
    .prepare('SELECT id, last_run_at, mode, detections, alert_level FROM furim_health_heartbeat WHERE id = ?')
    .bind('patrol')
    .first<HeartbeatRow>();
  // 心拍が 1 行も無いときは鳴らさない（テーブルを作った直後に誤報を出さない）
  if (!row) return;

  const lastMs = parseJst(row.last_run_at);
  if (lastMs === null) return;
  const nowMs = opts.nowMs ?? Date.now();
  const hoursSince = (nowMs - lastMs) / 3600_000;
  const current = Number(row.alert_level ?? 0);

  // 巡回が戻ったら段階を 0 に戻す（次の停止でまた 1 から鳴る）
  if (hoursSince < PATROL_ALERT_STEPS[0].hours) {
    if (current !== 0) {
      await db.prepare('UPDATE furim_health_heartbeat SET alert_level = 0, alerted_at = NULL WHERE id = ?').bind('patrol').run();
    }
    return;
  }

  const next = nextAlertLevel(hoursSince, current);
  if (!next) return; // 同じ段階では二度と鳴らさない

  const text = [
    '⚠️ 日次ヘルス巡回が動いていません',
    `最後の完走: ${row.last_run_at.slice(0, 16).replace('T', ' ')}（${Math.floor(hoursSince)} 時間前）`,
    next.level >= 3
      ? 'Firebase Storage のセッションログは 3 日で消えます。このままだと停止検知の証拠が残りません。'
      : next.level >= 2
        ? '証拠（Storage のセッションログ）が消えるまであと 1 日ほどです。'
        : 'Mac の電源・launchd（com.furimauto.dailyhealth）を確認してください。',
  ].join('\n');

  await db
    .prepare('UPDATE furim_health_heartbeat SET alert_level = ?, alerted_at = ? WHERE id = ?')
    .bind(next.level, jstNow(), 'patrol')
    .run();
  try {
    await lineClient.pushMessage(STAFF_LINE_USER_ID, [{ type: 'text', text } as never]);
  } catch (e) {
    console.error('[patrol-watch] staff LINE push failed:', e);
  }
  console.warn(`[patrol-watch] alert level=${next.level} hours=${Math.floor(hoursSince)}`);
}
