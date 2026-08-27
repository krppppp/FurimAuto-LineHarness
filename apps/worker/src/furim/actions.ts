import type { LineClient } from '@line-crm/line-sdk';
import { gasGet, gasPost } from './gas-client.js';
import { enqueueGasRetryJob } from './gas-retry-queue.js';
import { getSentGiftBatches, setSentGiftBatches } from './firebase-client.js';
import {
  carouselTemplate,
  ticketOrderTemplate,
  copyTicketFlexMessage,
  surveyButton,
} from './messages.js';
import {
  getFriendByLineUserId,
  getAffiliateByFriendId,
  createAffiliate,
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
  if (newTag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, datetime("now", "+9 hours"))').bind(friendId, newTag.id).run();
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
        await actionMemberPage(lineClient, lineUserId, replyToken, resolvedEnv);
        return true;
      case '限定特典GET':
        await actionLimitedGift(lineClient, lineUserId, replyToken, resolvedEnv);
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
        await actionMeetReservation(lineClient, lineUserId, replyToken, resolvedEnv);
        return true;
      case '簡単解説1分動画':
        await lineClient.replyMessage(replyToken, [carouselTemplate as never]);
        return true;
      case 'Youtube動画講座':
        await lineClient.replyMessage(replyToken, [
          { type: 'text', text: '【youtubeに動画をアップしました!!】\n\nFurimAutoは機能が多く、入門・初級・中級・上級と段階的にFurimAutoがこだわっている"全自動化運用"を理解できる内容となっております😄\n\nhttps://www.youtube.com/playlist?list=PLUhATsy78sfvUHMVmeQpKMyxATlHOCEeF' } as never,
          { type: 'image', originalContentUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/youtube_coupon.png', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/youtube_coupon.png' } as never,
          { type: 'text', text: '【お得に使えるクーポンをGET!!】\n\n動画内のキーワードをLINEに送っていただいた方には、\n\n・友達登録から1週間以内 → 月額半額クーポン\n・それ以外 → 月額20%引きクーポン\n\nをそれぞれプレゼントいたします！' } as never,
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
    // 無言で終わらせない: replyToken は失効している可能性があるので push で再操作を促す
    try {
      await lineClient.pushMessage(lineUserId, [{ type: 'text', text: 'エラーが発生しました🙇\nお手数ですが、もう一度タップしてください。' } as never]);
    } catch (pushErr) {
      console.error('[furim] error-fallback push failed:', pushErr);
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
  let data: Record<string, string> | null = null;
  try {
    data = await gasGet(env.GAS_DEPLOY_ID, { method: 'getKeyCode', lineUserId }) as Record<string, string>;
  } catch (err) {
    console.error('[furim] getKeyCode failed:', err);
  }
  console.log('[furim] getKeyCode response:', data);

  if (!data?.keyCode) {
    // 1回きり実行で失敗 → 再実行キューに積んでcronが完遂し、キーコードを届ける
    // （2026-08-14 くろさん方針: インラインリトライ廃止・中間の返信もしない。
    //   完遂通知はreplyToken優先→失効時のみpushで月間上限を節約）
    if (db) {
      await enqueueGasRetryJob(db, {
        lineUserId,
        method: 'getKeyCode',
        replyToken,
      });
      return;
    }
    await lineClient.pushMessage(lineUserId, [{ type: 'text', text: '申し訳ございません、発行処理が混み合っています🙇\nお手数ですが、少し時間をおいてもう一度「キーコード発行」をタップしてください。' } as never]);
    return;
  }

  if (data.keyCode === 'エラーコード(401)') {
    await replyOrPush(lineClient, replyToken, lineUserId, [{ type: 'text', text: 'まだ準備中なので10秒経ったらもう一回押してください🙇' } as never]);
    return;
  }

  // キーコードのみ返す（2026-08-27 くろさん指示）。
  // 旧実装は試用キーコード時に利用方法imagemap＋コピーチケットFlexも同時送信していたが、
  // 肝心のキーコードが埋もれて分かりづらいため廃止。チケットFlexは特典への道4/6(Day4昼)、
  // 利用方法はウェルカム動画・リッチメニューで導線が残っている
  const messages: unknown[] = [{ type: 'text', text: data.keyCode }];

  await replyOrPush(lineClient, replyToken, lineUserId, messages as never[]);

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
) {
  if (!env.STRIPE_SECRET_KEY) {
    console.warn('[furim] STRIPE_SECRET_KEY not set, cannot create billing portal');
    await lineClient.replyMessage(replyToken, [{ type: 'text', text: '会員ページの準備中です。しばらくお待ちください。' } as never]);
    return;
  }

  const gasData = await gasGet(env.GAS_DEPLOY_ID, { method: 'getStripeIDwithLINEID', lineUserId }) as Record<string, string>;
  const stripeCustomerId = gasData?.customer_stripe_id || gasData?.stripeCustomerId || gasData?.stripeID || gasData?.data;

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
) {
  const [statusRaw, sentBatches] = await Promise.all([
    gasGet(env.GAS_DEPLOY_ID, { method: 'getLimitedGiftStatus', lineUserId }),
    env.FIREBASE_DATABASE_URL ? getSentGiftBatches(env.FIREBASE_DATABASE_URL, lineUserId) : Promise.resolve([] as number[]),
  ]);

  const status = statusRaw as GiftStatus;

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
  const data = await gasGet(env.GAS_DEPLOY_ID, { method: 'getAmbassadorInfo', lineUserId }) as Record<string, unknown>;
  const ambassadorCode = data?.ambassadorCode ? String(data.ambassadorCode) : null;

  // アンバサダー固有の紹介URLを用意（affiliate.code = ambassadorCode に揃え、
  // URL経由attribution時に手動code方式と同じ processReferral へ載せる）。
  // db未接続 / offer未設定 / friend未取得 / WORKER base未設定 のいずれかなら
  // refUrl=null となり、従来の手動code方式にフォールバックする。
  let refUrl: string | null = null;
  if (db && ambassadorCode && env.FURIM_AMBASSADOR_OFFER_ID) {
    try {
      const friend = await getFriendByLineUserId(db, lineUserId);
      if (friend) {
        let affiliate = await getAffiliateByFriendId(db, friend.id);
        if (!affiliate) {
          try {
            affiliate = await createAffiliate(db, { name: `Ambassador ${ambassadorCode}`, code: ambassadorCode, friendId: friend.id });
          } catch {
            // 同時押し等のrace（friend_id / code のUNIQUE衝突）→ 既存を引き直す
            affiliate = await getAffiliateByFriendId(db, friend.id);
          }
        }
        if (affiliate) {
          const { link } = await enrollAffiliateInOffer(db, { affiliateId: affiliate.id, offerId: env.FURIM_AMBASSADOR_OFFER_ID });
          const base = env.WORKER_PUBLIC_URL ?? env.WORKER_URL;
          if (base) refUrl = `${base}/auth/line?ref=${link.ref_code}`;
        }
      }
    } catch (err) {
      console.error('[furim] Ambassador referral URL build failed (fallback to manual code):', err);
    }
  }

  const messages: unknown[] = [
    { type: 'image', originalContentUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/ambassador.png', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/ambassador.png' },
  ];

  if (refUrl) {
    // 紹介URL版: コピー(clipboard)＋LINE転送(share)＋説明書発行を1つのFlexに集約。
    // clipboard は LINE 13.6.0+ 限定のため、body に URL テキストも併記してフォールバック。
    const shareText = `FurimAuto公式LINEの友達紹介URLです！\n下のURLからお友達追加で特典が受け取れます👇\n${refUrl}`;
    messages.push({
      type: 'flex',
      altText: 'お友達紹介URL',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          contents: [
            { type: 'text', text: 'お友達紹介URL', weight: 'bold', size: 'lg' },
            { type: 'text', text: 'このURLをお友達に送るだけで紹介が成立します。お友達がタップ→友だち追加するだけで自動で紐付きます✨', size: 'sm', color: '#666666', wrap: true },
            { type: 'text', text: refUrl, size: 'xs', color: '#1565C0', wrap: true },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            { type: 'button', style: 'primary', action: { type: 'clipboard', label: 'URLをコピー', clipboardText: refUrl } },
            { type: 'button', style: 'secondary', action: { type: 'uri', label: 'お友達に転送する', uri: `https://line.me/R/share?text=${encodeURIComponent(shareText)}` } },
            { type: 'button', style: 'link', action: { type: 'message', label: 'お友達向け説明書の発行', text: '【ボタン】お友達向け説明書の発行' } },
          ],
        },
      },
    });
  } else {
    // フォールバック（従来）: OA登録URLの転送template。
    messages.push({
      type: 'template',
      altText: 'アカウントURL転送ボタン',
      template: {
        type: 'buttons',
        text: 'FurimAuto公式LINEの登録URLをお友達に転送できます📩',
        actions: [
          { type: 'uri', label: '転送する', uri: 'https://line.me/R/nv/recommendOA/@997axiep' },
          { type: 'message', label: 'お友達向け説明書の発行', text: '【ボタン】お友達向け説明書の発行' },
        ],
      },
    });
  }

  messages.push(
    { type: 'text', text: `👇アンバサダー制度についてはコチラから👇\nhttps://furimauto.com/ambassador/index.html\n\nお友達がFurimAuto公式ラインの友達登録が完了したら\n下の友達紹介コードをコピペしてそのまま送信するようにお伝えください。\n\n※注: 【】 ← も含めて送るように必ずお伝えください！！` },
    { type: 'text', text: `【キーワード】友達紹介コード:${ambassadorCode ?? '取得中...'}` },
  );

  if (data?.numberIntroduced && Number(data.numberIntroduced) > 0) {
    messages.push({ type: 'text', text: `【自動送信】\n招待人数確認用メッセージ\n\nあなたは現在までに${data.numberIntroduced}名のお友達をご紹介していただきました🙇` });
  }

  await lineClient.replyMessage(replyToken, (messages as unknown[]).slice(0, 5) as never[]);
}

async function actionMeetReservation(
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string,
  env: ResolvedEnv,
) {
  const result = await gasPost(env.GAS_DEPLOY_ID, { method: 'checkExtendKeyword', lineUserId }) as Record<string, unknown>;
  const hasWatchedVideo = result?.success === true && result?.used === true;

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
  const couponInfo = await gasGet(env.GAS_DEPLOY_ID, { method: 'getFurimanCouponInfo', lineUserId }) as Record<string, unknown>;
  if (!couponInfo?.success) {
    await lineClient.replyMessage(replyToken, [{ type: 'text', text: '申し訳ございません。顧客情報が見つかりませんでした。' } as never]);
    return;
  }
  const data = couponInfo.data as Record<string, string>;
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
  await gasPost(env.GAS_DEPLOY_ID, { method: 'setFurimanCoupon', lineUserId, couponName: data.eligibleCouponName });

  // Furimanですタグ付与 + セグメント7 へ昇格（Youtubeクーポン取得）
  if (db) {
    const friend = await db.prepare('SELECT id FROM friends WHERE line_user_id = ?').bind(lineUserId).first<{ id: string }>();
    if (friend) {
      const tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind('Furimanです').first<{ id: string }>();
      if (tag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, datetime("now", "+9 hours"))').bind(friend.id, tag.id).run();
      const currentSeg7 = await getCurrentSegment(db, friend.id);
      if (currentSeg7 !== null && currentSeg7 >= 5 && currentSeg7 < 7) await switchSegmentTag(db, friend.id, 7);
    }
  }

  await lineClient.replyMessage(replyToken, [{ type: 'text', text: `【自動送信】\nYoutubeのキーワードありがとうございます！\n\n"${data.eligibleCouponName}"\nを付与いたしました！\n\n有料会員のお客様はリッチメニューの月額会員ページから、\n次回の支払額についてクーポン値引きが適用されているのを確認してください😄\n\n無料期間中のお客様は、\n初月料金をお得にご利用いただき\nFurimAutoを最大限活用して\nプラン選択に役立ててください💰💰💰` } as never]);
}

export async function actionExtendTrial(
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string,
  gasDeployId: string,
  db?: D1Database,
): Promise<void> {
  const result = await gasPost(gasDeployId, { method: 'setExtendTrialByKeyword', lineUserId }) as Record<string, string>;
  const messages: Record<string, string> = {
    extended1w: `【自動送信】\n動画のご視聴ありがとうございます！🎉\n\n友達登録から1週間以内の方への特別特典として、\n無料試用期間を1週間延長しました✨\n\n引き続きFurimAutoをフル活用して\n売り上げUPを目指してください😄`,
    extended3d: `【自動送信】\n動画のご視聴ありがとうございます！🎉\n\nご視聴いただいた感謝として、\n無料試用期間を3日間延長しました✨\n\n引き続きFurimAutoをフル活用して\n売り上げUPを目指してください😄`,
    notEligible: `【自動送信】\n動画のご視聴ありがとうございます！🎉\n\n有料プランにご加入いただいているお客様には\n試用期間延長の代わりに、\nコピー出品チケットを100枚プレゼントしました🎁\n\nチケットは自動的に追加されていますので\nぜひご活用ください！`,
    alreadyUsed: `【自動送信】\n「解説見た」キーワードは\n既にご利用いただいております。\n\n1つのアカウントにつき1回限りの特典となっております🙇\n引き続きFurimAutoをよろしくお願いいたします！`,
  };
  const text = messages[result?.result] ?? '申し訳ございません。処理中にエラーが発生しました。';
  await lineClient.replyMessage(replyToken, [{ type: 'text', text } as never]);

  // kaisetsu フラグを書き込む（extended1w / extended3d のみ）
  if (db && (result?.result === 'extended1w' || result?.result === 'extended3d')) {
    try {
      const existing = await db.prepare('SELECT id, metadata FROM friends WHERE line_user_id = ?').bind(lineUserId).first<{ id: string; metadata: string }>();
      if (existing) {
        // クロージング用 trial_end はGASが書いた実際の新期限(newExpiry)をそのまま使う。
        // 旧実装の「今日+7日」自前計算はGAS（元期限+7日）と最大1日ズレていた。
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
        await db.prepare('UPDATE friends SET metadata = ?, updated_at = datetime("now", "+9 hours") WHERE id = ?')
          .bind(JSON.stringify(meta), existing.id).run();
        // 本編シナリオは停止しない（2026-08-24 一本化決定「seg8も本編継続」・2026-08-27 徹底）。
        // 旧実装はここで completeFriendActiveScenarios していたが、14日版シーケンスでは
        // Day6昼に「解説見た」を促すため、停止すると後半（全自動化教育）が丸ごと届かなくなる

        // 解説見たタグ付与
        const tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind('解説見た').first<{ id: string }>();
        if (tag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, datetime("now", "+9 hours"))').bind(existing.id, tag.id).run();

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
