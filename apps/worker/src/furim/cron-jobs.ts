import type { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../index.js';
import { processPendingCouponNotifications } from '../services/coupon-notifications.js';
import { processKaisetsuDeliveries } from '../services/kaisetsu-delivery.js';
import { syncSegments } from '../services/segment-sync.js';
import { sweepPendingStripeEvents } from '../services/stripe-processor.js';
import { watchPlanChangeIntents } from './plan-change-watch.js';
import { isJstMinuteWindow } from './cron-window.js';

// cron のうち FurimAuto 専用の処理。scheduled が FURIM_MODE=off でないときだけ呼ぶ（TB-2209）
export function furimCronJobs(
  event: ScheduledEvent,
  env: Env['Bindings'],
  defaultLineClient: LineClient,
): Promise<unknown>[] {
  const jobs: Promise<unknown>[] = [];
  jobs.push(
    processKaisetsuDeliveries(env.DB, env.LINE_CHANNEL_ACCESS_TOKEN, { syncTrials: true }), // furim: 試用終盤クロージング配信（対象は D1 から）
    syncSegments(env.DB), // furim: 毎時セグメント同期（D1 算出・内部で毎時:00ゲート・旧GASトリガーの置き換え）
    processPendingCouponNotifications(env.DB, env), // furim: クーポン付与のLINE通知 (3分猶予後)
  );
  // pendingのまま滞留したstripe_eventsの再処理（052/054のdurable設計の消費側。
  // 未配線のままpendingが永久放置される事故が2026-08-01〜05に8件発生した対策）
  jobs.push(sweepPendingStripeEvents(env.DB, env));
  // プラン変更（PB-…）の未反映検知: LINE でコード送信済みなのに 30分経っても used_at が無い、
  // または used なのに Stripe に反映が無いものを1回だけ通知する（Capsec #240）
  jobs.push(watchPlanChangeIntents(env.DB, defaultLineClient, env));
  // 日次ヘルス巡回そのものが止まっていないか（Capsec #292）。巡回は Mac の launchd で動くので、
  // 見張りは Worker 側に置く（Mac が落ちても鳴るように）。3/24/48 時間で 1 通ずつ
  jobs.push(
    import('./patrol-watch.js')
      .then(({ watchPatrolHeartbeat }) => watchPatrolHeartbeat(env.DB, defaultLineClient))
      .catch((err) => console.error('[cron] patrol-watch error:', err)),
  );
  // 週1セミナーの日程アンケート（Capsec #331 → TB-821）。土曜 9:00 JST に翌日曜からの週ぶんを有料/未課金の2種で送る。
  // 曜日・時刻の判定と二重送信の枠取りは sendSeminarSurvey の中で行う（日曜 9:00 にはもう送らない）
  jobs.push(
    import('./seminar.js')
      .then(({ sendSeminarSurvey }) => sendSeminarSurvey(env.DB, defaultLineClient, env, { nowMs: event.scheduledTime }))
      .then(async (r) => {
        if (r.sent || r.reason === 'quota' || r.reason === 'noSlots') console.log('[cron] seminar survey', JSON.stringify(r));
        // 送信量が確かめられない・足りないときは送らずにくろさんへ1行（仕様: weekly-seminar-funnel.md）
        if (!r.sent && r.reason === 'quota') {
          const { notifyStaff } = await import('./staff-notify.js');
          await notifyStaff(env.DB, defaultLineClient, env, { title: 'セミナーのアンケートを送れませんでした', body: `LINE の送信量を確認できませんでした（${r.note ?? ''}）。プランの確認をお願いします。` }, 'furim/seminar');
        }
      })
      .catch((err) => console.error('[cron] seminar survey error:', err)),
  );
  // 同・日曜 17:00 の集計と、日程アンケートに答えた人だけへの告知＋聞きたい内容アンケート（TB-821）
  jobs.push(
    import('./seminar.js')
      .then(async ({ announceSeminar, countNoFitVotes }) => {
        const r = await announceSeminar(env.DB, defaultLineClient, env, { nowMs: event.scheduledTime });
        if (r.sent) {
          const noFit = await countNoFitVotes(env.DB, r.weekId);
          const { notifyStaff } = await import('./staff-notify.js');
          const lines = r.chosen.map((c, i) => `${i + 1}. ${c.starts_at.slice(0, 16)} … ${c.votes} 票`).join('\n');
          await notifyStaff(env.DB, defaultLineClient, env, { title: `今週のセミナー日程が決まりました（${r.weekId}）`, body: `${lines}\n「どれも合わない」${noFit} 人。回答者 ${r.recipients} 人のうち ${r.delivered} 人へ告知と内容アンケートを送りました。` }, 'furim/seminar');
        } else if (r.reason === 'noVotes' || r.reason === 'noStreamUrl') {
          // 5 分ごとに鳴らさないよう :00 の tick だけ通知する
          if (isJstMinuteWindow(event.scheduledTime, 0)) {
            const { notifyStaff } = await import('./staff-notify.js');
            const body = r.reason === 'noVotes' ? `${r.note ?? ''}。今週は開催なしとして、告知は送っていません。` : '配信 URL（YouTube の /live）が未登録のため告知を送れません。';
            await notifyStaff(env.DB, defaultLineClient, env, { title: `セミナーの告知を送れませんでした（${r.weekId}）`, body }, 'furim/seminar');
          }
        }
      })
      .catch((err) => console.error('[cron] seminar announce error:', err)),
  );
  jobs.push(
    import('./seminar.js')
      .then(({ remindSeminarSlots }) => remindSeminarSlots(env.DB, defaultLineClient, env, { nowMs: event.scheduledTime }))
      .then(async (r) => {
        if (r.reminded.length > 0) console.log('[cron] seminar url', JSON.stringify(r));
        const short = r.reminded.filter((x) => x.quotaNote);
        if (short.length > 0) {
          const { notifyStaff } = await import('./staff-notify.js');
          const body = short.map((x) => `${x.slotId}: 投票者 ${x.recipients} 人だけに送り、残り ${x.others} 人には送っていません（${x.quotaNote}）`).join('\n');
          await notifyStaff(env.DB, defaultLineClient, env, { title: '生配信の URL を全員には送れませんでした', body }, 'furim/seminar');
        }
      })
      .catch((err) => console.error('[cron] seminar url error:', err)),
  );
  // 同・各枠の開始 1 時間前に、聞きたい内容アンケートの集計（票数＋その他の本文）をくろさんへ（TB-821）
  jobs.push(
    import('./seminar.js')
      .then(({ collectSeminarTopicReports }) => collectSeminarTopicReports(env.DB, { nowMs: event.scheduledTime }))
      .then(async (r) => {
        if (r.reported.length === 0) return;
        const { notifyStaff } = await import('./staff-notify.js');
        for (const x of r.reported) {
          await notifyStaff(env.DB, defaultLineClient, env, { title: '生配信の聞きたい内容（集計）', body: x.text.split('\n').slice(0, 3).join(' / '), lineText: x.text }, 'furim/seminar');
        }
      })
      .catch((err) => console.error('[cron] seminar topic report error:', err)),
  );
  // 更新 7 日前の全機能開放と案内 3 通（TB-1009）。FURIM_RENEWAL_UNLOCK=on の環境だけ動く
  if (event.cron !== '0 */6 * * *') {
    jobs.push(
      import('./renewal-unlock.js')
        .then(({ runRenewalUnlock }) => runRenewalUnlock(env.DB, defaultLineClient, env.FURIM_EXT_CACHE, env, { nowMs: event.scheduledTime }))
        .then((r) => { if (r.granted.length || r.sent.length || r.rejected.length) console.log('[cron] renewal-unlock', JSON.stringify(r)); })
        .catch((err) => console.error('[cron] renewal-unlock error:', err)),
    );
  }
  return jobs;
}
