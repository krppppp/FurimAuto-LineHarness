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
  const trialEndJst = new Date(nowJst.getTime() + 7 * 24 * 60 * 60_000);
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

    case 'call_gas':
    case 'call_gas_post': {
      const gasDeployId = env.gasDeployId;
      if (!gasDeployId) break;
      const { gasPost } = await import('../furim/gas-client.js');
      const method = action.params.method as string;
      const args = (action.params.args ?? {}) as Record<string, unknown>;
      const resolvedArgs = await resolveGasArgs(db, args, friendId, payload);
      await gasPost(gasDeployId, { method, ...resolvedArgs });
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
      if (payload.replyToken) {
        try {
          await lineClient.replyMessage(payload.replyToken, messages);
          payload.replyToken = undefined;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes('400') || errMsg.includes('Invalid reply token')) {
            await lineClient.pushMessage(friend.line_user_id, messages);
          } else {
            throw err;
          }
        }
      } else {
        await lineClient.pushMessage(friend.line_user_id, messages);
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
      const tagName = p.tagName;
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
