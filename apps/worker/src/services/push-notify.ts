import { buildPushPayload } from '@block65/webcrypto-web-push';
import type { PushMessage, PushSubscription } from '@block65/webcrypto-web-push';
import { jstNow } from '@line-crm/db';
import { countUnanswered } from './unanswered-inbox.js';

export type PushEnv = {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};

type SubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type PushPayloadData = {
  title: string;
  body: string;
  url: string;
  badge?: number;
};

// 購読1件に payload を送る。404/410 (購読失効) は行を削除して false を返す。
// それ以外の失敗は console.error のみ (webhook 本処理を巻き込まない)。
async function sendToSubscription(
  db: D1Database,
  vapid: { subject: string; publicKey: string; privateKey: string },
  sub: SubscriptionRow,
  message: PushMessage,
): Promise<void> {
  const subscription: PushSubscription = {
    endpoint: sub.endpoint,
    expirationTime: null,
    keys: { p256dh: sub.p256dh, auth: sub.auth },
  };
  const init = await buildPushPayload(message, subscription, vapid);
  const res = await fetch(sub.endpoint, init);
  if (res.status === 404 || res.status === 410) {
    await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
    console.log(`[push] subscription expired, deleted: ${sub.id}`);
  } else if (res.ok) {
    await db.prepare('UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?').bind(jstNow(), sub.id).run();
  } else {
    console.error(`[push] send failed status=${res.status} sub=${sub.id}`, await res.text().catch(() => ''));
  }
}

export async function sendPushToAll(db: D1Database, env: PushEnv, data: PushPayloadData): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;

  const subs = await db
    .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions')
    .all<SubscriptionRow>();
  if (!subs.results?.length) return;

  const vapid = {
    subject: env.VAPID_SUBJECT ?? 'mailto:tothetoptokyo@gmail.com',
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  const message: PushMessage = {
    data: JSON.stringify(data),
    options: { ttl: 3600, urgency: 'high' },
  };

  await Promise.allSettled(
    subs.results.map((sub) =>
      sendToSubscription(db, vapid, sub, message).catch((err) => {
        console.error(`[push] send error sub=${sub.id}`, err);
      }),
    ),
  );
}

// 顧客からの受信メッセージをスタッフ全端末に通知する。
// title は「アカウント名｜友だち名」、badge は未対応件数。失敗しても throw しない。
export async function notifyStaffOfIncomingMessage(
  db: D1Database,
  env: PushEnv,
  args: {
    friendId: string;
    friendName: string | null;
    accountId: string | null;
    preview: string;
  },
): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;
  try {
    let title = args.friendName ?? '新着メッセージ';
    if (args.accountId) {
      const acc = await db
        .prepare('SELECT name FROM line_accounts WHERE id = ?')
        .bind(args.accountId)
        .first<{ name: string }>();
      if (acc?.name) title = `${acc.name}｜${title}`;
    }
    const { total } = await countUnanswered(db);
    await sendPushToAll(db, env, {
      title,
      body: args.preview.slice(0, 80),
      url: `/chats?friend=${args.friendId}`,
      badge: total,
    });
  } catch (err) {
    console.error('[push] notifyStaffOfIncomingMessage failed', err);
  }
}
