import type { LineClient } from '@line-crm/line-sdk';
import { gasGet, gasPost } from './gas-client.js';
import { copyTicketFlexMessage } from './messages.js';

export type KeywordActionsEnv = {
  GAS_DEPLOY_ID: string;
  STRIPE_SECRET_KEY?: string;
};

export async function handleKeywordAction(
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string,
  rawText: string,
  env: KeywordActionsEnv,
): Promise<boolean> {
  if (!rawText.includes('【キーワード】')) return false;
  const text = rawText.replace('【キーワード】', '');

  if (text.includes('登録URL発行')) {
    const data = await gasGet(env.GAS_DEPLOY_ID, { method: 'getLIFFCheckoutUrl', message: text, lineUserId }) as Record<string, string>;
    await lineClient.replyMessage(replyToken, [{
      type: 'imagemap',
      baseUrl: 'https://storage.googleapis.com/furimauto_line/images/checkout_image',
      altText: '決済ページURL含む画像',
      baseSize: { width: 1040, height: 1040 },
      actions: [{ type: 'uri', linkUri: data.checkoutURL, area: { x: 0, y: 0, width: 1040, height: 1040 } }],
    } as never]);
    return true;
  }

  if (text.includes('キーコードリセット')) {
    await gasGet(env.GAS_DEPLOY_ID, { method: 'resetKeyCode', lineUserId });
    await lineClient.replyMessage(replyToken, [{ type: 'text', text: '紐づいた設定のリセットが完了しました。' } as never]);
    return true;
  }

  if (text.includes('無料お試し1週間')) {
    const match = text.match(/無料お試し1週間(\d{8})/);
    const expiryDate = match ? match[1] : null;
    const data = await gasPost(env.GAS_DEPLOY_ID, { method: 'setKeyCodeExpiry', lineUserId, expiryDate }) as Record<string, unknown>;
    if (data?.success) {
      await lineClient.replyMessage(replyToken, [
        { type: 'text', text: `🎉【キャンペーン参加完了！】🎉\n\nFurimAutoの全機能を1週間無料でお試しいただけます！\n\nキーコードの準備ができましたので、\nリッチメニューの「キーコード発行」をタップしてください👇\n\n使い方は簡単3ステップ！\n①キーコードを発行\n②PCブラウザにFurimAutoを導入\n③キーコードを入力する\nだけ！✋\n\n初回の導入方法は下の1分動画を参考に最短3分で導入してみてください♪` } as never,
        { type: 'video', originalContentUrl: 'https://storage.googleapis.com/furimauto_line/video/install.mp4', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png', trackingId: 'setup' } as never,
        { type: 'text', text: `📣使い方や設定方法について\n\n💡無料の1週間で全機能フル活用!\n💡全自動化運用を実現して欲しい!\n💡理解することで必ず大きな効果がでます!\n\nリッチメニューの"Youtube動画講座"から\nFurimAutoの基礎から応用まで\n全ての機能を解説しています！` } as never,
        copyTicketFlexMessage() as never,
      ]);
    } else {
      await lineClient.replyMessage(replyToken, [{ type: 'text', text: `申し訳ございません。\nこのキャンペーンを既にご利用いただいているか、\nすでに終了いたしました。` } as never]);
    }
    return true;
  }

  if (text.includes('友達紹介コード:')) {
    const match = text.match(/友達紹介コード:(\w+)/);
    if (!match) {
      await lineClient.replyMessage(replyToken, [{ type: 'text', text: `友達紹介コードが有効ではないようです。\n確認後、弊アカウントからご連絡差し上げます。` } as never]);
      return true;
    }
    const ambassadorCode = match[1];
    const data = await gasGet(env.GAS_DEPLOY_ID, { method: 'stackLINEIntroductionInfo', lineUserId, ambassadorCode }) as Record<string, string>;

    if (!data?.introducedCouponID || !env.STRIPE_SECRET_KEY) {
      await lineClient.replyMessage(replyToken, [{ type: 'text', text: `友達紹介コードが有効ではないようです。\n確認後、弊アカウントからご連絡差し上げます。` } as never]);
      return true;
    }

    await fetch(`https://api.stripe.com/v1/customers/${data.introducedStripeID}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ coupon: data.introducedCouponID, 'metadata[ambassadorStripeID]': data.ambassadorStripeID, 'metadata[isIntroduced]': 'true', 'metadata[isFirstSubscription]': 'true' }).toString(),
    });

    await lineClient.replyMessage(replyToken, [{ type: 'text', text: `友達紹介コードの確認が取れました😆\n\n無料試用期間を1週間追加して、友達登録から2週間ご利用いただけます。\n\n更に月額プランにご登録の際に、初月の利用料が半額になるクーポンを付与させていただきました♪\n\nそれではキーコードを発行して、2週間存分に使いまわして売り上げUPさせてください⭐️` } as never]);

    let pushText = `【お友達の${data.introducedLineDisplayName}様があなたの友達紹介コードを入力しました】\n\n`;
    if (data.ambassadorCouponName) {
      const ambassadorRes = await fetch(`https://api.stripe.com/v1/customers/${data.ambassadorStripeID}`, {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      }).then(r => r.json()) as { discount?: unknown };

      if (!ambassadorRes.discount) {
        const updateRes = await gasGet(env.GAS_DEPLOY_ID, { method: 'updateIntroductionCoupon', lineID: data.ambassadorLineID }) as Record<string, string>;
        if (updateRes?.ambassadorCouponID) {
          await fetch(`https://api.stripe.com/v1/customers/${data.ambassadorStripeID}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ coupon: updateRes.ambassadorCouponID }).toString(),
          });
          pushText += `それに伴い${updateRes.ambassadorCouponName}を付与いたしましたので、次回以降のお支払い時に自動で適用されます。\n\nリッチメニューの月額会員ページから、次回の支払額についてクーポン値引きが適用されているのを確認してください。`;
        }
      } else {
        pushText += 'すでに以前のクーポンを次回の支払いに適用しているので、今回分のクーポンは未来の支払いに充当されます。';
      }
    } else {
      pushText += '数多くのご紹介のご協力、誠に感謝いたします。';
    }
    await lineClient.pushMessage(data.ambassadorLineID, [{ type: 'text', text: pushText } as never]);
    return true;
  }

  return false;
}
