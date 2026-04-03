-- messages: メッセージ最小単位（text/image/flex/video）
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'video')),
  content      TEXT NOT NULL,
  alt_text     TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',
  label        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_messages_type ON messages (message_type);

-- template_messages: template 1:多 message (最大5件はアプリ層で制御)
CREATE TABLE IF NOT EXISTS template_messages (
  id          TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL REFERENCES messages (id) ON DELETE RESTRICT,
  step_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (template_id, step_order)
);

CREATE INDEX IF NOT EXISTS idx_template_messages_template ON template_messages (template_id);
CREATE INDEX IF NOT EXISTS idx_template_messages_message  ON template_messages (message_id);

-- automation_actions にtemplate_id追加（paramsは後方互換で残す）
ALTER TABLE automation_actions ADD COLUMN template_id TEXT REFERENCES templates (id) ON DELETE SET NULL;

-- scenario_steps にtemplate_id追加（message_type/message_contentは後方互換で残す）
ALTER TABLE scenario_steps ADD COLUMN template_id TEXT REFERENCES templates (id) ON DELETE SET NULL;
