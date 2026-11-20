-- 年払いの常設化（TB-3951）。通常は月額 × 11、決算セール（「年払い」の返信が 2026-11-27 19:00 JST より前）は月額 × 10。
-- 092 の行（× 10 で発行したもの）は price_months が NULL のまま。読む側は NULL を × 10 として扱う。

ALTER TABLE furim_annual_prepay ADD COLUMN price_months INTEGER;  -- 10 = 決算セール・11 = 常設
ALTER TABLE furim_annual_prepay ADD COLUMN reply_at TEXT;         -- 判定に使った「年払い」の最初の返信（messages_log の created_at・JST）。無ければ NULL
