-- 051: クーポン付与のLINE通知予約 (FurimAuto fork 独自)
-- 管理画面の友だちリストから Stripe クーポンをサブスクの discounts 配列へ
-- スタック付与（併用割引と共存・grant-coupon と同方式）した際、3分の取り消し
-- 猶予をおいて cron が LINE 通知を送る。送信直前にサブスクの discounts に
-- coupon_id が残っていることを再確認し、猶予中に削除されていたら skipped にする。
CREATE TABLE IF NOT EXISTS coupon_notifications (
  id                 TEXT PRIMARY KEY,
  friend_id          TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  subscription_id    TEXT NOT NULL,
  coupon_id          TEXT NOT NULL,
  coupon_name        TEXT,
  message            TEXT NOT NULL,
  send_after         TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled', 'skipped')),
  created_at         TEXT NOT NULL,
  sent_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_coupon_notifications_due ON coupon_notifications(status, send_after);
CREATE INDEX IF NOT EXISTS idx_coupon_notifications_friend ON coupon_notifications(friend_id);
