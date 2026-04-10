import { jstNow } from './utils.js';
export type ScenarioTriggerType = 'friend_add' | 'tag_added' | 'manual';
export type MessageType = 'text' | 'image' | 'flex';
export type FriendScenarioStatus = 'active' | 'paused' | 'completed';

export interface Scenario {
  id: string;
  name: string;
  description: string | null;
  trigger_type: ScenarioTriggerType;
  trigger_tag_id: string | null;
  line_account_id: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface TriggerCondition {
  type: 'delay_from_follow' | 'delay_from_previous' | 'on_tag_added';
  minutes?: number;       // delay_from_follow / delay_from_previous 用
  tag_id?: string;        // on_tag_added 用
  delay_minutes?: number; // on_tag_added 後の追加ディレイ（分）
}

export interface ScenarioStep {
  id: string;
  scenario_id: string;
  step_order: number;
  delay_minutes: number;
  message_type: MessageType;
  message_content: string;
  condition_type: string | null;
  condition_value: string | null;
  next_step_on_false: number | null;
  template_id: string | null;
  trigger_condition: string | null;
  created_at: string;
}

export interface ScenarioWithSteps extends Scenario {
  steps: ScenarioStep[];
}

export interface FriendScenario {
  id: string;
  friend_id: string;
  scenario_id: string;
  current_step_order: number;
  status: FriendScenarioStatus;
  started_at: string;
  next_delivery_at: string | null;
  updated_at: string;
}

// ============================================================
// Scenario CRUD
// ============================================================

export type ScenarioWithStepCount = Scenario & { step_count: number };

export async function getScenarioByName(db: D1Database, name: string): Promise<Scenario | null> {
  return db.prepare(`SELECT * FROM scenarios WHERE name = ? LIMIT 1`).bind(name).first<Scenario>();
}

export async function completeFriendActiveScenarios(db: D1Database, friendId: string): Promise<void> {
  const now = jstNow();
  await db
    .prepare(`UPDATE friend_scenarios SET status = 'completed', next_delivery_at = NULL, updated_at = ? WHERE friend_id = ? AND status = 'active'`)
    .bind(now, friendId)
    .run();
}

export async function getScenarios(db: D1Database): Promise<ScenarioWithStepCount[]> {
  const result = await db
    .prepare(
      `SELECT s.*, COUNT(ss.id) as step_count
       FROM scenarios s
       LEFT JOIN scenario_steps ss ON s.id = ss.scenario_id
       GROUP BY s.id
       ORDER BY s.name ASC`,
    )
    .all<ScenarioWithStepCount>();
  return result.results;
}

export async function getScenarioById(
  db: D1Database,
  id: string,
): Promise<ScenarioWithSteps | null> {
  const scenario = await db
    .prepare(`SELECT * FROM scenarios WHERE id = ?`)
    .bind(id)
    .first<Scenario>();

  if (!scenario) return null;

  const stepsResult = await db
    .prepare(
      `SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order ASC`,
    )
    .bind(id)
    .all<ScenarioStep>();

  return { ...scenario, steps: stepsResult.results };
}

export interface CreateScenarioInput {
  name: string;
  description?: string | null;
  triggerType: ScenarioTriggerType;
  triggerTagId?: string | null;
}

export async function createScenario(
  db: D1Database,
  input: CreateScenarioInput,
): Promise<Scenario> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO scenarios (id, name, description, trigger_type, trigger_tag_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(
      id,
      input.name,
      input.description ?? null,
      input.triggerType,
      input.triggerTagId ?? null,
      now,
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM scenarios WHERE id = ?`)
    .bind(id)
    .first<Scenario>())!;
}

export type UpdateScenarioInput = Partial<
  Pick<Scenario, 'name' | 'description' | 'trigger_type' | 'trigger_tag_id' | 'is_active'>
>;

export async function updateScenario(
  db: D1Database,
  id: string,
  updates: UpdateScenarioInput,
): Promise<Scenario | null> {
  const now = jstNow();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.trigger_type !== undefined) {
    fields.push('trigger_type = ?');
    values.push(updates.trigger_type);
  }
  if (updates.trigger_tag_id !== undefined) {
    fields.push('trigger_tag_id = ?');
    values.push(updates.trigger_tag_id);
  }
  if (updates.is_active !== undefined) {
    fields.push('is_active = ?');
    values.push(updates.is_active);
  }

  if (fields.length === 0) {
    return db
      .prepare(`SELECT * FROM scenarios WHERE id = ?`)
      .bind(id)
      .first<Scenario>();
  }

  fields.push('updated_at = ?');
  values.push(now);
  values.push(id);

  await db
    .prepare(`UPDATE scenarios SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  return db
    .prepare(`SELECT * FROM scenarios WHERE id = ?`)
    .bind(id)
    .first<Scenario>();
}

export async function deleteScenario(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM scenarios WHERE id = ?`).bind(id).run();
}

// ============================================================
// Scenario Steps
// ============================================================

export interface CreateScenarioStepInput {
  scenarioId: string;
  stepOrder: number;
  delayMinutes?: number;
  messageType?: MessageType;
  messageContent?: string;
  templateId?: string | null;
  conditionType?: string | null;
  conditionValue?: string | null;
  nextStepOnFalse?: number | null;
}

export async function createScenarioStep(
  db: D1Database,
  input: CreateScenarioStepInput,
): Promise<ScenarioStep> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, template_id, condition_type, condition_value, next_step_on_false, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.scenarioId,
      input.stepOrder,
      input.delayMinutes ?? 0,
      input.messageType ?? 'text',
      input.messageContent ?? '',
      input.templateId ?? null,
      input.conditionType ?? null,
      input.conditionValue ?? null,
      input.nextStepOnFalse ?? null,
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM scenario_steps WHERE id = ?`)
    .bind(id)
    .first<ScenarioStep>())!;
}

