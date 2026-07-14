-- plan-builder（機能単位サブスク）の申込意図。
-- LIFFの申込ボタン→liff.sendMessagesで「【プラン申し込み】PB-XXXX」がトークに送られ、
-- webhookがコードでこの行を引いてCheckoutセッションを発行する。
-- used_at が入っても行は残す（誰がどのプランで申込ボタンを押したかの行動データ）。
CREATE TABLE IF NOT EXISTS plan_builder_intents (
  id           TEXT PRIMARY KEY,            -- 申込コード（PB-XXXXXX）
  line_user_id TEXT NOT NULL,
  payload      TEXT NOT NULL,               -- JSON: { packages, features, multiChannelSites, total }
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  used_at      TEXT                         -- Checkout発行済みなら日時
);
CREATE INDEX IF NOT EXISTS idx_pb_intents_user ON plan_builder_intents(line_user_id, created_at);
