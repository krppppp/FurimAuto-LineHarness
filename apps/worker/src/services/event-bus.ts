import { extractFlexAltText } from '../utils/flex-alt-text.js';

/**
 * イベントバス — システム内イベントの発火と処理
 *
 * イベント発生時に以下を実行:
 * 1. アクティブな送信Webhookへ通知
 * 2. スコアリングルール適用
 * 3. 自動化ルール(IF-THEN)実行
 * 4. 通知ルール処理
 */

import { AutomationActionRow, MessageRow,
  getActiveOutgoingWebhooksByEvent,
  applyScoring,
  getActiveAutomationsByEvent,
  getAutomationActions,
  createAutomationLog,
  getActiveNotificationRulesByEvent,
  createNotification,
  addTagToFriend,
  removeTagFromFriend,
  enrollFriendInScenario,
  completeFriendActiveScenarios,
  resolveTemplateMessages,
  jstNow,
  getFriendScore,
  hasProcessedStripeAction,
  markStripeActionProcessed,
  unmarkStripeActionProcessed,
  getStripeActionRecord,
  ensureStripeDeliveryPending,
  markStripeActionSent,
} from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import type { Message } from '@line-crm/line-sdk';
import { sendAdConversions } from './ad-conversion.js';

export interface EventPayload {
  friendId?: string;
  eventData?: Record<string, unknown>;
  conversionEventName?: string;
  conversionValue?: number;
  replyToken?: string;
  // 冪等キー(通常はstripe event id)。指定時、automationの各アクションを
  // (idempotencyKey, automationId:stepIndex) 単位で厳密1回だけ実行する。
  // cron再処理で非冪等アクション(GAS append/加算・メッセージ送信)が二重にならない。
  idempotencyKey?: string;
}

export interface ActionEnv {
  lineAccessToken?: string;
  gasDeployId?: string;
  stripeSecretKey?: string;
  lineAccountId?: string | null;
  richMenuMemberHome?: string;
  richMenuDefaultHome?: string;
}

// call_gas_post の失敗時に gas_retry_jobs キューへ退避してよい書き込み系メソッドと、
// キュー実行前の「実行済みチェック」（gas-retry-queue.ts の DONE_CHECKS キー）。
// GAS側はWorkerがタイムアウトで見切っても実行を完走することがあるため、非冪等な
// メソッドは再実行前に効果の有無を必ず確認する。リスト外のメソッドは従来どおり
// throw して stripe_events sweep（イベント丸ごと再実行）に委ねる
const GAS_QUEUE_METHODS: Record<string, { doneCheck: string | null }> = {
  setCustomerData: { doneCheck: 'customerRowExists' },
  setSubscriptionData: { doneCheck: 'subscriptionRecorded' },
  // setKeyCode はGAS側の接頭語一致ガード（同一プランなら再発行しない）が冪等性を担保する
  setKeyCode: { doneCheck: null },
  setTransactionData: { doneCheck: 'transactionRecorded' },
  deleteSubscription: { doneCheck: 'subscriptionDeleted' },
  setTicketTransaction: { doneCheck: 'ticketTransactionRecorded' },
};

/**
 * Fire an event and run all registered handlers.
 *
 * Execution is split into two sequential phases so that score_threshold
 * conditions in automation rules see the score already updated by this event:
 *
 *   Phase 1 (concurrent): outgoing webhooks + scoring
 *   Phase 2 (concurrent): automations + notifications, with currentScore injected
 */
