-- templates.message_type の CHECK 制約を拡張して video を許可
-- SQLite は ALTER COLUMN が不可のため、テーブル再作成で対応

PRAGMA foreign_keys = OFF;

CREATE TABLE templates_v2 (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'general',
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'carousel', 'video')),
  message_content TEXT NOT NULL,
  categories      TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

INSERT INTO templates_v2 SELECT * FROM templates;

DROP TABLE templates;

ALTER TABLE templates_v2 RENAME TO templates;

CREATE INDEX IF NOT EXISTS idx_templates_category ON templates (category);

PRAGMA foreign_keys = ON;
