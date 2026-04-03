import { jstNow } from './utils.js';
import type { MessageRow } from './messages.js';
// テンプレート管理クエリヘルパー

export interface TemplateRow {
  id: string;
  name: string;
  category: string;
  categories: string; // JSON array string e.g. '["scenario","broadcast"]'
  message_type: string;
  message_content: string;
  created_at: string;
  updated_at: string;
}

export async function getTemplates(db: D1Database, category?: string): Promise<TemplateRow[]> {
  if (category) {
    const result = await db
      .prepare(`SELECT * FROM templates WHERE categories LIKE ? ORDER BY created_at DESC`)
      .bind(`%"${category}"%`)
      .all<TemplateRow>();
    return result.results;
  }
  const result = await db.prepare(`SELECT * FROM templates ORDER BY created_at DESC`).all<TemplateRow>();
  return result.results;
}

export async function getTemplateById(db: D1Database, id: string): Promise<TemplateRow | null> {
  return db.prepare(`SELECT * FROM templates WHERE id = ?`).bind(id).first<TemplateRow>();
}

export async function createTemplate(
  db: D1Database,
  input: { name: string; categories?: string[]; category?: string; messageType?: string; messageContent?: string },
): Promise<TemplateRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const cats = JSON.stringify(input.categories ?? []);
  const legacyCat = input.categories?.[0] ?? input.category ?? 'general';
  await db
    .prepare(`INSERT INTO templates (id, name, category, categories, message_type, message_content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.name, legacyCat, cats, input.messageType ?? 'text', input.messageContent ?? '', now, now)
    .run();
  return (await getTemplateById(db, id))!;
}

export async function updateTemplate(
  db: D1Database,
  id: string,
  updates: Partial<{ name: string; category: string; categories: string[]; messageType: string; messageContent: string }>,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.categories !== undefined) {
    sets.push('categories = ?');
    values.push(JSON.stringify(updates.categories));
    // keep legacy category in sync with first item
    sets.push('category = ?');
    values.push(updates.categories[0] ?? 'general');
  } else if (updates.category !== undefined) {
    sets.push('category = ?');
    values.push(updates.category);
  }
  if (updates.messageType !== undefined) { sets.push('message_type = ?'); values.push(updates.messageType); }
  if (updates.messageContent !== undefined) { sets.push('message_content = ?'); values.push(updates.messageContent); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);
  await db.prepare(`UPDATE templates SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
}

export async function deleteTemplate(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM templates WHERE id = ?`).bind(id).run();
}

// ── template_messages ──────────────────────────────────────────────────────

export interface TemplateMessageRow {
  id: string;
  template_id: string;
  message_id: string;
  step_order: number;
  created_at: string;
}

export interface TemplateMessageWithMessage extends TemplateMessageRow {
  message: MessageRow;
}

export async function getTemplateMessages(db: D1Database, templateId: string): Promise<TemplateMessageWithMessage[]> {
  const result = await db
    .prepare(`
      SELECT
        tm.id, tm.template_id, tm.message_id, tm.step_order, tm.created_at,
        m.id as m_id, m.message_type, m.content, m.alt_text, m.tags, m.label,
        m.created_at as m_created_at, m.updated_at as m_updated_at
      FROM template_messages tm
      JOIN messages m ON tm.message_id = m.id
      WHERE tm.template_id = ?
      ORDER BY tm.step_order ASC
    `)
    .bind(templateId)
    .all<Record<string, unknown>>();

  return result.results.map((row) => ({
    id: row.id as string,
    template_id: row.template_id as string,
    message_id: row.message_id as string,
    step_order: row.step_order as number,
    created_at: row.created_at as string,
    message: {
      id: row.m_id as string,
      message_type: row.message_type as MessageRow['message_type'],
      content: row.content as string,
      alt_text: row.alt_text as string | null,
      tags: row.tags as string,
      label: row.label as string | null,
      created_at: row.m_created_at as string,
      updated_at: row.m_updated_at as string,
    },
  }));
}

export async function addMessageToTemplate(
  db: D1Database,
  templateId: string,
  messageId: string,
  stepOrder: number,
): Promise<void> {
  const count = await db
    .prepare('SELECT COUNT(*) as cnt FROM template_messages WHERE template_id = ?')
    .bind(templateId)
    .first<{ cnt: number }>();
  if ((count?.cnt ?? 0) >= 5) throw new Error('Template already has 5 messages (max)');
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare('INSERT INTO template_messages (id, template_id, message_id, step_order, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, templateId, messageId, stepOrder, now)
    .run();
}

export async function removeMessageFromTemplate(
  db: D1Database,
  templateId: string,
  messageId: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM template_messages WHERE template_id = ? AND message_id = ?')
    .bind(templateId, messageId)
    .run();
}

export async function resolveTemplateMessages(db: D1Database, templateId: string): Promise<MessageRow[]> {
  const rows = await getTemplateMessages(db, templateId);
  return rows.map((r) => r.message);
}
