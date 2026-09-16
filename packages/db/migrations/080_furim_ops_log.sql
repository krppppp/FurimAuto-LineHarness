-- 手で片づけた操作の記録（Capsec #289 追加・くろさん指示 2026-09-16）。
--
-- 2026-08〜09 の継続課金メッセージの件（#287）では、あとから「本当に届いたのか」「誰が
-- どう片づけたのか」を追う必要が出た。確認済み（furim_anomaly_acks）は「見た」記録で、
-- こちらは「完了扱いにした」記録。何を何件、どういう理由で片づけたかを残す。
CREATE TABLE IF NOT EXISTS furim_ops_log (
  id TEXT PRIMARY KEY,
  acted_at TEXT NOT NULL,        -- 実行日時（JST の ISO+09:00）
  actor TEXT NOT NULL,           -- 実行した人（例: 権限管理課）
  action TEXT NOT NULL,          -- 何をしたか（例: mark_completed）
  target TEXT NOT NULL,          -- 対象（例: stripe_processed_actions）
  target_count INTEGER NOT NULL, -- 件数
  goal TEXT,                     -- 根拠のゴール（例: Capsec #287）
  note TEXT                      -- なぜそうしたか
);

CREATE INDEX IF NOT EXISTS idx_furim_ops_log_acted_at ON furim_ops_log(acted_at);
