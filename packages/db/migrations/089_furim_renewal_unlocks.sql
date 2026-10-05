-- 更新 7 日前の全機能開放（TB-1009 / TB-25・2026-10-05）。
-- furim_feature_flags は書き換えず、期限付きの開放をここに記録して拡張の認証（ext-auth）だけが上乗せする。
-- 1 人につき更新 1 回ぶんに 1 回（cycle = subscription_id + ':' + 更新日 YYYY-MM-DD）。

CREATE TABLE IF NOT EXISTS furim_renewal_unlocks (
  id            TEXT PRIMARY KEY,
  line_user_id  TEXT NOT NULL,
  cycle         TEXT NOT NULL,
  until_ms      INTEGER NOT NULL,   -- 開放の終わり（epoch ms）＝更新日時
  until_at      TEXT NOT NULL,      -- 同じ値の JST 表記（読む人のため）
  flags         TEXT NOT NULL,      -- 上乗せする機能フラグ（JSON。trial パッケージ相当を開放時点で固定）
  packages      TEXT,               -- 開放時点の契約パッケージ
  granted_at    TEXT NOT NULL,
  msg1_sent_at  TEXT,               -- 開放の案内（更新 7 日前）
  msg2_sent_at  TEXT,               -- 多販路・在庫管理（更新 4 日前）
  msg3_sent_at  TEXT,               -- 続けるなら（更新前日）
  UNIQUE (line_user_id, cycle)
);
CREATE INDEX IF NOT EXISTS idx_furim_renewal_unlocks_user ON furim_renewal_unlocks(line_user_id, until_ms);
CREATE INDEX IF NOT EXISTS idx_furim_renewal_unlocks_until ON furim_renewal_unlocks(until_ms);
