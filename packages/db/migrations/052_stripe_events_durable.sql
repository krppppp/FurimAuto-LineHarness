-- Stripe webhookの耐久処理化。
-- 従来はwebhook応答後のwaitUntil内で全処理を行っており、GAS遅延などで
-- 約30秒の打ち切りに当たるとチェーン後半（日時更新・メッセージ送信）が
-- 実行されないまま失われていた（2026-07-20 継続課金事故）。
-- payloadを保存しstatus管理することで、途中死したイベントをcronが再処理できるようにする。
ALTER TABLE stripe_events ADD COLUMN payload TEXT;
ALTER TABLE stripe_events ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE stripe_events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stripe_events ADD COLUMN last_error TEXT;
ALTER TABLE stripe_events ADD COLUMN last_attempt_at TEXT;
ALTER TABLE stripe_events ADD COLUMN completed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_stripe_events_status ON stripe_events (status);
