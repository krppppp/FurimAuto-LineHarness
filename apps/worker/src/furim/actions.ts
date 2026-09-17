import type { LineClient } from '@line-crm/line-sdk';
import { jstNow } from '@line-crm/db';
import { mirrorCustomerFieldsToGas } from './gas-retry-queue.js';
import { getSentGiftBatches, setSentGiftBatches } from './firebase-client.js';
import { recordBotHandlerError } from './bot-routed-message.js';
import { getFurimCustomer, upsertFurimCustomer, resolveStripeCustomerId, deriveGiftStatus, parseJstDateTime, formatJstDateTime, formatJstIso } from './customer-store.js';
import type { ExtCache } from './ext-auth.js';
import {
  carouselTemplate,
  ticketOrderTemplate,
  copyTicketFlexMessage,
  surveyButton,
} from './messages.js';
import { getOrCreateAmbassadorAffiliate, countReferrals } from './referral-store.js';
import {
  getFriendByLineUserId,
  enrollAffiliateInOffer,
} from '@line-crm/db';

export type FurimActionsEnv = {
  GAS_DEPLOY_ID?: string;
  FIREBASE_DATABASE_URL?: string;
  STRIPE_SECRET_KEY?: string;
  // plan-builder LIFF（プラン診断・申込UI）。未設定時はdevのLIFFにフォールバック
  PLAN_BUILDER_LIFF_URL?: string;
  // アンバサダー紹介URL生成用。WORKER_PUBLIC_URL 優先、無ければ WORKER_URL。
  // FURIM_AMBASSADOR_OFFER_ID 未設定 or base未設定なら手動code方式のみにフォールバック。
  WORKER_URL?: string;
  WORKER_PUBLIC_URL?: string;
  FURIM_AMBASSADOR_OFFER_ID?: string;
};

const PREFIX = '【リッチメニュー】';

// ── 限定特典 定義 ─────────────────────────────────────────────

type PdfItem = { label: string; url: string };
type GiftStatus = {
  hasCompletedSurvey: boolean;
  hasIssuedKeycode: boolean;
  hasActivatedKeycode: boolean;
  hasFree30Ticket: boolean;
  hasYoutubeCoupon: boolean;
  hasExtendKeyword: boolean;
};

