import { Hono } from 'hono';
import { getFriendById, jstNow, toJstString } from '@line-crm/db';
import type { Env } from '../index.js';

/**
 * 友だちリストからの Stripe クーポン付与 (FurimAuto fork 独自)。
 *
 * 付与は grant-coupon (routes/furim.ts) と同じ**サブスク discounts 配列への
 * スタック追加**（STRIPE_STACK_VERSION）。顧客レベル付与だと併用割引(combo,
 * サブスク側 forever)持ちに一切効かない構造ギャップがあるため（2026-07-07 の
 * 教訓）、必ずサブスク側にスタックする。once クーポンは次回請求で1回効いて
 * 自動でサブスクから外れる。
 *
 * 付与すると coupon_notifications に3分後の LINE 通知予約が入る。
 * 実送信は cron (services/coupon-notifications.ts) が担い、送信直前に
 * サブスクの discounts に coupon_id が残っていることを再確認する。
 * DELETE は該当 discount だけをスタックから外す + 予約キャンセル
 * (3分以内なら通知も飛ばない)。併用割引 (couponId が combo-*) は削除不可。
 */

const furimCoupons = new Hono<Env>();

const NOTIFY_DELAY_MS = 3 * 60_000;

/** 併用割引 (combo-*) と初月合算クーポン (fm{p}x{金額}-*) はプラン構成由来なので UI から触らせない */
export function isProtectedCoupon(couponId: string): boolean {
  return couponId.startsWith('combo-') || /^fm\d+x\d+-/.test(couponId);
}

type SubDiscount = {
  discountId: string;
  couponId: string;
  name: string;
  amountOff: number;
  percentOff: number | null;
  duration: string;
};

function serializeDiscount(d: SubDiscount) {
  return {
    couponId: d.couponId,
    name: d.name || d.couponId,
    amountOff: d.amountOff || null,
    percentOff: d.percentOff,
    duration: d.duration,
    deletable: !isProtectedCoupon(d.couponId),
  };
}

async function getPendingNotification(db: D1Database, friendId: string) {
  const pending = await db
    .prepare(
      `SELECT coupon_name, send_after FROM coupon_notifications
       WHERE friend_id = ? AND status = 'pending' ORDER BY send_after LIMIT 1`,
    )
    .bind(friendId)
    .first<{ coupon_name: string | null; send_after: string }>();
  return pending ? { couponName: pending.coupon_name, sendAfter: pending.send_after } : null;
}

async function cancelPendingNotifications(db: D1Database, friendId: string, couponId?: string) {
  if (couponId) {
    await db
      .prepare(`UPDATE coupon_notifications SET status = 'cancelled' WHERE friend_id = ? AND coupon_id = ? AND status = 'pending'`)
      .bind(friendId, couponId)
      .run();
  } else {
    await db
      .prepare(`UPDATE coupon_notifications SET status = 'cancelled' WHERE friend_id = ? AND status = 'pending'`)
      .bind(friendId)
      .run();
  }
}

