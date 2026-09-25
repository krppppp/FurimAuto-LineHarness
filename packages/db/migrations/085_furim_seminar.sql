-- 週1セミナー（生配信）の日程アンケートと告知（Capsec #331・2026-09-25）。
--
-- くろさんが週1で生配信セミナーをやると決め、日曜 9:00 に候補日時のアンケートを LINE で送り、
-- 17:00 に得票上位 2 枠を開催枠として告知する運用になった（仕様: specs/weekly-seminar-funnel.md）。
-- 票は「同じ人が同じ枠を 2 回押しても 1 票」にする必要があるため、postback をそのまま
-- messages_log に流すのではなく専用の表で (week_id, slot_id, friend_id) を UNIQUE にして数える。
-- 週ごとの状態（アンケート送信済み・集計済み・告知済み）も 5 分 cron が二重に送らないための
-- 枠取りに使う。cron は毎 5 分走り、21:00 などは 6 時間 cron と同時に発火するため、
-- 時刻の一致だけでは 1 回きりにならない（kaisetsu-delivery と同じ事故を避ける）。
CREATE TABLE IF NOT EXISTS furim_seminar_weeks (
  week_id        TEXT PRIMARY KEY,          -- 開催週を表す日曜日の JST 日付 'YYYY-MM-DD'
  stream_url     TEXT,                      -- 配信の入口（YouTube チャンネルの /live URL。毎週使い回す）
  survey_sent_at TEXT,                      -- アンケートを送った時刻（JST ISO+09:00。NULL なら未送信＝送信の枠取りに使う）
  decided_at     TEXT,                      -- 集計して開催枠を決めた時刻（JST ISO+09:00）
  announced_at   TEXT,                      -- 告知を送った時刻（JST ISO+09:00）
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS furim_seminar_slots (
  id          TEXT PRIMARY KEY,             -- UUID
  week_id     TEXT NOT NULL,                -- furim_seminar_weeks.week_id
  slot_id     TEXT NOT NULL,                -- 週の中で枠を指す短い ID（'s1'〜's5'。postback の data に入る）
  starts_at   TEXT NOT NULL,                -- 開催開始日時（JST ISO+09:00）
  is_chosen   INTEGER NOT NULL DEFAULT 0,   -- 1 = 得票上位で開催が決まった枠
  reminded_at TEXT,                         -- 30 分前リマインドを送った時刻（JST ISO+09:00・二重送信の枠取りに使う）
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_furim_seminar_slots_week_slot ON furim_seminar_slots(week_id, slot_id);
CREATE INDEX IF NOT EXISTS idx_furim_seminar_slots_starts ON furim_seminar_slots(starts_at);

CREATE TABLE IF NOT EXISTS furim_seminar_votes (
  id           TEXT PRIMARY KEY,            -- UUID
  week_id      TEXT NOT NULL,               -- furim_seminar_weeks.week_id
  slot_id      TEXT NOT NULL,               -- furim_seminar_slots.slot_id、または 'none'（どれも都合が合わない）
  friend_id    TEXT NOT NULL,               -- friends.id
  line_user_id TEXT,                        -- 記録時点の LINE ユーザー ID（後から友だちを引き直さずに済ませるため）
  voted_at     TEXT NOT NULL                -- 押した時刻（JST ISO+09:00）
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_furim_seminar_votes_unique ON furim_seminar_votes(week_id, slot_id, friend_id);
CREATE INDEX IF NOT EXISTS idx_furim_seminar_votes_week ON furim_seminar_votes(week_id, slot_id);
