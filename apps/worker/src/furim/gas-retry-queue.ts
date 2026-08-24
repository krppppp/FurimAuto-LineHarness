// GAS呼び出しの再実行キュー（2026-08-13新設・2026-08-14汎用化・Stripe経路統合）。
//
// Worker→GASのfetchは間欠的にハングする。2026-08-14のくろさん方針で、
// インラインのリトライは全廃して1回きり実行とし、失敗はすべてこのキューに積んで
// cron(*/5・壁時計15分)が完遂させる。GAS側はWorkerがタイムアウトで見切っても
// 実行を完走することがあるため、書き込み系は実行前に done_check で効果の有無を
// 確認し、すでにあれば実行済みと判断してスキップする（マスターシート3重行の再発防止）。
// 完遂通知は replyToken を優先し、失効時のみ push（push月間上限の節約）。
// stripe_events の sweep と同じ「durableに積んで消費側が拾う」設計だが、こちらは
// GAS呼び出し1本単位。Stripe系のGASステップもここに退避することで、イベント本体は
// 1パスで完走し、sweepによるイベント丸ごと再実行（二重送信・処理分断の温床）を
// ほぼ発生させない。
import { jstNow } from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import { gasGet, gasPost, getGasErrorFromResponse } from './gas-client.js';
import { keycodeReissuedMessages } from './messages.js';

const DEFAULT_MAX_ATTEMPTS = 5;

// cron側はGASのコールドスタート・シートロック待ちを悠然と待てる
const SWEEP_GAS_TIMEOUT_MS = 120_000;

const MASTER_SHEET = '顧客情報-サブスク情報-キーコード';

// ===== キーコードリセットの返信文（インライン成功時と再実行完遂時で共通） =====
// 「紐づいた設定のリセットが完了しました。」だけでは何が起きて次に何をすべきか
// 伝わらない（2026-08-13 くろさん指摘）。何がリセットされ・何を入力し直すかを明示し、
// キーコードはコピーしやすいよう単体メッセージで続けて送る。
// リセットの実体は端末判定文字列（キーコードと端末の紐付け）のクリアのみで、
// キーコード自体・プラン・チケット残数は変わらない（GAS resetKeyCode.js）。

export function buildKeycodeResetMessages(keyCode: string | null): Array<{ type: 'text'; text: string }> {
  const explanation = [
    '✅ リセットが完了しました。',
    '',
    '■ リセットされたもの',
    'キーコードとお使いの端末（ブラウザ）の紐づけを解除しました。',
    'キーコード自体・ご契約プラン・チケット残数はそのまま残っています。',
    '',
    '■ お手数ですが次の対応をお願いいたします',
    keyCode
      ? '次のメッセージでお送りするキーコードをコピーして、拡張機能のキーコード欄にもう一度入力してください。'
      : 'リッチメニューの「キーコード発行」をタップしてキーコードを取得し、拡張機能のキーコード欄にもう一度入力してください。',
  ].join('\n');
  const messages: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: explanation }];
  // キーコードはコピーしやすいよう単体メッセージで送る（LINEはメッセージ単位でしかコピーできない）
  if (keyCode) messages.push({ type: 'text', text: keyCode });
  return messages;
}

// 現在のキーコードを取得する。取れなくても呼び出し元はリセット完了の案内自体は返せる
// ようにnullで返す（getKeyCodeはエラー時 keyCode:"エラーコード(401)" を返す仕様）。
export async function fetchCurrentKeyCode(gasDeployId: string, lineUserId: string): Promise<string | null> {
  try {
    const data = await gasGet(gasDeployId, { method: 'getKeyCode', lineUserId }, { timeoutMs: SWEEP_GAS_TIMEOUT_MS }) as { keyCode?: string } | null;
    const kc = data?.keyCode ?? '';
    if (!kc || kc.includes('エラーコード')) return null;
    return kc;
  } catch (err) {
    console.warn('[gas-retry] キーコード取得に失敗（案内はメニュー誘導にフォールバック）:', String(err));
    return null;
  }
}

