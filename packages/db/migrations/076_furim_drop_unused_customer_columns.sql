-- FurimAuto #262（2026-09-14・くろさん GO decision #464）: furim_customers の未使用 4 列を消す。
-- 読む処理が無く、stripe-processor・シート取り込みが書くだけだった。決済のメールは furim_payments.customer_email に残る。
-- 消す前に値を退避テーブルへ写す。退避の行数が furim_customers の行数と一致することを確かめてから DROP を当てる。
CREATE TABLE IF NOT EXISTS furim_customers_dropped_cols_20260914 AS
  SELECT line_user_id, plan_label_legacy, last_invoice_id, subscription_status, customer_email, datetime('now', '+9 hours') AS backed_up_at
  FROM furim_customers;

ALTER TABLE furim_customers DROP COLUMN plan_label_legacy;
ALTER TABLE furim_customers DROP COLUMN last_invoice_id;
ALTER TABLE furim_customers DROP COLUMN subscription_status;
ALTER TABLE furim_customers DROP COLUMN customer_email;
