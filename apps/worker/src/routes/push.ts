import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';
import { sendPushToAll } from '../services/push-notify.js';

export const push = new Hono<Env>();

// 購読時の applicationServerKey として使う VAPID 公開鍵。認証必須 (/api/*)。
push.get('/api/push/vapid-public-key', async (c) => {
  if (!c.env.VAPID_PUBLIC_KEY) {
    return c.json({ success: false, error: 'Push notifications are not configured' }, 503);
  }
  return c.json({ success: true, data: { publicKey: c.env.VAPID_PUBLIC_KEY } });
});

push.post('/api/push/subscribe', async (c) => {
  try {
    const body = await c.req.json<{
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    }>();
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return c.json({ success: false, error: 'endpoint and keys (p256dh, auth) are required' }, 400);
    }
    const staff = c.get('staff');
    const now = jstNow();
    // 同一端末の再購読は endpoint 衝突で置き換える
    await c.env.DB
      .prepare(
        `INSERT INTO push_subscriptions (id, staff_member_id, endpoint, p256dh, auth, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           staff_member_id = excluded.staff_member_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           user_agent = excluded.user_agent`,
      )
      .bind(
        crypto.randomUUID(),
        staff.id,
        body.endpoint,
        body.keys.p256dh,
        body.keys.auth,
        c.req.header('user-agent') ?? null,
        now,
      )
      .run();
    return c.json({ success: true });
  } catch (err) {
    console.error('POST /api/push/subscribe error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

push.post('/api/push/unsubscribe', async (c) => {
  try {
    const body = await c.req.json<{ endpoint?: string }>();
    if (!body.endpoint) {
      return c.json({ success: false, error: 'endpoint is required' }, 400);
    }
    await c.env.DB
      .prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
      .bind(body.endpoint)
      .run();
    return c.json({ success: true });
  } catch (err) {
    console.error('POST /api/push/unsubscribe error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// iPhone 実機での疎通確認用。全購読宛にテスト通知を送る。
push.post('/api/push/test', async (c) => {
  try {
    if (!c.env.VAPID_PUBLIC_KEY || !c.env.VAPID_PRIVATE_KEY) {
      return c.json({ success: false, error: 'Push notifications are not configured' }, 503);
    }
    await sendPushToAll(c.env.DB, c.env, {
      title: 'テスト通知',
      body: 'プッシュ通知は正常に動作しています',
      url: '/notifications',
    });
    return c.json({ success: true });
  } catch (err) {
    console.error('POST /api/push/test error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
