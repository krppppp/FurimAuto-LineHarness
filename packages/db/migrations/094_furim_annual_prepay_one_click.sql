-- 年払いをボタン 1 つで決済（TB-3963）。登録済みのカードで PaymentIntent（off_session）を作り、成功したらそのまま年払いクーポンを足す。
-- 1 行 = ボタンの押下 1 回の決済。charge_key（定期契約 ID:期間の始まり）の UNIQUE で同じ人の 2 回目の決済を止める。
-- 3D セキュア・カード不可で決済できなかった行は charge_key を NULL に戻す（Checkout のリンクで払ってもらう）。

ALTER TABLE furim_annual_prepay ADD COLUMN pay_mode TEXT;       -- 'one_click' = ボタンの決済。NULL = Checkout
ALTER TABLE furim_annual_prepay ADD COLUMN tax_amount INTEGER;  -- 消費税（10%・外税）
ALTER TABLE furim_annual_prepay ADD COLUMN charge_key TEXT;
ALTER TABLE furim_annual_prepay ADD COLUMN charge_status TEXT;  -- processing / succeeded / authentication_required / card_failed / unknown
ALTER TABLE furim_annual_prepay ADD COLUMN charge_error TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_furim_annual_prepay_charge_key ON furim_annual_prepay(charge_key);
