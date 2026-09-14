-- FurimAuto #263 (4)（2026-09-14・くろさん決定 decision #493）: 空欄の棚卸しで消すと決めた 4 列を消す。
-- furim_ticket_ledger.source_url・target_url（消費は #258 で furim_auto_copy_logs へ移った）・invoice_id（同じ値が idempotency_key の premium_monthly:<invoice> にある）、
-- furim_customers.canceled_at（解約日時は furim_cancellations.canceled_at に残る）。
-- 消す前に値を退避テーブルへ写す。退避の行数と列ごとの値あり件数が元と一致することを確かめてから DROP を 1 本ずつ当てる。
CREATE TABLE IF NOT EXISTS furim_ticket_ledger_dropped_cols_20260914 AS
  SELECT idempotency_key, source_url, target_url, invoice_id, datetime('now', '+9 hours') AS backed_up_at
  FROM furim_ticket_ledger;

CREATE TABLE IF NOT EXISTS furim_customers_dropped_cols2_20260914 AS
  SELECT line_user_id, canceled_at, datetime('now', '+9 hours') AS backed_up_at
  FROM furim_customers;

ALTER TABLE furim_ticket_ledger DROP COLUMN source_url;
ALTER TABLE furim_ticket_ledger DROP COLUMN target_url;
ALTER TABLE furim_ticket_ledger DROP COLUMN invoice_id;
ALTER TABLE furim_customers DROP COLUMN canceled_at;
