-- FurimAuto 独自テーブル（upstreamスキーマに上乗せ）。
-- upstream最新(〜045)の後に適用する。event-bus / packages/db/src/furim.ts が参照。
-- automations / templates テーブルは upstream 側に存在する前提（FK参照）。

-- ── automation_actions（FurimAutoのオートメーションアクション。014+015を統合） ──
CREATE TABLE IF NOT EXISTS automation_actions (
  id            TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  step_order    INTEGER NOT NULL DEFAULT 0,
  action_type   TEXT NOT NULL,
  params        TEXT NOT NULL DEFAULT '{}',  -- JSON
  condition_json TEXT,                        -- JSON or NULL
  on_error      TEXT NOT NULL DEFAULT 'continue' CHECK (on_error IN ('continue', 'abort')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  label         TEXT,
  template_id   TEXT REFERENCES templates(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_automation_actions_automation ON automation_actions(automation_id);
CREATE INDEX IF NOT EXISTS idx_automation_actions_order ON automation_actions(automation_id, step_order);

-- ── messages（メッセージ最小単位） ──
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

-- ── template_messages（template 1:多 message） ──
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
