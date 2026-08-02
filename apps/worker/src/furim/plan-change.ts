import type { LineClient } from '@line-crm/line-sdk';
import { jstNow } from '@line-crm/db';
import {
  resolvePlanSelection,
  buildItemsFromSelection,
  type PlanCheckoutEnv,
} from '../routes/plan-builder.js';

// LIFFの申込ボタン（既存契約者）→「【プラン変更】PB-XXXXXX」を処理する。
// 新規Checkoutは作らず、既存サブスクをin-place更新して残り期間の差額を日割りで即時決済する。
// プラン構成が変わるためキーコードは再発行され（syncFeaturesFromSubscription側の判定）、
// 新キーコードをこの場で案内する。
export async function handlePlanChangeMessage(
  db: D1Database,
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string,
  text: string,
  env: PlanCheckoutEnv,
): Promise<void> {
  try {
    const m = text.match(/PB-[A-Z0-9]{6}/);
    if (!m) throw new Error('変更コードがメッセージに見つかりません');
    const code = m[0];

    const row = await db
      .prepare('SELECT payload, used_at, created_at FROM plan_builder_intents WHERE id = ? AND line_user_id = ?')
      .bind(code, lineUserId)
      .first<{ payload: string; used_at: string | null; created_at: string }>();
    if (!row) throw new Error(`intent not found: ${code}`);
    if (row.used_at) throw new Error(`intent already used: ${code}`);

    const payload = JSON.parse(row.payload) as {
      type?: string;
      kind?: 'upgrade' | 'downgrade';
      subscriptionId: string;
      prorationDate: number;
      amountDueNow: number;
      effectiveDate?: number;
      packages: string[];
      features: string[];
      multiChannelSites: string[];
      total: number;
    };
    if (payload.type !== 'change') throw new Error(`not a change intent: ${code}`);
    if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured');

    const { stripeCall, ensureComboCoupon, getSubDiscounts, STRIPE_STACK_VERSION } = await import('../routes/plan-builder.js');
    const sel = await resolvePlanSelection(env.GAS_DEPLOY_ID, { ...payload, lineUserId });
    const newItems = buildItemsFromSelection(sel);

    // 現在のitemsを取得して入れ替え（差額は日割りで即時invoice）
    const sub = (await stripeCall(env.STRIPE_SECRET_KEY, `subscriptions/${payload.subscriptionId}`, undefined, 'GET')) as unknown as {
      id: string;
      status: string;
      customer: string;
      current_period_end: number;
      schedule?: string | null;
      metadata?: Record<string, string>;
      items: { data: Array<{ id: string; price: { id: string }; quantity?: number }> };
    };
    if (sub.status !== 'active') throw new Error(`subscription not active: ${sub.status}`);

    // 現在の全discount（併用割引+付与済みキャンペーンクーポン等）。combo系は付け替え、それ以外は保持する。
    // once（1回限りクーポン）は差額invoiceに食われて価値ゼロで消滅しうるため、
    // 変更時に一旦外し、変更完了後に付け直して次回請求で効かせる
    const currentDiscounts = await getSubDiscounts(env.STRIPE_SECRET_KEY, sub.id);
    const keepDiscounts = currentDiscounts.filter((d) => !d.couponId.startsWith('combo-'));
    const keepForever = keepDiscounts.filter((d) => d.duration === 'forever');
    const keepOnce = keepDiscounts.filter((d) => d.duration !== 'forever');
    const newComboCouponId = sel.comboAmount > 0 ? await ensureComboCoupon(env.STRIPE_SECRET_KEY, sel.nFull, sel.nSemi) : null;

    // 予約済みの変更（スケジュール）が残っていたら解除してから進める
    if (sub.schedule) {
      try {
        await stripeCall(env.STRIPE_SECRET_KEY, `subscription_schedules/${sub.schedule}/release`, {});
      } catch (e) {
        console.error('[plan-change] schedule release failed:', e);
      }
    }

    // ── ダウングレード: 決済なし。次回更新日に新構成へ切り替わるようスケジュール予約 ──
    if (payload.kind === 'downgrade') {
      const schedule = (await stripeCall(env.STRIPE_SECRET_KEY, 'subscription_schedules', {
        from_subscription: sub.id,
      })) as unknown as { id: string; phases: Array<{ start_date: number; end_date: number }> };

      const params: Record<string, string> = { end_behavior: 'release' };
      // phase0 = 現契約を期末までそのまま維持
      params['phases[0][start_date]'] = String(schedule.phases[0].start_date);
      params['phases[0][end_date]'] = String(schedule.phases[0].end_date);
      sub.items.data.forEach((it, i) => {
        params[`phases[0][items][${i}][price]`] = it.price.id;
        params[`phases[0][items][${i}][quantity]`] = String(it.quantity ?? 1);
      });
      // phase1 = 次回更新日から新構成（1サイクル後にreleaseされ通常のサブスクに戻る）
      newItems.forEach((it, i) => {
        params[`phases[1][items][${i}][price]`] = it.price;
        params[`phases[1][items][${i}][quantity]`] = String(it.quantity);
      });
      // iterations は Stripe API 2025-09-30.clover で廃止 (STRIPE_STACK_VERSION は
      // それ以降を指定しているため使用不可)。duration = 1ヶ月 = 旧 iterations:1 相当
      params['phases[1][duration][interval]'] = 'month';
      params['phases[1][proration_behavior]'] = 'none';
      // discounts（新版・スタック対応）: phase0は現状維持、phase1は新combo+保持クーポン
      currentDiscounts.forEach((d, i) => {
        if (d.couponId) params[`phases[0][discounts][${i}][coupon]`] = d.couponId;
      });
      let dj = 0;
      if (newComboCouponId) params[`phases[1][discounts][${dj++}][coupon]`] = newComboCouponId;
      for (const d of keepDiscounts) {
        if (d.couponId) params[`phases[1][discounts][${dj++}][coupon]`] = d.couponId;
      }
      // phase1開始時にsubscription metadataがこの内容に置き換わる（invoice webhookが同期に使う）
      const meta: Record<string, string> = {
        source: 'plan-builder',
        packages: (payload.packages ?? []).join(','),
        features: (payload.features ?? []).join(','),
        multiChannelSites: (payload.multiChannelSites ?? []).join('/'),
        lineUserId,
      };
      if (sub.metadata?.migratedFrom) meta.migratedFrom = sub.metadata.migratedFrom;
      for (const [k, v] of Object.entries(meta)) params[`phases[1][metadata][${k}]`] = v;

      await stripeCall(env.STRIPE_SECRET_KEY, `subscription_schedules/${schedule.id}`, params, 'POST', STRIPE_STACK_VERSION);
      await db.prepare('UPDATE plan_builder_intents SET used_at = ? WHERE id = ?').bind(jstNow(), code).run();

      const effText = payload.effectiveDate
        ? new Date(payload.effectiveDate * 1000 + 9 * 3600000).toISOString().slice(5, 10).replace('-', '/')
        : '次回更新日';
      await lineClient.replyMessage(replyToken, [
        {
          type: 'flex',
          altText: 'プラン変更を予約しました',
          contents: {
            type: 'bubble',
            body: {
              type: 'box',
              layout: 'vertical',
              spacing: 'md',
              contents: [
                { type: 'text', text: '✅ プラン変更を予約しました！', weight: 'bold', size: 'md', wrap: true, color: '#f27d0c' },
                { type: 'separator' },
                { type: 'text', text: `【${effText} からの新しいプラン内容】`, weight: 'bold', size: 'sm', wrap: true },
                ...sel.summaryLines.map((line) => ({ type: 'text', text: line, size: 'sm', color: '#555555', wrap: true })),
                { type: 'text', text: `新しい月額合計 ${sel.total.toLocaleString('ja-JP')}円（税抜）`, weight: 'bold', size: 'sm', wrap: true },
                { type: 'separator' },
                {
                  type: 'text',
                  text: `本日のお支払いはありません。次回更新日（${effText}）までは現在のプランをそのままご利用いただけ、更新日から自動的に新しいプラン・新しい月額に切り替わります。切り替わり時にキーコードが新しくなるため、更新日に新しいキーコードをLINEでお送りします。`,
                  size: 'xs',
                  color: '#888888',
                  wrap: true,
                },
              ],
            },
          },
        } as never,
      ]);
      return;
    }

    const params: Record<string, string> = {
      proration_behavior: 'always_invoice',
      proration_date: String(payload.prorationDate),
    };
    sub.items.data.forEach((it, i) => {
      params[`items[${i}][id]`] = it.id;
      params[`items[${i}][deleted]`] = 'true';
    });
    newItems.forEach((it, i) => {
      const idx = sub.items.data.length + i;
      params[`items[${idx}][price]`] = it.price;
      params[`items[${idx}][quantity]`] = String(it.quantity);
    });
    // 併用割引の付け替え + forever系キャンペーンクーポンの保持（新版discounts・スタック対応）。
    // 旧版のcoupon=は既存スタックを全消去するため使用禁止。once系はここでは外す（差額invoice保護）
    let di = 0;
    for (const d of keepForever) params[`discounts[${di++}][discount]`] = d.discountId;
    if (newComboCouponId) params[`discounts[${di++}][coupon]`] = newComboCouponId;
    if (di === 0) params['discounts'] = ''; // combo無し・保持も無し → 全解除（旧comboを外す）
    params['metadata[source]'] = 'plan-builder';
    params['metadata[packages]'] = (payload.packages ?? []).join(',');
    params['metadata[features]'] = (payload.features ?? []).join(',');
    params['metadata[multiChannelSites]'] = (payload.multiChannelSites ?? []).join('/');
    params['metadata[lineUserId]'] = lineUserId;
    await stripeCall(env.STRIPE_SECRET_KEY, `subscriptions/${sub.id}`, params, 'POST', STRIPE_STACK_VERSION);

    // once系クーポンを付け直す（差額invoiceには効かせず、次回請求で満額効かせる）
    if (keepOnce.length > 0) {
      try {
        const after = await getSubDiscounts(env.STRIPE_SECRET_KEY, sub.id);
        const reParams: Record<string, string> = {};
        let ri = 0;
        for (const d of after) reParams[`discounts[${ri++}][discount]`] = d.discountId;
        for (const d of keepOnce) {
          if (d.couponId) reParams[`discounts[${ri++}][coupon]`] = d.couponId;
        }
        await stripeCall(env.STRIPE_SECRET_KEY, `subscriptions/${sub.id}`, reParams, 'POST', STRIPE_STACK_VERSION);
      } catch (e) {
        console.error('[plan-change] once coupon re-attach failed:', e);
      }
    }

    await db.prepare('UPDATE plan_builder_intents SET used_at = ? WHERE id = ?').bind(jstNow(), code).run();

    // スプシ同期を即時実行（プラン構成変更→キーコード再発行を含む）。
    // 数秒後のinvoice webhookでも同じ同期が走るが、ラベル一致のためキーコードは安定（冪等）
    let newKeyCode = '';
    let keyCodeIssued = false;
    if (env.GAS_DEPLOY_ID) {
      try {
        const { gasPost } = await import('./gas-client.js');
        const sync = (await gasPost(env.GAS_DEPLOY_ID, {
          method: 'syncFeaturesFromSubscription',
          lineUserId,
          stripeCustomerID: sub.customer,
          packages: (payload.packages ?? []).join(','),
          features: (payload.features ?? []).join(','),
          multiChannelSites: (payload.multiChannelSites ?? []).join('/'),
          subscriptionId: sub.id,
          grantPremiumTickets: false, // チケット付与はinvoice webhook側で行う（二重付与防止）
        })) as { success?: boolean; keyCode?: string; keyCodeIssued?: boolean };
        newKeyCode = sync?.keyCode ?? '';
        keyCodeIssued = sync?.keyCodeIssued === true;
      } catch (e) {
        console.error('[plan-change] syncFeatures failed:', e);
      }
    }

    const messages: unknown[] = [
      {
        type: 'flex',
        altText: 'プラン変更が完了しました',
        contents: {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: [
              { type: 'text', text: '✅ プラン変更が完了しました！', weight: 'bold', size: 'md', wrap: true, color: '#f27d0c' },
              { type: 'separator' },
              { type: 'text', text: '【新しいプラン内容】', weight: 'bold', size: 'sm' },
              ...sel.summaryLines.map((line) => ({ type: 'text', text: line, size: 'sm', color: '#555555', wrap: true })),
              { type: 'text', text: `新しい月額合計 ${sel.total.toLocaleString('ja-JP')}円（税抜）`, weight: 'bold', size: 'sm', wrap: true },
              { type: 'separator' },
              {
                type: 'text',
                text: `本日、残り期間の日割り差額 ${payload.amountDueNow.toLocaleString('ja-JP')}円（税込）をご登録のカードに請求いたします。次回更新日からは新しい月額でのご請求となります。請求日は変わりません。`,
                size: 'xs',
                color: '#888888',
                wrap: true,
              },
            ],
          },
        },
      },
    ];
    if (keyCodeIssued && newKeyCode) {
      // キーコードは単独メッセージで送る（LINE はメッセージ単位でしかコピーできないため、
      // 長文に混ぜるとユーザーがコピーしづらい）
      messages.push({
        type: 'text',
        text: `🔑 プラン変更に伴い、キーコードが新しくなりました。\n\n次のメッセージでお送りするキーコードをコピーして、拡張機能のキーコード欄に入力し直してご利用ください。`,
      });
      messages.push({ type: 'text', text: newKeyCode });
    }
    await lineClient.replyMessage(replyToken, messages as never[]);
  } catch (err) {
    console.error('[plan-change] error:', err);
    try {
      await lineClient.replyMessage(replyToken, [
        {
          type: 'text',
          text: 'プラン変更内容の確認に失敗しました。お手数ですが、リッチメニューの「プラン確認」からもう一度お手続きください。',
        } as never,
      ]);
    } catch (e) {
      console.error('[plan-change] error reply failed:', e);
    }
  }
}
