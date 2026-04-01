-- Add 'video' to message_type CHECK constraint in scenario_steps
-- SQLite requires table recreation to change a CHECK constraint

PRAGMA foreign_keys = OFF;

CREATE TABLE scenario_steps_new (
  id              TEXT PRIMARY KEY,
  scenario_id     TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
  step_order      INTEGER NOT NULL,
  delay_minutes   INTEGER NOT NULL DEFAULT 0,
  condition_type  TEXT,
  condition_value TEXT,
  next_step_on_false INTEGER,
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'video')),
  message_content TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (scenario_id, step_order)
);

INSERT INTO scenario_steps_new SELECT id, scenario_id, step_order, delay_minutes, condition_type, condition_value, next_step_on_false, message_type, message_content, created_at FROM scenario_steps;

DROP TABLE scenario_steps;

ALTER TABLE scenario_steps_new RENAME TO scenario_steps;

CREATE INDEX IF NOT EXISTS idx_scenario_steps_scenario_id ON scenario_steps (scenario_id);

PRAGMA foreign_keys = ON;
