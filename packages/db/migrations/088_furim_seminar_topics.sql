-- 生配信の配信を 3 通に作り直す（TB-821・2026-09-30 くろさん決定 TB-236 d2b31fb2）。
--
-- 日曜 17:00 の開催日時告知と一緒に「聞きたい内容アンケート」（6 択・複数選択）を送る。
-- 票は日程アンケートと同じく postback で受け、(week_id, topic_id, friend_id) の UNIQUE で二重押しを 1 票にする。
-- 「6 その他」を押した人の次の自由文は note に控える。
-- 集計は各枠の開始 1 時間前にくろさんへ送る。その二重送信を防ぐ枠取りに topic_reported_at を使う。
CREATE TABLE IF NOT EXISTS furim_seminar_topic_votes (
  id           TEXT PRIMARY KEY,            -- UUID
  week_id      TEXT NOT NULL,               -- furim_seminar_weeks.week_id
  topic_id     TEXT NOT NULL,               -- 't1'〜't6'（t6 = その他）
  friend_id    TEXT NOT NULL,               -- friends.id
  line_user_id TEXT,                        -- 記録時点の LINE ユーザー ID
  note         TEXT,                        -- t6 のときに受け取った自由記入（未記入は NULL）
  voted_at     TEXT NOT NULL                -- 押した時刻（JST ISO+09:00）
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_furim_seminar_topic_votes_unique ON furim_seminar_topic_votes(week_id, topic_id, friend_id);
CREATE INDEX IF NOT EXISTS idx_furim_seminar_topic_votes_friend ON furim_seminar_topic_votes(friend_id, topic_id, voted_at);

ALTER TABLE furim_seminar_slots ADD COLUMN topic_reported_at TEXT; -- 内容アンケートの集計をくろさんへ送った時刻（JST ISO+09:00・枠取り）
