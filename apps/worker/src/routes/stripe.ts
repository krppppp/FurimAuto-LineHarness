import { Hono } from 'hono';
import {
  getStripeEvents,
  getStripeEventByStripeId,
  createStripeEvent,
  markStripeEventCompleted,
  markStripeEventFailed,
  getFriendByLineUserId,
} from '@line-crm/db';
import { processStripeEvent, type StripeWebhookBody } from '../services/stripe-processor.js';
import type { Env } from '../index.js';

const stripe = new Hono<Env>();

// ========== Stripeイベント一覧 ==========

stripe.get('/api/integrations/stripe/events', async (c) => {
  try {
    const friendId = c.req.query('friendId') ?? undefined;
    const eventType = c.req.query('eventType') ?? undefined;
    const limit = Number(c.req.query('limit') ?? '100');
    const items = await getStripeEvents(c.env.DB, { friendId, eventType, limit });
    return c.json({
      success: true,
      data: items.map((e) => ({
        id: e.id,
        stripeEventId: e.stripe_event_id,
        eventType: e.event_type,
        friendId: e.friend_id,
        amount: e.amount,
        currency: e.currency,
        metadata: e.metadata ? JSON.parse(e.metadata) : null,
        processedAt: e.processed_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/stripe/events error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Stripe Webhookレシーバー ==========

/** Stripe署名検証 */
async function verifyStripeSignature(secret: string, rawBody: string, sigHeader: string): Promise<boolean> {
  const parts = Object.fromEntries(
    sigHeader.split(',').map((p) => {
      const [k, ...v] = p.split('=');
      return [k, v.join('=')];
    }),
  );
  const timestamp = parts.t;
  const expectedSig = parts.v1;
  if (!timestamp || !expectedSig) return false;

  const encoder = new TextEncoder();
  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const computedSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return computedSig === expectedSig;
}

stripe.post('/api/integrations/stripe/webhook', async (c) => {
  try {
    const stripeSecret = (c.env as unknown as Record<string, string | undefined>).STRIPE_WEBHOOK_SECRET;
    let body: StripeWebhookBody;

    if (stripeSecret) {
      const sigHeader = c.req.header('Stripe-Signature') ?? '';
      const rawBody = await c.req.text();
      const valid = await verifyStripeSignature(stripeSecret, rawBody, sigHeader);
      if (!valid) {
        return c.json({ success: false, error: 'Stripe signature verification failed' }, 401);
      }
      body = JSON.parse(rawBody) as StripeWebhookBody;
    } else {
      body = await c.req.json<StripeWebhookBody>();
    }

    // 冪等性チェック
    const existing = await getStripeEventByStripeId(c.env.DB, body.id);
    if (existing) {
      return c.json({ success: true, data: { message: 'Already processed' } });
    }

    const db = c.env.DB;
    const env = c.env;
    const obj = body.data.object;

    // Stripeメタデータの lineUserId（LINE U...ID）から内部友達IDを引く
    const lineUserId = obj.metadata?.lineUserId ?? null;
    let friendId: string | null = null;
    if (lineUserId) {
      const friend = await getFriendByLineUserId(db, lineUserId);
      friendId = friend?.id ?? null;
    }

    // イベントを記録（payload保存・status=pending）。処理は waitUntil + cron sweep の二段構え:
    // waitUntil はレスポンス後約30秒で打ち切られるため、GAS遅延等で本処理が途中死した場合は
    // pending のまま残り、5分cronの sweepPendingStripeEvents が再処理する（2026-07-20 継続課金事故対策）。
    // 冪等性レコードを先に挿入するので、処理中に Stripe の再送が来ても Already processed で弾かれる。
    const event = await createStripeEvent(db, {
      stripeEventId: body.id,
      eventType: body.type,
      friendId: friendId ?? undefined,
      amount: obj.amount,
      currency: obj.currency,
      metadata: JSON.stringify(obj.metadata ?? {}),
      payload: JSON.stringify(body),
      status: 'pending',
    });

    c.executionCtx.waitUntil(
      (async () => {
        try {
          await processStripeEvent(db, env, body);
          await markStripeEventCompleted(db, event.id);
        } catch (err) {
          console.error('[stripe/webhook] async processing error:', err);
          // pending のまま残して cron sweep に再処理させる
          await markStripeEventFailed(db, event.id, String(err), true).catch(() => {});
        }
      })(),
    );

    return c.json({
      success: true,
      data: { id: event.id, stripeEventId: event.stripe_event_id, eventType: event.event_type, processedAt: event.processed_at },
    });
  } catch (err) {
    console.error('POST /api/integrations/stripe/webhook error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { stripe };
