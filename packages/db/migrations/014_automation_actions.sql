-- automation_actions: オートメーションのアクションを個別テーブルで管理
-- automations.actions (JSON配列) の後継。後方互換のため旧カラムは残す。

CREATE TABLE IF NOT EXISTS automation_actions (
  id          TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  step_order  INTEGER NOT NULL DEFAULT 0,
  action_type TEXT NOT NULL,
  params      TEXT NOT NULL DEFAULT '{}',  -- JSON
  condition_json TEXT,                     -- JSON or NULL: このアクションを実行する条件
  on_error    TEXT NOT NULL DEFAULT 'continue' CHECK (on_error IN ('continue', 'abort')),
  is_active   INTEGER NOT NULL DEFAULT 1,
  label       TEXT,                        -- UIに表示する任意ラベル
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_automation_actions_automation ON automation_actions(automation_id);
CREATE INDEX IF NOT EXISTS idx_automation_actions_order ON automation_actions(automation_id, step_order);
