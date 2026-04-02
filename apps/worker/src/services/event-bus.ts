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

import {
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
  jstNow,
  getFriendScore,
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
}

export interface ActionEnv {
  lineAccessToken?: string;
  gasDeployId?: string;
  stripeSecretKey?: string;
}

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
): Promise<void> {
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
  const actionEnv: ActionEnv = { lineAccessToken, ...env };
  await Promise.allSettled([
    processAutomations(db, eventType, enrichedPayload, lineAccessToken, lineAccountId, actionEnv),
    processNotifications(db, eventType, enrichedPayload, lineAccountId),
  ]);
}

/** 送信Webhookへの通知 */
async function fireOutgoingWebhooks(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
): Promise<void> {
  try {
    const webhooks = await getActiveOutgoingWebhooksByEvent(db, eventType);
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

        await fetch(wh.url, { method: 'POST', headers, body });
      } catch (err) {
        console.error(`送信Webhook ${wh.id} への通知失敗:`, err);
      }
    }
  } catch (err) {
    console.error('fireOutgoingWebhooks error:', err);
  }
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
): Promise<void> {
  try {
    const allAutomations = await getActiveAutomationsByEvent(db, eventType);
    const automations = allAutomations.filter(
      (a) => !a.line_account_id || !lineAccountId || a.line_account_id === lineAccountId,
    );

    const actionEnv: ActionEnv = env ?? { lineAccessToken };

    for (const automation of automations) {
      const conditions = JSON.parse(automation.conditions) as Record<string, unknown>;
      if (!matchConditions(conditions, payload)) continue;

      // automation_actions テーブルを優先、なければ旧 actions JSON にフォールバック
      const actionRows = await getAutomationActions(db, automation.id);
      const actions: Array<{ type: string; params: Record<string, unknown>; conditionJson?: Record<string, unknown> | null; onError?: string; label?: string }> =
        actionRows.length > 0
          ? actionRows.map((r) => ({
              type: r.action_type,
              params: JSON.parse(r.params) as Record<string, unknown>,
              conditionJson: r.condition_json ? (JSON.parse(r.condition_json) as Record<string, unknown>) : null,
              onError: r.on_error,
              label: r.label ?? undefined,
            }))
          : (JSON.parse(automation.actions) as Array<{ type: string; params: Record<string, unknown> }>);

      const results: Array<{ action: string; label?: string; success: boolean; error?: string }> = [];

      for (const action of actions) {
        // アクション個別の条件チェック
        if (action.conditionJson && Object.keys(action.conditionJson).length > 0) {
          if (!matchConditions(action.conditionJson, payload)) {
            results.push({ action: action.type, label: action.label, success: true });
            continue;
          }
        }

        try {
          await executeAction(db, action, payload, actionEnv);
          results.push({ action: action.type, label: action.label, success: true });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          results.push({ action: action.type, label: action.label, success: false, error: errorMsg });
          if (action.onError === 'abort') break;
        }
      }

      const allSuccess = results.every((r) => r.success);
      const anySuccess = results.some((r) => r.success);

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
  }
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

  // keyword チェック（message_received イベント用）
  if (conditions.keyword !== undefined && payload.eventData) {
    const text = payload.eventData.text as string | undefined;
    if (!text || !text.includes(conditions.keyword as string)) return false;
  }

  return true;
}

/** アクション実行 */
async function executeAction(
  db: D1Database,
  action: { type: string; params: Record<string, unknown> },
  payload: EventPayload,
  env: ActionEnv,
): Promise<void> {
  const lineAccessToken = env.lineAccessToken;
  const friendId = payload.friendId;
  if (!friendId && action.type !== 'send_webhook') {
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
      const msgType = p.messageType || 'text';
      let msg: Message;
      if (msgType === 'flex') {
        const contents = JSON.parse(p.content);
        msg = { type: 'flex', altText: p.altText || extractFlexAltText(contents), contents };
      } else {
        msg = { type: 'text', text: p.content };
      }
      if (payload.replyToken) {
        try {
          await lineClient.replyMessage(payload.replyToken, [msg]);
          payload.replyToken = undefined;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isTokenError = errMsg.includes('400') || errMsg.includes('Invalid reply token');
          if (isTokenError) {
            await lineClient.pushMessage(friend.line_user_id, [msg]);
          } else {
            throw err;
          }
        }
      } else {
        await lineClient.pushMessage(friend.line_user_id, [msg]);
      }
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
      const lineClient = new LineClient(lineAccessToken);
      await lineClient.linkRichMenuToUser(friend.line_user_id, p.richMenuId);
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
      const patch = JSON.parse(p.data || '{}') as Record<string, unknown>;
      const merged = { ...current, ...patch };
      await db
        .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(merged), jstNow(), friendId)
        .run();
      break;
    }

    case 'call_gas': {
      const gasDeployId = env.gasDeployId;
      if (!gasDeployId) break;
      const { gasPost, gasGet } = await import('../furim/gas-client.js');
      const method = action.params.method as string;
      const args = (action.params.args ?? {}) as Record<string, unknown>;
      // {{friend_id}}, {{line_user_id}} などのテンプレートを展開
      const friend = friendId
        ? await db.prepare('SELECT id, line_user_id, metadata FROM friends WHERE id = ?').bind(friendId).first<{ id: string; line_user_id: string; metadata: string }>()
        : null;
      const resolvedArgs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === 'string' && friend) {
          resolvedArgs[k] = v
            .replace('{{friend_id}}', friend.id)
            .replace('{{line_user_id}}', friend.line_user_id);
        } else {
          resolvedArgs[k] = v;
        }
      }
      const httpMethod = (action.params.http_method as string | undefined)?.toUpperCase() ?? 'POST';
      if (httpMethod === 'GET') {
        await gasGet(gasDeployId, { method, ...resolvedArgs });
      } else {
        await gasPost(gasDeployId, { method, ...resolvedArgs });
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

    default:
      console.warn(`未知のアクションタイプ: ${action.type}`);
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
