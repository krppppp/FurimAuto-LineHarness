import { gasGet } from '../furim/gas-client.js';
import { sendPushToAll, type PushEnv } from './push-notify.js';

/**
 * GAS シート認可のヘルスチェック (FurimAuto fork 独自)。
 *
 * 2026-07: OAuth 同意画面がテスト公開ステータスだった影響で GAS のシート認可
 * (リフレッシュトークン) が7日周期で失効し、キーコード発行・顧客同期が全停止 →
 * 顧客の不具合報告で初めて気づく事故が3回発生 (7/1頃・7/7・7/13)。
 *
 * シートに実際に触る読み取り専用メソッドを毎時叩き、認可切れ (Apps Script が
 * JSON ではなく承認要求の HTML エラーページを返す / HTTP エラー) を検知したら
 * スタッフの Web Push へ即時通知する。cron の ping (シート非接触) では認可切れを
 * 検知できないため別建て。
 *
 * GAS 側の一時的な瞬断でも1回失敗しただけで通知が飛んでいたため、1分間隔で
 * 最大3回連続失敗した場合のみ通知するようにリトライを挟む (2026-07-28)。
 */

export type GasHealthEnv = PushEnv & { GAS_DEPLOY_ID?: string };

export async function checkGasSheetAuth(
  db: D1Database,
  env: GasHealthEnv,
  opts: { maxAttempts?: number; retryDelayMs?: number } = {},
): Promise<'ok' | 'unhealthy' | 'skipped'> {
  if (!env.GAS_DEPLOY_ID) return 'skipped';

  const maxAttempts = opts.maxAttempts ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 60_000;

  let detail = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // 存在しない ID でもシート読み取りが走り {customer_stripe_id: null} の JSON が返る。
      // 認可切れなら gasGet が throw するか、Google の HTML ページ (string) が返る
      const res = await gasGet(env.GAS_DEPLOY_ID, {
        method: 'getStripeIDwithLINEID',
        lineUserId: 'gas-health-canary',
      });
      if (typeof res === 'object' && res !== null) return 'ok';
      detail = String(res).slice(0, 150);
    } catch (err) {
      detail = String(err).slice(0, 200);
    }

    console.error(`[gas-health] GAS sheet auth check FAILED (attempt ${attempt}/${maxAttempts}):`, detail);
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  try {
    await sendPushToAll(db, env, {
      title: '⚠️ GAS認可エラー検知',
      body: `GASがスプレッドシートにアクセスできません（認可失効の可能性、${maxAttempts}回連続失敗）。キーコード発行・顧客同期が止まっています。Apps Scriptを開いて再認可してください。`,
      url: '/notifications',
    });
  } catch (err) {
    console.error('[gas-health] alert push failed:', err);
  }
  return 'unhealthy';
}
