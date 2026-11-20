-- 年払いプラン（TB-3929・手順は TB-3925 の runbook）。1 行 = 発行した Checkout 1 本。
-- 今の月払いの定期契約は残し、一括払いの入金を確かめてから年払いクーポン（100%・12 か月）を足す。
-- 一括払いは Stripe の請求書ではないので furim_payments には入らない。経理の集計はこの表から取る。

CREATE TABLE IF NOT EXISTS furim_annual_prepay (
  id                    TEXT PRIMARY KEY,   -- Checkout の metadata annualPrepayId と同じ値
  line_user_id          TEXT NOT NULL,
  stripe_customer_id    TEXT NOT NULL,
  subscription_id       TEXT NOT NULL,
  monthly_excl_tax      INTEGER NOT NULL,   -- 発行時点の月額（全品目 − forever の割引・税抜）
  annual_excl_tax       INTEGER NOT NULL,   -- 月額 × 10（税抜）
  amount_total          INTEGER,            -- Checkout の税込合計
  checkout_session_id   TEXT,
  checkout_url          TEXT,
  expires_at            TEXT,               -- Checkout の期限（JST）
  created_at            TEXT NOT NULL,
  created_by            TEXT,
  payment_intent_id     TEXT UNIQUE,
  amount_paid           INTEGER,
  paid_at               TEXT,
  stripe_event_id       TEXT,
  apply_started_at      TEXT,               -- 付与の取り合いを止める印（同じ入金で 2 回付けない）
  applied_at            TEXT,
  discount_id           TEXT,
  discount_end_at       TEXT,               -- 年払いの割引が切れる日時（JST）
  first_free_renewal_at TEXT,               -- 0 円になる最初の更新日時（JST）
  apply_error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_furim_annual_prepay_sub ON furim_annual_prepay(subscription_id, created_at);
CREATE INDEX IF NOT EXISTS idx_furim_annual_prepay_user ON furim_annual_prepay(line_user_id);
