import { extractFlexAltText } from '../utils/flex-alt-text.js';
import {
  getFriendScenariosDueForDelivery,
  getScenarioSteps,
  advanceFriendScenario,
  completeFriendScenario,
  getFriendById,
  getTemplateMessages,
  parseTriggerCondition,
  jstNow,
} from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import type { Message } from '@line-crm/line-sdk';
import { jitterDeliveryTime, addJitter, sleep } from './stealth.js';

/**
 * Replace template variables in message content.
 *
 * Supported variables:
 * - {{name}}                → friend's display name
 * - {{uid}}                 → friend's user UUID
 * - {{friend_id}}           → friend's internal ID
 * - {{auth_url:CHANNEL_ID}} → full /auth/line URL with uid for cross-account linking
 */
export function expandVariables(
  content: string,
  friend: { id: string; display_name: string | null; user_id: string | null; ref_code?: string | null },
  apiOrigin?: string,
): string {
  let result = content;
  result = result.replace(/\{\{name\}\}/g, friend.display_name || '');
  result = result.replace(/\{\{uid\}\}/g, friend.user_id || '');
  result = result.replace(/\{\{friend_id\}\}/g, friend.id);
  result = result.replace(/\{\{ref\}\}/g, friend.ref_code || '');
  // Conditional block: {{#if_ref}}...{{/if_ref}} — only shown if ref_code exists
  if (friend.ref_code) {
    result = result.replace(/\{\{#if_ref\}\}([\s\S]*?)\{\{\/if_ref\}\}/g, '$1');
  } else {
    result = result.replace(/\{\{#if_ref\}\}[\s\S]*?\{\{\/if_ref\}\}/g, '');
  }
  if (apiOrigin) {
    result = result.replace(/\{\{auth_url:([^}]+)\}\}/g, (_match, channelId) => {
      const params = new URLSearchParams({ account: channelId, ref: 'cross-link' });
      if (friend.user_id) params.set('uid', friend.user_id);
      return `${apiOrigin}/auth/line?${params.toString()}`;
    });
  }
  return result;
}

/** Default delivery window: 9:00-23:00 JST. If outside, push to next 9:00 AM. */
const DEFAULT_START_HOUR = 9;
const DEFAULT_END_HOUR = 23;

/**
 * trigger_condition に基づいて次回配信日時を計算する。
 * on_tag_added の場合は null を返す（タグ付与まで待機）。
 */
function calcNextDeliveryAt(
  nextStep: { delay_minutes: number; trigger_condition?: string | null },
  followDate: Date,
  preferredHour?: number,
): Date | null {
  const trigger = parseTriggerCondition(nextStep as Parameters<typeof parseTriggerCondition>[0]);

  if (trigger.type === 'on_tag_added') return null;

  let baseMs: number;
  let delayMs: number;

  if (trigger.type === 'delay_from_follow') {
    baseMs = followDate.getTime();
    delayMs = (trigger.minutes ?? 0) * 60_000;
  } else {
    // delay_from_previous（デフォルト・後方互換）
    baseMs = Date.now() + 9 * 60 * 60_000; // JST epoch
    delayMs = (trigger.minutes ?? nextStep.delay_minutes) * 60_000;
  }

  const rawDate = new Date(baseMs + delayMs);
  return enforceDeliveryWindow(rawDate, preferredHour);
}

function enforceDeliveryWindow(date: Date, preferredHour?: number): Date {
  // date is already shifted to JST epoch (+9h)
  const hours = date.getUTCHours();
  const startHour = preferredHour ?? DEFAULT_START_HOUR;
  const endHour = DEFAULT_END_HOUR;

  if (hours >= startHour && hours < endHour) return date;

  // Outside window: push to next preferred start hour
  const result = new Date(date);
  if (hours >= endHour) {
    result.setUTCDate(result.getUTCDate() + 1);
  }
  result.setUTCHours(startHour, 0, 0, 0);
  return result;
}

export async function processStepDeliveries(
  db: D1Database,
  lineClient: LineClient,
  workerUrl?: string,
): Promise<void> {
  // Skip delivery outside 9:00-23:00 JST window
  const jstHour = new Date(Date.now() + 9 * 60 * 60_000).getUTCHours();
  if (jstHour < DEFAULT_START_HOUR || jstHour >= DEFAULT_END_HOUR) return;

  const now = jstNow();
  const dueFriendScenarios = await getFriendScenariosDueForDelivery(db, now);

  for (let i = 0; i < dueFriendScenarios.length; i++) {
    const fs = dueFriendScenarios[i];
    try {
      // Stealth: add small random delay between deliveries to avoid burst patterns
      if (i > 0) {
        await sleep(addJitter(50, 200));
      }
      await processSingleDelivery(db, lineClient, fs, workerUrl);
    } catch (err) {
      console.error(`Error processing friend_scenario ${fs.id}:`, err);
      // Continue with next one
    }
  }
}

async function processSingleDelivery(
  db: D1Database,
  lineClient: LineClient,
  fs: {
    id: string;
    friend_id: string;
    scenario_id: string;
    current_step_order: number;
    status: string;
    next_delivery_at: string | null;
  },
  workerUrl?: string,
): Promise<void> {
  // Get friend first to read preferred delivery hour from metadata
  const friend = await getFriendById(db, fs.friend_id);
  if (!friend || !friend.is_following) {
    await completeFriendScenario(db, fs.id);
    return;
  }

  // 月額会員はステップ配信をスキップして完了
  const isMember = await db
    .prepare('SELECT 1 FROM friend_tags ft JOIN tags t ON ft.tag_id = t.id WHERE ft.friend_id = ? AND t.name = ?')
    .bind(friend.id, '月額会員')
    .first();
  if (isMember) {
    await completeFriendScenario(db, fs.id);
    return;
  }

  const metadata = JSON.parse((friend as { metadata?: string }).metadata || '{}') as Record<string, unknown>;
  const preferredHour = typeof metadata.preferred_hour === 'number' ? metadata.preferred_hour : undefined;
  const followDate = new Date(new Date((friend as { created_at: string }).created_at).getTime() + 9 * 60 * 60_000);

  // Get all steps for this scenario
  const steps = await getScenarioSteps(db, fs.scenario_id);
  if (steps.length === 0) {
    await completeFriendScenario(db, fs.id);
    return;
  }

  // Steps are sorted by step_order but may not be contiguous (e.g., 1, 3, 5 after deletions).
  // Find the next step whose step_order > current_step_order.
  const currentStep = steps.find((s) => s.step_order > fs.current_step_order);

  if (!currentStep) {
    await completeFriendScenario(db, fs.id);
    return;
  }

  // Check step condition before sending
  if (currentStep.condition_type) {
    const conditionMet = await evaluateCondition(db, fs.friend_id, currentStep);
    if (!conditionMet) {
      if (currentStep.next_step_on_false !== null && currentStep.next_step_on_false !== undefined) {
        const jumpStep = steps.find((s) => s.step_order === currentStep.next_step_on_false);
        if (jumpStep) {
          const nextDelivery = calcNextDeliveryAt(jumpStep, followDate, preferredHour);
          const jitteredDate = nextDelivery ? jitterDeliveryTime(nextDelivery) : null;
          await advanceFriendScenario(db, fs.id, currentStep.step_order, jitteredDate ? jitteredDate.toISOString().slice(0, -1) + '+09:00' : null);
          return;
        }
      }
      const nextIndex = steps.indexOf(currentStep) + 1;
      if (nextIndex < steps.length) {
        const nextStep = steps[nextIndex];
        const nextDelivery = calcNextDeliveryAt(nextStep, followDate, preferredHour);
        const jitteredDate = nextDelivery ? jitterDeliveryTime(nextDelivery) : null;
        await advanceFriendScenario(db, fs.id, currentStep.step_order, jitteredDate ? jitteredDate.toISOString().slice(0, -1) + '+09:00' : null);
      } else {
        await completeFriendScenario(db, fs.id);
      }
      return;
    }
  }

  const currentIndex = steps.indexOf(currentStep);

  if (currentStep.template_id) {
    // 新アーキテクチャ: template_messages からメッセージを取得して一括送信
    const templateMessages = await getTemplateMessages(db, currentStep.template_id);
    const messages: Message[] = [];
    for (const tm of templateMessages) {
      const expandedContent = expandVariables(tm.message.content, friend, workerUrl);
      let trackedType: string = tm.message.message_type;
      let trackedContent = expandedContent;
      if (workerUrl) {
        const { autoTrackContent } = await import('./auto-track.js');
        const tracked = await autoTrackContent(db, tm.message.message_type, expandedContent, workerUrl);
        trackedType = tracked.messageType;
        trackedContent = tracked.content;
      }
      messages.push(buildMessage(trackedType, trackedContent));
    }

    if (messages.length > 0) {
      await lineClient.pushMessage(friend.line_user_id, messages);
    }

    for (const tm of templateMessages) {
      const logId = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, ?)`,
        )
        .bind(logId, friend.id, tm.message.message_type, tm.message.content, currentStep.id, jstNow())
        .run();
    }

    const nextStep = currentIndex + 1 < steps.length ? steps[currentIndex + 1] : null;
    if (nextStep) {
      const nextDelivery = calcNextDeliveryAt(nextStep, followDate, preferredHour);
      const jitteredDate = nextDelivery ? jitterDeliveryTime(nextDelivery) : null;
      await advanceFriendScenario(db, fs.id, currentStep.step_order, jitteredDate ? jitteredDate.toISOString().slice(0, -1) + '+09:00' : null);
    } else {
      await completeFriendScenario(db, fs.id);
    }
  } else {
    // 旧アーキテクチャ: delay=0 の後続ステップをまとめてバッチ送信（コンパニオンメッセージ）
    const batchSteps = [currentStep];
    for (let i = currentIndex + 1; i < steps.length; i++) {
      if (steps[i].delay_minutes === 0 && !steps[i].condition_type) {
        batchSteps.push(steps[i]);
      } else {
        break;
      }
    }

    const messages: Message[] = [];
    for (const step of batchSteps) {
      const expandedContent = expandVariables(step.message_content, friend, workerUrl);
      let trackedType: string = step.message_type;
      let trackedContent = expandedContent;
      if (workerUrl) {
        const { autoTrackContent } = await import('./auto-track.js');
        const tracked = await autoTrackContent(db, step.message_type, expandedContent, workerUrl);
        trackedType = tracked.messageType;
        trackedContent = tracked.content;
      }
      messages.push(buildMessage(trackedType, trackedContent));
    }

    await lineClient.pushMessage(friend.line_user_id, messages);

    for (const step of batchSteps) {
      const logId = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, ?)`,
        )
        .bind(logId, friend.id, step.message_type, step.message_content, step.id, jstNow())
        .run();
    }

    const lastBatchIndex = currentIndex + batchSteps.length - 1;
    const nextStep = lastBatchIndex + 1 < steps.length ? steps[lastBatchIndex + 1] : null;
    const lastBatchStep = batchSteps[batchSteps.length - 1];

    if (nextStep) {
      const nextDelivery = calcNextDeliveryAt(nextStep, followDate, preferredHour);
      const jitteredDate = nextDelivery ? jitterDeliveryTime(nextDelivery) : null;
      await advanceFriendScenario(db, fs.id, lastBatchStep.step_order, jitteredDate ? jitteredDate.toISOString().slice(0, -1) + '+09:00' : null);
    } else {
      await completeFriendScenario(db, fs.id);
    }
  }
}

async function evaluateCondition(
  db: D1Database,
  friendId: string,
  step: { condition_type: string | null; condition_value: string | null },
): Promise<boolean> {
  if (!step.condition_type || !step.condition_value) return true;

  switch (step.condition_type) {
    case 'tag_exists': {
      const tag = await db
        .prepare('SELECT 1 FROM friend_tags WHERE friend_id = ? AND tag_id = ?')
        .bind(friendId, step.condition_value)
        .first();
      return !!tag;
    }
    case 'tag_not_exists': {
      const tag = await db
        .prepare('SELECT 1 FROM friend_tags WHERE friend_id = ? AND tag_id = ?')
        .bind(friendId, step.condition_value)
        .first();
      return !tag;
    }
    case 'metadata_equals': {
      const { key, value } = JSON.parse(step.condition_value) as { key: string; value: unknown };
      const friend = await db
        .prepare('SELECT metadata FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ metadata: string }>();
      const metadata = JSON.parse(friend?.metadata || '{}') as Record<string, unknown>;
      return metadata[key] === value;
    }
    case 'metadata_not_equals': {
      const { key, value } = JSON.parse(step.condition_value) as { key: string; value: unknown };
      const friend = await db
        .prepare('SELECT metadata FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ metadata: string }>();
      const metadata = JSON.parse(friend?.metadata || '{}') as Record<string, unknown>;
      return metadata[key] !== value;
    }
    default:
      return true;
  }
}


/** Remove empty text nodes from Flex JSON (caused by conditional blocks) */
function cleanEmptyNodes(obj: unknown): void {
  if (!obj || typeof obj !== 'object') return;
  const node = obj as Record<string, unknown>;
  for (const key of ['header', 'body', 'footer']) {
    if (node[key]) cleanEmptyNodes(node[key]);
  }
  if (Array.isArray(node.contents)) {
    node.contents = (node.contents as unknown[]).filter((c) => {
      if (c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text') {
        const text = (c as Record<string, unknown>).text;
        return typeof text === 'string' && text.trim().length > 0;
      }
      return true;
    });
    for (const c of node.contents as unknown[]) cleanEmptyNodes(c);
  }
}

export function buildMessage(messageType: string, messageContent: string, altText?: string): Message {
  if (messageType === 'text') {
    return { type: 'text', text: messageContent };
  }

  if (messageType === 'image') {
    // messageContent is expected to be JSON: { originalContentUrl, previewImageUrl }
    try {
      const parsed = JSON.parse(messageContent) as {
        originalContentUrl: string;
        previewImageUrl: string;
      };
      return {
        type: 'image',
        originalContentUrl: parsed.originalContentUrl,
        previewImageUrl: parsed.previewImageUrl,
      };
    } catch {
      // Fallback: treat as text if parsing fails
      return { type: 'text', text: messageContent };
    }
  }

  if (messageType === 'video') {
    try {
      const parsed = JSON.parse(messageContent) as {
        originalContentUrl: string;
        previewImageUrl: string;
        trackingId?: string;
      };
      return {
        type: 'video',
        originalContentUrl: parsed.originalContentUrl,
        previewImageUrl: parsed.previewImageUrl,
        ...(parsed.trackingId ? { trackingId: parsed.trackingId } : {}),
      } as unknown as Message;
    } catch {
      return { type: 'text', text: messageContent };
    }
  }

  if (messageType === 'flex') {
    try {
      const parsed = JSON.parse(messageContent);
      // Support both raw bubble/carousel and full flex message wrapper
      const contents = parsed.type === 'flex' ? parsed.contents : parsed;
      const resolvedAltText = altText || (parsed.type === 'flex' ? parsed.altText : undefined) || extractFlexAltText(contents);
      // Remove empty text nodes (from {{#if_ref}} conditional blocks)
      cleanEmptyNodes(contents);
      return { type: 'flex', altText: resolvedAltText, contents };
    } catch {
      return { type: 'text', text: messageContent };
    }
  }

  // Fallback
  return { type: 'text', text: messageContent };
}
