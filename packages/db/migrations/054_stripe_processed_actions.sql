-- Stripe自動化アクションの厳密1回実行(冪等)記録。
-- stripe webhookの初回waitUntilが途中死した際、cron再処理で「未実行のアクションだけ」再送するために使う。
-- (action_key = automationId:stepIndex 等)。setTransactionData(append)やsetSubscriptionData(加算)など
-- 非冪等なGAS書き込みが再処理で二重にならないことを保証する。
CREATE TABLE IF NOT EXISTS stripe_processed_actions (
  stripe_event_id TEXT NOT NULL,
  action_key      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (stripe_event_id, action_key)
);
