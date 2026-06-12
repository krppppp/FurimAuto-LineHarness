-- FurimAuto独自: scenario_steps.message_type に 'video' を許可する。
-- upstream は ('text','image','flex') のみだが、FurimAutoのステップ配信は
-- インストール解説動画(video)を含むため拡張する。
-- SQLite は CHECK 制約を ALTER できないのでテーブル再構築（id保持コピー）。
-- id を保持するため messages_log.scenario_step_id 等の参照は維持される。

CREATE TABLE scenario_steps_new (
  id              TEXT PRIMARY KEY,
  scenario_id     TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
  step_order      INTEGER NOT NULL,
  delay_minutes   INTEGER NOT NULL DEFAULT 0,
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'video')),
  message_content TEXT NOT NULL,
  offset_days     INTEGER,
  offset_minutes  INTEGER,
  delivery_time   TEXT,
  template_id     TEXT REFERENCES templates(id) ON DELETE SET NULL,
  on_reach_tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  condition_type     TEXT,
  condition_value    TEXT,
  next_step_on_false INTEGER,
  UNIQUE (scenario_id, step_order)
);

INSERT INTO scenario_steps_new (
  id, scenario_id, step_order, delay_minutes, message_type, message_content,
  offset_days, offset_minutes, delivery_time, template_id, on_reach_tag_id,
  created_at, condition_type, condition_value, next_step_on_false
)
SELECT
  id, scenario_id, step_order, delay_minutes, message_type, message_content,
  offset_days, offset_minutes, delivery_time, template_id, on_reach_tag_id,
  created_at, condition_type, condition_value, next_step_on_false
FROM scenario_steps;

DROP TABLE scenario_steps;
ALTER TABLE scenario_steps_new RENAME TO scenario_steps;

CREATE INDEX IF NOT EXISTS idx_scenario_steps_scenario_id ON scenario_steps (scenario_id);
