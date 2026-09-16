-- 異常区画の「確認済み」（Capsec #289）。
-- トップの異常は、片づくまで毎日同じものが並ぶ。見た人が確認済みにできるようにして、
-- 8 月から続いているものと今日出たものを分けて見せる。誰がいつ確認したかを残す。
--
-- 再び出す条件（放置の言い訳にしない）:
--   - 件数が確認時より増えた
--   - いったん解消してから再発した（初回検知が確認時より新しい）
CREATE TABLE IF NOT EXISTS furim_anomaly_acks (
  kind TEXT NOT NULL,              -- 異常の種類（gas_retry_pending など）
  ack_key TEXT NOT NULL DEFAULT '', -- 同じ種類で個別に確認したいときの識別子。既定は種類ごと 1 行
  acked_at TEXT NOT NULL,          -- 確認した日時（JST の ISO+09:00）
  acked_by TEXT NOT NULL,          -- 確認した人（スタッフ名）
  acked_by_id TEXT,                -- スタッフID
  count_at_ack INTEGER NOT NULL,   -- 確認したときの件数
  first_seen_at_ack TEXT,          -- 確認したときの初回検知
  note TEXT,
  PRIMARY KEY (kind, ack_key)
);
