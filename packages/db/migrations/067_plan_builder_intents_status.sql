-- プラン変更（PB-… change intent）の処理段階と失敗理由を残す（Capsec #240・2026-09-13）。
-- 9/11 の PB-CF0DAF は途中で落ちて used_at も返信も残らず、本人は LIFF の「予約しました」を信じて
-- 待ったまま旧プランで更新課金された。段階(stage)と error を持たせ、cron（plan-change-watch）が
-- 「LINE でコード送信済みなのに未反映」を検知して通知した時刻を notified_at に記録する。
ALTER TABLE plan_builder_intents ADD COLUMN stage TEXT;
ALTER TABLE plan_builder_intents ADD COLUMN error TEXT;
ALTER TABLE plan_builder_intents ADD COLUMN updated_at TEXT;
ALTER TABLE plan_builder_intents ADD COLUMN notified_at TEXT;
