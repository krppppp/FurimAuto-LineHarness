-- FurimAuto 段階2.5（Capsec #250・#254・#244 残・2026-09-14）: LINE 起点の残りを D1 先行にし、
-- 旧拡張が GAS 経由で書くチケット消費も D1 に届くようにする。シートは凍結（閲覧用）で、鏡写しは
-- getKeyCodeSet 廃止まで setCustomerFields 経由で続ける。

-- 旧拡張（GAS getKeyCodeSet 経路）から最後に認証した時刻。廃止日（#245(b)）の判断材料
ALTER TABLE furim_customers ADD COLUMN gas_last_seen_at TEXT;

-- アンケート回答の履歴（旧: シート「アンケート結果」）
CREATE TABLE IF NOT EXISTS furim_survey_answers (
  id            TEXT PRIMARY KEY,
  line_user_id  TEXT NOT NULL,
  display_name  TEXT,
  answer        TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_furim_survey_answers_user ON furim_survey_answers(line_user_id, created_at);

-- クーポン適用履歴（旧: シート「クーポン適用履歴」。Youtube「Furimanです」など顧客レベルのクーポン付与）
CREATE TABLE IF NOT EXISTS furim_coupon_applications (
  id                  TEXT PRIMARY KEY,
  line_user_id        TEXT NOT NULL,
  stripe_customer_id  TEXT,
  coupon_name         TEXT NOT NULL,
  coupon_id           TEXT,
  route               TEXT NOT NULL,   -- 'Furiman経由' 等
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_furim_coupon_applications_user ON furim_coupon_applications(line_user_id, created_at);
