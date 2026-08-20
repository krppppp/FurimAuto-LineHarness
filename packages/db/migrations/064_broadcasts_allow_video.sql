-- FurimAuto独自: broadcasts.message_type に 'video' を許可する。
-- 配信の2通目に解説動画（video メッセージ）を入れるため。upstream は ('text','image','flex') のみで、
-- video を含む配信は送信時のログ書き込みで CHECK に弾かれ、LINEへ届かないまま success_count=0 で終わっていた（2026-08-20 実測）。
-- SQLite は CHECK 制約を ALTER できないのでテーブル再構築（id保持コピー）。047 と同じ手順。

CREATE TABLE broadcasts_new (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'video')),
  message_content TEXT NOT NULL,
  target_type     TEXT NOT NULL CHECK (target_type IN ('all', 'tag')) DEFAULT 'all',
  target_tag_id   TEXT REFERENCES tags (id) ON DELETE SET NULL,
  status          TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'sending', 'sent')) DEFAULT 'draft',
  scheduled_at    TEXT,
  sent_at         TEXT,
  total_count     INTEGER NOT NULL DEFAULT 0,
  success_count   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  line_account_id TEXT,
  alt_text        TEXT,
  line_request_id TEXT,
  aggregation_unit TEXT,
  batch_offset    INTEGER NOT NULL DEFAULT 0,
  segment_conditions TEXT,
  account_ids     TEXT CHECK (account_ids IS NULL OR json_valid(account_ids)),
  dedup_priority  TEXT CHECK (dedup_priority IS NULL OR json_valid(dedup_priority)),
  failed_account_ids TEXT CHECK (failed_account_ids IS NULL OR json_valid(failed_account_ids)),
  dedup_progress  TEXT CHECK (dedup_progress IS NULL OR json_valid(dedup_progress)),
  batch_lock_at   TEXT,
  track_links     INTEGER NOT NULL DEFAULT 1,
  messages        TEXT CHECK (messages IS NULL OR json_valid(messages))
);

INSERT INTO broadcasts_new (
  id, title, message_type, message_content, target_type, target_tag_id, status,
  scheduled_at, sent_at, total_count, success_count, created_at, line_account_id,
  alt_text, line_request_id, aggregation_unit, batch_offset, segment_conditions,
  account_ids, dedup_priority, failed_account_ids, dedup_progress, batch_lock_at,
  track_links, messages
)
SELECT
  id, title, message_type, message_content, target_type, target_tag_id, status,
  scheduled_at, sent_at, total_count, success_count, created_at, line_account_id,
  alt_text, line_request_id, aggregation_unit, batch_offset, segment_conditions,
  account_ids, dedup_priority, failed_account_ids, dedup_progress, batch_lock_at,
  track_links, messages
FROM broadcasts;

DROP TABLE broadcasts;
ALTER TABLE broadcasts_new RENAME TO broadcasts;

CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts (status);
