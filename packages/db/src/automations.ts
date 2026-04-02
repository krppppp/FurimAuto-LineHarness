import { jstNow } from './utils.js';
// アクション自動化 (IF-THEN ルール) クエリヘルパー

export interface AutomationActionRow {
  id: string;
  automation_id: string;
  step_order: number;
  action_type: string;
  params: string;        // JSON
  condition_json: string | null;
  on_error: 'continue' | 'abort';
  is_active: number;
  label: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutomationRow {
  id: string;
  name: string;
  description: string | null;
  event_type: string;
  conditions: string;  // JSON
  actions: string;     // JSON配列
  line_account_id: string | null;
  is_active: number;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface AutomationLogRow {
  id: string;
  automation_id: string;
  friend_id: string | null;
  event_data: string | null;
  actions_result: string | null;
  status: string;
  created_at: string;
}

// --- 自動化ルール ---

export async function getAutomations(db: D1Database): Promise<AutomationRow[]> {
  const result = await db.prepare(`SELECT * FROM automations ORDER BY priority DESC, created_at DESC`).all<AutomationRow>();
  return result.results;
}

export async function getAutomationById(db: D1Database, id: string): Promise<AutomationRow | null> {
  return db.prepare(`SELECT * FROM automations WHERE id = ?`).bind(id).first<AutomationRow>();
}

export async function createAutomation(
  db: D1Database,
  input: { name: string; description?: string; eventType: string; conditions?: Record<string, unknown>; actions: unknown[]; priority?: number },
): Promise<AutomationRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db.prepare(`INSERT INTO automations (id, name, description, event_type, conditions, actions, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.name, input.description ?? null, input.eventType, JSON.stringify(input.conditions ?? {}), JSON.stringify(input.actions), input.priority ?? 0, now, now).run();
  return (await getAutomationById(db, id))!;
}

export async function updateAutomation(
  db: D1Database,
  id: string,
  updates: Partial<{ name: string; description: string; eventType: string; conditions: Record<string, unknown>; actions: unknown[]; isActive: boolean; priority: number }>,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.description !== undefined) { sets.push('description = ?'); values.push(updates.description); }
  if (updates.eventType !== undefined) { sets.push('event_type = ?'); values.push(updates.eventType); }
  if (updates.conditions !== undefined) { sets.push('conditions = ?'); values.push(JSON.stringify(updates.conditions)); }
  if (updates.actions !== undefined) { sets.push('actions = ?'); values.push(JSON.stringify(updates.actions)); }
  if (updates.isActive !== undefined) { sets.push('is_active = ?'); values.push(updates.isActive ? 1 : 0); }
  if (updates.priority !== undefined) { sets.push('priority = ?'); values.push(updates.priority); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);
  await db.prepare(`UPDATE automations SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
}

export async function deleteAutomation(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM automations WHERE id = ?`).bind(id).run();
}

// --- 自動化ログ ---

export async function getAutomationLogs(db: D1Database, automationId?: string, limit = 100): Promise<AutomationLogRow[]> {
  if (automationId) {
    const result = await db.prepare(`SELECT * FROM automation_logs WHERE automation_id = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(automationId, limit).all<AutomationLogRow>();
    return result.results;
  }
  const result = await db.prepare(`SELECT * FROM automation_logs ORDER BY created_at DESC LIMIT ?`)
    .bind(limit).all<AutomationLogRow>();
  return result.results;
}

export async function createAutomationLog(
  db: D1Database,
  input: { automationId: string; friendId?: string; eventData?: string; actionsResult?: string; status: string },
): Promise<void> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db.prepare(`INSERT INTO automation_logs (id, automation_id, friend_id, event_data, actions_result, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.automationId, input.friendId ?? null, input.eventData ?? null, input.actionsResult ?? null, input.status, now).run();
}

// --- オートメーションアクション ---

export async function getAutomationActions(db: D1Database, automationId: string): Promise<AutomationActionRow[]> {
  const result = await db
    .prepare(`SELECT * FROM automation_actions WHERE automation_id = ? AND is_active = 1 ORDER BY step_order ASC`)
    .bind(automationId)
    .all<AutomationActionRow>();
  return result.results;
}

export async function createAutomationAction(
  db: D1Database,
  input: {
    automationId: string;
    stepOrder: number;
    actionType: string;
    params?: Record<string, unknown>;
    conditionJson?: Record<string, unknown> | null;
    onError?: 'continue' | 'abort';
    label?: string;
  },
): Promise<AutomationActionRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO automation_actions (id, automation_id, step_order, action_type, params, condition_json, on_error, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.automationId,
      input.stepOrder,
      input.actionType,
      JSON.stringify(input.params ?? {}),
      input.conditionJson ? JSON.stringify(input.conditionJson) : null,
      input.onError ?? 'continue',
      input.label ?? null,
      now,
      now,
    )
    .run();
  return (await db.prepare(`SELECT * FROM automation_actions WHERE id = ?`).bind(id).first<AutomationActionRow>())!;
}

export async function updateAutomationAction(
  db: D1Database,
  id: string,
  updates: Partial<{ stepOrder: number; actionType: string; params: Record<string, unknown>; conditionJson: Record<string, unknown> | null; onError: 'continue' | 'abort'; isActive: boolean; label: string }>,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.stepOrder !== undefined) { sets.push('step_order = ?'); values.push(updates.stepOrder); }
  if (updates.actionType !== undefined) { sets.push('action_type = ?'); values.push(updates.actionType); }
  if (updates.params !== undefined) { sets.push('params = ?'); values.push(JSON.stringify(updates.params)); }
  if ('conditionJson' in updates) { sets.push('condition_json = ?'); values.push(updates.conditionJson ? JSON.stringify(updates.conditionJson) : null); }
  if (updates.onError !== undefined) { sets.push('on_error = ?'); values.push(updates.onError); }
  if (updates.isActive !== undefined) { sets.push('is_active = ?'); values.push(updates.isActive ? 1 : 0); }
  if (updates.label !== undefined) { sets.push('label = ?'); values.push(updates.label); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);
  await db.prepare(`UPDATE automation_actions SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
}

export async function deleteAutomationAction(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM automation_actions WHERE id = ?`).bind(id).run();
}

export async function bulkCreateAutomationActions(
  db: D1Database,
  automationId: string,
  actions: Array<{ actionType: string; params?: Record<string, unknown>; conditionJson?: Record<string, unknown> | null; onError?: 'continue' | 'abort'; label?: string }>,
): Promise<void> {
  const now = jstNow();
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO automation_actions (id, automation_id, step_order, action_type, params, condition_json, on_error, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        automationId,
        i,
        a.actionType,
        JSON.stringify(a.params ?? {}),
        a.conditionJson ? JSON.stringify(a.conditionJson) : null,
        a.onError ?? 'continue',
        a.label ?? null,
        now,
        now,
      )
      .run();
  }
}

/** イベントタイプに一致するアクティブな自動化ルールを取得（優先度順） */
export async function getActiveAutomationsByEvent(db: D1Database, eventType: string): Promise<AutomationRow[]> {
  const result = await db.prepare(`SELECT * FROM automations WHERE event_type = ? AND is_active = 1 ORDER BY priority DESC`)
    .bind(eventType).all<AutomationRow>();
  return result.results;
}
