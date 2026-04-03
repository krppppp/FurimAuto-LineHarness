import { Hono } from 'hono';
import {
  getStripeEvents,
  getStripeEventByStripeId,
  createStripeEvent,
  getFriendByLineUserId,
  jstNow,
} from '@line-crm/db';
import { gasGet } from '../furim/gas-client.js';
import { fireEvent } from '../services/event-bus.js';
import type { Env } from '../index.js';

const stripe = new Hono<Env>();

interface StripeWebhookBody {
  id: string;
  type: string;
  data: {
    object: {
      id: string;
      // subscription / payment_intent 共通
      amount?: number;
      currency?: string;
      metadata?: Record<string, string>;
      customer?: string;
      status?: string;
      // invoice 固有
      subscription?: string;
      billing_reason?: string;
      amount_paid?: number;
      customer_email?: string;
      tax?: number;
      total_discount_amounts?: Array<{ amount: number }>;
      attempt_count?: number;
      lines?: { data?: Array<{ price?: { unit_amount?: number; nickname?: string }; period?: { start?: number; end?: number } }> };
      // subscription 固有
      plan?: { amount?: number; nickname?: string };
      items?: { data?: Array<{ price?: { unit_amount?: number } }> };
    };
  };
}

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

    const obj = body.data.object;
    const db = c.env.DB;
    const env = c.env;

    // Stripeメタデータの lineUserId（LINE U...ID）から内部友達IDを引く
    const lineUserId = obj.metadata?.lineUserId ?? null;
    let friendId: string | null = null;
    if (lineUserId) {
      const friend = await getFriendByLineUserId(db, lineUserId);
      friendId = friend?.id ?? null;
    }

    // イベントを記録
    const event = await createStripeEvent(db, {
      stripeEventId: body.id,
      eventType: body.type,
      friendId: friendId ?? undefined,
      amount: obj.amount,
      currency: obj.currency,
      metadata: JSON.stringify(obj.metadata ?? {}),
    });

    const actionEnv = { lineAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN, gasDeployId: env.GAS_DEPLOY_ID, stripeSecretKey: env.STRIPE_SECRET_KEY };

    // ──────────────────────────────────────────
    // invoice.payment_succeeded
    // ──────────────────────────────────────────
    if (body.type === 'invoice.payment_succeeded') {
      const stripeCustomerId = obj.customer ?? '';
      const billingReason = obj.billing_reason ?? '';
      const isNewSubscription = billingReason === 'subscription_create';

      // LINE ID を解決（メタデータになければGASシートで照合）
      let resolvedLineUserId = lineUserId;
      if (!resolvedLineUserId && stripeCustomerId && env.GAS_DEPLOY_ID) {
        try {
          const gasData = await gasGet(env.GAS_DEPLOY_ID, { method: 'getLINEIDwithStripeID', stripeCustomerID: stripeCustomerId }) as Record<string, string>;
          resolvedLineUserId = gasData?.customer_line_id ?? null;
        } catch (e) {
          console.error('[stripe/invoice] getLINEIDwithStripeID failed:', e);
        }
      }

      // Stripe APIでサブスクリプション詳細を取得
      const subscriptionId = obj.subscription ?? '';
      let planName = '';
      let subscriptionPrice = 0;
      let subscriptionStartDateTime = '';
      let subscriptionEndDateTime = '';
      if (subscriptionId && env.STRIPE_SECRET_KEY) {
        try {
          const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
          if (subRes.ok) {
            const sub = await subRes.json() as { plan?: { nickname?: string; amount?: number }; current_period_start?: number; current_period_end?: number };
            planName = sub.plan?.nickname ?? '';
            subscriptionPrice = sub.plan?.amount ?? 0;
            const jstOffset = (9 * 60 + 15) * 60000;
            if (sub.current_period_start) subscriptionStartDateTime = new Date(sub.current_period_start * 1000 + jstOffset).toISOString().replace('T', ' ').slice(0, 19);
            if (sub.current_period_end) subscriptionEndDateTime = new Date(sub.current_period_end * 1000 + jstOffset).toISOString().replace('T', ' ').slice(0, 19);
          }
        } catch (e) { console.error('[stripe/invoice] subscriptions.retrieve failed:', e); }
      }

      // プラン金額tier計算
      const tiers = [3000, 5000, 8000, 10000, 15000, 19800];
      const planAmount = subscriptionPrice || (obj.lines?.data?.[0]?.price?.unit_amount ?? 0);
      const planTier = tiers.find((t) => planAmount <= t) ?? 0;

      const discountAmount = obj.total_discount_amounts?.[0]?.amount ?? 0;
      const taxAmount = obj.tax ?? 0;
      const actualPaidAmount = obj.amount_paid ?? 0;
      const priceExclTax = actualPaidAmount - taxAmount;

      // ambassador coupon: GASで紹介クーポン確認 → Stripeクーポン適用（code_managed相当・継続課金時のみ）
      let ambassadorCouponApplied = false;
      if (!isNewSubscription && resolvedLineUserId && env.GAS_DEPLOY_ID && stripeCustomerId) {
        try {
          const couponData = await gasGet(env.GAS_DEPLOY_ID, { method: 'updateIntroductionCoupon', lineID: resolvedLineUserId }) as Record<string, string> | null;
          const ambassadorCouponId = couponData?.ambassadorCouponID ?? null;
          if (ambassadorCouponId && env.STRIPE_SECRET_KEY) {
            await fetch(`https://api.stripe.com/v1/customers/${stripeCustomerId}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ coupon: ambassadorCouponId }).toString(),
            });
            ambassadorCouponApplied = true;
          }
        } catch (e) { console.error('[stripe/invoice] ambassador coupon failed:', e); }
      }

      const resolvedFriend = resolvedLineUserId ? await getFriendByLineUserId(db, resolvedLineUserId) : null;
      await fireEvent(db, 'stripe_invoice_paid', {
        friendId: resolvedFriend?.id ?? friendId ?? undefined,
        eventData: {
          stripeCustomerId, lineUserId: resolvedLineUserId, billingReason, isNewSubscription,
          planName, planAmount, planTier,
          subscriptionId, subscriptionStartDateTime, subscriptionEndDateTime,
          actualPaidAmount, discountAmount, taxAmount, priceExclTax,
          customerEmail: obj.customer_email ?? '',
          invoiceId: obj.id,
          ambassadorCouponApplied,
        },
      }, env.LINE_CHANNEL_ACCESS_TOKEN, null, actionEnv);

      console.log(`[stripe/invoice] ${billingReason} customer=${stripeCustomerId} lineUserId=${resolvedLineUserId}`);
    }

    // ──────────────────────────────────────────
    // invoice.payment_failed（初回のみLINE通知）
    // ──────────────────────────────────────────
    if (body.type === 'invoice.payment_failed') {
      const attemptCount = obj.attempt_count ?? 0;
      if (attemptCount !== 1) {
        console.log(`[stripe/payment_failed] attempt_count=${attemptCount} のためスキップ`);
      } else {
        const stripeCustomerId = obj.customer ?? '';
        let resolvedLineUserId = lineUserId;
        if (!resolvedLineUserId && stripeCustomerId && env.GAS_DEPLOY_ID) {
          try {
            const gasData = await gasGet(env.GAS_DEPLOY_ID, { method: 'getLINEIDwithStripeID', stripeCustomerID: stripeCustomerId }) as Record<string, string>;
            resolvedLineUserId = gasData?.customer_line_id ?? null;
          } catch (e) { console.error('[stripe/payment_failed] getLINEIDwithStripeID failed:', e); }
        }
        const resolvedFriend = resolvedLineUserId ? await getFriendByLineUserId(db, resolvedLineUserId) : null;
        await fireEvent(db, 'stripe_payment_failed', {
          friendId: resolvedFriend?.id ?? friendId ?? undefined,
          eventData: { stripeCustomerId, lineUserId: resolvedLineUserId },
        }, env.LINE_CHANNEL_ACCESS_TOKEN, null, actionEnv);
      }
    }

    // ──────────────────────────────────────────
    // customer.subscription.deleted
    // ──────────────────────────────────────────
    if (body.type === 'customer.subscription.deleted') {
      const stripeCustomerId = obj.customer ?? '';
      let resolvedLineUserId = lineUserId;
      if (!resolvedLineUserId && stripeCustomerId && env.GAS_DEPLOY_ID) {
        try {
          const gasData = await gasGet(env.GAS_DEPLOY_ID, { method: 'getLINEIDwithStripeID', stripeCustomerID: stripeCustomerId }) as Record<string, string>;
          resolvedLineUserId = gasData?.customer_line_id ?? null;
        } catch (e) { console.error('[stripe/subscription.deleted] getLINEIDwithStripeID failed:', e); }
      }
      const resolvedFriend = resolvedLineUserId ? await getFriendByLineUserId(db, resolvedLineUserId) : null;
      await fireEvent(db, 'stripe_subscription_deleted', {
        friendId: resolvedFriend?.id ?? friendId ?? undefined,
        eventData: { stripeCustomerId, lineUserId: resolvedLineUserId, subscriptionId: obj.id },
      }, env.LINE_CHANNEL_ACCESS_TOKEN, null, actionEnv);
    }

    // ──────────────────────────────────────────
    // payment_intent.succeeded（一回決済）
    // ──────────────────────────────────────────
    if (body.type === 'payment_intent.succeeded') {
      if (obj.metadata?.purchaseType === 'ticket') {
        const ticketLineUserId = obj.metadata?.lineUserId ?? lineUserId;
        const quantity = parseInt(obj.metadata?.quantity ?? '0', 10);
        if (ticketLineUserId && quantity > 0) {
          const ticketFriend = await getFriendByLineUserId(db, ticketLineUserId);
          await fireEvent(db, 'stripe_ticket_purchased', {
            friendId: ticketFriend?.id ?? undefined,
            eventData: { lineUserId: ticketLineUserId, quantity, paymentIntentId: obj.id, amount: obj.amount ?? 0, currency: obj.currency ?? 'jpy' },
          }, env.LINE_CHANNEL_ACCESS_TOKEN, null, actionEnv);
        }
      } else if (friendId) {
        const { applyScoring } = await import('@line-crm/db');
        await applyScoring(db, friendId, 'purchase');
        const productId = obj.metadata?.product_id;
        if (productId) {
          const tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(`purchased_${productId}`).first<{ id: string }>();
          if (tag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)').bind(friendId, tag.id, jstNow()).run();
        }
        await fireEvent(db, 'cv_fire', { friendId, eventData: { type: 'purchase', amount: obj.amount, stripeEventId: body.id } });
      }
    }

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
