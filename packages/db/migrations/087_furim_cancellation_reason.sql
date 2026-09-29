-- 解約理由アンケート（TB-740 / TB-746・2026-09-29）: 解約成立直後に LINE で 1 問 push し、
-- 回答を furim_cancellations の最新行に書く。既存行はバックフィルしない（過去分は取得不能）。
-- reason_code は英字固定（表示文言は Worker 側 CANCELLATION_REASONS が持つ。列に文言を入れない）。

ALTER TABLE furim_cancellations ADD COLUMN reason_code TEXT;        -- 5択のコード（not_working / too_hard / no_items / price / quit_side_job）
ALTER TABLE furim_cancellations ADD COLUMN reason_text TEXT;        -- 自由記述（任意）
ALTER TABLE furim_cancellations ADD COLUMN reason_answered_at TEXT; -- 回答日時（JST・jstNow() と同じ形）