export async function fireEvent(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
  lineAccessToken?: string,
  lineAccountId?: string | null,
  env?: ActionEnv,
): Promise<boolean> {
  // Phase 1: fire webhooks, apply scoring rules, and ad conversion postback concurrently.
  const phase1: Promise<unknown>[] = [
    fireOutgoingWebhooks(db, eventType, payload),
    processScoring(db, eventType, payload),
  ];
  if (payload.friendId && payload.conversionEventName) {
    phase1.push(
      sendAdConversions(db, payload.friendId, payload.conversionEventName, payload.conversionValue),
    );
  }
  await Promise.allSettled(phase1);

  // Build an enriched payload with the freshly-updated score.
  const enrichedPayload: EventPayload = payload.friendId
    ? {
        ...payload,
        eventData: {
          ...payload.eventData,
          currentScore: await getFriendScore(db, payload.friendId),
        },
      }
    : payload;

  // Phase 2: evaluate automations and create notifications concurrently.
  // automationsの全アクション成功可否を返す（呼び出し元が耐久再処理の要否判定に使う）。
  // 既存の呼び出し元は戻り値を無視するため挙動は不変。
  const actionEnv: ActionEnv = { lineAccessToken, ...env };
  const [autoResult] = await Promise.allSettled([
    processAutomations(db, eventType, enrichedPayload, lineAccessToken, lineAccountId, actionEnv),
    processNotifications(db, eventType, enrichedPayload, lineAccountId),
  ]);
  return autoResult.status === 'fulfilled' ? autoResult.value : false;
}

/**
 * 送信Webhookへの通知。fireEvent の Phase 1 で呼ばれるほか、friend を伴わない
 * システムイベント (quota_alert 等) の単独発火にも使う (services/quota-alert.ts)。
 * 失敗はすべて握りつぶす (best-effort)。戻り値は 2xx で受理された配信数 —
 * 呼び出し元 (quota-alert 等) が「実際に届いたか」を記録に反映できるようにする。
 * prefetched: 呼び出し元が購読者リストを取得済みなら渡すと再クエリを省ける。
 */
export async function fireOutgoingWebhooks(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
  prefetched?: Awaited<ReturnType<typeof getActiveOutgoingWebhooksByEvent>>,
): Promise<number> {
  let delivered = 0;
  try {
    const webhooks = prefetched ?? (await getActiveOutgoingWebhooksByEvent(db, eventType));
    for (const wh of webhooks) {
      try {
        const body = JSON.stringify({
          event: eventType,
          timestamp: jstNow(),
          data: payload,
        });

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };

        // HMAC署名（シークレットがある場合）
        if (wh.secret) {
          const encoder = new TextEncoder();
          const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(wh.secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
          );
          const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
          const hexSignature = Array.from(new Uint8Array(signature))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
          headers['X-Webhook-Signature'] = hexSignature;
        }

        const res = await fetch(wh.url, { method: 'POST', headers, body });
        if (res.ok) {
          delivered += 1;
        } else {
          console.error(`送信Webhook ${wh.id} への通知失敗: HTTP ${res.status}`);
        }
      } catch (err) {
        console.error(`送信Webhook ${wh.id} への通知失敗:`, err);
      }
    }
  } catch (err) {
    console.error('fireOutgoingWebhooks error:', err);
  }
  return delivered;
}

/** スコアリングルール適用 */
async function processScoring(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
): Promise<void> {
  if (!payload.friendId) return;
  try {
    await applyScoring(db, payload.friendId, eventType);
  } catch (err) {
    console.error('processScoring error:', err);
  }
}

