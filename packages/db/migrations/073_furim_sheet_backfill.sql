-- FurimAuto 段階4-B（Capsec #252・2026-09-14）: スプレッドシートの過去分を D1 に取り込む。
-- 既存の対応テーブルに入らないシートだけをここで定義する（列はシートの見出しを写す。主キーは行のハッシュ）。
-- シートは閲覧用の履歴として凍結（書き込まない）。取り込みは POST /api/furim/backfill-sheets（冪等）。

-- キャンセル一覧: シートにあって furim_cancellations に無い列
ALTER TABLE furim_cancellations ADD COLUMN display_name TEXT;        -- LINE表示名（解約時点）
ALTER TABLE furim_cancellations ADD COLUMN side_job_judgment TEXT;   -- 副業継続判定(基準:出品最新30件が1ヶ月以内=◯)

-- 自動コピー出品履歴（旧: シート「自動コピー出品履歴」。GAS updateCopyCredit が 1 消費 = 1 行で追記）
CREATE TABLE IF NOT EXISTS furim_auto_copy_logs (
  id                 TEXT PRIMARY KEY,     -- 行ハッシュ
  line_user_id       TEXT,                 -- LINE表示名が顧客 1 人に一意に当たる時だけ解決
  display_name       TEXT,                 -- LINE表示名
  source_url         TEXT,                 -- コピー元URL
  target_url         TEXT,                 -- コピー出品先URL
  remaining_tickets  INTEGER,              -- 残チケット数
  processed_at       TEXT NOT NULL,        -- 処理日時
  imported_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_furim_auto_copy_logs_user ON furim_auto_copy_logs(line_user_id, processed_at);
CREATE INDEX IF NOT EXISTS idx_furim_auto_copy_logs_processed ON furim_auto_copy_logs(processed_at);

-- 紹介キャッシュバック履歴（旧: シート「紹介キャッシュバック履歴」）
CREATE TABLE IF NOT EXISTS furim_referral_cashbacks (
  id                        TEXT PRIMARY KEY,   -- 行ハッシュ
  occurred_at               TEXT NOT NULL,      -- 日時
  introduced_display_name   TEXT,               -- LINE表示名(友)
  introduced_line_user_id   TEXT,               -- Stripe顧客ID → furim_customers で解決
  stripe_customer_id        TEXT,               -- Stripe顧客ID（友）
  price                     INTEGER,            -- 価格
  ambassador_display_name   TEXT,               -- LINE表示名(ア)
  ambassador_line_user_id   TEXT,               -- LINE_ID（ア）
  cashback_amount           INTEGER,            -- キャッシュバック金額
  imported_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_furim_referral_cashbacks_ambassador ON furim_referral_cashbacks(ambassador_line_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_furim_referral_cashbacks_introduced ON furim_referral_cashbacks(introduced_line_user_id, occurred_at);