export type UpdateScenarioStepInput = Partial<
  Pick<ScenarioStep, 'step_order' | 'delay_minutes' | 'message_type' | 'message_content' | 'template_id' | 'condition_type' | 'condition_value' | 'next_step_on_false'>
>;

export async function updateScenarioStep(
  db: D1Database,
  id: string,
  updates: UpdateScenarioStepInput,
): Promise<ScenarioStep | null> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.step_order !== undefined) {
    fields.push('step_order = ?');
    values.push(updates.step_order);
  }
  if (updates.delay_minutes !== undefined) {
    fields.push('delay_minutes = ?');
    values.push(updates.delay_minutes);
  }
  if (updates.message_type !== undefined) {
    fields.push('message_type = ?');
    values.push(updates.message_type);
  }
  if (updates.message_content !== undefined) {
    fields.push('message_content = ?');
    values.push(updates.message_content);
  }
  if (updates.template_id !== undefined) {
    fields.push('template_id = ?');
    values.push(updates.template_id);
  }
  if (updates.condition_type !== undefined) {
    fields.push('condition_type = ?');
    values.push(updates.condition_type);
  }
  if (updates.condition_value !== undefined) {
    fields.push('condition_value = ?');
    values.push(updates.condition_value);
  }
  if (updates.next_step_on_false !== undefined) {
    fields.push('next_step_on_false = ?');
    values.push(updates.next_step_on_false);
  }

  if (fields.length > 0) {
    values.push(id);
    await db
      .prepare(`UPDATE scenario_steps SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  return db
    .prepare(`SELECT * FROM scenario_steps WHERE id = ?`)
    .bind(id)
    .first<ScenarioStep>();
}

export async function deleteScenarioStep(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM scenario_steps WHERE id = ?`).bind(id).run();
}

export async function getScenarioSteps(
  db: D1Database,
  scenarioId: string,
): Promise<ScenarioStep[]> {
  const result = await db
    .prepare(
      `SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order ASC`,
    )
    .bind(scenarioId)
    .all<ScenarioStep>();
  return result.results;
}

// ============================================================
// Friend Scenario Enrollments
// ============================================================

/** JST delivery window enforcement (9:00-21:00). Date is already in JST epoch (+9h). */
function enforceEnrollDeliveryWindow(date: Date): Date {
  const hours = date.getUTCHours();
  if (hours >= 9 && hours < 21) return date;
  const result = new Date(date);
  if (hours >= 21) result.setUTCDate(result.getUTCDate() + 1);
  result.setUTCHours(9, 0, 0, 0);
  return result;
}