/** 自動化ルール(IF-THEN)実行 */
async function processAutomations(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
  lineAccessToken?: string,
  lineAccountId?: string | null,
  env?: ActionEnv,
): Promise<boolean> {
  // 全マッチ automation の全アクションが成功したか。冪等キー指定時、耐久再処理の要否判定に使う。
  let allAutomationsSuccess = true;
  try {
    const allAutomations = await getActiveAutomationsByEvent(db, eventType);
    const automations = allAutomations.filter(
      (a) => !a.line_account_id || !lineAccountId || a.line_account_id === lineAccountId,
    );

    const actionEnv: ActionEnv = { lineAccessToken, ...(env ?? {}), lineAccountId };
    // 冪等キー(stripe event id等)。指定時、各アクションを厳密1回だけ実行する。
    const idemKey = payload.idempotencyKey;

    for (const automation of automations) {
      const conditions = JSON.parse(automation.conditions) as Record<string, unknown>;
      if (!matchConditions(conditions, payload)) continue;

      // automation_actions テーブルを優先、なければ旧 actions JSON にフォールバック
      const actionRows = await getAutomationActions(db, automation.id);
      const actions: Array<{ type: string; params: Record<string, unknown>; conditionJson?: Record<string, unknown> | null; onError?: string; label?: string }> =
        actionRows.length > 0
          ? actionRows.map((r: AutomationActionRow) => {
              const params = JSON.parse(r.params) as Record<string, unknown>;
              if (r.template_id && !params.template_id) params.template_id = r.template_id;
              return {
                type: r.action_type,
                params,
                conditionJson: r.condition_json ? (JSON.parse(r.condition_json) as Record<string, unknown>) : null,
                onError: r.on_error,
                label: r.label ?? undefined,
              };
            })
          : (JSON.parse(automation.actions) as Array<{ type: string; params: Record<string, unknown> }>);

      const results: Array<{ action: string; label?: string; success: boolean; error?: string }> = [];

      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        // メッセージ抑制: 発火元がeventData.suppressMessages=trueを立てた場合、
        // 配信系アクションだけスキップする（例: プラン変更のinvoiceで継続課金メッセージを出さない）
        if (action.type === 'send_messages' && payload.eventData?.suppressMessages === true) {
          results.push({ action: action.type, label: (action.label ?? '') + ' (suppressed)', success: true });
          continue;
        }
        // アクション個別の条件チェック
        if (action.conditionJson && Object.keys(action.conditionJson).length > 0) {
          if (!matchConditions(action.conditionJson, payload)) {
            results.push({ action: action.type, label: action.label, success: true });
            continue;
          }
        }

        // 冪等: このアクションが (idemKey, automationId:stepIndex) で既に成功済みならスキップ。
        // 初回waitUntil途中死→cron再処理でも、済みアクション(GAS append/加算・送信)を再実行しない。
        const actionKey = `${automation.id}:${i}`;
        const isDelivery = action.type === 'send_messages';

        // 配信系は2段階先記録（2026-08-18改訂）:
        //   premark(pending)＋X-Line-Retry-Key → 送信 → done更新。
        // 旧at-most-once先記録は「premark直後のwaitUntil打ち切り」で配信が永久ロストした
        // （2026-08-18 NakaRyuさん・黒岩さん主プランの新規登録メッセージ未達）。
        // 2段階化により再処理はpending（送信未確認）を再送する。再送は保存済みの同一
        // Retry-Keyを使うため、「実は送れていた」場合もLINE側が24時間重複排除する
        // （取りこぼしゼロ×重複ゼロ。送信成功→done更新前に死ぬraceもRetry-Keyが吸収）。
        // GAS書き込み等の非配信アクションは従来どおり成功後記録(at-least-once)のまま。
        let deliveryRetryKey: string | undefined;
        if (idemKey) {
          if (isDelivery) {
            const rec = await getStripeActionRecord(db, idemKey, actionKey);
            if (rec?.status === 'done') {
              results.push({ action: action.type, label: (action.label ?? '') + ' (already-done)', success: true });
              continue;
            }
            deliveryRetryKey = rec?.retry_key ?? crypto.randomUUID();
          } else if (await hasProcessedStripeAction(db, idemKey, actionKey)) {
            results.push({ action: action.type, label: (action.label ?? '') + ' (already-done)', success: true });
            continue;
          }
        }

        const preMark = idemKey !== undefined && isDelivery;
        try {
          if (preMark) {
            deliveryRetryKey = await ensureStripeDeliveryPending(db, idemKey, actionKey, deliveryRetryKey ?? crypto.randomUUID());
          }
          await executeAction(db, action, payload, actionEnv, deliveryRetryKey);
          results.push({ action: action.type, label: action.label, success: true });
          // 成功したアクションのみ記録（失敗は未記録→次の再処理で再実行される）
          if (idemKey && !preMark) await markStripeActionProcessed(db, idemKey, actionKey);
          if (preMark) await markStripeActionSent(db, idemKey, actionKey);
        } catch (err) {
          // 配信の例外時はpendingのまま残す（削除しない）。retry_keyを保持したまま
          // 次の再処理が同一キーで再送するため、二重配信にならずに送り直せる
          const errorMsg = err instanceof Error ? err.message : String(err);
          results.push({ action: action.type, label: action.label, success: false, error: errorMsg });
          if (action.onError === 'abort') break;
        }
      }

      const allSuccess = results.every((r) => r.success);
      const anySuccess = results.some((r) => r.success);
      if (!allSuccess) allAutomationsSuccess = false;

      await createAutomationLog(db, {
        automationId: automation.id,
        friendId: payload.friendId,
        eventData: JSON.stringify(payload.eventData ?? {}),
        actionsResult: JSON.stringify(results),
        status: allSuccess ? 'success' : anySuccess ? 'partial' : 'failed',
      });
    }
  } catch (err) {
    console.error('processAutomations error:', err);
    allAutomationsSuccess = false;
  }
  return allAutomationsSuccess;
}

