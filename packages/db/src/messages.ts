import { jstNow } from './utils.js';

export interface MessageRow {
  id: string;
  message_type: 'text' | 'image' | 'flex' | 'video';
  content: string;
  alt_text: string | null;
  tags: string;
  label: string | null;
  created_at: string;
  updated_at: string;
}

export async function getMessages(
  db: D1Database,
  opts?: { type?: string; tag?: string; limit?: number },
): Promise<MessageRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (opts?.type) { conditions.push('message_type = ?'); values.push(opts.type); }
  if (opts?.tag) { conditions.push("json_each.value = ?"); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  if (opts?.tag) {
    const result = await db
      .prepare(`SELECT m.* FROM messages m, json_each(m.tags) WHERE json_each.value = ? ${opts.type ? 'AND m.message_type = ?' : ''} ORDER BY m.created_at DESC LIMIT ?`)
      .bind(...(opts.type ? [opts.tag, opts.type] : [opts.tag]), opts.limit ?? 200)
      .all<MessageRow>();
    return result.results;
  }
  const result = await db
    .prepare(`SELECT * FROM messages ${where} ORDER BY created_at DESC LIMIT ?`)
    .bind(...values, opts?.limit ?? 200)
    .all<MessageRow>();
  return result.results;
}

export async function getMessageById(db: D1Database, id: string): Promise<MessageRow | null> {
  return db.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first<MessageRow>();
}

export async function createMessage(
  db: D1Database,
  input: { messageType: 'text' | 'image' | 'flex' | 'video'; content: string; altText?: string | null; tags?: string[]; label?: string | null },
): Promise<MessageRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const tags = JSON.stringify(input.tags ?? []);
  await db
    .prepare('INSERT INTO messages (id, message_type, content, alt_text, tags, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, input.messageType, input.content, input.altText ?? null, tags, input.label ?? null, now, now)
    .run();
  return (await getMessageById(db, id))!;
}

export async function updateMessage(
  db: D1Database,
  id: string,
  updates: Partial<{ messageType: string; content: string; altText: string | null; tags: string[]; label: string | null }>,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.messageType !== undefined) { sets.push('message_type = ?'); values.push(updates.messageType); }
  if (updates.content !== undefined) { sets.push('content = ?'); values.push(updates.content); }
  if ('altText' in updates) { sets.push('alt_text = ?'); values.push(updates.altText ?? null); }
  if (updates.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(updates.tags)); }
  if ('label' in updates) { sets.push('label = ?'); values.push(updates.label ?? null); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(jstNow(), id);
  await db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
}

export async function deleteMessage(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM messages WHERE id = ?').bind(id).run();
}
