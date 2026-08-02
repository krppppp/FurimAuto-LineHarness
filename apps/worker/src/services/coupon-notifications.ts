import { LineClient } from '@line-crm/line-sdk';
import { getFriendById, getLineAccountById, jstNow } from '@line-crm/db';

/**
 * クーポン付与のLINE通知 (FurimAuto fork 独自)。
 *
 * 管理画面の友だちリストから Stripe クーポンをサブスクへスタック付与すると
 * coupon_notifications に予約行 (send_after = 付与+3分) が入り、
 * 5分間隔 cron の processPendingCouponNotifications が期限到来分を送信する。
 *
 * 取り消し猶予の保証は cron の粒度に依存しない: 送信直前にサブスクの
 * discounts 配列を再確認し、予約時の coupon_id が残っている時だけ送る。
 * 猶予中に削除されていれば skipped で終わる (通知は飛ばない)。
 */

export interface CouponNotifierEnv {
  LINE_CHANNEL_ACCESS_TOKEN: string;
  STRIPE_SECRET_KEY?: string;
}

type PendingRow = {
  id: string;
  friend_id: string;
  subscription_id: string;
  coupon_id: string;
  message: string;
};

export async function processPendingCouponNotifications(
  db: D1Database,
  env: CouponNotifierEnv,
): Promise<{ sent: number; skipped: number }> {
  if (!env.STRIPE_SECRET_KEY) return { sent: 0, skipped: 0 };

  const due = await db
    .prepare(
      `SELECT id, friend_id, subscription_id, coupon_id, message
       FROM coupon_notifications
       WHERE status = 'pending' AND send_after <= ?
       ORDER BY send_after LIMIT 20`,
    )
    .bind(jstNow())
    .all<PendingRow>();

  if (due.results.length === 0) return { sent: 0, skipped: 0 };

  // 循環import回避のため動的import (routes/furim.ts の grant-coupon と同じ流儀)
  const { getSubDiscounts } = await import('../routes/plan-builder.js');

  let sent = 0;
  let skipped = 0;

  const markSkipped = async (id: string) => {
    await db
      .prepare(`UPDATE coupon_notifications SET status = 'skipped' WHERE id = ? AND status = 'pending'`)
      .bind(id)
      .run();
    skipped++;
  };

  for (const row of due.results) {
    try {
      // 送信直前ガード: サブスクの discounts に予約時の coupon が残っているか
      let stillApplied = false;
      try {
        const discounts = await getSubDiscounts(env.STRIPE_SECRET_KEY, row.subscription_id);
        stillApplied = discounts.some((d) => d.couponId === row.coupon_id);
      } catch (e) {
        // サブスク自体が消えている (解約等) なら通知しない。それ以外は一時エラーとして再試行
        if (/no such subscription/i.test(String(e))) {
          await markSkipped(row.id);
          continue;
        }
        throw e;
      }
      if (!stillApplied) {
        // 猶予中に削除済み — 通知しない
        await markSkipped(row.id);
        continue;
      }

      const friend = await getFriendById(db, row.friend_id);
      if (!friend?.line_user_id || !friend.is_following) {
        await markSkipped(row.id);
        continue;
      }

      let accessToken = env.LINE_CHANNEL_ACCESS_TOKEN;
      if (friend.line_account_id) {
        const account = await getLineAccountById(db, friend.line_account_id);
        if (account?.channel_access_token) accessToken = account.channel_access_token;
      }

      const client = new LineClient(accessToken);
      await client.pushMessage(friend.line_user_id, [{ type: 'text', text: row.message } as never]);

      const ts = jstNow();
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, created_at)
           VALUES (?, ?, 'outgoing', 'text', ?, 'automation', ?)`,
        )
        .bind(crypto.randomUUID(), row.friend_id, row.message, ts)
        .run();
      await db
        .prepare(`UPDATE coupon_notifications SET status = 'sent', sent_at = ? WHERE id = ?`)
        .bind(ts, row.id)
        .run();
      sent++;
    } catch (err) {
      // pending のまま残して次 tick で再試行 (Stripe/LINE の一時エラー対策)
      console.error(`[coupon-notify] ${row.id} failed (will retry next tick):`, err);
    }
  }

  if (sent + skipped > 0) console.log(`[coupon-notify] sent=${sent} skipped=${skipped}`);
  return { sent, skipped };
}