/** 条件マッチング */
function matchConditions(
  conditions: Record<string, unknown>,
  payload: EventPayload,
): boolean {
  // 条件が空 → 常にマッチ
  if (Object.keys(conditions).length === 0) return true;

  // score_threshold チェック
  if (conditions.score_threshold !== undefined && payload.eventData) {
    const currentScore = payload.eventData.currentScore as number | undefined;
    if (currentScore !== undefined && currentScore < (conditions.score_threshold as number)) {
      return false;
    }
  }

  // tag_id チェック
  if (conditions.tag_id !== undefined && payload.eventData) {
    if (payload.eventData.tagId !== conditions.tag_id) return false;
  }

  // keyword チェック（message_received / postback_received イベント用）
  if (conditions.keyword !== undefined && payload.eventData) {
    const text = payload.eventData.text as string | undefined;
    if (!text || !text.includes(conditions.keyword as string)) return false;
  }

  // keyword_exact（完全一致）
  if (conditions.keyword_exact) {
    const rawText = payload.eventData?.text as string | undefined;
    const text = (rawText || '').trim();
    if (text !== conditions.keyword_exact) {
      return false;
    }
  }

  // isNewUser チェック（friend_add イベント用）
  if (conditions.isNewUser !== undefined && payload.eventData) {
    if (payload.eventData.isNewUser !== conditions.isNewUser) return false;
  }

  // remaining_days 範囲チェック（closing_daily イベント用）
  if (conditions.remaining_days_gte !== undefined && payload.eventData) {
    const rd = payload.eventData.remaining_days as number | undefined;
    if (rd === undefined || rd < (conditions.remaining_days_gte as number)) return false;
  }
  if (conditions.remaining_days_lte !== undefined && payload.eventData) {
    const rd = payload.eventData.remaining_days as number | undefined;
    if (rd === undefined || rd > (conditions.remaining_days_lte as number)) return false;
  }

  // 上記以外のキーは payload.eventData との等値マッチ
  // （isNewSubscription / source / isLegacyPlan 等。eventData に無いキーは不一致扱い）
  const specialKeys = new Set([
    'score_threshold',
    'tag_id',
    'keyword',
    'keyword_exact',
    'isNewUser',
    'remaining_days_gte',
    'remaining_days_lte',
  ]);
  for (const [key, value] of Object.entries(conditions)) {
    if (specialKeys.has(key)) continue;
    if (payload.eventData?.[key] !== value) return false;
  }

  return true;
}

/** GAS引数のテンプレート変数展開 */
async function resolveGasArgs(
  db: D1Database,
  args: Record<string, unknown>,
  friendId: string | undefined,
  payload: EventPayload,
): Promise<Record<string, unknown>> {
  const friend = friendId
    ? await db
        .prepare('SELECT id, line_user_id, display_name, metadata FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ id: string; line_user_id: string; display_name: string | null; metadata: string }>()
    : null;
  const nowJst = new Date(Date.now() + 9 * 60 * 60_000);
  // 無料試用は14日（2026-08-27 くろさん決定で7日→14日化。既存登録者は7日のまま）
  const trialEndJst = new Date(nowJst.getTime() + 14 * 24 * 60 * 60_000);
  const fmtJst = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
  const resolved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      const meta = friend ? (JSON.parse(friend.metadata || '{}') as Record<string, string>) : {};
      let s = v;
      if (friend) {
        s = s
          .replace('{{friend_id}}', friend.id)
          .replace('{{line_user_id}}', friend.line_user_id)
          .replace('{{display_name}}', friend.display_name ?? '')
          .replace('{{stripe_customer_id}}', meta.stripeCustomerId ?? '')
          .replace('{{now_jst}}', fmtJst(nowJst))
          .replace('{{trial_end_jst}}', fmtJst(trialEndJst));
      }
      // {{eventData.KEY}} — payload.eventData から動的展開
      s = s.replace(/\{\{eventData\.([^}]+)\}\}/g, (_m, key: string) =>
        String(payload.eventData?.[key] ?? ''),
      );
      resolved[k] = s;
    } else {
      resolved[k] = v;
    }
  }
  return resolved;
}

