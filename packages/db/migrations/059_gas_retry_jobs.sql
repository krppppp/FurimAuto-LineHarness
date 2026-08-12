-- GAS呼び出しの再実行キュー（2026-08-13）。
-- Worker→GASのfetchが間欠的にハングし、キーコードリセット等が無言で失敗していた対策。
-- インラインで完遂できなかったジョブを積み、cron(*/5)の sweepGasRetryJobs が完遂させる。
CREATE TABLE IF NOT EXISTS gas_retry_jobs (
  id TEXT PRIMARY KEY,
  line_user_id TEXT NOT NULL,
  method TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  notify_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gas_retry_jobs_status ON gas_retry_jobs(status, created_at);
