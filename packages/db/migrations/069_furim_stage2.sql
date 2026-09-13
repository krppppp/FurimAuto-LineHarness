-- FurimAuto 段階2（Capsec #244・2026-09-13）: Stripe 起点と紹介処理を D1 先行にする。
-- 顧客マスターのサブスク関連列・台帳シート・紹介台帳・クーポン表・マスタを D1 に持つ。
-- 段階3 まで拡張はシートを読むので、キーコード/期限/チケット/機能フラグは GAS 経由の鏡写しを残す。

-- 顧客（1 行 = 1 LINE ユーザー）にサブスク・拡張が読む値を追加
ALTER TABLE furim_customers ADD COLUMN subscription_id TEXT;
ALTER TABLE furim_customers ADD COLUMN subscription_start_at TEXT;   -- JST 'YYYY-MM-DD HH:MM:SS'
ALTER TABLE furim_customers ADD COLUMN subscription_end_at TEXT;     -- JST（+24h バッファ込み。拡張の期限判定）
ALTER TABLE furim_customers ADD COLUMN subscription_price INTEGER;
ALTER TABLE furim_customers ADD COLUMN plan_label TEXT;              -- 表示名（PBプラン:メルカリ 基本プラン 等）
ALTER TABLE furim_customers ADD COLUMN plan_label_legacy TEXT;
ALTER TABLE furim_customers ADD COLUMN packages TEXT;                -- plan-builder の packages csv
ALTER TABLE furim_customers ADD COLUMN features TEXT;                -- plan-builder の features csv
ALTER TABLE furim_customers ADD COLUMN multi_channel_sites TEXT;
ALTER TABLE furim_customers ADD COLUMN subscription_source TEXT;     -- 'plan-builder' | 'legacy'
ALTER TABLE furim_customers ADD COLUMN subscription_status TEXT;     -- 'trial' | 'active' | 'canceled'
ALTER TABLE furim_customers ADD COLUMN copy_tickets INTEGER;         -- コピー出品チケット残数（段階3 まではシートが正）
ALTER TABLE furim_customers ADD COLUMN mercari_url TEXT;             -- 段階3 まではシートが正
ALTER TABLE furim_customers ADD COLUMN customer_email TEXT;
ALTER TABLE furim_customers ADD COLUMN last_invoice_id TEXT;
ALTER TABLE furim_customers ADD COLUMN canceled_at TEXT;

-- 機能フラグ（顧客マスターの mChangePrice〜最終列。AutoMultiChannel は巡回サイトの文字列）
CREATE TABLE IF NOT EXISTS furim_feature_flags (
  line_user_id TEXT NOT NULL,
  feature_key  TEXT NOT NULL,
  value        TEXT NOT NULL,      -- '1' / '0' / 'メルカリ/ラクマ'
  source       TEXT,               -- 'plan' | 'promo' | 'always_enabled' | 'manual' | 'sheet'
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (line_user_id, feature_key)
);

-- 決済台帳（1 invoice = 1 行。通算回数/総額はここの集計で出す）
CREATE TABLE IF NOT EXISTS furim_payments (
  invoice_id          TEXT PRIMARY KEY,
  stripe_event_id     TEXT,
  line_user_id        TEXT,
  stripe_customer_id  TEXT,
  subscription_id     TEXT,
  plan_name           TEXT,
  billing_reason      TEXT,
  subscription_price  INTEGER,
  discount_amount     INTEGER,
  price_excl_tax      INTEGER,
  tax_amount          INTEGER,
  actual_paid_amount  INTEGER,
  customer_email      TEXT,
  paid_at             TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_furim_payments_user ON furim_payments(line_user_id, paid_at);

-- コピー出品チケット台帳（付与・消費すべて。idempotency_key で二重付与を防ぐ）
CREATE TABLE IF NOT EXISTS furim_ticket_ledger (
  id                 TEXT PRIMARY KEY,
  line_user_id       TEXT NOT NULL,
  delta              INTEGER NOT NULL,
  reason             TEXT NOT NULL,        -- 'purchase' | 'premium_monthly' | 'free30' | 'consume' | 'manual' | 'sheet_backfill'
  idempotency_key    TEXT NOT NULL UNIQUE,
  payment_intent_id  TEXT,
  invoice_id         TEXT,
  amount             INTEGER,
  currency           TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_furim_ticket_ledger_user ON furim_ticket_ledger(line_user_id, created_at);

-- 解約履歴（キャンセル一覧の置き換え）
CREATE TABLE IF NOT EXISTS furim_cancellations (
  id               TEXT PRIMARY KEY,
  line_user_id     TEXT,
  stripe_event_id  TEXT UNIQUE,
  subscription_id  TEXT,
  plan_name        TEXT,
  mercari_url      TEXT,
  canceled_at      TEXT NOT NULL
);

-- 紹介台帳（LINE紹介履歴の置き換え）。アンバサダー本体は affiliates（code＝アンバサダーコード）
CREATE TABLE IF NOT EXISTS furim_referrals (
  id                    TEXT PRIMARY KEY,
  affiliate_id          TEXT NOT NULL,
  ambassador_friend_id  TEXT,
  introduced_friend_id  TEXT NOT NULL,
  ref_code              TEXT,             -- URL 経由なら affiliate_links.ref_code
  source                TEXT NOT NULL,    -- 'url' | 'keyword' | 'retry' | 'sheet_backfill'
  ambassador_plan_name  TEXT,
  reward_coupon_name    TEXT,             -- NULL = 10 枚上限 or 解決不能
  reward_coupon_id      TEXT,
  reward_applied_at     TEXT,
  introduced_coupon_id  TEXT,
  trial_extended_days   INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_furim_referrals_introduced ON furim_referrals(introduced_friend_id);
CREATE INDEX IF NOT EXISTS idx_furim_referrals_affiliate ON furim_referrals(affiliate_id, created_at);
CREATE INDEX IF NOT EXISTS idx_furim_referrals_ambassador ON furim_referrals(ambassador_friend_id, reward_applied_at);

-- クーポン名 → Stripe クーポン ID（クーポン一覧の置き換え）
CREATE TABLE IF NOT EXISTS furim_coupons (
  name       TEXT PRIMARY KEY,
  coupon_id  TEXT NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1
);

-- マスタのミラー（機能/パッケージ/プラン/チケット単価。段階4 の管理画面までシートから refresh）
CREATE TABLE IF NOT EXISTS furim_master (
  kind            TEXT NOT NULL,   -- 'feature' | 'package' | 'plan' | 'ticket_price'
  key             TEXT NOT NULL,
  display_name    TEXT,
  stripe_price_id TEXT,
  monthly_price   INTEGER,
  active          INTEGER NOT NULL DEFAULT 1,
  payload         TEXT NOT NULL,   -- 行全体の JSON
  fetched_at      TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);
