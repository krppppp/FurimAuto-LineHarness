-- 050: Web Push 購読 (iOS PWA 通知)
-- staff_member_id は staff_members.id または 'env-owner' (環境変数 API_KEY ログイン) が
-- 入るため FK は張らない。endpoint がブラウザ購読の一意キー。
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id               TEXT PRIMARY KEY,
  staff_member_id  TEXT NOT NULL,
  endpoint         TEXT NOT NULL UNIQUE,
  p256dh           TEXT NOT NULL,
  auth             TEXT NOT NULL,
  user_agent       TEXT,
  created_at       TEXT NOT NULL,
  last_used_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_staff ON push_subscriptions(staff_member_id);