export type GasRetryJobInput = {
  lineUserId: string;
  method: string;
  params?: Record<string, unknown>;
  // 'get'（doGet・デフォルト）| 'post'（doPost。setCustomerData等の書き込み系）
  callType?: 'get' | 'post';
  // 完遂通知に使う。失効していたらpushにフォールバック
  replyToken?: string | null;
  // 実行前の「実行済みチェック」キー（下のDONE_CHECKS）。非冪等な書き込み系は必ず指定する
  doneCheck?: string | null;
  // 重複積み防止の判定キー。省略時はmethod（同一ユーザー×同一メソッドで1件）。
  // stripe系は「method:StripeイベントID」で一意化し、同一ユーザーの別インボイス分を落とさない
  dedupeKey?: string;
  // 省略時5。台帳書き込み系はGASの長時間障害に耐えるため20を指定する
  maxAttempts?: number;
  // 完遂時にユーザーへ送る文言。nullなら通知しない（method個別の組み立てが優先）
  notifyMessage?: string | null;
};

export async function enqueueGasRetryJob(db: D1Database, job: GasRetryJobInput): Promise<void> {
  const dedupeKey = job.dedupeKey ?? job.method;
  // 同一ユーザー×同一dedupe_keyのpendingが既にあれば積まない。
  // ボタン連打でジョブが多重に積まれて完遂通知（push）が乱打されるのを防ぐ
  const existing = await db.prepare(
    `SELECT id FROM gas_retry_jobs WHERE line_user_id = ? AND COALESCE(dedupe_key, method) = ? AND status = 'pending' LIMIT 1`,
  ).bind(job.lineUserId, dedupeKey).first();
  if (existing) {
    console.log(`[gas-retry] 同一pendingジョブがあるため積み直しをスキップ dedupeKey=${dedupeKey} lineUserId=${job.lineUserId}`);
    return;
  }
  const now = jstNow();
  await db.prepare(
    `INSERT INTO gas_retry_jobs (id, line_user_id, method, params, call_type, reply_token, done_check, dedupe_key, max_attempts, notify_message, attempts, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?)`,
  ).bind(
    crypto.randomUUID(), job.lineUserId, job.method, JSON.stringify(job.params ?? {}),
    job.callType ?? 'get', job.replyToken ?? null, job.doneCheck ?? null,
    dedupeKey, job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, job.notifyMessage ?? null,
    now, now,
  ).run();
}

// ===== 実行前の「実行済みチェック」 =====
// true を返したら「GAS側で既に完遂している」ので実行せずdoneにする。
// チェック自体が失敗（throw）したら、書き込み系ジョブなので実行もスキップして
// 次回巡回に回す（重複書き込みのリスクを取らない）。

type QueueJobRow = { line_user_id: string; params: string };
type DoneCheckFn = (gasDeployId: string, job: QueueJobRow) => Promise<boolean>;

function jobParams(job: QueueJobRow): Record<string, unknown> {
  return JSON.parse(job.params || '{}') as Record<string, unknown>;
}

// claudeApi getData でシート行を取得する（読み取り専用・done_check用）
async function fetchSheetRows(
  gasDeployId: string,
  sheet: string,
  headerRow: number,
  filterCol: string,
  filterVal: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await gasGet(gasDeployId, {
    method: 'getData', sheet, headerRow: String(headerRow), filterCol, filterVal,
  }, { timeoutMs: SWEEP_GAS_TIMEOUT_MS });
  const failure = getGasErrorFromResponse(res);
  if (failure) throw new Error(`getData(${sheet}) failed: ${failure}`);
  const data = res as { success?: boolean; rows?: Array<Record<string, unknown>> };
  if (data?.success !== true || !Array.isArray(data.rows)) throw new Error(`getData(${sheet}) unexpected response`);
  return data.rows;
}

// シート値(ISO/TZ付き)とargs値(JST文字列/TZ無し)が混在するため、双方をepochに正規化して比較する
export function toEpoch(value: unknown): number | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  const t = Date.parse(hasTz ? iso : `${iso}+09:00`);
  return Number.isNaN(t) ? null : t;
}

