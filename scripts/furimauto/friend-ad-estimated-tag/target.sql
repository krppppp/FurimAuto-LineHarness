-- TB-2388 「広告_LINE友だち追加（推定）」を付ける相手（TB-2383 と同じ条件）。run.mjs が {{WINDOW}} を差し込む。
-- 期間（{{WINDOW}}）: 前回の until 〜 今週月曜 0:00 JST を、ad-periods.csv の広告 ON の期間で切ったもの。
-- ref_code がある人・ref_tracking に行がある人は外す。時刻は +09:00 付きと UTC が混ざるので datetime() で UTC に直して比べる。
SELECT f.id AS friend_id, f.created_at, f.is_following
FROM friends f
WHERE ({{WINDOW}})
  AND f.ref_code IS NULL
  AND NOT EXISTS (SELECT 1 FROM ref_tracking r WHERE r.friend_id = f.id)