/** アクション実行 */
async function executeAction(
  db: D1Database,
  action: { type: string; params: Record<string, unknown> },
  payload: EventPayload,
  env: ActionEnv,
  // 配信系のX-Line-Retry-Key（2段階先記録の再送を重複なしにする）
  deliveryRetryKey?: string,
): Promise<void> {
  const lineAccessToken = env.lineAccessToken;
  const friendId = payload.friendId;
  const noFriendActions = ['send_webhook', 'code_managed'];
  if (!friendId && !noFriendActions.includes(action.type)) {
    throw new Error('friendId is required for this action');
  }

  const p = action.params as Record<string, string>;

  switch (action.type) {
    case 'add_tag':
      await addTagToFriend(db, friendId!, p.tagId);
      break;

    case 'remove_tag':
      await removeTagFromFriend(db, friendId!, p.tagId);
      break;

    case 'start_scenario':
      await enrollFriendInScenario(db, friendId!, p.scenarioId);
      break;

    case 'send_message': {
      if (!lineAccessToken || !friendId) break;
      const friend = await db
        .prepare('SELECT line_user_id FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ line_user_id: string }>();
      if (!friend) break;
      const lineClient = new LineClient(lineAccessToken);
      // template_id が set なら templates から content/type を resolve、なければ inline params
      let resolvedType = p.messageType || 'text';
      let resolvedContent = p.content ?? '';
      const tplId = action.params.template_id as string | undefined;
      if (tplId) {
        const { getTemplateById } = await import('@line-crm/db');
        const tpl = await getTemplateById(db, tplId);
        if (tpl) {
          resolvedType = tpl.message_type;
          resolvedContent = tpl.message_content;
        }
      }
      let msg: Message;
      let logContent: string;
      if (resolvedType === 'flex') {
        const contents = JSON.parse(resolvedContent);
        msg = { type: 'flex', altText: p.altText || extractFlexAltText(contents), contents };
        logContent = JSON.stringify(contents);
      } else {
        msg = { type: 'text', text: resolvedContent };
        logContent = resolvedContent;
      }
      let deliveryType: 'reply' | 'push';
      if (payload.replyToken) {
        try {
          await lineClient.replyMessage(payload.replyToken, [msg]);
          payload.replyToken = undefined;
          deliveryType = 'reply';
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isTokenError = errMsg.includes('400') || errMsg.includes('Invalid reply token');
          if (isTokenError) {
            await lineClient.pushMessage(friend.line_user_id, [msg]);
            deliveryType = 'push';
          } else {
            throw err;
          }
        }
      } else {
        await lineClient.pushMessage(friend.line_user_id, [msg]);
        deliveryType = 'push';
      }
      await logOutgoingMessage(db, {
        friendId,
        messageType: msg.type,
        content: logContent,
        deliveryType,
        source: 'automation',
        lineAccountId: env.lineAccountId,
      });
      break;
    }

    case 'send_webhook': {
      const url = p.url;
      if (url) {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ friendId, ...payload.eventData }),
        });
      }
      break;
    }

    case 'switch_rich_menu': {
      if (!lineAccessToken || !friendId) break;
      const friend = await db
        .prepare('SELECT line_user_id FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ line_user_id: string }>();
      if (!friend) break;
      // p.richMenuId が直接指定されていればそれを、なければ p.menu で env から解決
      let richMenuId: string | undefined = p.richMenuId;
      if (!richMenuId && p.menu === 'member') richMenuId = env.richMenuMemberHome;
      if (!richMenuId && p.menu === 'default') richMenuId = env.richMenuDefaultHome;
      if (!richMenuId) break;
      const lineClient = new LineClient(lineAccessToken);
      await lineClient.linkRichMenuToUser(friend.line_user_id, richMenuId);
      break;
    }

    case 'remove_rich_menu': {
      if (!lineAccessToken || !friendId) break;
      const friend = await db
        .prepare('SELECT line_user_id FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ line_user_id: string }>();
      if (!friend) break;
      const lineClient = new LineClient(lineAccessToken);
      await lineClient.unlinkRichMenuFromUser(friend.line_user_id);
      break;
    }

    case 'set_metadata': {
      if (!friendId) break;
      const existing = await db
        .prepare('SELECT metadata FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ metadata: string }>();
      const current = JSON.parse(existing?.metadata || '{}') as Record<string, unknown>;
      // {{message}} を受信メッセージ内容に置換してからパース
      // JSON文字列内に埋め込むため、JSON仕様に準拠して全制御文字をエスケープ
      const escapeForJsonString = (s: string): string =>
        s
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t')
          .replace(/[\u0000-\u001f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      const messageText = (payload.eventData?.text as string | undefined) || '';
      const raw = ((action.params.data as string | undefined) || '{}')
        .replace(/\{\{message\}\}/g, escapeForJsonString(messageText));
      const patch = JSON.parse(raw) as Record<string, unknown>;
      const merged = { ...current, ...patch };
      await db
        .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(merged), jstNow(), friendId)
        .run();
      break;
    }

    case 'call_gas':
    case 'call_gas_post': {
      const gasDeployId = env.gasDeployId;
      if (!gasDeployId) break;
      const { gasPost, getGasErrorFromResponse } = await import('../furim/gas-client.js');
      const method = action.params.method as string;
      const args = (action.params.args ?? {}) as Record<string, unknown>;
      const resolvedArgs = await resolveGasArgs(db, args, friendId, payload);
      let response: unknown;
      try {
        response = await gasPost(gasDeployId, { method, ...resolvedArgs });
        // GASはHTTP 200のまま失敗を返すことがある（{success:false} / HTMLエラーページ）。
        // 成功扱いで無言ロストしないよう、応答本文の失敗も例外に揃える
        const failure = getGasErrorFromResponse(response);
        if (failure) throw new Error(`${method}: ${failure}`);
      } catch (err) {
        // GAS_QUEUE_METHODS の書き込み系は失敗を落とせない。再実行キューに積み、cronが
        // doneCheck（実行前の実行済み確認）つきで完遂させる。
        // GAS側はWorkerが見切っても完走することがあるため、盲目リトライは重複書き込みを生む
        // （2026-08-14 よっしーさん3重行）。doneCheckつきのキュー退避だけが安全な再実行手段。
        // これによりイベント本体は1パスで完走し、sweepのイベント丸ごと再実行を発生させない
        const queueSpec = GAS_QUEUE_METHODS[method];
        if (queueSpec && friendId) {
          const friend = await db
            .prepare('SELECT line_user_id FROM friends WHERE id = ?')
            .bind(friendId)
            .first<{ line_user_id: string }>();
          if (friend) {
            const { enqueueGasRetryJob } = await import('../furim/gas-retry-queue.js');
            await enqueueGasRetryJob(db, {
              lineUserId: friend.line_user_id,
              method,
              params: resolvedArgs as Record<string, unknown>,
              callType: 'post',
              doneCheck: queueSpec.doneCheck,
              // 同一ユーザーの別イベント分（別インボイス等）を落とさないようイベントIDで一意化
              dedupeKey: payload.idempotencyKey ? `${method}:${payload.idempotencyKey}` : undefined,
              maxAttempts: 20,
            });
            console.warn(`[event-bus] ${method} 失敗→再実行キューに退避 friendId=${friendId}: ${String(err)}`);
            // 退避時はresponseが無いため後続のcaptureはスキップされる（stripe系automationはcapture未使用）
            break;
          }
        }
        throw err;
      }
      // capture: { eventDataキー: GAS応答フィールド } — 後続stepの {{eventData.KEY}} で参照できる
      const capture = action.params.capture as Record<string, string> | undefined;
      if (capture && response && typeof response === 'object') {
        if (!payload.eventData) payload.eventData = {};
        for (const [evKey, respField] of Object.entries(capture)) {
          payload.eventData[evKey] = (response as Record<string, unknown>)[respField];
        }
      }
      break;
    }

    case 'call_gas_get': {
      const gasDeployId = env.gasDeployId;
      if (!gasDeployId) break;
      const { gasGet } = await import('../furim/gas-client.js');
      const method = action.params.method as string;
      const args = (action.params.args ?? {}) as Record<string, unknown>;
      const setVariable = action.params.set_variable as string;
      const responseField = action.params.response_field as string | undefined;
      const operator = (action.params.operator as string | undefined) ?? 'truthy';
      const compareValue = action.params.compare_value as string | undefined;
      const resolvedArgs = await resolveGasArgs(db, args, friendId, payload);
      const response = await gasGet(gasDeployId, { method, ...resolvedArgs }) as Record<string, unknown>;
      const fieldValue = responseField ? response[responseField] : response;
      let result: boolean;
      switch (operator) {
        case 'not_empty': result = !!fieldValue && fieldValue !== ''; break;
        case 'empty':     result = !fieldValue || fieldValue === ''; break;
        case 'equals':    result = String(fieldValue) === compareValue; break;
        case 'not_equals':result = String(fieldValue) !== compareValue; break;
        case 'falsy':     result = !fieldValue; break;
        default:          result = !!fieldValue; break;
      }
      if (!payload.eventData) payload.eventData = {};
      payload.eventData[setVariable] = result;
      break;
    }

    case 'send_messages': {
      if (!lineAccessToken || !friendId) break;
      const friend = await db
        .prepare('SELECT line_user_id FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ line_user_id: string }>();
      if (!friend) break;
      const lineClient = new LineClient(lineAccessToken);
      const expandContent = (s: string) =>
        s.replace(/\{\{eventData\.([^}]+)\}\}/g, (_m, key: string) => String(payload.eventData?.[key] ?? ''));

      const buildLineMessages = (cfgs: Array<{ messageType: string; content: string; altText?: string | null }>): Message[] =>
        cfgs.map((cfg) => {
          const content = expandContent(cfg.content);
          if (cfg.messageType === 'flex') {
            const contents = JSON.parse(content) as unknown;
            return { type: 'flex', altText: cfg.altText || extractFlexAltText(contents), contents } as Message;
          }
          if (cfg.messageType === 'image') {
            const parsed = JSON.parse(content) as { originalContentUrl: string; previewImageUrl: string };
            return { type: 'image', originalContentUrl: parsed.originalContentUrl, previewImageUrl: parsed.previewImageUrl } as Message;
          }
          if (cfg.messageType === 'video') {
            const parsed = JSON.parse(content) as { originalContentUrl: string; previewImageUrl: string; trackingId?: string };
            return { type: 'video', originalContentUrl: parsed.originalContentUrl, previewImageUrl: parsed.previewImageUrl, ...(parsed.trackingId ? { trackingId: parsed.trackingId } : {}) } as Message;
          }
          return { type: 'text', text: content } as Message;
        });

      let messages: Message[];
      const templateId = action.params.template_id as string | undefined;
      if (templateId) {
        const msgRows = await resolveTemplateMessages(db, templateId);
        messages = buildLineMessages(msgRows.map((m: MessageRow) => ({ messageType: m.message_type, content: m.content, altText: m.alt_text })));
      } else {
        const msgConfigs = action.params.messages as Array<{ messageType: string; content: string; altText?: string }>;
        messages = buildLineMessages(msgConfigs);
      }
      let deliveryType: 'reply' | 'push';
      if (payload.replyToken) {
        try {
          await lineClient.replyMessage(payload.replyToken, messages);
          payload.replyToken = undefined;
          deliveryType = 'reply';
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes('400') || errMsg.includes('Invalid reply token')) {
            await lineClient.pushMessage(friend.line_user_id, messages, deliveryRetryKey);
            deliveryType = 'push';
          } else {
            throw err;
          }
        }
      } else {
        await lineClient.pushMessage(friend.line_user_id, messages, deliveryRetryKey);
        deliveryType = 'push';
      }
      for (const m of messages) {
        await logOutgoingMessage(db, {
          friendId,
          messageType: m.type,
          content: m.type === 'text' ? (m as { text: string }).text : JSON.stringify(m),
          deliveryType,
          source: 'automation',
          lineAccountId: env.lineAccountId,
        });
      }
      break;
    }

    case 'create_stripe_customer': {
      const stripeSecretKey = env.stripeSecretKey;
      if (!stripeSecretKey || !friendId) break;
      const friend = await db
        .prepare('SELECT line_user_id, display_name, metadata FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ line_user_id: string; display_name: string | null; metadata: string }>();
      if (!friend) break;
      const meta = JSON.parse(friend.metadata || '{}') as Record<string, unknown>;
      if (meta.stripeCustomerId) break; // 既に作成済み
      const res = await fetch('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          name: friend.display_name ?? friend.line_user_id,
          'metadata[lineUserId]': friend.line_user_id,
          'address[country]': 'JP',
          'preferred_locales[]': 'ja',
        }).toString(),
      });
      const data = await res.json() as { id?: string };
      if (data.id) {
        const saveKey = (action.params.save_to_metadata as string | undefined) ?? 'stripeCustomerId';
        const merged = { ...meta, [saveKey]: data.id };
        await db.prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(merged), jstNow(), friendId).run();
      }
      break;
    }

    case 'add_tag_by_name': {
      if (!friendId) break;
      // タグ名の {{eventData.KEY}} を展開（例: 月額{{eventData.planTier}}）
      const tagName = (p.tagName ?? '').replace(/\{\{eventData\.([^}]+)\}\}/g, (_m, key: string) =>
        String(payload.eventData?.[key] ?? ''),
      );
      if (!tagName) break;
      const tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(tagName).first<{ id: string }>();
      if (tag) await addTagToFriend(db, friendId, tag.id);
      break;
    }

    case 'remove_tag_by_name': {
      if (!friendId) break;
      const tagName = p.tagName;
      if (!tagName) break;
      const tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(tagName).first<{ id: string }>();
      if (tag) await removeTagFromFriend(db, friendId, tag.id);
      break;
    }

    case 'complete_active_scenarios': {
      if (!friendId) break;
      await completeFriendActiveScenarios(db, friendId);
      break;
    }

    case 'code_managed':
      // コード管理アクション: 実行はwebhook.tsのコードに委ねる（GUI表示専用）
      break;

    default:
      console.warn(`未知のアクションタイプ: ${action.type}`);
  }
}