export const DONE_CHECKS: Record<string, DoneCheckFn> = {
  // setCustomerData: マスターシートに同一LINE_IDの行が既にあれば実行済み
  customerRowExists: async (gasDeployId, job) => {
    const data = await gasGet(gasDeployId, { method: 'getStripeIDwithLINEID', lineUserId: job.line_user_id }, { timeoutMs: SWEEP_GAS_TIMEOUT_MS }) as Record<string, string> | null;
    const stripeId = data?.customer_stripe_id || data?.stripeCustomerId || data?.stripeID || data?.data;
    return !!stripeId;
  },

  // setSubscriptionData: マスター行のサブスクIDと終了日時が書き込み予定値と一致していれば実行済み。
  // 通算支払い回数/総額の加算・プレミアムチケット+200が非冪等なため、再実行は必ずここで防ぐ
  subscriptionRecorded: async (gasDeployId, job) => {
    const p = jobParams(job);
    const customerId = String(p.stripeCustomerID ?? '');
    if (!customerId) throw new Error('subscriptionRecorded: stripeCustomerID missing');
    const rows = await fetchSheetRows(gasDeployId, MASTER_SHEET, 3, 'Stripe顧客ID', customerId);
    const wantEnd = toEpoch(p.subscriptionEndDateTime);
    return rows.some((r) => {
      if (String(r['サブスクID'] ?? '') !== String(p.subscriptionID ?? '')) return false;
      // 終了日時が引数に無い（Stripe API取得失敗）場合はサブスクID一致のみで判定
      if (wantEnd == null) return true;
      const gotEnd = toEpoch(r['サブスク終了日時']);
      return gotEnd != null && Math.abs(gotEnd - wantEnd) <= 60_000;
    });
  },

  // setTransactionData: 取引台帳に同一インボイスIDの行があれば実行済み（無条件appendのため）
  transactionRecorded: async (gasDeployId, job) => {
    const p = jobParams(job);
    const invoiceId = String(p.invoiceID ?? '');
    if (!invoiceId) throw new Error('transactionRecorded: invoiceID missing');
    const rows = await fetchSheetRows(gasDeployId, 'サブスクトランザクション', 1, 'インボイスID', invoiceId);
    return rows.length > 0;
  },

  // deleteSubscription: 既にキャンセル済みなら実行済み。
  // さらに行のサブスクIDが対象と不一致（削除完遂後の空欄・ユーザーが再契約済みの別ID）の場合も
  // 実行してはいけない（実行すると現契約のキーコード・機能フラグを消す事故になる）ためdone扱い
  subscriptionDeleted: async (gasDeployId, job) => {
    const p = jobParams(job);
    const customerId = String(p.stripeCustomerID ?? '');
    if (!customerId) throw new Error('subscriptionDeleted: stripeCustomerID missing');
    const rows = await fetchSheetRows(gasDeployId, MASTER_SHEET, 3, 'Stripe顧客ID', customerId);
    if (rows.length === 0) return true; // 行自体が無ければGAS側もno-op
    const row = rows[0];
    // くろさんが解約理由を「キャンセル済み(商材が合わない)」のように追記するため前方一致で見る
    if (String(row['プラン名'] ?? '').startsWith('キャンセル済み')) return true;
    if (String(row['サブスクID'] ?? '') !== String(p.subscriptionID ?? '')) return true;
    return false;
  },

  // setTicketTransaction: チケット台帳に同一決済(請求書ID=paymentIntentId)の行があれば実行済み
  ticketTransactionRecorded: async (gasDeployId, job) => {
    const p = jobParams(job);
    const paymentIntentId = String(p.paymentIntentId ?? '');
    if (!paymentIntentId) throw new Error('ticketTransactionRecorded: paymentIntentId missing');
    const rows = await fetchSheetRows(gasDeployId, 'チケットトランザクション', 1, '請求書ID', paymentIntentId);
    return rows.length > 0;
  },
};

// 完遂通知: replyTokenを優先し、失効・使用済みならpushにフォールバック。
// pushは月間上限（5000通プラン）を食うため、生きているreplyTokenがあれば必ずそちらを使う
async function notifyUser(
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string | null,
  messages: never[],
): Promise<void> {
  if (replyToken) {
    try {
      await lineClient.replyMessage(replyToken, messages);
      return;
    } catch (err) {
      console.warn(`[gas-retry] replyToken返信に失敗（pushにフォールバック）: ${String(err)}`);
    }
  }
  await lineClient.pushMessage(lineUserId, messages);
}

