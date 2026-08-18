-- 配信の先記録を2段階化（2026-08-18）。
-- 従来のat-most-once先記録は「premark直後にwaitUntil打ち切り」で配信が永久ロストした
-- （2026-08-18 NakaRyuさん・黒岩さん主プランの新規登録メッセージ未達）。
-- status: 'pending'=premark済み(送信未確認) / 'done'=送信成功確認済み。
--   既存行はすべて送信済みなのでdefault 'done'（再送対象にしない）
-- retry_key: LINEの X-Line-Retry-Key。pendingの再送時に同じキーを使うことで、
--   「実は送れていた」場合もLINE側が24時間重複排除する（取りこぼしゼロ×重複ゼロ）
ALTER TABLE stripe_processed_actions ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
ALTER TABLE stripe_processed_actions ADD COLUMN retry_key TEXT;