/** Stripe 上の有効クーポン一覧 (付与ドロップダウン用) */
furimCoupons.get('/api/furim/coupons', async (c) => {
  try {
    if (!c.env.STRIPE_SECRET_KEY) {
      return c.json({ success: false, error: 'STRIPE_SECRET_KEY not configured' }, 503);
    }
    const res = await fetch('https://api.stripe.com/v1/coupons?limit=100', {
      headers: { Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}` },
    });
    if (!res.ok) {
      console.error('[furim-coupons] Stripe coupons list error:', await res.text());
      return c.json({ success: false, error: 'Stripe API error' }, 502);
    }
    const body = (await res.json()) as {
      data: Array<{ id: string; name?: string; percent_off?: number; amount_off?: number; currency?: string; duration?: string; duration_in_months?: number; valid: boolean }>;
    };
    return c.json({
      success: true,
      data: body.data
        .filter((cp) => cp.valid && !isProtectedCoupon(cp.id))
        .map((cp) => ({
          id: cp.id,
          name: cp.name ?? null,
          percentOff: cp.percent_off ?? null,
          amountOff: cp.amount_off ?? null,
          currency: cp.currency ?? null,
          duration: cp.duration ?? null,
          durationInMonths: cp.duration_in_months ?? null,
        })),
    });
  } catch (err) {
    console.error('GET /api/furim/coupons error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** 友だちのサブスク discount スタック + 通知予約状況 */
furimCoupons.get('/api/furim/friends/:id/coupon', async (c) => {
  try {
    if (!c.env.STRIPE_SECRET_KEY || !c.env.GAS_DEPLOY_ID) {
      return c.json({ success: false, error: 'Stripe/GAS not configured' }, 503);
    }
    const friend = await getFriendById(c.env.DB, c.req.param('id'));
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    const { getActiveSubscriptionForLine, getSubDiscounts } = await import('./plan-builder.js');
    const found = await getActiveSubscriptionForLine(c.env, friend.line_user_id);
    const pendingNotification = await getPendingNotification(c.env.DB, friend.id);
    if (!found) {
      return c.json({ success: true, data: { hasSubscription: false, discounts: [], pendingNotification } });
    }

    const discounts = await getSubDiscounts(c.env.STRIPE_SECRET_KEY, String((found.sub as { id: string }).id));
    return c.json({
      success: true,
      data: {
        hasSubscription: true,
        discounts: discounts.map(serializeDiscount),
        pendingNotification,
      },
    });
  } catch (err) {
    console.error('GET /api/furim/friends/:id/coupon error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** クーポンをサブスクへスタック付与 + 3分後のLINE通知を予約 */
furimCoupons.post('/api/furim/friends/:id/coupon', async (c) => {
  try {
    if (!c.env.STRIPE_SECRET_KEY || !c.env.GAS_DEPLOY_ID) {
      return c.json({ success: false, error: 'Stripe/GAS not configured' }, 503);
    }
    const body = await c.req.json<{ couponId?: string; message?: string }>();
    if (!body.couponId || !body.message?.trim()) {
      return c.json({ success: false, error: 'couponId and message are required' }, 400);
    }
    if (isProtectedCoupon(body.couponId)) {
      return c.json({ success: false, error: 'このクーポンは手動付与できません' }, 400);
    }

    const friend = await getFriendById(c.env.DB, c.req.param('id'));
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    const { getActiveSubscriptionForLine, getSubDiscounts, stripeCall, STRIPE_STACK_VERSION } = await import('./plan-builder.js');
    const found = await getActiveSubscriptionForLine(c.env, friend.line_user_id);
    if (!found) {
      return c.json({ success: false, error: 'アクティブなサブスクリプションが見つかりません（有料会員のみ付与できます）' }, 400);
    }
    const subId = String((found.sub as { id: string }).id);

    const existing = await getSubDiscounts(c.env.STRIPE_SECRET_KEY, subId);
    if (existing.some((d) => d.couponId === body.couponId)) {
      return c.json({ success: false, error: 'このクーポンは既に適用されています' }, 400);
    }

    // 既存discount（併用割引等）を保持したままスタック追加 (grant-coupon と同方式)
    const params: Record<string, string> = {};
    existing.forEach((d, i) => {
      params[`discounts[${i}][discount]`] = d.discountId;
    });
    params[`discounts[${existing.length}][coupon]`] = body.couponId;
    await stripeCall(c.env.STRIPE_SECRET_KEY, `subscriptions/${subId}`, params, 'POST', STRIPE_STACK_VERSION);

    const after = await getSubDiscounts(c.env.STRIPE_SECRET_KEY, subId);
    const applied = after.find((d) => d.couponId === body.couponId) ?? null;

    // 既存の予約を破棄して付け直し (付け間違い→即付け直しでも通知は最新1件だけ)
    await cancelPendingNotifications(c.env.DB, friend.id);
    const sendAfter = toJstString(new Date(Date.now() + NOTIFY_DELAY_MS));
    await c.env.DB
      .prepare(
        `INSERT INTO coupon_notifications
           (id, friend_id, stripe_customer_id, subscription_id, coupon_id, coupon_name, message, send_after, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .bind(
        crypto.randomUUID(),
        friend.id,
        found.customerId,
        subId,
        body.couponId,
        applied?.name || null,
        body.message.trim(),
        sendAfter,
        jstNow(),
      )
      .run();

    return c.json({
      success: true,
      data: {
        discounts: after.map(serializeDiscount),
        pendingNotification: { couponName: applied?.name ?? null, sendAfter },
      },
    });
  } catch (err) {
    console.error('POST /api/furim/friends/:id/coupon error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 502);
  }
});

/** 指定クーポンをスタックから除去 + 通知予約キャンセル */
furimCoupons.delete('/api/furim/friends/:id/coupon', async (c) => {
  try {
    if (!c.env.STRIPE_SECRET_KEY || !c.env.GAS_DEPLOY_ID) {
      return c.json({ success: false, error: 'Stripe/GAS not configured' }, 503);
    }
    const couponId = c.req.query('couponId') ?? '';
    if (!couponId) return c.json({ success: false, error: 'couponId is required' }, 400);
    if (isProtectedCoupon(couponId)) {
      return c.json({ success: false, error: '併用割引・プラン由来の割引は削除できません' }, 400);
    }

    const friend = await getFriendById(c.env.DB, c.req.param('id'));
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    const { getActiveSubscriptionForLine, getSubDiscounts, stripeCall, STRIPE_STACK_VERSION } = await import('./plan-builder.js');
    const found = await getActiveSubscriptionForLine(c.env, friend.line_user_id);
    let discounts: SubDiscount[] = [];
    if (found) {
      const subId = String((found.sub as { id: string }).id);
      const existing = await getSubDiscounts(c.env.STRIPE_SECRET_KEY, subId);
      const remaining = existing.filter((d) => d.couponId !== couponId);
      if (remaining.length < existing.length) {
        const params: Record<string, string> = {};
        remaining.forEach((d, i) => {
          params[`discounts[${i}][discount]`] = d.discountId;
        });
        if (remaining.length === 0) params['discounts'] = ''; // 全解除
        await stripeCall(c.env.STRIPE_SECRET_KEY, `subscriptions/${subId}`, params, 'POST', STRIPE_STACK_VERSION);
      }
      discounts = await getSubDiscounts(c.env.STRIPE_SECRET_KEY, subId);
    }

    await cancelPendingNotifications(c.env.DB, friend.id, couponId);

    return c.json({
      success: true,
      data: {
        discounts: discounts.map(serializeDiscount),
        pendingNotification: await getPendingNotification(c.env.DB, friend.id),
      },
    });
  } catch (err) {
    console.error('DELETE /api/furim/friends/:id/coupon error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 502);
  }
});

export { furimCoupons };