/** 送信メッセージを messages_log に記録（失敗しても例外を上げない） */
export async function logOutgoingMessage(
  db: D1Database,
  params: {
    friendId: string;
    messageType: string;
    content: string;
    deliveryType: 'reply' | 'push';
    source: string;
    lineAccountId?: string | null;
  },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        params.friendId,
        params.messageType,
        params.content,
        params.deliveryType,
        params.source,
        params.lineAccountId ?? null,
        jstNow(),
      )
      .run();
  } catch (err) {
    console.error('logOutgoingMessage failed:', err);
  }
}

/** 通知ルール処理 */
async function processNotifications(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
  lineAccountId?: string | null,
): Promise<void> {
  try {
    const allRules = await getActiveNotificationRulesByEvent(db, eventType);
    const rules = allRules.filter(
      (r) => !r.line_account_id || !lineAccountId || r.line_account_id === lineAccountId,
    );

    for (const rule of rules) {
      let channels: string[] = JSON.parse(rule.channels);
      // Guard against double-encoded JSON strings (e.g. "\"[\\\"webhook\\\"]\"")
      if (typeof channels === 'string') channels = JSON.parse(channels);

      for (const channel of channels) {
        await createNotification(db, {
          ruleId: rule.id,
          eventType,
          title: `${rule.name}: ${eventType}`,
          body: JSON.stringify(payload),
          channel,
          metadata: JSON.stringify(payload.eventData ?? {}),
        });

        // Webhook通知チャネルの場合は即時配信
        if (channel === 'webhook') {
          // 送信Webhookと統合（既にfireOutgoingWebhooksで処理済み）
        }
        // email チャネルの場合はSendGrid等で送信（将来実装）
        // dashboard チャネルの場合はDB記録のみ（上記createNotificationで完了）
      }
    }
  } catch (err) {
    console.error('processNotifications error:', err);
  }
}