export async function enrollFriendInScenario(
  db: D1Database,
  friendId: string,
  scenarioId: string,
): Promise<FriendScenario> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const nowMs = Date.now();

  // Get all steps ordered by step_order
  const stepsResult = await db
    .prepare(`SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order ASC`)
    .bind(scenarioId)
    .all<ScenarioStep>();
  const steps = stepsResult.results;

  // No steps → immediately completed
  if (steps.length === 0) {
    await db
      .prepare(
        `INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at, next_delivery_at, updated_at)
         VALUES (?, ?, ?, 0, 'completed', ?, NULL, ?)`,
      )
      .bind(id, friendId, scenarioId, now, now)
      .run();
    return (await db.prepare(`SELECT * FROM friend_scenarios WHERE id = ?`).bind(id).first<FriendScenario>())!;
  }

  // Determine trigger type from the first step
  const firstStepTrigger = parseTriggerCondition(steps[0]);

  if (firstStepTrigger.type === 'delay_from_follow') {
    // Get friend's follow date
    const friend = await db.prepare(`SELECT created_at FROM friends WHERE id = ?`).bind(friendId).first<{ created_at: string }>();
    const followMs = friend ? new Date(friend.created_at).getTime() : nowMs;
    const elapsedMinutes = (nowMs - followMs) / 60_000;

    // Find the first step not yet due (follow_date + step.minutes > now)
    // Steps whose due time has already passed are considered "skipped"
    let startStepIndex = steps.findIndex((s) => {
      const tc = parseTriggerCondition(s);
      return tc.type === 'delay_from_follow' && (tc.minutes ?? 0) > elapsedMinutes;
    });

    if (startStepIndex === -1) {
      // All steps already passed → completed immediately
      await db
        .prepare(
          `INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at, next_delivery_at, updated_at)
           VALUES (?, ?, ?, ?, 'completed', ?, NULL, ?)`,
        )
        .bind(id, friendId, scenarioId, steps[steps.length - 1].step_order, now, now)
        .run();
      return (await db.prepare(`SELECT * FROM friend_scenarios WHERE id = ?`).bind(id).first<FriendScenario>())!;
    }

    const pendingStep = steps[startStepIndex];
    const tc = parseTriggerCondition(pendingStep);
    const deliveryMs = followMs + (tc.minutes ?? 0) * 60_000;
    const rawDate = new Date(deliveryMs + 9 * 60 * 60_000); // shift to JST epoch for window check
    const windowedDate = enforceEnrollDeliveryWindow(rawDate);
    const nextDeliveryAt = windowedDate.toISOString().slice(0, -1) + '+09:00';

    // current_step_order = one before pendingStep so delivery finds pendingStep via step_order > current
    const prevStepOrder = startStepIndex > 0 ? steps[startStepIndex - 1].step_order : pendingStep.step_order - 1;

    await db
      .prepare(
        `INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at, next_delivery_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .bind(id, friendId, scenarioId, prevStepOrder, now, nextDeliveryAt, now)
      .run();
    return (await db.prepare(`SELECT * FROM friend_scenarios WHERE id = ?`).bind(id).first<FriendScenario>())!;
  }

  if (firstStepTrigger.type === 'on_tag_added') {
    // Event-driven: wait for tag — next_delivery_at = NULL
    await db
      .prepare(
        `INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at, next_delivery_at, updated_at)
         VALUES (?, ?, ?, -1, 'active', ?, NULL, ?)`,
      )
      .bind(id, friendId, scenarioId, now, now)
      .run();
    return (await db.prepare(`SELECT * FROM friend_scenarios WHERE id = ?`).bind(id).first<FriendScenario>())!;
  }

  // Default: delay_from_previous (current behavior)
  const rawDate = new Date(nowMs + 9 * 60 * 60_000 + steps[0].delay_minutes * 60_000);
  const windowedDate = enforceEnrollDeliveryWindow(rawDate);
  const nextDeliveryAt = windowedDate.toISOString().slice(0, -1) + '+09:00';

  await db
    .prepare(
      `INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at, next_delivery_at, updated_at)
       VALUES (?, ?, ?, 0, 'active', ?, ?, ?)`,
    )
    .bind(id, friendId, scenarioId, now, nextDeliveryAt, now)
    .run();

  return (await db.prepare(`SELECT * FROM friend_scenarios WHERE id = ?`).bind(id).first<FriendScenario>())!;
}

/** trigger_condition JSON をパース。NULL の場合は delay_from_previous として扱う */
export function parseTriggerCondition(step: ScenarioStep): TriggerCondition {
  if (!step.trigger_condition) {
    return { type: 'delay_from_previous', minutes: step.delay_minutes };
  }
  try {
    return JSON.parse(step.trigger_condition) as TriggerCondition;
  } catch {
    return { type: 'delay_from_previous', minutes: step.delay_minutes };
  }
}

export async function getFriendScenariosDueForDelivery(
  db: D1Database,
  now: string,
): Promise<FriendScenario[]> {
  // Fetch all active scenarios with a delivery time, then filter by epoch comparison
  // to handle mixed timestamp formats (Z and +09:00) during migration
  const result = await db
    .prepare(
      `SELECT * FROM friend_scenarios
       WHERE status = 'active'
         AND next_delivery_at IS NOT NULL`,
    )
    .all<FriendScenario>();
  const nowMs = new Date(now).getTime();
  return result.results
    .filter((fs) => new Date(fs.next_delivery_at!).getTime() <= nowMs)
    .sort((a, b) => new Date(a.next_delivery_at!).getTime() - new Date(b.next_delivery_at!).getTime());
}

export async function advanceFriendScenario(
  db: D1Database,
  id: string,
  nextStepOrder: number,
  nextDeliveryAt?: string | null,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE friend_scenarios
       SET current_step_order = ?,
           next_delivery_at = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(nextStepOrder, nextDeliveryAt ?? null, now, id)
    .run();
}

export async function completeFriendScenario(
  db: D1Database,
  id: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE friend_scenarios
       SET status = 'completed',
           next_delivery_at = NULL,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(now, id)
    .run();
}
