-- FurimAuto 段階4-A（Capsec #251・2026-09-14）: 管理画面「データ」区画からの行編集の監査ログ。
-- /api/furim/admin/:table/:id への PATCH で、変更された列ごとに 1 行（誰が・いつ・どの行の・どの列を・前後の値）。
CREATE TABLE IF NOT EXISTS furim_admin_audit (
  id           TEXT PRIMARY KEY,
  staff_id     TEXT NOT NULL,
  staff_name   TEXT NOT NULL,
  table_name   TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  column_name  TEXT NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_furim_admin_audit_row ON furim_admin_audit(table_name, row_id, created_at);
