// GAS呼び出しの再実行キュー（2026-08-13新設）。
//
// Worker→GASのfetchは間欠的にハングする（同日のキーコードリセット無言死の真因）。
// インラインのリトライで完遂できなかった処理をD1に積み、cron(*/5)が完遂させる。
// ユーザーには受付済みの旨を即返し、完遂時に通知メッセージをpushする。
// stripe_events の sweep と同じ「durableに積んで消費側が拾う」設計。
import { jstNow } from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import { gasGet } from './gas-client.js';

const MAX_ATTEMPTS = 5;

export type GasRetryJobInput = {
  lineUserId: string;
  method: string;
  params?: Record<string, string>;
  // 完遂時にユーザーへpushする文言。nullなら通知しない
  notifyMessage?: string | null;
};

export async function enqueueGasRetryJob(db: D1Database, job: GasRetryJobInput): Promise<void> {
  const now = jstNow();
  await db.prepare(
    `INSERT INTO gas_retry_jobs (id, line_user_id, method, params, notify_message, attempts, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 'pending', ?, ?)`,
  ).bind(crypto.randomUUID(), job.lineUserId, job.method, JSON.stringify(job.params ?? {}), job.notifyMessage ?? null, now, now).run();
}

// cronから呼ぶ。pendingのジョブを拾ってGASを再実行し、成功したら通知して完了にする。
// 1回の巡回で5件まで（GASが不調のときに叩きすぎない）。
export async function sweepGasRetryJobs(
  db: D1Database,
  lineClient: LineClient,
  env: { GAS_DEPLOY_ID?: string },
): Promise<void> {
  if (!env.GAS_DEPLOY_ID) return;
  const rows = await db.prepare(
    `SELECT id, line_user_id, method, params, notify_message, attempts FROM gas_retry_jobs
     WHERE status = 'pending' ORDER BY created_at LIMIT 5`,
  ).all<{ id: string; line_user_id: string; method: string; params: string; notify_message: string | null; attempts: number }>();

  for (const job of rows.results ?? []) {
    if (job.attempts >= MAX_ATTEMPTS) {
      await db.prepare(`UPDATE gas_retry_jobs SET status = 'failed', updated_at = ? WHERE id = ?`)
        .bind(jstNow(), job.id).run();
      console.error(`[gas-retry] 上限到達で断念 method=${job.method} lineUserId=${job.line_user_id} (${MAX_ATTEMPTS}回)`);
      continue;
    }
    try {
      const params = JSON.parse(job.params || '{}') as Record<string, string>;
      await gasGet(env.GAS_DEPLOY_ID, { method: job.method, lineUserId: job.line_user_id, ...params });
      if (job.notify_message) {
        try {
          await lineClient.pushMessage(job.line_user_id, [{ type: 'text', text: job.notify_message } as never]);
        } catch (e) {
          // 通知が落ちても処理自体は完遂している。doneにして通知失敗だけ記録する
          console.error(`[gas-retry] 完遂通知のpushに失敗 method=${job.method}`, e);
        }
      }
      await db.prepare(`UPDATE gas_retry_jobs SET status = 'done', updated_at = ? WHERE id = ?`)
        .bind(jstNow(), job.id).run();
      console.log(`[gas-retry] 完遂 method=${job.method} lineUserId=${job.line_user_id} attempts=${job.attempts + 1}`);
    } catch (err) {
      await db.prepare(`UPDATE gas_retry_jobs SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`)
        .bind(String(err).slice(0, 500), jstNow(), job.id).run();
      console.warn(`[gas-retry] 再実行失敗 method=${job.method} attempts=${job.attempts + 1}: ${String(err)}`);
    }
  }
}