const WELCOME_PDFS: PdfItem[] = [
  { label: '① ロードマップ❶', url: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B81%E3%83%AD%E3%83%BC%E3%83%88%E3%82%99%E3%83%9E%E3%83%83%E3%83%95%E3%82%9A%E2%9D%B6.pdf' },
  { label: '② ロードマップ❷', url: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B82%E3%83%AD%E3%83%BC%E3%83%88%E3%82%99%E3%83%9E%E3%83%83%E3%83%95%E3%82%9A%E2%9D%B7.pdf' },
];

const GIFT_BATCHES = [
  {
    batchNo: 1,
    isUnlocked: (s: GiftStatus) => s.hasCompletedSurvey,
    introText: '🎁 アンケートご回答ありがとうございます！\n特典をお届けします📩',
    pdfs: [
      { label: '③ ロードマップ❸', url: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B83%E3%83%AD%E3%83%BC%E3%83%88%E3%82%99%E3%83%9E%E3%83%83%E3%83%95%E3%82%9A%E2%9D%B8.pdf' },
      { label: '④ ロードマップ❹', url: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B84%E3%83%AD%E3%83%BC%E3%83%88%E3%82%99%E3%83%9E%E3%83%83%E3%83%95%E3%82%9A%E2%9D%B9.pdf' },
    ],
    lockedHint: '📝 アンケートにご回答いただくと特典③・④（ロードマップ❸&❹）をプレゼント！\nまだの方はアンケートへのご協力をお願いします🙏',
    buildActionMessages: () => [surveyButton('📝 アンケートに回答して特典③④をGET！')],
    deliveryMessages: undefined as (() => unknown[]) | undefined,
  },
  {
    batchNo: 2,
    isUnlocked: (s: GiftStatus) => s.hasCompletedSurvey && s.hasIssuedKeycode,
    introText: '🎁 キーコード発行ありがとうございます！\n特典をお届けします📩',
    pdfs: [
      { label: '⑤ 撮影方法マニュアル前編', url: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B85%E6%92%AE%E5%BD%B1%E6%96%B9%E6%B3%95%E3%83%9E%E3%83%8B%E3%83%A5%E3%82%A2%E3%83%AB%E5%89%8D%E7%B7%A8.pdf' },
      { label: '⑥ 撮影方法マニュアル後編', url: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B86%E6%92%AE%E5%BD%B1%E6%96%B9%E6%B3%95%E3%83%9E%E3%83%8B%E3%83%A5%E3%82%A2%E3%83%AB%E5%BE%8C%E7%B7%A8.pdf' },
    ],
    lockedHint: '🔑 リッチメニューの「キーコード発行」からキーコードを発行すると特典⑤・⑥（撮影方法マニュアル）をプレゼント！',
    buildActionMessages: () => [
      { type: 'text', text: '📣ご対応ありがとうございます！\n\nキーコードの準備ができましたので、\nリッチメニューの「キーコード発行」をタップしてください👇\n\n使い方は簡単3ステップ！\n①キーコードを発行\n②PCブラウザにFurimAutoを導入\n③キーコードを入力する\nだけ！✋\n\n初回の導入方法は下の1分動画を参考に最短3分で導入してみてください♪' },
      { type: 'video', originalContentUrl: 'https://storage.googleapis.com/furimauto_line/video/install.mp4', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png', trackingId: 'setup' },
    ],
    deliveryMessages: undefined as (() => unknown[]) | undefined,
  },
  {
    batchNo: 3,
    isUnlocked: (s: GiftStatus) => s.hasCompletedSurvey && s.hasIssuedKeycode && s.hasActivatedKeycode,
    introText: '🎁 FurimAutoのご利用開始ありがとうございます！\n特典をお届けします📩',
    pdfs: [
      { label: '⑦ 外注化マニュアル前編', url: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B87%E5%A4%96%E6%B3%A8%E5%8C%96%E3%83%9E%E3%83%8B%E3%83%A5%E3%82%A2%E3%83%AB%E5%89%8D%E7%B7%A8.pdf' },
      { label: '⑧ 外注化マニュアル後編', url: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B88%E5%A4%96%E6%B3%A8%E5%8C%96%E3%83%9E%E3%83%8B%E3%83%A5%E3%82%A2%E3%83%AB%E5%BE%8C%E7%B7%A8.pdf' },
    ],
    lockedHint: '🚀 FurimAutoにキーコードを入力してご利用を開始すると特典⑦・⑧（外注化マニュアル）をプレゼント！\nまずはリッチメニューの「キーコード発行」からどうぞ😊',
    buildActionMessages: () => [
      { type: 'text', text: '📣ご対応ありがとうございます！\n\nキーコードの準備ができましたので、\nリッチメニューの「キーコード発行」をタップしてください👇' },
      { type: 'video', originalContentUrl: 'https://storage.googleapis.com/furimauto_line/video/install.mp4', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png', trackingId: 'setup' },
    ],
    deliveryMessages: undefined as (() => unknown[]) | undefined,
  },
  {
    batchNo: 4,
    isUnlocked: (s: GiftStatus) => s.hasCompletedSurvey && s.hasIssuedKeycode && s.hasActivatedKeycode && s.hasFree30Ticket,
    introText: '🎁 無料チケットをお受け取りいただきありがとうございます！\n特典をお届けします📩',
    pdfs: [
      { label: '⑨ 外注募集テンプレート', url: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B89%E5%A4%96%E6%B3%A8%E5%8B%9F%E9%9B%86%E3%83%86%E3%83%B3%E3%83%95%E3%82%9A%E3%83%AC.pdf' },
      { label: '⑩ 外注先業務委託契約書テンプレ', url: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B810%E5%A4%96%E6%B3%A8%E5%85%88%E6%A5%AD%E5%8B%99%E5%A7%94%E8%A8%97%E5%A5%91%E7%B4%84%E6%9B%B8%E3%83%86%E3%83%B3%E3%83%95%E3%82%9A%E3%83%AC.pdf' },
    ],
    lockedHint: '🎟️ LINEでお届けしている無料30枚チケットを受け取ると特典⑨・⑩（外注テンプレート）をプレゼント！',
    buildActionMessages: () => [copyTicketFlexMessage()],
    deliveryMessages: () => [copyTicketFlexMessage()],
  },
  {
    batchNo: 5,
    isUnlocked: (s: GiftStatus) => s.hasCompletedSurvey && s.hasIssuedKeycode && s.hasActivatedKeycode && s.hasFree30Ticket && s.hasYoutubeCoupon,
    introText: '🎁 YouTube動画のご視聴ありがとうございます！\n特典をお届けします📩',
    pdfs: [
      { label: '⑪ コメントセールの手法と効果の解説', url: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B811%E3%82%B3%E3%83%A1%E3%83%B3%E3%83%88%E3%82%BB%E3%83%BC%E3%83%AB%E3%81%AE%E6%89%8B%E6%B3%95%E3%81%A8%E5%8A%B9%E6%9E%9C%E3%81%AE%E8%A7%A3%E8%AA%AC.pdf' },
    ],
    lockedHint: '🎬 YouTube1分解説シリーズを見てキーワードをLINEに送ると特典⑪（コメントセール解説）をプレゼント！',
    buildActionMessages: () => [
      {
        type: 'flex',
        altText: '1分解説シリーズ',
        contents: {
          type: 'bubble',
          hero: { type: 'image', url: 'https://img.youtube.com/vi/FY8GUB-CoaY/maxresdefault.jpg', size: 'full', aspectRatio: '16:9', aspectMode: 'cover', action: { type: 'uri', uri: 'https://www.youtube.com/watch?v=FY8GUB-CoaY' } },
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'text', text: '1分解説シリーズ', weight: 'bold', size: 'xl', wrap: true },
              { type: 'text', text: 'FurimAutoの全機能を解説した動画シリーズです。倍速で見れば10分で全てわかります！(最大半額クーポン付き💰)', size: 'sm', color: '#666666', margin: 'md', wrap: true },
            ],
          },
        },
      },
    ],
    deliveryMessages: undefined as (() => unknown[]) | undefined,
  },
  {
    batchNo: 6,
    isUnlocked: (s: GiftStatus) => s.hasCompletedSurvey && s.hasIssuedKeycode && s.hasActivatedKeycode && s.hasFree30Ticket && s.hasYoutubeCoupon && s.hasExtendKeyword,
    introText: '🎁🎁 全ての条件達成おめでとうございます！\n最後の特典をお届けします📩',
    pdfs: [
      { label: '⑫ 売れるブランドリスト', url: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B812%E5%A3%B2%E3%82%8C%E3%82%8B%E3%83%95%E3%82%99%E3%83%A9%E3%83%B3%E3%83%88%E3%82%99%E3%83%AA%E3%82%B9%E3%83%88.pdf' },
      { label: '⑬ 売れるアカウント説明&プロフィール解説', url: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B813%E5%A3%B2%E3%82%8C%E3%82%8B%E3%82%A2%E3%82%AB%E3%82%A6%E3%83%B3%E3%83%88%E8%AA%AC%E6%98%8E%26%E3%83%95%E3%82%9A%E3%83%AD%E3%83%95%E3%82%A3%E3%83%BC%E3%83%AB%E8%A7%A3%E8%AA%AC.pdf' },
    ],
    lockedHint: '📺 YouTube長尺動画を見るとキーワードが案内されます。キーワードを送ると特典⑫・⑬（ブランドリスト＆プロフィール解説）をプレゼント！',
    buildActionMessages: () => [
      { type: 'text', text: '📺 FurimAutoの全てがわかる長尺動画を公開中です！\n\nhttps://www.youtube.com/playlist?list=PLUhATsy78sfvUHMVmeQpKMyxATlHOCEeF\n\n動画を最後まで視聴してください！\n動画内で案内されるキーワードをLINEに送ると\n特典⑫・⑬＋無料試用期間延長をプレゼントします🎁' },
    ],
    deliveryMessages: undefined as (() => unknown[]) | undefined,
  },
];

function buildReceivedListFlex(sentBatchNos: number[]) {
  const allPdfs: PdfItem[] = [
    ...WELCOME_PDFS,
    ...GIFT_BATCHES.filter((b) => sentBatchNos.includes(b.batchNo)).flatMap((b) => b.pdfs),
  ];
  const buttons = allPdfs.map((p) => ({
    type: 'button',
    style: 'link',
    height: 'sm',
    action: { type: 'uri', label: p.label, uri: p.url },
  }));
  return {
    type: 'flex',
    altText: '📋 現在受け取り済みの特典一覧',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FF6B35',
        contents: [{ type: 'text', text: '📋 現在受け取り済みの特典一覧', color: '#ffffff', weight: 'bold', size: 'md' }],
      },
      body: { type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: 'md', contents: buttons },
    },
  };
}

// ── メインディスパッチャー ─────────────────────────────────────

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
  if (newTag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)').bind(friendId, newTag.id, jstNow()).run();
}

export async function handleFurimAction(
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string,
  text: string,
  env: ResolvedEnv,
  db?: D1Database,
): Promise<boolean> {
  if (!text.startsWith(PREFIX)) return false;
  if (!env.GAS_DEPLOY_ID) return false;
  const action = text.slice(PREFIX.length);
  const resolvedEnv = env as Required<Pick<FurimActionsEnv, 'GAS_DEPLOY_ID'>> & FurimActionsEnv;

  try {
    switch (action) {
      case 'キーコード発行':
        await actionKeycodeIssue(lineClient, lineUserId, replyToken, resolvedEnv, db);
        return true;
      case 'チケット注文':
        await lineClient.replyMessage(replyToken, [ticketOrderTemplate as never]);
        return true;
      case '月額会員ページ':
        await actionMemberPage(lineClient, lineUserId, replyToken, resolvedEnv, db);
        return true;
      case '限定特典GET':
        await actionLimitedGift(lineClient, lineUserId, replyToken, resolvedEnv, db);
        return true;
      case '利用方法説明書':
        await lineClient.replyMessage(replyToken, [{
          type: 'imagemap',
          baseUrl: 'https://storage.googleapis.com/furimauto_line/images/howtopage',
          altText: '利用方法説明ページURL含む画像',
          baseSize: { width: 1040, height: 585 },
          actions: [{ type: 'uri', linkUri: 'https://furimauto.com/howto/index.html', area: { x: 0, y: 0, width: 1040, height: 585 } }],
        } as never]);
        return true;
      case 'アンバサダー制度':
        await actionAmbassador(lineClient, lineUserId, replyToken, resolvedEnv, db);
        return true;
      case 'Meet予約':
        await actionMeetReservation(lineClient, lineUserId, replyToken, resolvedEnv, db);
        return true;
      case '簡単解説1分動画':
        await lineClient.replyMessage(replyToken, [carouselTemplate as never]);
        return true;
      case 'Youtube動画講座':
        await lineClient.replyMessage(replyToken, [
          { type: 'text', text: '【youtubeに動画をアップしました!!】\n\nFurimAutoは機能が多く、入門・初級・中級・上級と段階的にFurimAutoがこだわっている"全自動化運用"を理解できる内容となっております😄\n\nhttps://www.youtube.com/playlist?list=PLUhATsy78sfvUHMVmeQpKMyxATlHOCEeF' } as never,
          { type: 'image', originalContentUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/youtube_coupon.png', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/youtube_coupon.png' } as never,
          { type: 'text', text: '【お得に使えるクーポンをGET!!】\n\n動画内のキーワードをLINEに送っていただいた方には、\n\n・友達登録から1週間以内 → 初月半額クーポン\n・それ以外 → 初月20%OFFクーポン\n\nをそれぞれプレゼントいたします！' } as never,
        ]);
        return true;
      case 'クーポンGET':
        await lineClient.replyMessage(replyToken, [
          { type: 'image', originalContentUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/coupon_get.png', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/coupon_get.png' } as never,
          { type: 'text', text: '【Xで口コミを投稿して毎月お得になるクーポンをGET!!】\n\n🔵 X（旧Twitter）にFurimAutoの口コミを投稿していただいたら500円OFF\n\n① ハッシュタグ #FurimAutoクチコミ を付けて、使ってみた感想・口コミをXに投稿\n② 投稿したポストのURLを、この公式LINEにそのまま送信\n\n⚠️ スクリーンショットでの申請は受け付けておりません。必ずポストのURLをお送りください（URLの送信のみがクーポン付与の対象です）。\n\nURLを確認後、次回のお支払いに適用される500円OFFクーポンを付与いたします。毎月1回ご利用可能です😄\n\n🔴Googleの拡張機能の公式ページにレビューを投稿していただいたら1000円OFF\nhttps://x.gd/whptf\nGmailアカウント1つに付き1回可能です✋' } as never,
          { type: 'video', originalContentUrl: 'https://storage.googleapis.com/furimauto_line/video/coupon.mp4', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png', trackingId: 'setup' } as never,
        ]);
        return true;
      case 'ホームページ':
        await lineClient.replyMessage(replyToken, [{ type: 'text', text: 'https://furimauto.com/service/' } as never]);
        return true;
      case 'メルカリ物販Lab':
        await lineClient.replyMessage(replyToken, [{ type: 'text', text: 'https://furimauto.com' } as never]);
        return true;
      case 'バグ・エラー報告':
        await lineClient.replyMessage(replyToken, [
          { type: 'text', text: '【謝罪させてください】\n\nまずこちらのメッセージが送信されているということはお客様がバグ・エラーを発見したということかと思います。\n\nお詫び申し上げます。ご迷惑おかけしており申し訳ございません。\n\n以下のフォーマットをコピーして内容を埋めてこのLINEトークに送信してください🙇' } as never,
          { type: 'text', text: '【バグ・エラー報告フォーマット】\nバージョン：\n発生したページ：\nバグ・エラー内容：' } as never,
          { type: 'text', text: '【各項目について】\n・バージョン\nキーコードを入力するポップアップ上部に記載があります。\n\n・発生したページ\n例) 出品一覧、商品ページ など\n\n・バグ・エラー内容\nどういったバグやエラーを発見したか、現状何ができないか。\n\n💡パソコン画面を携帯で録画して送っていただけますと原因が即判断できますので可能であればご対応をお願いします🙇' } as never,
        ]);
        return true;
      case '開発者について':
        // 廃止済み（LP・Youtubeで説明）。旧リッチメニュー画像からの送信に備えて案内だけ残す
        await lineClient.replyMessage(replyToken, [{ type: 'text', text: '開発の想いやコンセプトはホームページとYoutubeでご紹介しています！\n\nhttps://furimauto.com/service/' } as never]);
        return true;
      case 'プラン診断':
      case 'プラン確認': {
        // ガイドタブの「プラン診断」ボタンから。
        // 'プラン確認' はガイドタブv2（旧文言）を開いたままのユーザー向けの互換
        // フォールバックはDEVではなく本番URL（DEVを顧客へ送る事故の防止・2026-08-20）
        const liffUrl = resolvedEnv.PLAN_BUILDER_LIFF_URL || 'https://liff.line.me/1660804123-ZfTZnrBV';
        await lineClient.replyMessage(replyToken, [
          {
            type: 'text',
            text:
              '💡【FurimAutoの料金プラン】\n\nFurimAutoは必要な機能だけを選べる\nビュッフェ式の料金体系です🍽\n\n・サイトごとのパッケージプラン\n（全自動化 / 半自動化 / 基本）\n・機能単位の単品追加\n・全部入りの最強プレミアムプラン\n\n複数サイトの併用割引もあります✨',
          } as never,
          {
            type: 'text',
            text:
              '▼ 料金シミュレーション＆お申し込み ▼\n\nサイトと機能を選ぶだけで\n月額がその場で分かります👇\nそのままお申し込みも可能です！\n\n' + liffUrl,
          } as never,
        ]);
        return true;
      }
      case 'アップデート情報':
        await lineClient.replyMessage(replyToken, [{ type: 'text', text: '【Googleの公式ストアページ】\n\nhttps://x.gd/whptf\n\n2023年6月にリリースしてから最新までのアップデート履歴は全てこちらに記載アリ🎵' } as never]);
        return true;
      default:
        return false;
    }
  } catch (err) {
    console.error(`[furim] handleFurimAction error (${action}):`, err);
    // 次に起きたら原因が分かるよう D1 に残す（Capsec #299 / #300。当時は例外の中身がどこにも残らなかった）
    await recordBotHandlerError(db, lineUserId, `handleFurimAction:${action}`, 'handler', err);
    // 無言で終わらせない: replyToken は失効している可能性があるので push で再操作を促す
    try {
      await lineClient.pushMessage(lineUserId, [{ type: 'text', text: 'エラーが発生しました🙇\nお手数ですが、もう一度タップしてください。' } as never]);
    } catch (pushErr) {
      console.error('[furim] error-fallback push failed:', pushErr);
      await recordBotHandlerError(db, lineUserId, `handleFurimAction:${action}`, 'fallback_push', pushErr);
    }
    return true;
  }
}

// ── 個別アクション実装 ────────────────────────────────────────

type ResolvedEnv = FurimActionsEnv & { GAS_DEPLOY_ID: string };

// reply を試み、失敗（GAS遅延による replyToken 失効等）なら push で確実に届ける。
// 2026-07-16: キーコード発行タップの約7%が GAS の遅延起因で無応答になっていた対策
async function replyOrPush(
  lineClient: LineClient,
  replyToken: string,
  lineUserId: string,
  messages: never[],
) {
  try {
    await lineClient.replyMessage(replyToken, messages);
  } catch (err) {
    console.error('[furim] reply failed, falling back to push:', err);
    await lineClient.pushMessage(lineUserId, messages);
  }
}

async function actionKeycodeIssue(
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string,
  env: ResolvedEnv,
  db?: D1Database,
) {
  // キーコードは D1 furim_customers から返す（Capsec #243）。GAS getKeyCode は呼ばない。
  // 友だち追加時に Worker が生成し、Stripe 起点の再発行は absorbGasKeyCode で取り込まれている
  const customer = db ? await getFurimCustomer(db, lineUserId) : null;
  const keyCode = (customer?.key_code ?? '').trim();
  console.log('[furim] keycode from D1:', lineUserId, keyCode ? 'hit' : 'miss');

  if (!keyCode) {
    // 行が無い/空: 友だち追加直後で未生成、または解約でクリア済み。GAS 時代の 401 と同じ案内
    await replyOrPush(lineClient, replyToken, lineUserId, [{ type: 'text', text: 'まだ準備中なので10秒経ったらもう一回押してください🙇' } as never]);
    return;
  }

  // キーコードのみ返す（2026-08-27 くろさん指示）。
  // 旧実装は試用キーコード時に利用方法imagemap＋コピーチケットFlexも同時送信していたが、
  // 肝心のキーコードが埋もれて分かりづらいため廃止。チケットFlexは特典への道4/6(Day4昼)、
  // 利用方法はウェルカム動画・リッチメニューで導線が残っている
  const messages: unknown[] = [{ type: 'text', text: keyCode }];

  await replyOrPush(lineClient, replyToken, lineUserId, messages as never[]);

  // 「初回発行」フラグ（限定特典②の解放判定）: D1 を先に立て、シートへは返信後に 1 回だけ試して
  // 失敗なら再実行キュー（GAS getKeyCode が持っていた副作用の鏡写し）
  if (db && customer?.key_code_issued !== 1) {
    try {
      await upsertFurimCustomer(db, lineUserId, { key_code_issued: 1 });
    } catch (err) {
      console.error('[furim] key_code_issued upsert failed:', lineUserId, err);
    }
    await mirrorCustomerFieldsToGas(db, env.GAS_DEPLOY_ID, lineUserId, { '初回発行': true });
  }

  // セグメント3 へ昇格（キーコード発行済み）
  if (db) {
    try {
      const friend = await db.prepare('SELECT id FROM friends WHERE line_user_id = ?').bind(lineUserId).first<{ id: string }>();
      if (friend) await switchSegmentTag(db, friend.id, 3);
    } catch (err) {
      console.error('[furim] segment upgrade error (keycode issue):', err);
    }
  }
}

async function actionMemberPage(
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string,
  env: ResolvedEnv,
  db?: D1Database,
) {
  if (!env.STRIPE_SECRET_KEY) {
    console.warn('[furim] STRIPE_SECRET_KEY not set, cannot create billing portal');
    await lineClient.replyMessage(replyToken, [{ type: 'text', text: '会員ページの準備中です。しばらくお待ちください。' } as never]);
    return;
  }

  // Stripe顧客ID は D1（furim_customers → friends.metadata）から（Capsec #243）。GAS getStripeIDwithLINEID は呼ばない
  const stripeCustomerId = db ? await resolveStripeCustomerId(db, lineUserId) : null;

  if (!stripeCustomerId) {
    await lineClient.replyMessage(replyToken, [{ type: 'text', text: '会員情報が見つかりませんでした。' } as never]);
    return;
  }

  const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ customer: stripeCustomerId }).toString(),
  });

  if (!portalRes.ok) {
    console.error('[furim] Stripe billing portal error:', await portalRes.text());
    await lineClient.replyMessage(replyToken, [{ type: 'text', text: '会員ページの取得に失敗しました。' } as never]);
    return;
  }

  const portal = await portalRes.json() as { url: string };
  console.log('[furim] billing portal created:', lineUserId, stripeCustomerId, portal.url ? 'ok' : 'no-url');
  await lineClient.replyMessage(replyToken, [{
    type: 'imagemap',
    baseUrl: 'https://storage.googleapis.com/furimauto_line/images/member_page',
    altText: '会員限定ページURL含む画像',
    baseSize: { width: 1040, height: 1040 },
    actions: [{ type: 'uri', linkUri: portal.url, area: { x: 0, y: 0, width: 1040, height: 1040 } }],
  } as never]);
}

async function actionLimitedGift(
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string,
  env: ResolvedEnv,
  db?: D1Database,
) {
  // 解放判定の 6 フラグは D1 furim_customers から（Capsec #243。派生式は GAS getLimitedGiftStatus と同じ）。
  // 送信済み特典番号は従来どおり Firebase
  const [customer, sentBatches] = await Promise.all([
    db ? getFurimCustomer(db, lineUserId) : Promise.resolve(null),
    env.FIREBASE_DATABASE_URL ? getSentGiftBatches(env.FIREBASE_DATABASE_URL, lineUserId) : Promise.resolve([] as number[]),
  ]);

  const status: GiftStatus = deriveGiftStatus(customer);

  const newBatches = GIFT_BATCHES.filter(
    (b) => !sentBatches.includes(b.batchNo) && b.isUnlocked(status),
  );

  if (newBatches.length > 0) {
    const allPdfLines = newBatches.flatMap((b) => b.pdfs).map((p) => `${p.label}\n${p.url}`).join('\n\n');
    const introText = newBatches.length === 1 ? newBatches[0].introText : `🎁 ${newBatches.length}つの特典が新たに解放されました！\n特典をお届けします📩`;
    const updatedSentBatches = [...sentBatches, ...newBatches.map((b) => b.batchNo)];

    if (env.FIREBASE_DATABASE_URL) {
      await setSentGiftBatches(env.FIREBASE_DATABASE_URL, lineUserId, updatedSentBatches);
    }

    const extraMessages = newBatches.flatMap((b) => b.deliveryMessages ? b.deliveryMessages() : []);
    const listMessage = buildReceivedListFlex(updatedSentBatches);
    const nextLocked = GIFT_BATCHES.find((b) => !updatedSentBatches.includes(b.batchNo));
    const messages: unknown[] = [{ type: 'text', text: `${introText}\n\n${allPdfLines}` }, ...extraMessages, listMessage];
    if (nextLocked) {
      messages.push({ type: 'text', text: `💡 次の特典について\n${nextLocked.lockedHint}` });
      messages.push(...nextLocked.buildActionMessages());
    }
    await lineClient.replyMessage(replyToken, (messages as unknown[]).slice(0, 5) as never[]);
    return;
  }

  const nextLocked = GIFT_BATCHES.find((b) => !sentBatches.includes(b.batchNo) && !b.isUnlocked(status));
  if (nextLocked) {
    const messages = [buildReceivedListFlex(sentBatches), { type: 'text', text: nextLocked.lockedHint }, ...nextLocked.buildActionMessages()].slice(0, 5);
    await lineClient.replyMessage(replyToken, messages as never[]);
    return;
  }

  await lineClient.replyMessage(replyToken, [
    { type: 'text', text: '✅ 特典①〜⑬全てお届け済みです！\n引き続きFurimAutoをフル活用してください🎉' } as never,
    buildReceivedListFlex(sentBatches) as never,
  ]);
}

async function actionAmbassador(
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string,
  env: ResolvedEnv,
  db?: D1Database,
) {
  // 段階2（Capsec #244）: アンバサダーコードと紹介数は D1（affiliates.code / furim_referrals）。GAS は呼ばない
  // （2026-09-13 実機で GAS getAmbassadorInfo の 15 秒見切りが「エラーが発生しました」になった）。
  // アンバサダー固有の紹介URLを用意し、URL経由attribution時に手動code方式と同じ processReferral へ載せる。
  // db未接続 / offer未設定 / friend未取得 / WORKER base未設定 のいずれかなら refUrl=null となり、URLなし（再タップ案内）のFlexを返す。
  let refUrl: string | null = null;
  let introduced = 0;
  if (db) {
    try {
      const friend = await getFriendByLineUserId(db, lineUserId);
      if (friend) {
        const affiliate = await getOrCreateAmbassadorAffiliate(db, friend.id, friend.display_name ?? null);
        introduced = (await countReferrals(db, affiliate.id)).total;
        if (env.FURIM_AMBASSADOR_OFFER_ID) {
          const { link } = await enrollAffiliateInOffer(db, { affiliateId: affiliate.id, offerId: env.FURIM_AMBASSADOR_OFFER_ID });
          const base = env.WORKER_PUBLIC_URL ?? env.WORKER_URL;
          if (base) refUrl = `${base}/auth/line?ref=${link.ref_code}`;
        }
      }
    } catch (err) {
      console.error('[furim] Ambassador referral URL build failed:', err);
    }
  }

  // 1通目: 制度説明＋共有方法を1つのFlexに集約。紹介URLはボタン（コピー/転送）にだけ持たせる。
  const shareText = `FurimAuto公式LINEの友達紹介URLです！\n下のURLからお友達追加で特典が受け取れます👇\n${refUrl}`;
  const urlSection: unknown[] = refUrl
    ? [
        { type: 'separator', margin: 'lg' },
        { type: 'text', text: '共有方法', weight: 'bold', size: 'md', margin: 'lg' },
        { type: 'text', text: '下の「URLをコピー」であなた専用の紹介URLをコピーしてお友達に送るか、「お友達に転送する」でLINEからそのまま送れます。\nお友達がURLをタップ→友だち追加するだけで自動で紐付き、紹介が成立します✨', size: 'sm', color: '#666666', wrap: true },
      ]
    : [
        { type: 'separator', margin: 'lg' },
        { type: 'text', text: '紹介URLの発行に失敗しました🙇\n時間をおいて、もう一度リッチメニューの「アンバサダー制度」をタップしてください。', size: 'sm', color: '#C62828', wrap: true, margin: 'lg' },
      ];
  const footerButtons: unknown[] = refUrl
    ? [
        { type: 'button', style: 'primary', action: { type: 'clipboard', label: 'URLをコピー', clipboardText: refUrl } },
        { type: 'button', style: 'secondary', action: { type: 'uri', label: 'お友達に転送する', uri: `https://line.me/R/share?text=${encodeURIComponent(shareText)}` } },
      ]
    : [];
  footerButtons.push({ type: 'button', style: 'link', action: { type: 'uri', label: '制度についてHPはコチラ', uri: 'https://furimauto.com/ambassador/index.html' } });

  const ambassadorFlex = {
    type: 'flex',
    altText: 'アンバサダー制度のご案内',
    contents: {
      type: 'bubble',
      hero: { type: 'image', url: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/ambassador.png', size: 'full', aspectRatio: '16:9', aspectMode: 'cover' },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: 'アンバサダー制度', weight: 'bold', size: 'lg' },
          { type: 'text', text: 'お友達にFurimAutoを紹介すると、紹介した方にもされた方にも特典があります。', size: 'sm', color: '#666666', wrap: true },
          { type: 'text', text: '・あなた：ご加入プランに応じた割引クーポン（最大10枚）\n・お友達：無料お試し期間＋1週間＆初月50%OFFクーポン', size: 'sm', wrap: true },
          ...urlSection,
        ],
      },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footerButtons },
    },
  };

  // 2通目: 招待人数確認
  await lineClient.replyMessage(replyToken, [
    ambassadorFlex,
    { type: 'text', text: `【自動送信】\n招待人数確認用メッセージ\n\nあなたは現在までに${introduced}名のお友達をご紹介していただきました🙇` },
  ] as never[]);
}

async function actionMeetReservation(
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string,
  _env: ResolvedEnv,
  db?: D1Database,
) {
  // 延長キーワード送信済みか（旧 GAS checkExtendKeyword。段階2.5・Capsec #250 で D1 furim_customers.extend_keyword を見る）
  const customer = db ? await getFurimCustomer(db, lineUserId) : null;
  const hasWatchedVideo = (customer?.extend_keyword ?? '').trim() !== '';

  const text = hasWatchedVideo
    ? `「直接話を聞いてから決めたい！」\n「動画を見ても疑問が残った」\n\nという方はMeet説明会にご参加ください🎥\n\n説明会では動画の補足説明＋質疑応答をお受けします。\n所要時間は15〜30分程度です🕰️\n\n▼予約はこちら📓\nhttps://x.gd/FA_reservation\n(顔出し不要です！)`
    : `【Meet予約の前に動画をご覧ください】\n\nMeet説明会のご予約いただく前に、\nまず完全解説動画のご視聴をお願いしております🙇\n\n▼完全解説動画はこちら👇\nhttps://www.youtube.com/watch?v=jhaCPxgE_Sk\n\n動画の中のキーワードをLINEに送っていただくことで\n「それでも直接話を聞いてから決めたい！」\n\nという方向けにMeet予約ができるようになります✨`;

  await lineClient.replyMessage(replyToken, [{ type: 'text', text } as never]);
}

export async function actionFurimanCoupon(
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string,
  env: ResolvedEnv,
  db?: D1Database,
): Promise<void> {
  if (!env.STRIPE_SECRET_KEY) {
    await lineClient.replyMessage(replyToken, [{ type: 'text', text: '申し訳ございません。クーポン処理中にエラーが発生しました。' } as never]);
    return;
  }
  // 段階2.5（Capsec #250）: 適用条件は D1 で判定する（旧 GAS getFurimanCouponInfo / setFurimanCoupon は削除）。
  // 友だち登録日時 = friends.created_at、付与済み = furim_customers.youtube_coupon、クーポン ID = furim_coupons
  const data = db ? await resolveFurimanCoupon(db, lineUserId) : null;
  if (!data) {
    await lineClient.replyMessage(replyToken, [{ type: 'text', text: '申し訳ございません。顧客情報が見つかりませんでした。' } as never]);
    return;
  }
  const customer = await fetch(`https://api.stripe.com/v1/customers/${data.stripeCustomerId}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  }).then(r => r.json()) as { discount?: { coupon?: { name?: string } } };
  if (customer.discount?.coupon) {
    await lineClient.replyMessage(replyToken, [{ type: 'text', text: `申し訳ございません。既に${customer.discount.coupon.name || '他のクーポン'}が適用されているため、YouTubeクーポンはご利用いただけません。` } as never]);
    return;
  }
  if (!data.canApply) {
    await lineClient.replyMessage(replyToken, [{ type: 'text', text: '申し訳ございません。YouTubeの\'Furimanです\'クーポンは既にご利用いただいているので、ご利用いただけません。' } as never]);
    return;
  }
  await fetch(`https://api.stripe.com/v1/customers/${data.stripeCustomerId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ coupon: data.eligibleCouponId }).toString(),
  });
  // D1 furim_customers（限定特典⑤の解放判定）と適用履歴（旧: シート「クーポン適用履歴」）を先に書く
  if (db) {
    try {
      await upsertFurimCustomer(db, lineUserId, { youtube_coupon: data.eligibleCouponName || 'applied' });
      await db
        .prepare('INSERT INTO furim_coupon_applications (id, line_user_id, stripe_customer_id, coupon_name, coupon_id, route, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), lineUserId, data.stripeCustomerId, data.eligibleCouponName, data.eligibleCouponId, 'Furiman経由', jstNow())
        .run();
    } catch (e) {
      console.error('[furim] youtube_coupon upsert failed:', lineUserId, e);
    }
  }

  // Furimanですタグ付与 + セグメント7 へ昇格（Youtubeクーポン取得）
  if (db) {
    const friend = await db.prepare('SELECT id FROM friends WHERE line_user_id = ?').bind(lineUserId).first<{ id: string }>();
    if (friend) {
      const tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind('Furimanです').first<{ id: string }>();
      if (tag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)').bind(friend.id, tag.id, jstNow()).run();
      const currentSeg7 = await getCurrentSegment(db, friend.id);
      if (currentSeg7 !== null && currentSeg7 >= 5 && currentSeg7 < 7) await switchSegmentTag(db, friend.id, 7);
    }
  }

  await lineClient.replyMessage(replyToken, [{ type: 'text', text: `【自動送信】\nYoutubeのキーワードありがとうございます！\n\n"${data.eligibleCouponName}"\nを付与いたしました！\n\n有料会員のお客様はリッチメニューの月額会員ページから、\n次回の支払額についてクーポン値引きが適用されているのを確認してください😄\n\n無料期間中のお客様は、\n初月料金をお得にご利用いただき\nFurimAutoを最大限活用して\nプラン選択に役立ててください💰💰💰` } as never]);
  // シートの Youtubeクーポン列へ鏡写し（旧拡張の間はシートも残す。失敗は再実行キューが完遂させる）
  if (db) await mirrorCustomerFieldsToGas(db, env.GAS_DEPLOY_ID, lineUserId, { 'Youtubeクーポン': data.eligibleCouponName });
}

// 「Furimanです」クーポンの適用判定（GAS getFurimanCouponInfo / checkCouponEligibility の移植）。
// 顧客行（Stripe顧客ID）が無ければ null。付与済み・クーポン未登録は canApply=false
export async function resolveFurimanCoupon(
  db: D1Database,
  lineUserId: string,
  nowMs = Date.now(),
): Promise<{ stripeCustomerId: string; daysSinceRegistration: number; eligibleCouponName: string; eligibleCouponId: string; canApply: boolean; reason: 'eligible' | 'already_applied' | 'coupon_not_found' } | null> {
  const customer = await getFurimCustomer(db, lineUserId);
  const stripeCustomerId = await resolveStripeCustomerId(db, lineUserId);
  if (!stripeCustomerId) return null;
  const friend = await db.prepare('SELECT created_at FROM friends WHERE line_user_id = ?').bind(lineUserId).first<{ created_at: string }>();
  const registeredAt = friend?.created_at ? Date.parse(friend.created_at) : NaN;
  const daysSinceRegistration = Number.isNaN(registeredAt) ? NaN : Math.floor((nowMs - registeredAt) / (24 * 60 * 60_000));
  if ((customer?.youtube_coupon ?? '').trim() !== '') {
    return { stripeCustomerId, daysSinceRegistration, eligibleCouponName: '', eligibleCouponId: '', canApply: false, reason: 'already_applied' };
  }
  // 1 週間以内は半額、以降は 20%OFF（登録日時が不明なら 20%OFF）
  const eligibleCouponName = daysSinceRegistration < 7 ? 'Youtubeご視聴感謝半額クーポン' : 'Youtubeご視聴感謝20%OFFクーポン';
  const { getCouponId } = await import('./referral-store.js');
  const eligibleCouponId = await getCouponId(db, eligibleCouponName);
  if (!eligibleCouponId) {
    console.error('[furim] resolveFurimanCoupon: furim_coupons に無い', eligibleCouponName);
    return { stripeCustomerId, daysSinceRegistration, eligibleCouponName, eligibleCouponId: '', canApply: false, reason: 'coupon_not_found' };
  }
  return { stripeCustomerId, daysSinceRegistration, eligibleCouponName, eligibleCouponId, canApply: true, reason: 'eligible' };
}

// 「解説見た」の延長判定（GAS setExtendTrialByKeyword の移植・段階2.5・Capsec #250）。D1 に先に書き、鏡写し用の fields を返す
export async function applyExtendTrialKeyword(
  db: D1Database,
  kv: ExtCache | undefined,
  lineUserId: string,
  nowMs = Date.now(),
): Promise<{ result: 'extended1w' | 'extended3d' | 'notEligible' | 'alreadyUsed' | 'error'; newExpiry?: string; mirror?: Record<string, unknown> }> {
  const customer = await getFurimCustomer(db, lineUserId);
  if (!customer) return { result: 'error' };
  if ((customer.extend_keyword ?? '').trim() !== '') return { result: 'alreadyUsed' };
  // プラン名が空でない（有料加入済み・解約履歴あり）→ 延長の代わりにチケット 100 枚（1 回きり）
  if ((customer.plan_label ?? '').trim() !== '') {
    const { applyTicketDelta } = await import('./ticket-ledger.js');
    const r = await applyTicketDelta(db, kv, { line_user_id: lineUserId, key_code: customer.key_code }, { delta: 100, reason: 'extend_keyword', idempotencyKey: `extend_keyword:${lineUserId}` });
    await upsertFurimCustomer(db, lineUserId, { extend_keyword: '対象外' });
    return { result: 'notEligible', mirror: { '延長キーワード': '対象外', 'コピー出品チケット': r.copyTickets } };
  }
  const friend = await db.prepare('SELECT created_at FROM friends WHERE line_user_id = ?').bind(lineUserId).first<{ created_at: string }>();
  const followMs = friend?.created_at ? Date.parse(friend.created_at) : NaN;
  const ONE_WEEK_MS = 7 * 24 * 60 * 60_000;
  const isWithinOneWeek = !Number.isNaN(followMs) && nowMs - followMs <= ONE_WEEK_MS;
  const baseMs = parseJstDateTime(customer.subscription_end_at) ?? nowMs;
  const newExpiryMs = baseMs + (isWithinOneWeek ? ONE_WEEK_MS : 3 * 24 * 60 * 60_000);
  const label = isWithinOneWeek ? '1w' : '3d';
  const newExpiryJst = formatJstDateTime(newExpiryMs);
  await upsertFurimCustomer(db, lineUserId, { subscription_end_at: formatJstIso(newExpiryMs), extend_keyword: label });
  const { invalidateExtCache } = await import('./ext-auth.js');
  await invalidateExtCache(kv, customer.key_code);
  return { result: isWithinOneWeek ? 'extended1w' : 'extended3d', newExpiry: new Date(newExpiryMs).toISOString(), mirror: { 'サブスク終了日時': newExpiryJst, '延長キーワード': label } };
}

export async function actionExtendTrial(
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string,
  gasDeployId: string,
  db?: D1Database,
  kv?: ExtCache,
): Promise<void> {
  const result = db ? await applyExtendTrialKeyword(db, kv, lineUserId) : { result: 'error' as const };
  const messages: Record<string, string> = {
    extended1w: `【自動送信】\n動画のご視聴ありがとうございます！🎉\n\n友達登録から1週間以内の方への特別特典として、\n無料試用期間を1週間延長しました✨\n\n引き続きFurimAutoをフル活用して\n売り上げUPを目指してください😄`,
    extended3d: `【自動送信】\n動画のご視聴ありがとうございます！🎉\n\nご視聴いただいた感謝として、\n無料試用期間を3日間延長しました✨\n\n引き続きFurimAutoをフル活用して\n売り上げUPを目指してください😄`,
    notEligible: `【自動送信】\n動画のご視聴ありがとうございます！🎉\n\n有料プランにご加入いただいているお客様には\n試用期間延長の代わりに、\nコピー出品チケットを100枚プレゼントしました🎁\n\nチケットは自動的に追加されていますので\nぜひご活用ください！`,
    alreadyUsed: `【自動送信】\n「解説見た」キーワードは\n既にご利用いただいております。\n\n1つのアカウントにつき1回限りの特典となっております🙇\n引き続きFurimAutoをよろしくお願いいたします！`,
  };
  const text = messages[result.result] ?? '申し訳ございません。処理中にエラーが発生しました。';
  await lineClient.replyMessage(replyToken, [{ type: 'text', text } as never]);

  // シートへ鏡写し（サブスク終了日時・延長キーワード・チケット残。旧拡張は GAS 経路でシートの期限を読む）
  if (db && result.mirror) await mirrorCustomerFieldsToGas(db, gasDeployId, lineUserId, result.mirror);

  // kaisetsu フラグを書き込む（extended1w / extended3d のみ）
  if (db && (result?.result === 'extended1w' || result?.result === 'extended3d')) {
    try {
      const existing = await db.prepare('SELECT id, metadata FROM friends WHERE line_user_id = ?').bind(lineUserId).first<{ id: string; metadata: string }>();
      if (existing) {
        // クロージング用 trial_end は D1 に書いた実際の新期限(newExpiry)をそのまま使う。
        // 旧実装の「今日+7日」自前計算は元期限+7日と最大1日ズレていた。
        // newExpiry が返らない異常時のみ従来式でフォールバック
        let trialEndStr: string;
        if (result.newExpiry && !Number.isNaN(new Date(result.newExpiry).getTime())) {
          trialEndStr = new Date(new Date(result.newExpiry).getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10);
        } else {
          const daysToAdd = result.result === 'extended1w' ? 7 : 3;
          trialEndStr = new Date(Date.now() + 9 * 60 * 60_000 + daysToAdd * 24 * 60 * 60_000).toISOString().slice(0, 10);
        }
        const meta = JSON.parse(existing.metadata || '{}');
        meta.kaisetsu = true;
        meta.trial_end = trialEndStr;
        await db.prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(meta), jstNow(), existing.id).run();
        // 本編シナリオは停止しない（2026-08-24 一本化決定「seg8も本編継続」・2026-08-27 徹底）。
        // 旧実装はここで completeFriendActiveScenarios していたが、14日版シーケンスでは
        // Day6昼に「解説見た」を促すため、停止すると後半（全自動化教育）が丸ごと届かなくなる

        // 解説見たタグ付与
        const tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind('解説見た').first<{ id: string }>();
        if (tag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)').bind(existing.id, tag.id, jstNow()).run();

        // セグメント8 へ昇格（解説見た）— seg4+5 達成済みの場合のみ
        const currentSeg8 = await getCurrentSegment(db, existing.id);
        if (currentSeg8 !== null && currentSeg8 >= 5 && currentSeg8 < 8) await switchSegmentTag(db, existing.id, 8);

        console.log(`[furim] kaisetsu flag set for ${lineUserId}, trial_end=${meta.trial_end}`);
      }
    } catch (err) {
      console.error('[furim] kaisetsu metadata write error:', err);
    }
  }
}
