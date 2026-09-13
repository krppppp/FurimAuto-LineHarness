-- FurimAuto 段階3（Capsec #245・2026-09-14）: 拡張の認証・ログを GAS から Worker（/api/ext/v1）へ。
-- 認証は furim_customers＋furim_feature_flags が正（KV はキャッシュ）。実行ログ・無料台帳・手動コピー・
-- ショップ調査は GAS のシートと同じ粒度で D1 に置く（ヘルス巡回が顧客・日時・種別で引ける）。

-- 顧客: 端末判定文字列（旧: シートが正）・各サイト URL・在庫管理シート・Worker 経由の最終認証
ALTER TABLE furim_customers ADD COLUMN device_code TEXT;               -- 端末判定文字列（GAS getKeyCodeSet が発行していたもの）
ALTER TABLE furim_customers ADD COLUMN shops_url TEXT;                 -- ShopsURL
ALTER TABLE furim_customers ADD COLUMN rakuma_url TEXT;                -- ラクマURL
ALTER TABLE furim_customers ADD COLUMN yahoo_flea_url TEXT;            -- ヤフフリURL
ALTER TABLE furim_customers ADD COLUMN inventory_sheet_url TEXT;       -- 在庫管理シート
ALTER TABLE furim_customers ADD COLUMN inventory_sheet_created_at TEXT;
ALTER TABLE furim_customers ADD COLUMN ext_last_seen_at TEXT;          -- Worker 経由で最後に認証した時刻。NULL = まだ旧拡張（GAS 経路）
CREATE INDEX IF NOT EXISTS idx_furim_customers_key_code ON furim_customers(key_code);
CREATE INDEX IF NOT EXISTS idx_furim_customers_mercari_url ON furim_customers(mercari_url);

-- チケット消費の履歴（旧: 自動コピー出品履歴シートのコピー元/先）
ALTER TABLE furim_ticket_ledger ADD COLUMN source_url TEXT;
ALTER TABLE furim_ticket_ledger ADD COLUMN target_url TEXT;

-- 自動化処理履歴（旧: シート「自動化処理履歴」）。payload は受け取った JSON 丸ごと
CREATE TABLE IF NOT EXISTS furim_execution_logs (
  id                        TEXT PRIMARY KEY,
  line_user_id              TEXT,
  key_code                  TEXT,
  service                   TEXT,
  account_url               TEXT,
  mypage_info_updated_date  TEXT,
  count_rating              TEXT,
  sales_amount              TEXT,
  total_target_count        TEXT,
  options                   TEXT,
  dedupe_key                TEXT NOT NULL UNIQUE,
  client                    TEXT,
  payload                   TEXT NOT NULL,
  created_at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_furim_execution_logs_user ON furim_execution_logs(line_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_furim_execution_logs_created ON furim_execution_logs(created_at);

-- 拡張からの業務エラー（旧: シート「Error」）。ヘルス巡回の入口
CREATE TABLE IF NOT EXISTS furim_ext_errors (
  id                   TEXT PRIMARY KEY,
  line_user_id         TEXT,
  key_code             TEXT,
  method               TEXT NOT NULL,
  error                TEXT NOT NULL,
  mercari_url          TEXT,
  discrimination_code  TEXT,
  client               TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_furim_ext_errors_created ON furim_ext_errors(created_at);
CREATE INDEX IF NOT EXISTS idx_furim_ext_errors_user ON furim_ext_errors(line_user_id, created_at);

-- 無料アカウント台帳（旧: シート「無料アカウント台帳」。1 インストール = 1 行・URL 列は改行区切り）
CREATE TABLE IF NOT EXISTS furim_free_accounts (
  install_id          TEXT PRIMARY KEY,
  mercari_url         TEXT,
  rakuma_url          TEXT,
  yahoo_flea_url      TEXT,
  yahoo_auction_url   TEXT,
  shops_url           TEXT,
  key_code            TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- 手動コピー出品履歴（旧: シート「手動コピー出品履歴」。1 コピー = 1 行・dedupe_key で開始→完了を紐付け）
CREATE TABLE IF NOT EXISTS furim_manual_copy_logs (
  id             TEXT PRIMARY KEY,
  dedupe_key     TEXT NOT NULL UNIQUE,
  install_id     TEXT,
  key_code       TEXT,
  line_user_id   TEXT,
  item_id        TEXT,
  item_name      TEXT,
  target         TEXT,
  status         TEXT NOT NULL,   -- '開始' | '出品完了' | '未完了(期限切れ)'
  target_url     TEXT,
  source_url     TEXT,
  started_at     TEXT NOT NULL,
  completed_at   TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_furim_manual_copy_logs_install ON furim_manual_copy_logs(install_id, target);
CREATE INDEX IF NOT EXISTS idx_furim_manual_copy_logs_created ON furim_manual_copy_logs(created_at);

-- ショップ調査履歴（旧: シート「ショップ調査履歴」）
CREATE TABLE IF NOT EXISTS furim_shop_research_logs (
  id              TEXT PRIMARY KEY,
  dedupe_key      TEXT NOT NULL UNIQUE,
  install_id      TEXT,
  key_code        TEXT,
  line_user_id    TEXT,
  my_mercari_url  TEXT,
  target_url      TEXT NOT NULL,
  is_free         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_furim_shop_research_logs_install ON furim_shop_research_logs(install_id, is_free);
CREATE INDEX IF NOT EXISTS idx_furim_shop_research_logs_created ON furim_shop_research_logs(created_at);
