-- LP行動計測: イベントごとの詳細（JSON文字列）を保存する。
-- 診断LPの「どの設問で何を選んだか」「どのボタンを押したか」を、設問が変わっても意味が残る
-- 文字列（設問文・選択肢の表記）で残すため。session_id で ref_tracking.lp_session_id と接続できる。
ALTER TABLE lp_events ADD COLUMN detail TEXT;
CREATE INDEX IF NOT EXISTS idx_lp_events_type_created ON lp_events(event_type, created_at);
