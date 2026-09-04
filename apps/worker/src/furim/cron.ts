// FurimAuto 独自の定期ジョブ。scheduled.ts (upstream 共有ファイル) からは
// この3関数を呼ぶだけにして、upstream マージ時のコンフリクトを最小化する。
import type { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../index.js';
import { setFirebaseAuthToken } from './firebase-client.js';
import { processPendingCouponNotifications } from '../services/coupon-notifications.js';
import { processKaisetsuDeliveries } from '../services/kaisetsu-delivery.js';
import { syncSegmentsFromGas } from '../services/segment-sync.js';
import { sweepPendingStripeEvents } from '../services/stripe-processor.js';
import { sweepGasRetryJobs } from './gas-retry-queue.js';

type Bindings = Env['Bindings'];

/** scheduled() 冒頭で呼ぶ。待たずに waitUntil へ逃がす軽量ジョブ群。 */
export function furimCronPrelude(env: Bindings, ctx: ExecutionContext): void {
  setFirebaseAuthToken(env.FIREBASE_DB_SECRET);
  // FurimAuto: 毎時0分に GAS sendStepMessages（セグメント判定・シナリオ切替）
  const jstMinutes = new Date(Date.now() + 9 * 60 * 60_000).getUTCMinutes();
  if (jstMinutes === 0 && env.GAS_DEPLOY_ID) {
    const gasUrl = `https://script.google.com/macros/s/${env.GAS_DEPLOY_ID}/exec`;
    ctx.waitUntil(
      fetch(gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'sendStepMessages' }),
      }).catch((err) => console.error('[cron] GAS sendStepMessages error:', err)),
    );
  }

  // GASキープウォーム: 5分ごとの軽量ping（シート非接触・doGetで即return）。
  // 低頻度時間帯のコールドスタート緩和（キーコード発行等の体感遅延・無応答対策）
  if (env.GAS_DEPLOY_ID) {
    ctx.waitUntil(
      fetch(`https://script.google.com/macros/s/${env.GAS_DEPLOY_ID}/exec?method=ping`, { redirect: 'follow' })
        .catch((err) => console.error('[cron] GAS ping error:', err)),
    );
  }

  // アンバサダー紹介URLの再試行（毎回）: 友だち追加時の processReferral が、被紹介者の
  // GASマスター登録(CF eventFollow)より先に走って保留になったケースを catch-up で成立させる。
  // タイミング非依存で確実に紹介成立させるための機構（冪等・silent）。
  if (env.GAS_DEPLOY_ID && env.FURIM_AMBASSADOR_OFFER_ID) {
    ctx.waitUntil(
      import('./keyword-actions.js')
        .then(({ retryPendingAmbassadorReferrals }) => retryPendingAmbassadorReferrals(env, env.DB))
        .catch((err) => console.error('[cron] ambassador referral retry error:', err)),
    );
  }

  // 広告CVのcatch-up再送（毎回・冪等）: follow webhook の CV送信が ref_tracking
  // 書き込みとのサブ秒レースでスキップされた分を回収する（2026-08-18監査で実害確認）。
  ctx.waitUntil(
    import('../services/ad-conversion.js')
      .then(({ retryMissedAdConversions }) => retryMissedAdConversions(env.DB))
      .catch((err) => console.error('[cron] ad-conversion retry error:', err)),
  );

  // GASシート認可ヘルスチェック: 毎時30分にシート読み取りを実叩きし、
  // 認可失効（7日周期事故の再発）を顧客報告より先に検知してスタッフへWeb Push
  if (jstMinutes === 30) {
    ctx.waitUntil(
      import('../services/gas-health.js')
        .then(({ checkGasSheetAuth }) => checkGasSheetAuth(env.DB, env))
        .catch((err) => console.error('[cron] gas-health error:', err)),
    );
  }

  // LIFF ID 取り違え検知: 案内先(env.LIFF_URL)とフロントに焼かれたIDの突き合わせ。
  // 比較のみで外部通信は無いので毎tick走らせ、通知だけ毎時15分に絞る
  // （2026-08-18の事故は丸2日誰も気づけなかった）
  ctx.waitUntil(
    import('../services/liff-health.js')
      .then(({ checkLiffIdConsistency }) =>
        checkLiffIdConsistency(env.DB, env, { notify: jstMinutes === 15 }),
      )
      .catch((err) => console.error('[cron] liff-health error:', err)),
  );
}

/** 配信系と並列で走らせるジョブ群 (Promise.allSettled に載せる)。 */
export function furimCronJobs(env: Bindings, defaultLineClient: LineClient): Promise<unknown>[] {
  return [
    processKaisetsuDeliveries(env.DB, env.LINE_CHANNEL_ACCESS_TOKEN, env.GAS_DEPLOY_ID), // 試用終盤クロージング配信
    syncSegmentsFromGas(env.DB, env.GAS_DEPLOY_ID), // 毎時セグメント同期（内部で毎時:00ゲート・旧GASトリガーの置き換え）
    processPendingCouponNotifications(env.DB, env), // クーポン付与のLINE通知 (3分猶予後)
    // pendingのまま滞留したstripe_eventsの再処理（052/054のdurable設計の消費側。
    // 未配線のままpendingが永久放置される事故が2026-08-01〜05に8件発生した対策）
    sweepPendingStripeEvents(env.DB, env),
    // GAS呼び出しの再実行キュー（migration 059）。キーコードリセット等がインラインで
    // 完遂できなかった場合にここが完遂させ、完了をユーザーへpushする
    // （2026-08-13 GASフェッチのハング対策。積み側は keyword-actions）
    sweepGasRetryJobs(env.DB, defaultLineClient, env),
  ];
}

/** 6時間 cron tick でだけ走らせるジョブ。 */
export async function furimCronSixHourly(env: Bindings): Promise<void> {
  // プロフィール画像 URL の 404 化スイープ
  try {
    const { sweepStalePictureUrls } = await import('../routes/profile-refresh.js');
    const result = await sweepStalePictureUrls(env.DB, env);
    console.log(
      `[profile-sweep] checked=${result.checked} stale=${result.stale} updated=${result.updated} notFound=${result.notFound} otherErrors=${result.otherErrors}`,
    );
  } catch (e) {
    console.error('profile-sweep error:', e);
  }
}