// cronから呼ぶ。pendingのジョブを拾ってGASを再実行し、成功したら通知して完了にする。
// 1回の巡回で10件まで（GASが不調のときに叩きすぎない）。
export async function sweepGasRetryJobs(
  db: D1Database,
  lineClient: LineClient,
  env: { GAS_DEPLOY_ID?: string },
): Promise<void> {
  if (!env.GAS_DEPLOY_ID) return;
  const rows = await db.prepare(
    `SELECT id, line_user_id, method, params, call_type, reply_token, done_check, notify_message, attempts, max_attempts FROM gas_retry_jobs
     WHERE status = 'pending' ORDER BY created_at LIMIT 10`,
  ).all<{ id: string; line_user_id: string; method: string; params: string; call_type: string; reply_token: string | null; done_check: string | null; notify_message: string | null; attempts: number; max_attempts: number }>();

  for (const job of rows.results ?? []) {
    const maxAttempts = job.max_attempts || DEFAULT_MAX_ATTEMPTS;
    if (job.attempts >= maxAttempts) {
      await db.prepare(`UPDATE gas_retry_jobs SET status = 'failed', updated_at = ? WHERE id = ?`)
        .bind(jstNow(), job.id).run();
      console.error(`[gas-retry] 上限到達で断念 method=${job.method} lineUserId=${job.line_user_id} (${maxAttempts}回)`);
      continue;
    }
    try {
      // 実行前の実行済みチェック: GAS側はWorkerが見切っても完走していることがある
      const check = job.done_check ? DONE_CHECKS[job.done_check] : null;
      if (check && await check(env.GAS_DEPLOY_ID, job)) {
        await db.prepare(`UPDATE gas_retry_jobs SET status = 'done', last_error = 'skipped: already done', updated_at = ? WHERE id = ?`)
          .bind(jstNow(), job.id).run();
        console.log(`[gas-retry] 実行済みのためスキップ method=${job.method} lineUserId=${job.line_user_id}`);
        continue;
      }

      const params = jobParams(job);
      // `__` プレフィックスは通知判定用のメタデータ。GASには送らない
      const gasParams = Object.fromEntries(Object.entries(params).filter(([k]) => !k.startsWith('__')));
      let result: unknown;
      if (job.call_type === 'post') {
        result = await gasPost(env.GAS_DEPLOY_ID, { method: job.method, ...gasParams }, { timeoutMs: SWEEP_GAS_TIMEOUT_MS });
      } else {
        const getParams = Object.fromEntries(Object.entries(gasParams).map(([k, v]) => [k, String(v)]));
        result = await gasGet(env.GAS_DEPLOY_ID, { method: job.method, lineUserId: job.line_user_id, ...getParams }, { timeoutMs: SWEEP_GAS_TIMEOUT_MS });
      }

      // GASはHTTP 200のまま失敗を返すことがある（{success:false} / HTMLエラーページ）
      const failure = getGasErrorFromResponse(result);
      if (failure) throw new Error(failure);

      // キーコード発行はマスター行が未作成のうちは "エラーコード(401)" を返す。
      // その間は失敗扱いで残し、行が出来てから（setCustomerDataジョブの完遂後に）発行して届ける
      if (job.method === 'getKeyCode') {
        const kc = (result as { keyCode?: string } | null)?.keyCode ?? '';
        if (!kc || kc.includes('エラーコード')) throw new Error(`keycode not ready: ${kc || '(empty)'}`);
      }

      try {
        if (job.method === 'resetKeyCode') {
          // リセットの完遂通知は説明＋キーコード単体のセットで送る（インライン成功時と同じ体験）
          const keyCode = await fetchCurrentKeyCode(env.GAS_DEPLOY_ID, job.line_user_id);
          await notifyUser(lineClient, job.line_user_id, job.reply_token, buildKeycodeResetMessages(keyCode) as never[]);
        } else if (job.method === 'getKeyCode') {
          // キーコード発行の完遂通知はキーコード単体（インライン成功時と同じ）
          const keyCode = (result as { keyCode: string }).keyCode;
          await notifyUser(lineClient, job.line_user_id, job.reply_token, [{ type: 'text', text: keyCode }] as never[]);
        } else if (job.method === 'syncFeaturesFromSubscription') {
          // 更新時のキーコード再発行通知（インライン成功時のstripe-processorと同じ文面）。
          // GAS完走済み・Worker見切りのケースでは再実行時 keyCodeIssued=false になり
          // 通知は送られない（ユーザーはメニューの「キーコード発行」で自己回復可能）
          const r = result as { keyCodeIssued?: boolean; keyCode?: string } | null;
          if (params.__notifyKeycodeReissue === '1' && r?.keyCodeIssued && r.keyCode) {
            await notifyUser(lineClient, job.line_user_id, job.reply_token, keycodeReissuedMessages(r.keyCode) as never[]);
          }
        } else if (job.notify_message) {
          await notifyUser(lineClient, job.line_user_id, job.reply_token, [{ type: 'text', text: job.notify_message }] as never[]);
        }
      } catch (e) {
        // 通知が落ちても処理自体は完遂している。doneにして通知失敗だけ記録する
        console.error(`[gas-retry] 完遂通知に失敗 method=${job.method}`, e);
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
