-- 日次ヘルス巡回の状態を D1 に置く（Capsec #290・2026-09-17）。
--
-- これまで巡回は Vault（iCloud）の md ファイルに状態を書いていた。launchd から起動した
-- プロセスは iCloud を読めないため、巡回ごと止まっていた（#210）。状態はファイルではなく
-- D1 に置き、時刻で判定できる形にする。
--
-- furim_health_notices: 同じユーザーに同じ種類の案内を送りすぎない（最終送信から 36 時間）
-- furim_health_acks: くろさんの「対応済み」申告によるサイレンス（済=当日・対応中=24h・無視=7日）
CREATE TABLE IF NOT EXISTS furim_health_notices (
  line_user_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'loop_stuck' など案内の種類
  friend_id TEXT,
  display_name TEXT,
  last_notified_at TEXT NOT NULL,  -- JST の ISO+09:00
  detail TEXT,                     -- 送った時点の根拠（stuck 件数など）
  PRIMARY KEY (line_user_id, kind)
);

CREATE TABLE IF NOT EXISTS furim_health_acks (
  event_id TEXT PRIMARY KEY,       -- 事象ID（例 #0818-3）
  event_key TEXT,                  -- 事象キー（例 mochi me×STALL）
  state TEXT NOT NULL,             -- 'done' | 'in_progress' | 'ignore'
  acked_at TEXT NOT NULL,          -- 申告を拾った時刻（JST の ISO+09:00）
  silence_until TEXT,              -- サイレンスの終わり（JST の ISO+09:00）
  source TEXT,                     -- 'line' など、どこで拾ったか
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_furim_health_acks_silence ON furim_health_acks(silence_until);
