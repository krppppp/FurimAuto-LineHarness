import {
  getFriendByLineUserId,
  toJstString,
  jstNow,
  getStalePendingStripeEvents,
  claimStripeEventForRetry,
  markStripeEventCompleted,
  markStripeEventFailed,
  updateFriendPlanName,
  hasProcessedStripeAction,
  markStripeActionProcessed,
} from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { gasGet, gasPost, getGasErrorFromResponse } from '../furim/gas-client.js';
import { enqueueGasRetryJob } from '../furim/gas-retry-queue.js';
import { keycodeReissuedMessages } from '../furim/messages.js';
import { fireEvent } from './event-bus.js';
import { logOutgoing } from '../utils/message-log.js';
import type { Env } from '../index.js';

type Bindings = Env['Bindings'];

export interface StripeWebhookBody {
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

/**
 * 再処理時の二重送信ガード: 同じイベント種別のautomationがこの友だちに対して
 * 直近withinMinutes内にsuccessしていれば true。
 * （初回実行がfireEventまで到達した後に死んだケースの再実行で使う）
 */
async function automationRanRecently(
  db: D1Database,
  eventType: string,
  friendId: string | null | undefined,
  withinMinutes: number,
): Promise<boolean> {
  if (!friendId) return false;
  const cutoff = toJstString(new Date(Date.now() - withinMinutes * 60_000));
  const row = await db.prepare(
    `SELECT l.id FROM automation_logs l INNER JOIN automations a ON a.id = l.automation_id
     WHERE a.event_type = ? AND l.friend_id = ? AND l.status = 'success' AND l.created_at > ? LIMIT 1`,
  ).bind(eventType, friendId, cutoff).first();
  return !!row;
}

/**
 * Stripe webhookイベントの本処理。
 * webhookルートのwaitUntil（初回）と、cronのsweep（再処理）の両方から呼ばれる。
 * waitUntilはレスポンス後約30秒で打ち切られるため、GAS遅延等でここが途中死しても
 * stripe_eventsがpendingのまま残り、sweepPendingStripeEventsが再実行する。
 * 再処理に備え、各ステップは冪等（GAS syncはラベル比較・クーポンは適用済み確認）で、
 * automation発火はisRetry時にautomation_logsの直近実績で二重送信を防ぐ。
 */
export async function processStripeEvent(
  db: D1Database,
  env: Bindings,
  body: StripeWebhookBody,
  opts: { isRetry?: boolean } = {},
): Promise<void> {
  const obj = body.data.object;

  // Stripeメタデータの lineUserId（LINE U...ID）から内部友達IDを引く
  const lineUserId = obj.metadata?.lineUserId ?? null;
  let friendId: string | null = null;
  if (lineUserId) {
    const friend = await getFriendByLineUserId(db, lineUserId);
    friendId = friend?.id ?? null;
  }

  const actionEnv = { lineAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN, gasDeployId: env.GAS_DEPLOY_ID, stripeSecretKey: env.STRIPE_SECRET_KEY, richMenuMemberHome: env.RICHMENU_MEMBER_HOME, richMenuDefaultHome: env.RICHMENU_DEFAULT_HOME };

  // ──────────────────────────────────────────
  // invoice.payment_succeeded
  // ──────────────────────────────────────────
  if (body.type === 'invoice.payment_succeeded') {
    const stripeCustomerId = obj.customer ?? '';
    const billingReason = obj.billing_reason ?? '';
    const isNewSubscription = billingReason === 'subscription_create';

    // LINE ID を解決（メタデータになければGASシートで照合）
    // GAS照合のfetch失敗は「未解決のまま進む」と友だち特定・通知が全部欠けたまま
    // イベントがcompletedになってしまうため記録しておき、後段のsubscription metadata
    // フォールバックでも解決できなければthrowしてsweepの再試行に委ねる
    let resolvedLineUserId = lineUserId;
    let gasLookupFailed = false;
    if (!resolvedLineUserId && stripeCustomerId && env.GAS_DEPLOY_ID) {
      try {
        const gasData = await gasGet(env.GAS_DEPLOY_ID, { method: 'getLINEIDwithStripeID', stripeCustomerID: stripeCustomerId }) as Record<string, string>;
        resolvedLineUserId = gasData?.customer_line_id ?? null;
      } catch (e) {
        console.error('[stripe/invoice] getLINEIDwithStripeID failed:', e);
        gasLookupFailed = true;
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
          const sub = await subRes.json() as { plan?: { nickname?: string; amount?: number }; items?: { data?: Array<{ price?: { unit_amount?: number }; quantity?: number }> }; current_period_start?: number; current_period_end?: number; metadata?: Record<string, string> };
          planName = sub.plan?.nickname ?? '';
          // サブスク価格＝継続課金の月額総額。plan-builder(複数item)では plan.amount が取れないため
          // 全item の unit_amount×quantity を合計する。これは差額invoice(アップグレード)でも常に
          // 「新プランの月額総額」を返す（invoice合計=差額 とは別物）。単一itemのlegacyでも sum=plan.amount。
          const itemsTotal = (sub.items?.data ?? []).reduce((t, it) => t + (it.price?.unit_amount ?? 0) * (it.quantity ?? 1), 0);
          subscriptionPrice = itemsTotal || (sub.plan?.amount ?? 0);
          subMetadata = sub.metadata ?? {};
          const jstOffset = (9 * 60 + 15) * 60000;
          // 終了日時のみ+1日バッファ（2026-07-21変更・従来は+15分）:
          // 更新webhookの処理遅延やcron再処理(最大数十分)の間にキーコード照合が走っても
          // 期限切れ判定にならない猶予。実際の課金サイクルはStripe側が正なのでシートは表示・判定用
          const endJstOffset = (9 * 60 + 24 * 60) * 60000;
          if (sub.current_period_start) subscriptionStartDateTime = new Date(sub.current_period_start * 1000 + jstOffset).toISOString().replace('T', ' ').slice(0, 19);
          if (sub.current_period_end) subscriptionEndDateTime = new Date(sub.current_period_end * 1000 + endJstOffset).toISOString().replace('T', ' ').slice(0, 19);
        }
      } catch (e) { console.error('[stripe/invoice] subscriptions.retrieve failed:', e); }
    }

    // subscription metadataのlineUserIdをフォールバックに使う
    // （invoice metadataには載らず、CheckoutがStripe顧客を新規作成した場合はシート照合も効かないため）
    if (!resolvedLineUserId && subMetadata.lineUserId) resolvedLineUserId = subMetadata.lineUserId;

    // GAS照合のfetch失敗が原因で未解決の場合はイベントをpendingに残してsweepで再試行する
    // （GASが正常応答で空を返した=LINE紐付けなし、は従来どおり続行）
    if (!resolvedLineUserId && gasLookupFailed) {
      throw new Error(`getLINEIDwithStripeID fetch failed and no metadata fallback (event=${body.id}); will retry via cron`);
    }

    // plan-builder（機能単位サブスク）: metadataの機能セットを顧客行フラグへ同期。
    // 初回・毎月更新の両方で発火し、premiumは支払いごとにチケット200枚付与。
    // ラベルは「プラン」を含む "PBプラン:" 接頭必須（getKeyCodeSetの期限切れ文言・
    // setExtendTrialByKeywordの有料者判定・sendStepMessagesの配信除外の3判定が
    // planName.includes("プラン") を見るため）。
    const isPlanBuilder = subMetadata.source === 'plan-builder';
    if (isPlanBuilder && env.GAS_DEPLOY_ID) {
      const pbPackages = subMetadata.packages ?? '';
      const pbLabel = 'PBプラン:' + [pbPackages, subMetadata.features].filter(Boolean).join('+');
      // sweepのイベント再実行と gas_retry_jobs キューの二重経路を防ぐための実行済みマーク。
      // 初回試行で「完遂」または「キュー退避」した時点でマークし、以降の再実行では触らない
      const syncActionKey = 'hardcoded:sync-features';
      const syncGasArgs = {
        lineUserId: subMetadata.lineUserId ?? resolvedLineUserId ?? '',
        stripeCustomerID: stripeCustomerId,
        packages: pbPackages,
        features: subMetadata.features ?? '',
        multiChannelSites: subMetadata.multiChannelSites ?? '',
        subscriptionId,
        planLabel: pbLabel,
        grantPremiumTickets: pbPackages.split(',').includes('premium'),
      };
      if (await hasProcessedStripeAction(db, body.id, syncActionKey)) {
        // 再実行時: 同期はインライン完遂済みかキューが担当中。planNameだけ復元する
        // （初回試行がD1のfriends.plan_nameに同期済み。無ければキーベースのラベル）
        if (!planName) {
          const syncedFriend = resolvedLineUserId ? await getFriendByLineUserId(db, resolvedLineUserId) : null;
          planName = (syncedFriend as { plan_name?: string } | null)?.plan_name || pbLabel;
        }
      } else {
        try {
          const result = await gasPost(env.GAS_DEPLOY_ID, { method: 'syncFeaturesFromSubscription', ...syncGasArgs });
          const failure = getGasErrorFromResponse(result);
          if (failure) throw new Error(failure);
          console.log('[stripe/invoice] plan-builder sync:', JSON.stringify(result).slice(0, 200));
          await markStripeActionProcessed(db, body.id, syncActionKey);
          // PBサブスクはStripe側にplan.nicknameが無くplanNameが空になる。
          // 空のままだと後続automationのsetSubscriptionDataがプラン名を空上書きするため、
          // GASが合成した日本語ラベル（なければキーベースのラベル）で埋める
          const syncRes = result as { planLabel?: string; keyCode?: string; keyCodeIssued?: boolean } | null;
          if (!planName) planName = syncRes?.planLabel || pbLabel;

          // キーコードが再発行された場合は新キーコードをユーザーへ通知する。
          // - subscription_cycle: ダウングレード予約の切替日・移行顧客の初回更新（ラベル変化で再発行）
          // - subscription_update: アップグレード即時実行の差額invoice。通常はplan-change.tsの
          //   同期が先に発行して返信するが、この同期が競合で先勝ちした場合（2026-07-14 澁谷さん
          //   事象の類型）はplan-change側がkeyCodeIssued=falseになり通知が漏れるため、ここで送る。
          //   発行判定は冪等（ラベル一致なら再発行しない）ので二重通知にはならない
          if (syncRes?.keyCodeIssued && syncRes.keyCode && (billingReason === 'subscription_cycle' || billingReason === 'subscription_update') && resolvedLineUserId && env.LINE_CHANNEL_ACCESS_TOKEN) {
            try {
              // キーコードは単独メッセージで送る（LINE はメッセージ単位でしかコピーできないため）
              const kcMessages = keycodeReissuedMessages(syncRes.keyCode);
              await new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN).pushMessage(resolvedLineUserId, kcMessages as never[]);
              const kcFriend = await getFriendByLineUserId(db, resolvedLineUserId);
              if (kcFriend) {
                for (const m of kcMessages) await logOutgoing(db, kcFriend.id, 'text', m.text);
              }
            } catch (e) {
              console.error('[stripe/invoice] keycode notice failed:', e);
            }
          }
        } catch (e) {
          // 従来はここで握りつぶしてイベントがcompletedになり、キーコード同期漏れが
          // 永久ロストしていた。再実行キューに退避してcronが完遂させる（キュー完遂時の
          // 再発行通知は __notifyKeycodeReissue フラグで sweep 側が送る）
          const syncLineUserId = subMetadata.lineUserId || resolvedLineUserId || '';
          if (!syncLineUserId) {
            // 退避先が無い: イベントをpendingに残しsweepの再試行に委ねる
            throw e;
          }
          await enqueueGasRetryJob(db, {
            lineUserId: syncLineUserId,
            method: 'syncFeaturesFromSubscription',
            params: {
              ...syncGasArgs,
              __notifyKeycodeReissue: (billingReason === 'subscription_cycle' || billingReason === 'subscription_update') ? '1' : '0',
            },
            callType: 'post',
            doneCheck: null,
            dedupeKey: `syncFeaturesFromSubscription:${body.id}`,
            maxAttempts: 20,
          });
          await markStripeActionProcessed(db, body.id, syncActionKey);
          console.warn('[stripe/invoice] syncFeaturesFromSubscription 失敗→再実行キューに退避:', String(e));
          if (!planName) planName = pbLabel;
        }
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

    // D1側にもプラン名を同期（legacy/plan-builder問わず、ここまでで planName は確定済み）。
    // friendId ではなく resolvedLineUserId を使う: friendId は metadata.lineUserId が
    // ある場合のみ解決され(86-90行目)、GAS逆引き・サブスクmetadataフォールバックを
    // 経ていないため resolvedLineUserId より不完全なことがある。
    if (resolvedLineUserId && planName) {
      try {
        await updateFriendPlanName(db, resolvedLineUserId, planName);
      } catch (e) {
        console.error('[stripe/invoice] updateFriendPlanName failed:', e);
      }
    }

    // プラン金額tier計算（19800超は最上位タグに丸める）
    // サブスク継続課金の月額総額（上で算出した subscriptionPrice=全item合計）を最優先。
    // アップグレードの差額invoiceでは invoice合計(total_excluding_tax/subtotal)=差額 になるため、
    // サブスク価格・tier判定には継続課金総額を使う必要がある（差額を使うと過小評価）。
    // 継続課金総額が取れない場合のみ従来フォールバック（PB=invoice税抜合計 / legacy=先頭item単価）。
    const tiers = [3000, 5000, 8000, 10000, 15000, 19800];
    const planAmount = subscriptionPrice
      || (isPlanBuilder
        ? (obj.total_excluding_tax ?? obj.subtotal ?? 0)
        : (obj.lines?.data?.[0]?.price?.unit_amount ?? 0));
    const planTier = tiers.find((t) => planAmount <= t) ?? 19800;

    // 複数discountスタック対応: 併用割引+キャンペーンクーポン等の合算（[0]だけだと2枚目以降が漏れる）
    const discountAmount = (obj.total_discount_amounts ?? []).reduce((t, d) => t + (d.amount ?? 0), 0);
    const taxAmount = obj.tax ?? 0;
    const actualPaidAmount = obj.amount_paid ?? 0;
    const priceExclTax = actualPaidAmount - taxAmount;

    // ambassador coupon: GASで紹介クーポン確認 → Stripeクーポン適用（code_managed相当・継続課金時のみ）
    // アンバサダー紹介クーポン: 従来の顧客レベル適用は、サブスク側discount（併用割引）を
    // 持つ顧客には一切効かない（サブスク側優先のため不発）。サブスクへのスタック追加に変更（2026-07-14）
    // 既知の穴（2026-08-14調査・受容）: updateIntroductionCoupon はGAS側が「クーポン適用フラグを
    // 先に立ててから」IDを返すため、fetchがハングしてGAS側だけ完走するとシート上は適用済み・
    // Stripe未適用のまま翌月以降も拾えず割引がロストする。GAS非改修方針のためWorker側では
    // 塞げない。発生時はクーポン適用履歴とStripe側discountを突き合わせて手動適用する
    let ambassadorCouponApplied = false;
    if (!isNewSubscription && resolvedLineUserId && env.GAS_DEPLOY_ID && stripeCustomerId) {
      try {
        const couponData = await gasGet(env.GAS_DEPLOY_ID, { method: 'updateIntroductionCoupon', lineID: resolvedLineUserId }) as Record<string, string> | null;
        const ambassadorCouponId = couponData?.ambassadorCouponID ?? null;
        if (ambassadorCouponId && env.STRIPE_SECRET_KEY) {
          if (subscriptionId) {
            const { getSubDiscounts, stripeCall, STRIPE_STACK_VERSION } = await import('../routes/plan-builder.js');
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

    // 再処理時の継続課金メッセージ二重送信ガード（2026-08-11追加）。
    // idempotencyKeyの「厳密1回」は、送信(executeAction)の成功を記録(markStripeActionProcessed)する前に
    // waitUntilが打ち切られると成立しない。この窓に入ると再処理で同じ通知がもう一度飛ぶ。
    // 実測: 2026-07-23 / 07-26 / 08-07(2件) / 08-11 の計5件、いずれも11〜15分間隔＝sweepの再処理間隔。
    // 冪等キー導入(688201c, 2026-08-04)後も3件出ているため、配信系だけ時間窓ガードを併用する。
    // suppressMessagesはsend_messagesアクションだけを飛ばすので、GAS台帳記録など未完了の処理は再実行される。
    const invoiceNoticeAlreadySent = opts.isRetry === true
      && await automationRanRecently(db, 'stripe_invoice_paid', resolvedFriend?.id ?? friendId, 60);
    if (invoiceNoticeAlreadySent) {
      console.log(`[stripe/invoice] 継続課金メッセージは送信済みのため抑制します (event=${body.id})`);
    }

    // automationの各アクションは body.id を冪等キーに event-bus 側で厳密1回だけ実行される。
    // 途中で失敗したら allOk=false が返るので throw し、markStripeEventCompletedを回避 →
    // cron(sweep)が再処理し、未実行アクション(GAS台帳記録等)だけ再送する。
    const invoiceAutomationsOk = await fireEvent(db, 'stripe_invoice_paid', {
        friendId: resolvedFriend?.id ?? friendId ?? undefined,
        idempotencyKey: body.id,
        eventData: {
          stripeCustomerId, lineUserId: resolvedLineUserId, billingReason, isNewSubscription,
          // プラン変更(subscription_update)の差額invoiceでは継続課金メッセージを出さない
          // （変更完了+新キーコードの案内はplan-change.tsが返信済み）
          // 再処理で既に送信済みの場合も同様に配信だけ抑制する
          suppressMessages: billingReason === 'subscription_update' || invoiceNoticeAlreadySent,
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
    if (!invoiceAutomationsOk) {
      throw new Error(`stripe_invoice_paid automations incomplete (event=${body.id}); will retry via cron`);
    }

    console.log(`[stripe/invoice] ${billingReason} customer=${stripeCustomerId} lineUserId=${resolvedLineUserId}`);
  }

  // ──────────────────────────────────────────
  // invoice.payment_failed
  // ──────────────────────────────────────────
  if (body.type === 'invoice.payment_failed') {
    const attemptCount = obj.attempt_count ?? 0;

    // 新規申し込みのCheckout中に3Dセキュア認証が挟まると、認証完了前に
    // billing_reason=subscription_create / attempt_count=0 の payment_failed が届き、
    // 数秒後に payment_succeeded が続く（2026-08-13 mochi me事例: 失敗17:20:37→成功17:20:43）。
    // ユーザーはまだ決済画面の途中なので「お支払いが確認できませんでした」を送ると
    // 直後の登録完了メッセージと連投になり混乱させる。Checkoutの失敗はStripeの決済画面
    // 自身が案内するため、初回invoiceの失敗は通知もautomation（タグ付け等）も行わない。
    // 継続課金の失敗（subscription_cycle）は従来どおり通知する。
    if ((obj.billing_reason ?? '') === 'subscription_create' && attemptCount === 0) {
      console.log(`[stripe/payment_failed] 初回Checkout中(3DS等)の失敗のため通知しません (event=${body.id})`);
      return;
    }

    const stripeCustomerId = obj.customer ?? '';
    let resolvedLineUserId = lineUserId;
    if (!resolvedLineUserId && stripeCustomerId && env.GAS_DEPLOY_ID) {
      try {
        const gasData = await gasGet(env.GAS_DEPLOY_ID, { method: 'getLINEIDwithStripeID', stripeCustomerID: stripeCustomerId }) as Record<string, string>;
        resolvedLineUserId = gasData?.customer_line_id ?? null;
      } catch (e) {
        // fetch失敗のまま進むと「友だち未特定」の縮退動作でイベントが完了してしまう。
        // pendingに残してsweepで再試行する（GAS正常応答で空=LINE紐付けなし、は続行）
        console.error('[stripe/payment_failed] getLINEIDwithStripeID failed:', e);
        throw e;
      }
    }
    const resolvedFriend = resolvedLineUserId ? await getFriendByLineUserId(db, resolvedLineUserId) : null;

    // 通知判定: 従来は attempt_count=1 のみ通知していたが、初回通知が失われた顧客
    // （Harness移行前の初回失敗・処理途中死）はリトライで永遠に通知されない穴があった
    // （2026-07-18事例）。友だちが特定できる場合は「直近14日に失敗通知実績が無ければ
    // リトライでも通知する」に変更。実績があればスキップ（リトライごとのスパム防止）。
    let shouldNotify: boolean;
    if (resolvedFriend) {
      shouldNotify = !(await automationRanRecently(db, 'stripe_payment_failed', resolvedFriend.id, 14 * 24 * 60));
    } else {
      // 友だち未特定なら実績確認ができないため従来同様初回のみ（automationも友だち宛送信はできない）
      shouldNotify = attemptCount === 1;
    }

    if (!shouldNotify) {
      console.log(`[stripe/payment_failed] attempt_count=${attemptCount} 通知済みのためスキップ`);
    } else {
      // 14日通知スロットル(automationRanRecently=status'success'ベース)は上で維持。
      // その上でaction単位の冪等(body.id)を効かせ、途中死→再処理で通知の二重送信を防ぎつつ
      // 未完なら送り切る。partialは'success'にならないため再処理でスロットルに弾かれない。
      const failedOk = await fireEvent(db, 'stripe_payment_failed', {
        friendId: resolvedFriend?.id ?? friendId ?? undefined,
        idempotencyKey: body.id,
        eventData: { stripeCustomerId, lineUserId: resolvedLineUserId },
      }, env.LINE_CHANNEL_ACCESS_TOKEN, null, actionEnv);
      if (!failedOk) {
        throw new Error(`stripe_payment_failed automations incomplete (event=${body.id}); will retry via cron`);
      }
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
      } catch (e) {
        // fetch失敗のまま進むと友だち未特定で解約フローが空振りしたままイベントが
        // 完了してしまう。pendingに残してsweepで再試行する
        console.error('[stripe/subscription.deleted] getLINEIDwithStripeID failed:', e);
        throw e;
      }
    }
    const resolvedFriend = resolvedLineUserId ? await getFriendByLineUserId(db, resolvedLineUserId) : null;
    // action単位でbody.idを冪等キーに厳密1回実行。未完なら(clearAll後に)throwしてcron再処理に回す。
    const subDeletedOk = await fireEvent(db, 'stripe_subscription_deleted', {
      friendId: resolvedFriend?.id ?? friendId ?? undefined,
      idempotencyKey: body.id,
      eventData: { stripeCustomerId, lineUserId: resolvedLineUserId, subscriptionId: obj.id },
    }, env.LINE_CHANNEL_ACCESS_TOKEN, null, actionEnv);

    // plan-builderサブスクの解約: 全フラグOFF（キーコード・端末判定文字列は残す）
    // planLabelは渡さない: 直前のautomation(deleteSubscription)がプラン名に書いた
    // 「キャンセル済み」を上書きしないため（getKeyCodeSetのキャンセル判定が見る）
    if (obj.metadata?.source === 'plan-builder' && env.GAS_DEPLOY_ID) {
      const clearArgs = {
        lineUserId: obj.metadata?.lineUserId ?? resolvedLineUserId ?? '',
        stripeCustomerID: stripeCustomerId,
        subscriptionId: obj.id,
        clearAll: true,
      };
      try {
        const result = await gasPost(env.GAS_DEPLOY_ID, { method: 'syncFeaturesFromSubscription', ...clearArgs });
        const failure = getGasErrorFromResponse(result);
        if (failure) throw new Error(failure);
      } catch (e) {
        // 従来は握りつぶしで「解約したのに機能フラグが残る」が無言で起きていた。
        // 再実行キューに退避してcronが完遂させる（clearAllは冪等なのでdoneCheck不要）
        const clearLineUserId = clearArgs.lineUserId;
        if (!clearLineUserId) throw e; // 退避先が無ければpendingに残しsweepへ
        await enqueueGasRetryJob(db, {
          lineUserId: clearLineUserId,
          method: 'syncFeaturesFromSubscription',
          params: clearArgs,
          callType: 'post',
          doneCheck: null,
          dedupeKey: `syncFeaturesFromSubscription:clearAll:${body.id}`,
          maxAttempts: 20,
        });
        console.warn('[stripe/subscription.deleted] syncFeaturesFromSubscription 失敗→再実行キューに退避:', String(e));
      }
    }
    if (!subDeletedOk) {
      throw new Error(`stripe_subscription_deleted automations incomplete (event=${body.id}); will retry via cron`);
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
        // チケット付与(枚数加算=非冪等)含むため action単位でbody.idを冪等キーに厳密1回実行。
        const ticketOk = await fireEvent(db, 'stripe_ticket_purchased', {
          friendId: ticketFriend?.id ?? undefined,
          idempotencyKey: body.id,
          eventData: { lineUserId: ticketLineUserId, quantity, paymentIntentId: obj.id, amount: obj.amount ?? 0, currency: obj.currency ?? 'jpy' },
        }, env.LINE_CHANNEL_ACCESS_TOKEN, null, actionEnv);
        if (!ticketOk) {
          throw new Error(`stripe_ticket_purchased automations incomplete (event=${body.id}); will retry via cron`);
        }
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
}

/**
 * cron再処理: pendingのまま滞留しているstripe_eventsを拾って処理し直す。
 * 対象は最終試行から10分以上経過（=初回waitUntilが打ち切られたと判断できる）した行。
 * 最大4回試行し、超えたらfailedにして手動対応に回す。
 */
export async function sweepPendingStripeEvents(db: D1Database, env: Bindings): Promise<void> {
  const MAX_ATTEMPTS = 4;

  // 試行上限超過のpendingをfailedへ（sweep途中でwaitUntil打ち切りに遭った行の後始末）
  await db.prepare(
    `UPDATE stripe_events SET status = 'failed', last_error = COALESCE(last_error, 'max attempts exhausted') WHERE status = 'pending' AND attempts >= ?`,
  ).bind(MAX_ATTEMPTS).run();

  const stale = await getStalePendingStripeEvents(db, { staleMinutes: 10, maxAttempts: MAX_ATTEMPTS, limit: 10 });
  for (const ev of stale) {
    if (!ev.payload) {
      // 052以前の行（payload未保存）は再処理不能
      await markStripeEventFailed(db, ev.id, 'no payload (pre-052 event)', false);
      continue;
    }
    const claimed = await claimStripeEventForRetry(db, ev.id, ev.attempts);
    if (!claimed) continue;
    try {
      const body = JSON.parse(ev.payload) as StripeWebhookBody;
      console.log(`[stripe/sweep] retry ${ev.stripe_event_id} (${ev.event_type}) attempt=${ev.attempts + 1}`);
      await processStripeEvent(db, env, body, { isRetry: true });
      await markStripeEventCompleted(db, ev.id);
      console.log(`[stripe/sweep] ${ev.stripe_event_id} recovered`);
    } catch (err) {
      const exhausted = ev.attempts + 1 >= MAX_ATTEMPTS;
      await markStripeEventFailed(db, ev.id, String(err), !exhausted);
      console.error(`[stripe/sweep] ${ev.stripe_event_id} failed (attempt ${ev.attempts + 1}${exhausted ? ', giving up' : ''})`, err);
    }
  }
}
