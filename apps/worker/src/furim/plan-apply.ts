import type { LineClient } from '@line-crm/line-sdk';
import { jstNow } from '@line-crm/db';
import { createPlanBuilderCheckout, type PlanCheckoutEnv } from '../routes/plan-builder.js';

// LIFFの申込ボタン→liff.sendMessagesで届く「【プラン申し込み】PB-XXXXXX」を処理する。
// コードで plan_builder_intents から選択内容を引き、Checkoutリンク（12時間有効）を
// ボタン入りFlexで返信する。
export async function handlePlanApplyMessage(
  db: D1Database,
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string,
  text: string,
  env: PlanCheckoutEnv,
): Promise<void> {
  try {
    const m = text.match(/PB-[A-Z0-9]{6}/);
    if (!m) throw new Error('申込コードがメッセージに見つかりません');
    const code = m[0];

    const row = await db
      .prepare('SELECT payload FROM plan_builder_intents WHERE id = ? AND line_user_id = ?')
      .bind(code, lineUserId)
      .first<{ payload: string }>();
    if (!row) throw new Error(`intent not found: ${code}`);

    const payload = JSON.parse(row.payload) as {
      packages: string[];
      features: string[];
      multiChannelSites: string[];
    };

    // 二重課金ガード: 既にアクティブなサブスクがある場合は新規Checkoutを作らない
    // （既存契約者のintentは【プラン変更】になるため、ここに来るのは古いコードの再送等）
    const { getActiveSubscriptionForLine } = await import('../routes/plan-builder.js');
    const existing = await getActiveSubscriptionForLine(env, lineUserId);
    if (existing) {
      await lineClient.replyMessage(replyToken, [
        {
          type: 'text',
          text: '既にご契約中のプランがあります。プラン内容の変更をご希望の場合は、お手数ですがリッチメニューの「プラン診断」からもう一度お手続きください（差額のみのお支払いでプラン変更できます）。',
        } as never,
      ]);
      return;
    }

    const result = await createPlanBuilderCheckout(env, { ...payload, lineUserId });
    await db.prepare('UPDATE plan_builder_intents SET used_at = ? WHERE id = ?').bind(jstNow(), code).run();

    const totalText = `月額合計 ${result.total.toLocaleString('ja-JP')}円（税抜）`;
    await lineClient.replyMessage(replyToken, [
      {
        type: 'flex',
        altText: 'お申し込みありがとうございます！決済ページのご案内です',
        contents: {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: [
              { type: 'text', text: '📝 お申し込みを受け付けました！', weight: 'bold', size: 'md', wrap: true, color: '#f27d0c' },
              { type: 'separator' },
              { type: 'text', text: '【ご選択内容】', weight: 'bold', size: 'sm' },
              ...result.summaryLines.map((line) => ({ type: 'text', text: line, size: 'sm', color: '#555555', wrap: true })),
              { type: 'text', text: totalText, weight: 'bold', size: 'sm', margin: 'md' },
              { type: 'text', text: '下のボタンから決済ページにお進みください👇', size: 'sm', wrap: true, margin: 'md' },
            ],
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: 'primary',
                height: 'md',
                color: '#f27d0c',
                action: { type: 'uri', label: '決済ページへ進む', uri: result.url },
              },
              {
                type: 'text',
                text: '⚠️ このリンクは発行から12時間有効です。期限が切れた場合は、お手数ですがもう一度メニューの「プラン診断」からお申し込みください。',
                size: 'xxs',
                color: '#999999',
                wrap: true,
              },
            ],
          },
        },
      } as never,
    ]);
  } catch (err) {
    console.error('[plan-apply] error:', err);
    try {
      await lineClient.replyMessage(replyToken, [
        {
          type: 'text',
          text: 'お申し込み内容の確認に失敗しました🙇\nお手数ですが、もう一度メニューの「プラン診断」からお試しください。',
        } as never,
      ]);
    } catch (e) {
      console.error('[plan-apply] fallback reply failed:', e);
    }
  }
}
