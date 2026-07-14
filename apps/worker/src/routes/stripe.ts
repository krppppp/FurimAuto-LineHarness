import { Hono } from 'hono';
import {
  getStripeEvents,
  getStripeEventByStripeId,
  createStripeEvent,
  getFriendByLineUserId,
  jstNow,
} from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { gasGet, gasPost } from '../furim/gas-client.js';
import { fireEvent } from '../services/event-bus.js';
import { logOutgoing } from '../utils/message-log.js';
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
      total_excluding_tax?: number;
      subtotal?: number;
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
      // Stripe API 2025-03(basil)以降、invoice.subscriptionはparent.subscription_details配下に移動。
      // エンドポイントのapi_version固定値により新旧どちらの形でも届きうるため両対応する
      const subscriptionId =
        obj.subscription ??
        (obj as { parent?: { subscription_details?: { subscription?: string } } }).parent?.subscription_details?.subscription ??
        '';
      let planName = '';
      let subscriptionPrice = 0;
      let subscriptionStartDateTime = '';
      let subscriptionEndDateTime = '';
      let subMetadata: Record<string, string> = {};
      if (subscriptionId && env.STRIPE_SECRET_KEY) {
        try {
          const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
          if (subRes.ok) {
            const sub = await subRes.json() as { plan?: { nickname?: string; amount?: number }; current_period_start?: number; current_period_end?: number; metadata?: Record<string, string> };
            planName = sub.plan?.nickname ?? '';
            subscriptionPrice = sub.plan?.amount ?? 0;
            subMetadata = sub.metadata ?? {};
            const jstOffset = (9 * 60 + 15) * 60000;
            if (sub.current_period_start) subscriptionStartDateTime = new Date(sub.current_period_start * 1000 + jstOffset).toISOString().replace('T', ' ').slice(0, 19);
            if (sub.current_period_end) subscriptionEndDateTime = new Date(sub.current_period_end * 1000 + jstOffset).toISOString().replace('T', ' ').slice(0, 19);
          }
        } catch (e) { console.error('[stripe/invoice] subscriptions.retrieve failed:', e); }
      }

      // subscription metadataのlineUserIdをフォールバックに使う
      // （invoice metadataには載らず、CheckoutがStripe顧客を新規作成した場合はシート照合も効かないため）
      if (!resolvedLineUserId && subMetadata.lineUserId) resolvedLineUserId = subMetadata.lineUserId;

      // plan-builder（機能単位サブスク）: metadataの機能セットを顧客行フラグへ同期。
      // 初回・毎月更新の両方で発火し、premiumは支払いごとにチケット200枚付与。
      // ラベルは「プラン」を含む "PBプラン:" 接頭必須（getKeyCodeSetの期限切れ文言・
      // setExtendTrialByKeywordの有料者判定・sendStepMessagesの配信除外の3判定が
      // planName.includes("プラン") を見るため）。
      const isPlanBuilder = subMetadata.source === 'plan-builder';
      if (isPlanBuilder && env.GAS_DEPLOY_ID) {
        try {
          const pbPackages = subMetadata.packages ?? '';
          const pbLabel = 'PBプラン:' + [pbPackages, subMetadata.features].filter(Boolean).join('+');
          const result = await gasPost(env.GAS_DEPLOY_ID, {
            method: 'syncFeaturesFromSubscription',
            lineUserId: subMetadata.lineUserId ?? resolvedLineUserId ?? '',
            stripeCustomerID: stripeCustomerId,
            packages: pbPackages,
            features: subMetadata.features ?? '',
            multiChannelSites: subMetadata.multiChannelSites ?? '',
            subscriptionId,
            planLabel: pbLabel,
            grantPremiumTickets: pbPackages.split(',').includes('premium'),
          });
          console.log('[stripe/invoice] plan-builder sync:', JSON.stringify(result).slice(0, 200));
          // PBサブスクはStripe側にplan.nicknameが無くplanNameが空になる。
          // 空のままだと後続automationのsetSubscriptionDataがプラン名を空上書きするため、
          // GASが合成した日本語ラベル（なければキーベースのラベル）で埋める
          const syncRes = result as { planLabel?: string; keyCode?: string; keyCodeIssued?: boolean } | null;
          if (!planName) planName = syncRes?.planLabel || pbLabel;

          // 更新課金でキーコードが再発行された場合（=ダウングレード予約の切替日など）は
          // 新キーコードをユーザーへ通知する（変更即時実行時の通知はplan-change.tsが返信済み）
          if (syncRes?.keyCodeIssued && syncRes.keyCode && billingReason === 'subscription_cycle' && resolvedLineUserId && env.LINE_CHANNEL_ACCESS_TOKEN) {
            try {
              const kcText = `🔑 本日の更新でご予約のプラン変更が適用され、キーコードが新しくなりました。\n\n新しいキーコード:\n${syncRes.keyCode}\n\n拡張機能のキーコード欄に新しいキーコードを入力し直してご利用ください。`;
              await new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN).pushMessage(resolvedLineUserId, [{ type: 'text', text: kcText } as never]);
              const kcFriend = await getFriendByLineUserId(db, resolvedLineUserId);
              if (kcFriend) await logOutgoing(db, kcFriend.id, 'text', kcText);
            } catch (e) {
              console.error('[stripe/invoice] keycode notice failed:', e);
            }
          }
        } catch (e) {
          console.error('[stripe/invoice] syncFeaturesFromSubscription failed:', e);
        }

        if (isNewSubscription) {
          // 併用割引(combo)の後付け: 初月は顧客クーポン（または合算クーポン）を効かせるため
          // Checkoutでcomboを渡していない。2ヶ月目以降に効くcombo(forever)をここで適用する
          if (subMetadata.pendingComboCoupon && subscriptionId && env.STRIPE_SECRET_KEY) {
            try {
              await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ coupon: subMetadata.pendingComboCoupon }).toString(),
              });
              console.log('[stripe/invoice] pending combo coupon applied:', subMetadata.pendingComboCoupon);
            } catch (e) { console.error('[stripe/invoice] pending combo coupon failed:', e); }
          }
          // 合算初月クーポン（半額+併用割引）の後始末:
          // クーポンオブジェクト削除（一覧を汚さない。適用済みの請求には影響しない）
          if (subMetadata.mergedCouponId && env.STRIPE_SECRET_KEY) {
            try {
              await fetch(`https://api.stripe.com/v1/coupons/${subMetadata.mergedCouponId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
              });
            } catch (e) { console.error('[stripe/invoice] merged coupon delete failed:', e); }
          }
          // 顧客レベルクーポンの消し込み: 合算クーポンで初月の割引は提供済みのため、
          // 顧客に残った once クーポンを外す（残すと将来のinvoiceで二重適用される）
          if (subMetadata.consumedCustomerCoupon === '1' && stripeCustomerId && env.STRIPE_SECRET_KEY) {
            try {
              await fetch(`https://api.stripe.com/v1/customers/${stripeCustomerId}/discount`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
              });
              console.log('[stripe/invoice] customer coupon consumed (merged into first invoice)');
            } catch (e) { console.error('[stripe/invoice] customer discount delete failed:', e); }
          }
        }
      }

      // プラン金額tier計算（19800超は最上位タグに丸める）
      // PBは複数line itemのためsub.plan/先頭itemでは取れない → invoiceの税抜合計を使う
      const tiers = [3000, 5000, 8000, 10000, 15000, 19800];
      const planAmount = isPlanBuilder
        ? (obj.total_excluding_tax ?? obj.subtotal ?? 0)
        : (subscriptionPrice || (obj.lines?.data?.[0]?.price?.unit_amount ?? 0));
      const planTier = tiers.find((t) => planAmount <= t) ?? 19800;

      // 複数discountスタック対応: 併用割引+キャンペーンクーポン等の合算（[0]だけだと2枚目以降が漏れる）
      const discountAmount = (obj.total_discount_amounts ?? []).reduce((t, d) => t + (d.amount ?? 0), 0);
      const taxAmount = obj.tax ?? 0;
      const actualPaidAmount = obj.amount_paid ?? 0;
      const priceExclTax = actualPaidAmount - taxAmount;

      // ambassador coupon: GASで紹介クーポン確認 → Stripeクーポン適用（code_managed相当・継続課金時のみ）
      // アンバサダー紹介クーポン: 従来の顧客レベル適用は、サブスク側discount（併用割引）を
      // 持つ顧客には一切効かない（サブスク側優先のため不発）。サブスクへのスタック追加に変更（2026-07-14）
      let ambassadorCouponApplied = false;
      if (!isNewSubscription && resolvedLineUserId && env.GAS_DEPLOY_ID && stripeCustomerId) {
        try {
          const couponData = await gasGet(env.GAS_DEPLOY_ID, { method: 'updateIntroductionCoupon', lineID: resolvedLineUserId }) as Record<string, string> | null;
          const ambassadorCouponId = couponData?.ambassadorCouponID ?? null;
          if (ambassadorCouponId && env.STRIPE_SECRET_KEY) {
            if (subscriptionId) {
              const { getSubDiscounts, stripeCall, STRIPE_STACK_VERSION } = await import('./plan-builder.js');
              const existingDiscounts = await getSubDiscounts(env.STRIPE_SECRET_KEY, subscriptionId);
              if (existingDiscounts.some((d) => d.couponId === ambassadorCouponId)) {
                console.log('[stripe/invoice] ambassador coupon already stacked:', ambassadorCouponId);
              } else {
                const stackParams: Record<string, string> = {};
                existingDiscounts.forEach((d, i) => {
                  stackParams[`discounts[${i}][discount]`] = d.discountId;
                });
                stackParams[`discounts[${existingDiscounts.length}][coupon]`] = ambassadorCouponId;
                await stripeCall(env.STRIPE_SECRET_KEY, `subscriptions/${subscriptionId}`, stackParams, 'POST', STRIPE_STACK_VERSION);
                ambassadorCouponApplied = true;
                console.log('[stripe/invoice] ambassador coupon stacked:', ambassadorCouponId, 'onto', subscriptionId);
              }
            } else {
              // サブスクIDが取れない場合のフォールバック（従来動作: 顧客レベル適用）
              await fetch(`https://api.stripe.com/v1/customers/${stripeCustomerId}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ coupon: ambassadorCouponId }).toString(),
              });
              ambassadorCouponApplied = true;
            }
          }
        } catch (e) { console.error('[stripe/invoice] ambassador coupon failed:', e); }
      }

      const resolvedFriend = resolvedLineUserId ? await getFriendByLineUserId(db, resolvedLineUserId) : null;
      await fireEvent(db, 'stripe_invoice_paid', {
        friendId: resolvedFriend?.id ?? friendId ?? undefined,
        eventData: {
          stripeCustomerId, lineUserId: resolvedLineUserId, billingReason, isNewSubscription,
          // プラン変更(subscription_update)の差額invoiceでは継続課金メッセージを出さない
          // （変更完了+新キーコードの案内はplan-change.tsが返信済み）
          suppressMessages: billingReason === 'subscription_update',
          // isLegacyPlan: 旧プラン一覧ベースのサブスク（automation側のsetKeyCode等はこちらだけ実行）
          source: subMetadata.source ?? '', isLegacyPlan: !isPlanBuilder,
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

      // plan-builderサブスクの解約: 全フラグOFF（キーコード・端末判定文字列は残す）
      // planLabelは渡さない: 直前のautomation(deleteSubscription)がプラン名に書いた
      // 「キャンセル済み」を上書きしないため（getKeyCodeSetのキャンセル判定が見る）
      if (obj.metadata?.source === 'plan-builder' && env.GAS_DEPLOY_ID) {
        try {
          await gasPost(env.GAS_DEPLOY_ID, {
            method: 'syncFeaturesFromSubscription',
            lineUserId: obj.metadata?.lineUserId ?? resolvedLineUserId ?? '',
            stripeCustomerID: stripeCustomerId,
            subscriptionId: obj.id,
            clearAll: true,
          });
        } catch (e) {
          console.error('[stripe/subscription.deleted] syncFeaturesFromSubscription failed:', e);
        }
      }
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
