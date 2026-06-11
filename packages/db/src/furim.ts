// FurimAuto 独自 DB ヘルパー（upstreamに依存しない隔離レイヤー）。
// upstreamファイルを汚さず、ここに FurimAuto 固有のクエリを集約する。
import type { MessageRow } from './messages.js';

// ── オートメーションアクション（automation_actions テーブル / FurimAuto独自モデル） ──
export interface AutomationActionRow {
  id: string;
  automation_id: string;
  step_order: number;
  action_type: string;
  params: string; // JSON
  condition_json: string | null;
  on_error: 'continue' | 'abort';
  is_active: number;
  label: string | null;
  template_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function getAutomationActions(
  db: D1Database,
  automationId: string,
  activeOnly = true,
): Promise<AutomationActionRow[]> {
  const sql = activeOnly
    ? `SELECT * FROM automation_actions WHERE automation_id = ? AND is_active = 1 ORDER BY step_order ASC`
    : `SELECT * FROM automation_actions WHERE automation_id = ? ORDER BY step_order ASC`;
  const result = await db.prepare(sql).bind(automationId).all<AutomationActionRow>();
  return result.results;
}

// ── テンプレートメッセージ（template_messages テーブル / FurimAuto独自モデル） ──
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

export async function getTemplateMessages(
  db: D1Database,
  templateId: string,
): Promise<TemplateMessageWithMessage[]> {
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

export async function resolveTemplateMessages(db: D1Database, templateId: string): Promise<MessageRow[]> {
  const rows = await getTemplateMessages(db, templateId);
  return rows.map((r) => r.message);
}
