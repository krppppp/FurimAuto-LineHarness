import type { LineClient } from '@line-crm/line-sdk';
import { gasGet, gasPost } from './gas-client.js';
import { carouselTemplate, surveyTemplate, copyTicketFlexMessage } from './messages.js';
import { logOutgoing } from '../utils/message-log.js';

export type ButtonActionsEnv = {
  GAS_DEPLOY_ID: string;
  STRIPE_SECRET_KEY?: string;
};

const PLAN_BUILDER_LIFF_URL = 'https://liff.line.me/1661091589-81CpgAs1';

const FEATURE_VIDEOS: Record<string, { url: string; manual: string }> = {
  '値段変更(ワンバイワン)': { url: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E5%80%A4%E6%AE%B5%E5%A4%89%E6%9B%B4.mov', manual: 'https://furimauto.com/howto/#ｍChangePrice' },
  'コメント投稿(ワンバイワン)': { url: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E3%82%B3%E3%83%A1%E3%83%B3%E3%83%88%E6%8A%95%E7%A8%BF.mov', manual: 'https://furimauto.com/howto/#ｍComment' },
  'コメント削除(ワンバイワン)': { url: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E3%82%B3%E3%83%A1%E3%83%B3%E3%83%88%E5%89%8A%E9%99%A4.mov', manual: 'https://furimauto.com/howto/#mCommentDelete' },
  '商品別底値設定(ワンバイワン)': { url: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E5%95%86%E5%93%81%E5%88%A5%E5%BA%95%E5%80%A4%E8%A8%AD%E5%AE%9A.mov', manual: 'https://furimauto.com/howto/#mBottomPrice' },
  'オークション(ワンバイワン)': { url: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E3%82%AA%E3%83%BC%E3%82%AF%E3%82%B7%E3%83%A7%E3%83%B3.mov', manual: 'https://furimauto.com/howto/#mAuction' },
  'バックアップ(ワンバイワン)': { url: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E3%83%8F%E3%82%99%E3%83%83%E3%82%AF%E3%82%A2%E3%83%83%E3%83%95%E3%82%9A.mov', manual: 'https://furimauto.com/howto/#mBackup' },
  '再出品(ワンバイワン)': { url: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E5%86%8D%E5%87%BA%E5%93%81.mov', manual: 'https://furimauto.com/howto/#mRelist' },
  '商品削除(ワンバイワン)': { url: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E5%95%86%E5%93%81%E5%89%8A%E9%99%A4.mov', manual: 'https://furimauto.com/howto/#mDelete' },
  '配送変更(ワンバイワン)': { url: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E9%80%81%E8%BE%93%E5%A4%89%E6%9B%B4.mov', manual: 'https://furimauto.com/howto/#yfChangeShipping' },
  '出品一覧追加情報表示(ビューブースト)': { url: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E5%87%BA%E5%93%81%E4%B8%80%E8%A6%A7%E8%BF%BD%E5%8A%A0%E6%83%85%E5%A0%B1%E8%A1%A8%E7%A4%BA.mov', manual: 'https://furimauto.com/howto/#mLoadAdditionalInfo' },
  'チェックコントローラー(ビューブースト)': { url: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E3%83%81%E3%82%A7%E3%83%83%E3%82%AF%E3%83%9B%E3%82%99%E3%83%83%E3%82%AF%E3%82%B9%E3%82%B3%E3%83%B3%E3%83%88%E3%83%AD%E3%83%BC%E3%83%A9%E3%83%BC.mov', manual: 'https://furimauto.com/howto/#mAttributeCheckbox' },
  'ショップ調査機能(ビューブースト)': { url: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E3%82%B7%E3%83%A7%E3%83%83%E3%83%95%E3%82%9A%E8%AA%BF%E6%9F%BB.mov', manual: 'https://furimauto.com/howto/#mProfileOptions' },
  '自動化処理予約機能(ワークフロー)': { url: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E8%87%AA%E5%8B%95%E5%8C%96%E5%87%A6%E7%90%86%E4%BA%88%E7%B4%84.mov', manual: 'https://furimauto.com/howto/#mTimeReservation' },
  '自動いいね対応機能(ワークフロー)': { url: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E8%87%AA%E5%8B%95%E3%81%84%E3%81%84%E3%81%AD%E5%AF%BE%E5%BF%9C.mov', manual: 'https://furimauto.com/howto/#mAutoComment' },
  '自動取引対応機能(ワークフロー)': { url: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E8%87%AA%E5%8B%95%E5%8F%96%E5%BC%95%E5%AF%BE%E5%BF%9C.mov', manual: 'https://furimauto.com/howto/#mAutoTransaction' },
  '売上表CSV出力機能(ワークフロー)': { url: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E5%A3%B2%E4%B8%8ACSV%E5%87%BA%E5%8A%9B.mov', manual: 'https://furimauto.com/howto/#mCSV' },
  'メルカリToラクマコピー出品機能(コピー出品チケット)': { url: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E3%83%A1%E3%83%AB%E3%82%AB%E3%83%AATo%E3%83%A9%E3%82%AF%E3%83%9E%E3%82%B3%E3%83%92%E3%82%9A%E3%83%BC%E5%87%BA%E5%93%81.mov', manual: 'https://furimauto.com/howto/#mCopyToRakuma' },
};

async function getCurrentSegment(db: D1Database, friendId: string): Promise<number | null> {
  for (let seg = 8; seg >= 1; seg--) {
    const tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(`セグメント${seg}`).first<{ id: string }>();
    if (!tag) continue;
    const has = await db.prepare('SELECT 1 FROM friend_tags WHERE friend_id = ? AND tag_id = ?').bind(friendId, tag.id).first();
    if (has) return seg;
  }
  return null;
}

async function switchSegmentTag(db: D1Database, friendId: string, newSeg: number): Promise<void> {
  for (const name of ['セグメント1', 'セグメント2', 'セグメント3', 'セグメント4', 'セグメント5', 'セグメント6', 'セグメント7', 'セグメント8']) {
    const t = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(name).first<{ id: string }>();
    if (t) await db.prepare('DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ?').bind(friendId, t.id).run();
  }
  const newTag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(`セグメント${newSeg}`).first<{ id: string }>();
  if (newTag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, datetime("now", "+9 hours"))').bind(friendId, newTag.id).run();
}

export async function handleButtonAction(
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string,
  rawText: string,
  env: ButtonActionsEnv,
  db?: D1Database,
): Promise<boolean> {
  if (!rawText.includes('【ボタン】')) return false;
  const text = rawText.replace('【ボタン】', '');

  if (text.includes('チケット購入')) {
    const match = text.match(/チケット購入\s*(\d+)/);
    const ticketCount = match ? parseInt(match[1], 10) : 0;
    const data = await gasGet(env.GAS_DEPLOY_ID, { method: 'getTicketCheckoutUrl', message: text, lineUserId, ticketCount: String(ticketCount) }) as Record<string, string>;
    if (data.error) {
      await lineClient.replyMessage(replyToken, [{ type: 'text', text: data.error } as never]);
    } else {
      await lineClient.replyMessage(replyToken, [{
        type: 'imagemap',
        baseUrl: 'https://storage.googleapis.com/furimauto_line/images/checkout_image',
        altText: 'チケット決済ページURL含む画像',
        baseSize: { width: 1040, height: 1040 },
        actions: [{ type: 'uri', linkUri: data.checkoutURL, area: { x: 0, y: 0, width: 1040, height: 1040 } }],
      } as never]);
    }
    return true;
  }

  if (text.includes('アンケート開始')) {
    await lineClient.replyMessage(replyToken, [surveyTemplate as never]);
    return true;
  }

  if (text.includes('アンケート回答')) {
    const surveyResult = text.split(':')[1];
    const messages: unknown[] = [
      { type: 'text', text: `📣ご対応ありがとうございます！\n\nキーコードの準備ができましたので、\nリッチメニューの「キーコード発行」をタップしてください👇\n\n使い方は簡単3ステップ！\n①キーコードを発行\n②PCブラウザにFurimAutoを導入\n③キーコードを入力する\nだけ！✋\n\n初回の導入方法は下の1分動画を参考に最短3分で導入してみてください♪` },
      { type: 'video', originalContentUrl: 'https://storage.googleapis.com/furimauto_line/video/meet.mp4', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png', trackingId: 'setup' },
      { type: 'text', text: `📣使い方や設定方法について\n\n💡無料の1週間で全機能フル活用!\n💡全自動化運用を実現して欲しい!\n💡理解することで必ず大きな効果がでます!\n\nリッチメニューの"Youtube動画講座"から\nFurimAutoの基礎から応用まで\n全ての機能を解説しています！\n\n------------------------------------------------------------------------\n\n実際に使う際の細かい設定方法は\n"利用方法説明書"や"簡単解説1分動画"\nを参考にしてください☀️` },
      {
        type: 'flex',
        altText: '1分解説シリーズ',
        contents: {
          type: 'bubble',
          hero: { type: 'image', url: 'https://img.youtube.com/vi/FY8GUB-CoaY/maxresdefault.jpg', size: 'full', aspectRatio: '16:9', aspectMode: 'cover', action: { type: 'uri', uri: 'https://www.youtube.com/watch?v=FY8GUB-CoaY' } },
          body: {
            type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: '1分解説シリーズ', weight: 'bold', size: 'xl', wrap: true },
              { type: 'text', text: 'FurimAutoのコンセプトは\n\n🙌簡単・シンプル・時短🙌\nこの3つ!!\n\nYoutubeには入門編から通して観る事で\n自動化の全てがわかる動画集をアップしています。\n\n倍速で見れば10分で見終わりますよ!!\n(最大半額クーポン付き💰)', size: 'sm', color: '#666666', margin: 'md', wrap: true },
            ],
          },
        },
      },
    ];
    await lineClient.replyMessage(replyToken, messages as never[]);
    const referralPushText = `📣お友達からの紹介で登録してくれたお客様へ\n\nFurimAutoへようこそ🙇\n\nご紹介いただいたお友達から紹介コードをいただいていましたらこのLINEトークルームにコピペしてお送りください！\n\n以下のようにカッコで囲まれたテキストを何もいじることなく\n'そのまま'コピーして送信してください！\n\n【キーワード】友達紹介コード:XXXXXXXXXXXX\n\nそれだけで\n✅無料期間は2週間に延長\n✅初回月額料金半額クーポン付与`;
    if (surveyResult === '紹介') {
      await lineClient.pushMessage(lineUserId, [{ type: 'text', text: referralPushText } as never]);
    }
    await gasPost(env.GAS_DEPLOY_ID, { method: 'setSurveyResult', lineUserId, surveyResult });

    // セグメント2 へ昇格（アンケート回答済み）
    if (db) {
      const friend = await db.prepare('SELECT id FROM friends WHERE line_user_id = ?').bind(lineUserId).first<{ id: string }>();
      if (friend) {
        await switchSegmentTag(db, friend.id, 2);
        if (surveyResult === '紹介') await logOutgoing(db, friend.id, 'text', referralPushText);
      }
    }
    return true;
  }

  // 解約理由アンケート（月額解約フローのFlexから）: タグで記録し、理由に応じて再開提案を返す
  if (text.includes('解約理由:')) {
    const reason = text.split(':')[1] ?? '';
    if (db && reason) {
      const friend = await db.prepare('SELECT id FROM friends WHERE line_user_id = ?').bind(lineUserId).first<{ id: string }>();
      if (friend) {
        const tagName = `解約理由:${reason}`;
        let tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(tagName).first<{ id: string }>();
        if (!tag) {
          await db.prepare('INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)').bind(crypto.randomUUID(), tagName).run();
          tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(tagName).first<{ id: string }>();
        }
        if (tag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, datetime("now", "+9 hours"))').bind(friend.id, tag.id).run();
      }
    }
    const thanks = 'ご回答ありがとうございます🙇\n今後のサービス改善に活用させていただきます。';
    if (reason === '物販休止' || reason === '他ツールへ乗り換え') {
      await lineClient.replyMessage(replyToken, [
        { type: 'text', text: `${thanks}\n\nまた物販を再開される際は、いつでもこのLINEからお待ちしております！` } as never,
      ]);
    } else {
      await lineClient.replyMessage(replyToken, [
        { type: 'text', text: thanks } as never,
        { type: 'text', text: `💡【機能を絞って安く続ける選択肢も】\n\nFurimAutoは必要な機能だけを選べるビュッフェ式です🍽\nよく使う機能1つだけなら月980円(税抜)から再開できます。\n\n▼ 料金シミュレーション＆お申し込み ▼\n${PLAN_BUILDER_LIFF_URL}` } as never,
      ]);
    }
    return true;
  }

  if (text === 'お友達向け説明書の発行') {
    await lineClient.replyMessage(replyToken, [{ type: 'image', originalContentUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/introduction.png', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/introduction.png' } as never]);
    return true;
  }

  if (text.includes('(料金表)')) {
    switch (text) {
      case '概要(料金表)':
        await lineClient.replyMessage(replyToken, [
          { type: 'image', originalContentUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/about_price.png', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/about_price.png' } as never,
          { type: 'text', text: '🔵ビュッフェ式プランについて\n\n当社が独自に考えた形式です。\n機能ごとに単品価格が設定されており、必要な機能を1つ単位で選択することが可能です。\n\nコメント投稿とコメント削除だけ出来ればいい、というお客様の場合は\n980円＋980円＝1960円(税抜)が月額利用料となります。\n\n詳しい料金表は\nビュッフェ式料金表(料金表)\nをタップしてください🎵' } as never,
          { type: 'text', text: '🔴パッケージプランについて\n\nハンバーガーをセットで頼むと単品で頼むよりお得になるのと同じように\nある程度の機能をひとまとまりのパッケージとして提供しています。\n\n基本プランは3980円(税抜)からとなっております。\n\n詳しくは\nパッケージプラン(料金表)\nをタップしてください🎵' } as never,
          carouselTemplate as never,
        ]);
        break;
      case 'ビュッフェ式料金表(料金表)':
        await lineClient.replyMessage(replyToken, [{ type: 'image', originalContentUrl: 'https://furimauto.com/service/images/plan_buffet_sp.png', previewImageUrl: 'https://furimauto.com/service/images/plan_buffet_sp.png' } as never]);
        break;
      case 'パッケージプラン(料金表)':
        await lineClient.replyMessage(replyToken, [
          { type: 'image', originalContentUrl: 'https://furimauto.com/service/images/plan_package_sp1.png', previewImageUrl: 'https://furimauto.com/service/images/plan_package_sp1.png' } as never,
          { type: 'image', originalContentUrl: 'https://furimauto.com/service/images/plan_package_sp2.png', previewImageUrl: 'https://furimauto.com/service/images/plan_package_sp2.png' } as never,
          { type: 'image', originalContentUrl: 'https://furimauto.com/service/images/plan_package_sp3.png', previewImageUrl: 'https://furimauto.com/service/images/plan_package_sp3.png' } as never,
          { type: 'image', originalContentUrl: 'https://furimauto.com/service/images/plan_package_sp4.png', previewImageUrl: 'https://furimauto.com/service/images/plan_package_sp4.png' } as never,
          carouselTemplate as never,
        ]);
        break;
    }
    return true;
  }

  if (text.includes('カード払い')) {
    await lineClient.replyMessage(replyToken, [{ type: 'text', text: `ありがとうございます。\n\nhttps://buy.stripe.com/3cI00jfiy0o70P7fHCeIw05\n☝️3万円アソートの初回注文の方はこちら\n\n👇3万円アソートリピート(送料2000円含)はこちら\nhttps://buy.stripe.com/28EbJ15HY7Qz55n0MIeIw08\n\n📢上記以外のご注文の場合は弊社から後ほどご連絡させていただきますのでお待ちくださいm(_ _)m\n\n・ご希望数量\n・お名前\n・お届け先住所\n・メールアドレスと電話番号\n・カード情報\nを入力してお手続きをよろしくお願いいたしますm(_ _)m` } as never]);
    return true;
  }

  if (text.includes('銀行振込')) {
    await lineClient.replyMessage(replyToken, [{ type: 'text', text: `ありがとうございます。\n\nお手数ですが、\n・ご希望数量\n・お名前\n・お届け先住所\n・電話番号\nをお送りください。\n\n送料を含めた最終金額を算定してお知らせさせていただきます。\n\n--------------------------------\n\n振込先情報\nGMO あおぞらネット銀行\n法人第2営業部支店\n普通\n1426354\nド）ティーフォー` } as never]);
    return true;
  }

  if (text.includes('[簡単解説1分動画]')) {
    const featureName = text.split(']')[1];
    const feature = FEATURE_VIDEOS[featureName];
    if (!feature) {
      await lineClient.replyMessage(replyToken, [{ type: 'text', text: '現在急ピッチで準備中です！' } as never]);
      return true;
    }
    await lineClient.replyMessage(replyToken, [
      { type: 'text', text: `${featureName}の説明書はこちらです。\nURL: ${feature.manual}` } as never,
      { type: 'video', originalContentUrl: feature.url, previewImageUrl: 'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png' } as never,
    ]);
    return true;
  }

  if (text.includes('コピー出品チケット30枚GET')) {
    await gasPost(env.GAS_DEPLOY_ID, { method: 'setFree30CopyTickets', lineUserId });
    if (db) {
      const friend = await db.prepare('SELECT id FROM friends WHERE line_user_id = ?').bind(lineUserId).first<{ id: string }>();
      if (friend) {
        const currentSeg = await getCurrentSegment(db, friend.id);
        if (currentSeg !== null && currentSeg >= 5) await switchSegmentTag(db, friend.id, 6);
      }
    }
    await lineClient.replyMessage(replyToken, [
      { type: 'text', text: `タップありがとうございます。\n\nコピー出品チケット\n30枚プレゼントいたしました！\n(通算1回のみ有効です。2回目以降は無効となっております。)\n\n一度キーコードの入力ボタンを押して\nOKになったら、以下の動画を参考にコピー出品してみてください！` } as never,
      { type: 'video', originalContentUrl: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E3%83%A1%E3%83%AB%E3%82%AB%E3%83%AATo%E3%83%A9%E3%82%AF%E3%83%9E%E3%82%B3%E3%83%92%E3%82%9A%E3%83%BC%E5%87%BA%E5%93%81.mp4', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png' } as never,
      { type: 'text', text: 'メルカリToラクマコピー出品機能の説明書はこちらです。\nURL: https://furimauto.com/howto/#mCopyRakumaListing' } as never,
    ]);
    return true;
  }

  if (text.includes('アソート注文')) {
    await lineClient.replyMessage(replyToken, [
      { type: 'text', text: `-----------------------\n\n💰 お支払い方法\n* 銀行振込もしくはカード払いとなります\n\n🗒️ご注文について\n* 1箱あたり3万円+消費税となります\n* 複数発注大歓迎です!!\n* 初回1箱分は送料無料でお届けいたします！\n* 送料が発生する分については1箱あたり2000円均一を加算して請求させていただきます\n\n🚚発送について\n* 佐川急便にて発送\n* 日曜・即日以外が発送日\n\n-----------------------\n\n👇 ご希望の方は下記からお支払い方法を選択下さい。` } as never,
      {
        type: 'flex',
        altText: '支払い方法を選択してください',
        contents: {
          type: 'bubble',
          body: {
            type: 'box', layout: 'vertical', contents: [
              { type: 'text', text: 'お支払い方法を選択してください', weight: 'bold', size: 'md', margin: 'md', align: 'center' },
              { type: 'box', layout: 'vertical', margin: 'xl', spacing: 'sm', contents: [
                { type: 'button', action: { type: 'message', label: '銀行振込', text: '【ボタン】銀行振込' }, style: 'primary' },
                { type: 'button', action: { type: 'message', label: 'カード払い', text: '【ボタン】カード払い' }, style: 'primary' },
              ]},
            ],
          },
        },
      } as never,
    ]);
    return true;
  }

  if (text.includes('追加サポート')) {
    await lineClient.replyMessage(replyToken, [{ type: 'text', text: 'かしこまりました。\n近日、AIとのやりとりを確認した上で担当者からサポートさせていただきます🙇' } as never]);
    return true;
  }

  // 在庫管理シート無料プロモ: フラグ(InventorySheet)をTRUE・自動削除巡回(AutoMultiChannel)を全サイトに設定。
  // 該当ユーザーのマスターシート行を GAS が書き換える。拡張は次回 getKeyCodeSet 取得で有効判定する。
  if (text.includes('在庫管理シート無料お試し')) {
    await gasPost(env.GAS_DEPLOY_ID, { method: 'enableInventorySheet', lineUserId });
    // 手順①のバージョン更新を最初に置く: 旧バージョン(4.2.1以前)のままシートを作成すると
    // 旧型シートが生成されるため（4.2.2側に後付けマイグレーションはあるが）、
    // 先に更新へ誘導して新形式で作らせる（2026-08-17 くろさん指示）
    await lineClient.replyMessage(replyToken, [{
      type: 'text',
      text: '✅在庫管理シートを有効化しました！\n\nメルカリ・ラクマ・Shops・ヤフオク・ヤフフリの在庫を1枚のスプレッドシートでまとめて管理し、売れたら他サイトの出品を自動でお知らせ・削除できます📦\n\n【使い始め方】\n① FurimAuto拡張機能を最新版（v4.2.2以降）へ更新する\n更新方法: https://furimauto.com/howto/#checkVersion\n\n② キーコード入力画面にてバージョンが4.2.2であることを確認して、入力ボタンを一度押して成功になるまでそのまま待つ\n\n③ 出品一覧ページを一度更新してみると、新たに緑色の「在庫管理シートを作成」ボタンが現れる\n\n④ 説明書に沿ってセットアップする\nhttps://furimauto.com/howto/index.html#inventorySheet\n\nうまく表示されない時は一度拡張を開き直してキーコードを再取得してみてください🙏',
    } as never]);
    return true;
  }

  // 掘り起こしキャンペーン: 期間限定の全機能無料開放を付与する（1キャンペーンにつき1回きり）。
  // 期限はキャンペーン終了日時（押した時点からのN日ではない）・キーコード刷新・端末判定文字列のクリア・
  // 全機能開放は GAS 側（grantOneWeekTrial / TRIAL_PROMOS）で行う。
  // 有料会員はキーコード刷新が不利益になるため GAS が付与せず reason=paid を返す
  if (text.includes('1週間無料プレゼント') || text.includes('無料開放プレゼント')) {
    const result = await gasPost(env.GAS_DEPLOY_ID, { method: 'grantOneWeekTrial', lineUserId }) as Record<string, string>;
    const messages: unknown[] = [];
    if (result && result.success) {
      messages.push({
        type: 'text',
        text: `🎁無料開放を適用しました！\n\n${result.expiry ? `ご利用期限: ${result.expiry} まで\n\n` : ''}期限までの間、フリマサイト自動化・自動コピー出品・自動併売在庫管理のすべてをお使いいただけます。\n\n早く始めるほど長く使えますので、今日から動かしてみてください！\n\n導入方法はこちらの1分動画を参考にしてください！\n\nうまくいかないときは、このLINEにそのままご返信ください🙇`,
      });
      messages.push({
        type: 'video',
        originalContentUrl: 'https://storage.googleapis.com/furimauto_line/video/install.mp4',
        previewImageUrl: 'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png',
        trackingId: 'oneWeekTrial',
      });
    } else if (result && result.reason === 'already') {
      messages.push({ type: 'text', text: '🙇こちらのプレゼントは、お一人さま1回のみ有効です。\n\n既にお受け取りいただいているため、今回は付与されませんでした。\n\n引き続きご利用いただく場合は、必要な機能だけを選べるビュッフェ式プラン（月980円税抜〜）もご用意しています。\n\n▼ 料金シミュレーション＆お申し込み ▼\n' + PLAN_BUILDER_LIFF_URL });
    } else if (result && result.reason === 'expired') {
      messages.push({ type: 'text', text: '🙇このキャンペーンは終了しました。\n\n次回のご案内をお待ちください。お急ぎの場合は、必要な機能だけを選べるビュッフェ式プラン（月980円税抜〜）からご利用いただけます。\n\n▼ 料金シミュレーション＆お申し込み ▼\n' + PLAN_BUILDER_LIFF_URL });
    } else if (result && result.reason === 'paid') {
      messages.push({ type: 'text', text: '✅現在ご契約中のプランで、既に各機能をご利用いただける状態です。\n\nこのプレゼントは、ご契約のない方の再開用としてご用意しているものです。キーコードや契約内容はそのままにしてあります。\n\nご不明点があればこのLINEにそのままご返信ください🙇' });
    } else {
      messages.push({ type: 'text', text: '申し訳ございません、付与処理に失敗しました🙇\n\nお手数ですが、このLINEにそのままご返信ください。担当者が確認して付与いたします。' });
    }
    await lineClient.replyMessage(replyToken, messages as never[]);
    return true;
  }

  await lineClient.replyMessage(replyToken, [{ type: 'text', text: '現在急ピッチで準備中です！' } as never]);
  return true;
}
