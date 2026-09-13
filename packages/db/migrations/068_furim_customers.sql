-- FurimAuto 段階1（Capsec #243・2026-09-13）: LINE タップ操作（キーコード発行・月額会員ページ・
-- 限定特典GET・チケット注文）が GAS/スプレッドシートを同期で待たずに済むよう、必要な値を D1 に持つ。
-- スプレッドシート「顧客情報-サブスク情報-キーコード」の鏡ではなく、LINE 起点の状態は D1 が正。
-- 端末判定文字列（拡張が GAS 経由で書く）だけは段階1ではシートが正で、device_activated に取り込む。
CREATE TABLE IF NOT EXISTS furim_customers (
  line_user_id       TEXT PRIMARY KEY,
  stripe_customer_id TEXT,
  key_code           TEXT,
  key_code_issued    INTEGER NOT NULL DEFAULT 0,  -- シート「初回発行」
  device_activated   INTEGER NOT NULL DEFAULT 0,  -- シート「端末判定文字列」が非空
  survey_answer      TEXT,                        -- シート「アンケート回答」
  free30_ticket      INTEGER NOT NULL DEFAULT 0,  -- シート「Free30チケット」
  youtube_coupon     TEXT,                        -- シート「Youtubeクーポン」
  extend_keyword     TEXT,                        -- シート「延長キーワード」 '1w' | '3d' | '対象外'
  sheet_synced_at    TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_furim_customers_stripe ON furim_customers(stripe_customer_id);

-- D1 とシートの差分検知（移行期間のアラート用）。同じ (line_user_id, field) の未解決行は 1 本に保つ
CREATE TABLE IF NOT EXISTS furim_sync_diffs (
  id            TEXT PRIMARY KEY,
  line_user_id  TEXT NOT NULL,
  field         TEXT NOT NULL,    -- 列名 or 'row_missing_in_d1' / 'row_missing_in_sheet'
  d1_value      TEXT,
  sheet_value   TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  notified_at   TEXT,
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_furim_sync_diffs_open ON furim_sync_diffs(resolved_at, notified_at, first_seen_at);
