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

    // ──────────────────────────────────────────
    // invoice.payment_succeeded
    // 月次自動課金・新規加入のメインイベント
    // ──────────────────────────────────────────
    if (body.type === 'invoice.payment_succeeded') {
      const stripeCustomerId = obj.customer ?? '';
      const billingReason = obj.billing_reason ?? '';

      // GAS から LINE ID を取得（メタデータにない場合はGASシートが正）
      let resolvedLineUserId = lineUserId;
      if (!resolvedLineUserId && stripeCustomerId && env.GAS_DEPLOY_ID) {
        try {
          const gasData = await gasGet(env.GAS_DEPLOY_ID, {
            method: 'getLINEIDwithStripeID',
            stripeCustomerID: stripeCustomerId,
          }) as Record<string, string>;
          resolvedLineUserId = gasData?.customer_line_id ?? null;
        } catch (e) {
          console.error('[stripe/invoice] getLINEIDwithStripeID failed:', e);
        }
      }

      // GAS: サブスク情報更新・キーコード更新・取引記録
      // Stripe APIからサブスクリプション詳細を取得（plan.nickname・plan.amount が正確な値）
      const subscriptionId = obj.subscription ?? '';
      let planName = '';
      let subscriptionPrice = 0;
      let subscriptionStartDateTime = '';
      let subscriptionEndDateTime = '';

      if (subscriptionId && env.STRIPE_SECRET_KEY) {
        try {
          const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
            headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
          });
          if (subRes.ok) {
            const sub = await subRes.json() as { plan?: { nickname?: string; amount?: number }; current_period_start?: number; current_period_end?: number };
            planName = sub.plan?.nickname ?? '';
            subscriptionPrice = sub.plan?.amount ?? 0;
            // JST変換（旧仕様に合わせ +9h15min）
            const jstOffset = (9 * 60 + 15) * 60000;
            if (sub.current_period_start) {
              subscriptionStartDateTime = new Date(sub.current_period_start * 1000 + jstOffset).toISOString().replace('T', ' ').slice(0, 19);
            }
            if (sub.current_period_end) {
              subscriptionEndDateTime = new Date(sub.current_period_end * 1000 + jstOffset).toISOString().replace('T', ' ').slice(0, 19);
            }
          }
        } catch (e) {
          console.error('[stripe/invoice] subscriptions.retrieve failed:', e);
        }
      }

      const discountAmount = obj.total_discount_amounts?.[0]?.amount ?? 0;
      const taxAmount = obj.tax ?? 0;
      const actualPaidAmount = obj.amount_paid ?? 0;
      const priceExclTax = actualPaidAmount - taxAmount;

      if (env.GAS_DEPLOY_ID) {
        try {
          await gasPost(env.GAS_DEPLOY_ID, {
            method: 'setSubscriptionData',
            customerEmail: obj.customer_email ?? '',
            stripeCustomerID: stripeCustomerId,
            planName,
            subscriptionID: subscriptionId,
            subscriptionStartDateTime,
            subscriptionEndDateTime,
            subscriptionPrice,
            subscriptionActualPaidAmount: actualPaidAmount,
          });
        } catch (e) {
          console.error('[stripe/invoice] setSubscriptionData failed:', e);
        }
        try {
          await gasPost(env.GAS_DEPLOY_ID, {
            method: 'setKeyCode',
            planName,
            stripeCustomerID: stripeCustomerId,
          });
        } catch (e) {
          console.error('[stripe/invoice] setKeyCode failed:', e);
        }
        try {
          await gasPost(env.GAS_DEPLOY_ID, {
            method: 'setTransactionData',
            stripeCustomerID: stripeCustomerId,
            invoiceID: obj.id,
            planName,
            subscriptionPrice,
            discountAmount,
            priceExclTax,
            taxAmount,
            actualPaidAmount,
          });
        } catch (e) {
          console.error('[stripe/invoice] setTransactionData failed:', e);
        }
      }

      // LINE通知 + リッチメニュー切替
      if (resolvedLineUserId) {
        const lineClient = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);

        // リッチメニューを会員用に切り替え
        if (env.RICHMENU_MEMBER_HOME) {
          try {
            await lineClient.linkRichMenuToUser(resolvedLineUserId, env.RICHMENU_MEMBER_HOME);
          } catch (e) {
            console.error('[stripe/invoice] linkRichMenu failed:', e);
          }
        }

        // 決済完了メッセージ
        const isNewSubscription = billingReason === 'subscription_create';
        try {
          if (isNewSubscription) {
            await lineClient.pushMessage(resolvedLineUserId, [
              { type: 'text', text: `【自動送信】\n月額プランへのご登録ありがとうございました🌟\nまた、それに伴いましてお客様のキーコードが更新されましたので、お手数ですがリッチメニューから新しいキーコードを発行の上、拡張機能に再入力してください。\n\n引き続き仕様変更への迅速な対応、ユーザー様の声をできる限り汲んで運営してまいりますので\nよろしくお願いいたします。` } as never,
              { type: 'image', originalContentUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/ambassador.png', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/ambassador.png' } as never,
              { type: 'text', text: `【アンバサダー制度でお得にご利用いただけます💡】\n      \n「FurimAutoオススメだよ!!」\nとお友達にご紹介していただけましたら\n双方にとって絶対にお得なプログラムとなっております✨\n\nご興味ございましたらリッチメニューの\nアンバサダー制度\nをタップしてください😆\n\nFurimAutoが皆様の物販事業\n底上げに繋がるように\n引き続き開発を続けて参りますので、\nどうぞ末長くよろしくお願いいたします。` } as never,
            ] as never);
          } else {
            await lineClient.pushMessage(resolvedLineUserId, [
              { type: 'text', text: `【自動送信】\nご登録いただいております月額プランへの継続課金成功のお知らせをお知らせいたします。\n内容のご確認をご希望のお客様は、メニュー下部の"会員情報の確認"クリックしてご確認してください。\n\nまた、それに伴いましてお客様のキーコードが更新されましたので、お手数ですがリッチメニューから新しいキーコードを発行の上、ブラウザにて再入力してください。\n\nそれでは、これからもFurimAutoを存分に活用してください♪` } as never,
            ] as never);

            // 割引告知（クーポン案内）
            if (env.GAS_DEPLOY_ID && stripeCustomerId) {
              try {
                const couponData = await gasGet(env.GAS_DEPLOY_ID, {
                  method: 'updateIntroductionCoupon',
                  lineID: resolvedLineUserId,
                }) as Record<string, string> | null;

                const ambassadorCouponId = couponData?.ambassadorCouponID ?? null;

                const renewalMessages: never[] = [];

                if (ambassadorCouponId && env.STRIPE_SECRET_KEY) {
                  try {
                    const body = new URLSearchParams({ coupon: ambassadorCouponId });
                    await fetch(`https://api.stripe.com/v1/customers/${stripeCustomerId}`, {
                      method: 'POST',
                      headers: {
                        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
                        'Content-Type': 'application/x-www-form-urlencoded',
                      },
                      body: body.toString(),
                    });
                    renewalMessages.push({ type: 'text', text: `お友達紹介の未使用クーポンが見つかりました！\n次回の継続課金の際に自動で割引が適用されます💰` } as never);
                  } catch (e) {
                    console.error('[stripe/invoice] Stripe coupon apply failed:', e);
                  }
                }

                renewalMessages.push(
                  { type: 'image', originalContentUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/coupon_get.png', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/coupon_get.png' } as never,
                  { type: 'text', text: `【割引告知】\nお客様のご利用にあたり、\n次回の継続課金の際に適用可能な割引クーポンのご案内です💰\n\n詳しくはリッチメニューの\n1️⃣ガイドタブ\n2️⃣クーポンGET\nを順番にタップしてご確認ください🎆` } as never,
                );

                await lineClient.pushMessage(resolvedLineUserId, renewalMessages as never);
              } catch (e) {
                console.error('[stripe/invoice] 割引告知メッセージ送信失敗:', e);
              }
            }
          }
        } catch (e) {
          console.error('[stripe/invoice] pushMessage failed:', e);
        }

        // タグ更新（新規・継続共通）
        const friend = await getFriendByLineUserId(db, resolvedLineUserId);
        if (friend) {
          // 月額会員タグ付与
          const memberTag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind('月額会員').first<{ id: string }>();
          if (memberTag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)').bind(friend.id, memberTag.id, jstNow()).run();

          // 有料会員化に伴い不要タグを削除
          const removeTags = ['セグメント1','セグメント2','セグメント3','セグメント4','セグメント5','セグメント6','セグメント7','セグメント8','無料試用期間中','解説見た','Furimanです','キャンセル済み'];
          for (const name of removeTags) {
            const t = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(name).first<{ id: string }>();
            if (t) await db.prepare('DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ?').bind(friend.id, t.id).run();
          }

          // 金額タグ: 既存を全削除して正しい金額タグを付与
          const tiers = [3000, 5000, 8000, 10000, 15000, 19800];
          for (const t of tiers) {
            const oldTag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(`月額${t}`).first<{ id: string }>();
            if (oldTag) await db.prepare('DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ?').bind(friend.id, oldTag.id).run();
          }
          const planAmount = obj.lines?.data?.[0]?.price?.unit_amount ?? 0;
          if (planAmount > 0) {
            const tier = tiers.find((t) => planAmount <= t);
            if (tier) {
              const tierTag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(`月額${tier}`).first<{ id: string }>();
              if (tierTag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)').bind(friend.id, tierTag.id, jstNow()).run();
            }
          }
        }
      }

      console.log(`[stripe/invoice] ${billingReason} customer=${stripeCustomerId} lineUserId=${resolvedLineUserId}`);
    }

    // ──────────────────────────────────────────
    // customer.subscription.created
    // ──────────────────────────────────────────
    if (body.type === 'customer.subscription.created' && friendId) {
      const subObj = obj as unknown as { plan?: { amount?: number }; items?: { data?: Array<{ price?: { unit_amount?: number } }> } };
      const amount = subObj.plan?.amount ?? subObj.items?.data?.[0]?.price?.unit_amount ?? 0;

      const memberTag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind('月額会員').first<{ id: string }>();
      if (memberTag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)').bind(friendId, memberTag.id, jstNow()).run();

      if (amount > 0) {
        const tier = [3000, 5000, 8000, 10000, 15000, 19800].find((t) => amount <= t);
        if (tier) {
          const tierTag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(`月額${tier}`).first<{ id: string }>();
          if (tierTag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)').bind(friendId, tierTag.id, jstNow()).run();
        }
      }
    }

    // ──────────────────────────────────────────
    // invoice.payment_failed
    // 初回失敗時のみLINE通知（attempt_count === 1）
    // ──────────────────────────────────────────
    if (body.type === 'invoice.payment_failed') {
      const attemptCount = obj.attempt_count ?? 0;
      if (attemptCount === 1) {
        const stripeCustomerId = obj.customer ?? '';
        let resolvedLineUserId = lineUserId;
        if (!resolvedLineUserId && stripeCustomerId && env.GAS_DEPLOY_ID) {
          try {
            const gasData = await gasGet(env.GAS_DEPLOY_ID, {
              method: 'getLINEIDwithStripeID',
              stripeCustomerID: stripeCustomerId,
            }) as Record<string, string>;
            resolvedLineUserId = gasData?.customer_line_id ?? null;
          } catch (e) {
            console.error('[stripe/payment_failed] getLINEIDwithStripeID failed:', e);
          }
        }

        if (resolvedLineUserId) {
          const lineClient = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
          try {
            await lineClient.pushMessage(resolvedLineUserId, [{
              type: 'text',
              text: `【自動送信】\nお客様の月額プランへのお支払いが確認できませんでした。\n\nリッチメニューのホームタブ「月額会員ページ」から、お支払い方法のご確認・変更をお願いいたします。\n\nお支払いが確認できない場合、サービスのご利用ができなくなる場合がございます。`,
            } as never]);
            console.log(`[stripe/payment_failed] LINE通知送信完了 lineUserId=${resolvedLineUserId}`);
          } catch (e) {
            console.error('[stripe/payment_failed] pushMessage failed:', e);
          }
        }
      } else {
        console.log(`[stripe/payment_failed] attempt_count=${attemptCount} のためスキップ`);
      }
    }

    // ──────────────────────────────────────────
    // customer.subscription.deleted
    // ──────────────────────────────────────────
    if (body.type === 'customer.subscription.deleted') {
      // GAS: 解約処理
      const stripeCustomerId = obj.customer ?? '';
      if (env.GAS_DEPLOY_ID && stripeCustomerId) {
        try {
          await gasPost(env.GAS_DEPLOY_ID, {
            method: 'deleteSubscription',
            stripeCustomerID: stripeCustomerId,
            subscriptionID: obj.id,
          });
        } catch (e) {
          console.error('[stripe/subscription.deleted] deleteSubscription failed:', e);
        }
      }

      // LINE ID を解決
      let resolvedLineUserId = lineUserId;
      if (!resolvedLineUserId && stripeCustomerId && env.GAS_DEPLOY_ID) {
        try {
          const gasData = await gasGet(env.GAS_DEPLOY_ID, {
            method: 'getLINEIDwithStripeID',
            stripeCustomerID: stripeCustomerId,
          }) as Record<string, string>;
          resolvedLineUserId = gasData?.customer_line_id ?? null;
        } catch (e) {
          console.error('[stripe/subscription.deleted] getLINEIDwithStripeID failed:', e);
        }
      }

      if (resolvedLineUserId) {
        const lineClient = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);

        // リッチメニューをデフォルトに切り替え
        if (env.RICHMENU_DEFAULT_HOME) {
          try {
            await lineClient.linkRichMenuToUser(resolvedLineUserId, env.RICHMENU_DEFAULT_HOME);
          } catch (e) {
            console.error('[stripe/subscription.deleted] linkRichMenu failed:', e);
          }
        }

        // 解約通知
        try {
          await lineClient.pushMessage(resolvedLineUserId, [{
            type: 'text',
            text: `【自動送信】\nご登録いただいておりました月額プランを解消しました。\n現時点でキーコードは使用不可となります。\n\nFurimAutoでは日々開発を進め今後も機能面はもちろん、利用可能になるプラットフォームを広げていきますので、またの機会がございましたら再度と月額プラン登録の手順を踏んでください。\n\nまたのご利用をお待ちしております！`,
          } as never]);
        } catch (e) {
          console.error('[stripe/subscription.deleted] pushMessage failed:', e);
        }

        // タグ操作（DB内部IDが必要）
        const friend = await getFriendByLineUserId(db, resolvedLineUserId);
        if (friend) {
          const cancelledTag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind('キャンセル済み').first<{ id: string }>();
          if (cancelledTag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)').bind(friend.id, cancelledTag.id, jstNow()).run();

          for (const tagName of ['月額会員', '月額3000', '月額5000', '月額8000', '月額10000', '月額15000', '月額19800', '無料試用期間中']) {
            const tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(tagName).first<{ id: string }>();
            if (tag) await db.prepare('DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ?').bind(friend.id, tag.id).run();
          }
        }
      }
    }

    // ──────────────────────────────────────────
    // payment_intent.succeeded（一回決済）
    // ──────────────────────────────────────────
    if (body.type === 'payment_intent.succeeded') {
      // チケット購入処理
      if (obj.metadata?.purchaseType === 'ticket') {
        const ticketLineUserId = obj.metadata?.lineUserId ?? lineUserId;
        const quantity = parseInt(obj.metadata?.quantity ?? '0', 10);

        if (ticketLineUserId && quantity > 0 && env.GAS_DEPLOY_ID) {
          try {
            await gasPost(env.GAS_DEPLOY_ID, {
              method: 'setTicketTransaction',
              lineUserId: ticketLineUserId,
              ticketCount: quantity,
              paymentIntentId: obj.id,
              amount: obj.amount ?? 0,
              currency: obj.currency ?? 'jpy',
            });
            console.log(`[stripe/ticket] setTicketTransaction完了 lineUserId=${ticketLineUserId} quantity=${quantity}`);
          } catch (e) {
            console.error('[stripe/ticket] setTicketTransaction failed:', e);
          }

          const lineClient = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
          try {
            await lineClient.pushMessage(ticketLineUserId, [{
              type: 'text',
              text: `🎉【チケット購入完了】🎉\n\nコピー出品チケット ${quantity}枚の購入が完了しました！\n\nキーコードの入力ボタンを押して、チケット枚数を取得してください。\nFurimAutoのコピー出品機能でご利用いただけます。\n\n引き続きFurimAutoをよろしくお願いします。`,
            } as never]);
          } catch (e) {
            console.error('[stripe/ticket] pushMessage failed:', e);
          }
        }
      } else if (friendId) {
        // 通常の一回決済（スコアリング・イベント発火）
        const { applyScoring } = await import('@line-crm/db');
        await applyScoring(db, friendId, 'purchase');

        const productId = obj.metadata?.product_id;
        if (productId) {
          const tag = await db.prepare(`SELECT id FROM tags WHERE name = ?`).bind(`purchased_${productId}`).first<{ id: string }>();
          if (tag) {
            await db.prepare(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)`).bind(friendId, tag.id, jstNow()).run();
          }
        }

        const { fireEvent } = await import('../services/event-bus.js');
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
