/**
 * FurimAuto 統合版ステップ配信 Flexデザイン版の定義（2026-08-26 くろさん指示）
 *
 * 全配信をFlexバブルで囲い、テキストと画像を1枚のカードに統合する。
 * シナリオ種別ごとにヘッダー帯の色を変える（14日試用・2026-08-27〜）:
 *   無料ステップ（ウェルカム＋Day0〜4朝）   = グリーン #2FA25B（5段階画像の「ずっと無料」ゾーンと同色）
 *   段階ステップ（Day7〜12朝の全自動化教育） = オレンジ #F68A1D（ブランド色）
 *   15大特典への道（Day1〜6昼）           = レッド   #D94A3D
 *   クロージング（残5/3/2/1日）            = レッド   #D94A3D（締切）
 *
 * 設計ルール:
 * - Flex内テキストのURLはタップ不可のため、リンクは全てフッターのボタンに置く
 * - 画像は本文の該当位置にキャプション付きで埋め込む
 * - 「キーコード発行」ボタンは message action で『【リッチメニュー】キーコード発行』を
 *   送らせる（リッチメニュータップと同一テキスト→同一ハンドラが走る。実ログで確認済み）
 * - altText はプッシュ通知のプレビューになるため各バブルの見出しを入れる
 *
 * 文面の正: Vault marketing/furim-auto/2026-08-20-scenario-drafts.md（FIX済み文言を維持。
 * URL行のボタン化・画像位置キャプションのみ追加）
 *
 * 使い方:
 *   プレビュー生成: node scripts/furimauto-unified-flex.mjs <出力dir>
 *     → 出力dirに p000.json.. の送信ペイロード（📝区切りメモ込み）を書き出す
 *   本投入: seed-furimauto-unified-scenario.mjs 側からimportして使う（FIX後に配線）
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ──────────────── palette / helpers ────────────────

// 2026-08-27 くろさんFB: 昼の特典連載と朝の本編が同じオレンジで見分けづらい
//   → 15大特典への道=レッド / クロージング=ブラック に分離（計4色）
export const COLORS = { free: '#2FA25B', step: '#F68A1D', tokuten: '#D94A3D', closing: '#222222' };

const LINE_IMG = 'https://furimauto.com/line_images/';
const GCS_IMG = 'https://storage.googleapis.com/furimauto_line/images/messageEvent/';
const HOWTO_IMG = 'https://furimauto.com/howto/images/';
const PLAN_LIFF = 'https://liff.line.me/1660804123-ZfTZnrBV';

function band(color, label) {
  return {
    type: 'box', layout: 'vertical', backgroundColor: color, paddingAll: '12px',
    contents: [{ type: 'text', text: label, color: '#FFFFFF', weight: 'bold', size: 'sm', wrap: true }],
  };
}
function t(text, opts = {}) {
  return { type: 'text', text, size: 'sm', color: '#555555', wrap: true, ...opts };
}
function heading(text) {
  return t(text, { weight: 'bold', size: 'lg', color: '#333333' });
}
function caption(text, color = '#888888') {
  return t(text, { size: 'xs', color, margin: 'md' });
}
function captionStrong(text, color = '#D94A3D') {
  return t(text, { size: 'xs', color, weight: 'bold', margin: 'md' });
}
function bimg(url, ratio, margin) {
  return { type: 'image', url, size: 'full', aspectRatio: ratio, aspectMode: 'cover', ...(margin ? { margin } : {}) };
}
function hlBox(text, bg = '#FFF1EC', color = '#D94A3D', size = 'md') {
  return {
    type: 'box', layout: 'vertical', backgroundColor: bg, cornerRadius: '8px', paddingAll: '12px',
    contents: [t(text, { weight: 'bold', size, color })],
  };
}
function btn(label, action, { style = 'primary', color } = {}) {
  return { type: 'button', style, height: 'sm', ...(color ? { color } : {}), action };
}
function uriBtn(label, uri, opts) {
  return btn(label, { type: 'uri', label, uri }, opts);
}
function msgBtn(label, text, opts) {
  return btn(label, { type: 'message', label, text }, opts);
}
function bubble({ color, label, hero, body, footer }) {
  return {
    type: 'bubble', size: 'mega',
    header: band(color, label),
    ...(hero ? { hero } : {}),
    body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px', contents: body },
    ...(footer ? { footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer } } : {}),
  };
}
function flexMsg(altText, contents) {
  return { messageType: 'flex', messageContent: JSON.stringify({ type: 'flex', altText, contents }) };
}

// ボタンラベルは全角12文字以内（超えると端末幅によって「…」で途切れる・2026-08-27 くろさんFB）
const KEYCODE_BTN = msgBtn('キーコード発行', '【リッチメニュー】キーコード発行', { color: COLORS.step });
const SURVEY_BTN = msgBtn('アンケート開始（30秒）', '【ボタン】アンケート開始', { color: '#D94A3D' });
const INSTALL_BTN = uriBtn('拡張機能を導入（1分）', 'https://furimauto.com/install', { style: 'secondary' });
const PLAN_BTN = uriBtn('プラン診断をはじめる', PLAN_LIFF, { color: '#D94A3D' });
// 動画CTA（AIレビュー指摘対応・2026-08-27。文言はベネフィット型で各メッセージの流れに合わせる）
// 1分解説シリーズ再生リスト = クーポン導線（キーワードは動画内でのみ案内・配信文非開示の原則）
const YT_PLAYLIST = 'https://youtube.com/playlist?list=PLUhATsy78sfvUHMVmeQpKMyxATlHOCEeF&si=4ZT_HFKCIGcuHibG';
// 完全解説動画（長編）= 無料期間延長＋⑫⑬の導線
const FULL_VIDEO = 'https://youtu.be/jhaCPxgE_Sk';
const ytBtn = (label) => uriBtn(label, YT_PLAYLIST, { color: '#FF0000' });
const fullBtn = (label) => uriBtn(label, FULL_VIDEO, { color: '#FF0000' });

// ──────────────── ウェルカム（friend_add automation・無料ステップ） ────────────────

export const WELCOME_MESSAGES = [
  flexMsg('友だち追加ありがとうございます🎉 2週間の無料試用期間がスタートしました！', bubble({
    color: COLORS.free,
    label: 'FurimAuto｜ようこそ',
    body: [
      heading('友だち追加ありがとうございます🎉'),
      t('FurimAuto（フリマート）です。\n\nたった今からFurimAuto内の全ての機能を解放した【2週間の無料試用期間】がスタートしました！\n\nまずはChrome拡張機能の導入から。\n下の動画のとおりに進めるだけ、1分で終わります👇'),
    ],
    footer: [uriBtn('導入ページを開く', 'https://furimauto.com/install', { color: COLORS.free })],
  })),
  {
    messageType: 'video',
    messageContent: JSON.stringify({
      originalContentUrl: 'https://storage.googleapis.com/furimauto_line/video/install.mp4',
      previewImageUrl: 'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png',
      trackingId: 'setup',
    }),
  },
];

// ──────────────── 本編シナリオ（Day0=無料ステップ・Day1〜6=段階ステップ） ────────────────

// Day1 9:00 検索カードリサーチ（旧Day0+30分から移動・2026-08-27 14日化）
const set1 = flexMsg('【導入した瞬間から、変わります】無料のリサーチ機能がもう動いています', bubble({
  color: COLORS.free,
  label: '無料ステップ 1/3｜導入した瞬間から',
  body: [
    heading('導入した瞬間から、変わります'),
    t('拡張機能は導入できましたか？\n\n導入すると、無料のリサーチ機能があなたのメルカリですぐに動き始めます。\n\n試しに、メルカリで何か検索してみてください🔍'),
    caption('▼ 導入前の検索結果'),
    bimg(HOWTO_IMG + 'freeFeature_mercari_search_before.png', '2260:1760'),
    captionStrong('▼ 導入後：評価・本人確認・出品日時・SOLDの"売れた日時"が自動で追加'),
    bimg(HOWTO_IMG + 'freeFeature_mercari_search_after.png', '2260:1658'),
    t('設定も操作もいりません。\n「いつ・何が・どれだけ売れているか」が見えるだけで、仕入れの精度は大きく変わります。\n\nまだ導入がお済みでない方は、下のボタンから1分でどうぞ👇', { margin: 'md' }),
  ],
  footer: [INSTALL_BTN],
}));

// Day0 +30分（アンケートのみの軽量カード。リサーチ案内はDay1朝へ移動・2026-08-27 14日化）
const set0 = flexMsg('30秒だけください。1問だけアンケートにご協力お願いします', bubble({
  color: COLORS.free,
  label: 'FurimAuto｜30秒だけください',
  body: [
    heading('あなたに合ったご案内を\nお届けするために'),
    t('改めまして、FurimAutoです。\n\n1問だけアンケートにご協力お願いします（30秒で終わります）👇'),
  ],
  footer: [SURVEY_BTN],
}));

// Day0 +2時間（旧5通 → カルーセル1通＋特典1通）
const productCard = bubble({
  color: COLORS.free,
  label: '無料リサーチ｜商品ページ',
  hero: bimg(HOWTO_IMG + 'freeToolCard_overview.png', '1420:1536'),
  body: [
    heading('🔍 商品ページでできるリサーチ'),
    {
      type: 'box', layout: 'vertical', backgroundColor: '#FFF1EC', cornerRadius: '8px', paddingAll: '12px', spacing: 'xs',
      contents: [
        t('💰 出品者の"期間別売上金額"が見える', { weight: 'bold', size: 'md', color: '#D94A3D' }),
        t('直近90日の販売実績を自動表示。期間別に何個・いくら売れたかが丸わかりです。'),
      ],
    },
    {
      type: 'box', layout: 'vertical', backgroundColor: '#FFF6E5', cornerRadius: '8px', paddingAll: '12px', spacing: 'xs',
      contents: [
        t('📤 ワンクリックでコピー出品', { weight: 'bold', size: 'md', color: '#E8730C' }),
        t('メルカリの商品を、そのまま他のフリマサイトへ。出品し直しの手間がなくなります。'),
      ],
    },
    caption('ほかにも、8サイト横断リサーチ・商品画像の一括保存がこのカードから使えます。'),
  ],
});
const sellerCard = bubble({
  color: COLORS.free,
  label: '無料リサーチ｜出品者ページ',
  hero: bimg(HOWTO_IMG + 'shopResearch_panels.png', '2874:1630'),
  body: [
    heading('🏪 出品者ページでできるリサーチ'),
    t('参考にしたいアカウント、競合アカウントの"戦略"を丸裸にします。'),
    {
      type: 'box', layout: 'vertical', backgroundColor: '#FFF1EC', cornerRadius: '8px', paddingAll: '12px', spacing: 'xs',
      contents: [
        t('⚡ 数百ページを、数分で分析', { weight: 'bold', size: 'md', color: '#D94A3D' }),
        t('出品傾向・価格帯を自動で集計。手作業では追い切れない量を一気に分析できます。'),
      ],
    },
    {
      type: 'box', layout: 'vertical', backgroundColor: '#FFF6E5', cornerRadius: '8px', paddingAll: '12px', spacing: 'xs',
      contents: [
        t('⭐ 評価も、その場で確認', { weight: 'bold', size: 'md', color: '#E8730C' }),
        t('購入者からの評価一覧をページ内に表示。"信頼される売り方"まで研究できます。'),
      ],
    },
  ],
});
const set2a = {
  messageType: 'flex',
  messageContent: JSON.stringify({
    type: 'flex',
    altText: '【何が売れるかは、"事実"で分かります】無料リサーチの2枚のカードをどうぞ',
    contents: {
      type: 'carousel',
      contents: [
        bubble({
          color: COLORS.free,
          label: '無料ステップ 2/3｜何が売れるかを知る',
          body: [
            heading('何が売れるかは、"事実"で分かります'),
            t('勘で仕入れると、在庫が残ります。\n\n売れている人は「売れた事実」から逆算して仕入れています。\n\nFurimAutoの無料リサーチなら、その事実が、ぜんぶ見えます。'),
            hlBox('横にスワイプして、2つのリサーチカードをご覧ください →', '#F0FAF4', COLORS.free, 'sm'),
          ],
        }),
        productCard,
        sellerCard,
      ],
    },
  }),
};
const set2b = flexMsg('🎁 無料期間中に15大特典をGETしよう！', bubble({
  color: COLORS.free,
  label: '無料ステップ 2/3｜15大特典',
  hero: bimg('https://furimauto.com/service/images/special_offer.png', '1:1'),
  body: [
    t('そして、リサーチと一緒に受け取ってほしいものがあります🎁\n\n無料期間中に段階的に解放される【15大特典】です。物販ロードマップから撮影マニュアルまで。まずは"今すぐもらえる特典"からどうぞ👇', { color: '#333333' }),
    { type: 'separator', margin: 'md' },
    t('📦 今すぐもらえる特典', { weight: 'bold', color: '#333333', margin: 'md' }),
    btn('① ロードマップ❶（PDF）', { type: 'uri', label: '① ロードマップ❶（PDF）', uri: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B81%E3%83%AD%E3%83%BC%E3%83%88%E3%82%99%E3%83%9E%E3%83%83%E3%83%95%E3%82%9A%E2%9D%B6.pdf' }, { style: 'link' }),
    btn('② ロードマップ❷（PDF）', { type: 'uri', label: '② ロードマップ❷（PDF）', uri: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B82%E3%83%AD%E3%83%BC%E3%83%88%E3%82%99%E3%83%9E%E3%83%83%E3%83%95%E3%82%9A%E2%9D%B7.pdf' }, { style: 'link' }),
    { type: 'separator', margin: 'md' },
    t('🔓 使うほどもらえる特典（リッチメニューから）', { weight: 'bold', color: '#333333', margin: 'md' }),
    t('③④ ロードマップ❸❹\n⑤⑥ 撮影方法マニュアル 前編・後編\n⑦⑧ 外注化マニュアル 前編・後編\n⑨⑩ 外注募集テンプレ・業務委託契約書\n⑪ コメントセールの手法と効果の解説\n⑫⑬ 売れるブランドリスト・アカウント解説', { size: 'xs', color: '#444444' }),
    t('🎬 YouTube視聴＋キーワード入力でもらえる特典', { weight: 'bold', color: '#333333', margin: 'md' }),
    t('⑭ 初月半額クーポン\n⑮ 無料試用期間1週間延長', { size: 'xs', color: '#444444' }),
    caption('リッチメニューの「限定特典GET」をタップすると、あなたの利用状況に応じて次の特典が届きます！'),
  ],
}));

// Day0 +6時間（旧3通 → 2バブル）
// 2026-08-27 くろさんFB: コピー出品を主役に全面書き換え。競合ツールの不具合で
// 乗り換え先を探して来る顧客が多く、これ目当ての流入が多いため。付随機能は軽く触れるだけ
const set3a = flexMsg('【他サイトへの出品、ワンクリックで終わります】無料のコピー出品をご存知ですか', bubble({
  color: COLORS.free,
  label: '無料ステップ 3/3｜コピー出品',
  body: [
    heading('他サイトへの出品、ワンクリックで終わります'),
    t('リサーチで「売れるもの」が見えたら、次は出品です。\n\nFurimAutoの無料機能でいちばん人気なのが【コピー出品】。\n\nメルカリの商品ページからワンクリックで、メルカリShops・ラクマ・ヤフオク・Yahoo!フリマへそのままコピー出品できます。\n\nこの手動ワンクリックコピーは、無料で使えます。まとめて一気に出したくなったら、全自動の連続出品（チケット制）もあります──それはまた後日ご案内します。'),
    captionStrong('▼ 商品ページに出るツールカード。「コピー出品」から1クリックです', COLORS.free),
    bimg(HOWTO_IMG + 'freeToolCard_overview.png', '1420:1536'),
    caption('画像の一括保存・商品情報の追加表示・8サイト横断リサーチなどの無料機能も、このカードに揃っています。'),
    { type: 'separator', margin: 'md' },
    hlBox('ただ、正直にお伝えします。\nリサーチと出品が整っても、毎日の値下げ・コメント対応・取引メッセージは消えません。商品数が増えるほど、手が止まります。', '#FFF1EC', '#D94A3D', 'sm'),
    t('そこでFurimAutoの本体です。\nいまの無料期間中は、【自動化の全機能】もすべて使えます。\n\n発行は下のボタンをタップするだけ。\nクレジットカードの登録は不要、期間が終わっても勝手に課金されることはありません👇', { margin: 'md' }),
  ],
  footer: [KEYCODE_BTN],
}));
const set3b = flexMsg('【FurimAutoが、リサーチを無料で配る理由】少しだけ、私たちの話をさせてください', bubble({
  color: COLORS.free,
  label: 'FurimAutoの5段階',
  body: [
    heading('FurimAutoが、リサーチを無料で配る理由'),
    t('少しだけ、私たちの話をさせてください。\n\nFurimAutoは、現役のフリマ物販プレイヤーが作っている自動化ツールです。\n\n先に、身も蓋もない事実からお伝えします。\n\nフリマ物販に適したジャンルは、すでに世の中に出きっています。\n\nそして、いま売上が立っているアカウントこそが"答え合わせの済んだ成功例"です。\n\nだから、自分に合ったジャンルのトッププレイヤーを丸ごと真似する。それだけの、シンプルな事業です。\n\nオリジナリティは、むしろ邪魔になります。'),
    hlBox('私たちが「今のフリマサイトでの成功の順番」だと確信しているのが、この5段階です。重要度も、①から順になっています。', '#F0FAF4', COLORS.free, 'sm'),
    t('① 何が売れるかを、事実で知る\n② 売れる商品を仕入れて、\n　いい写真・丁寧な情報を添えて出品する\n③ 毎日の作業を自動化して、売上を継続させる\n④ 販路を広げて、売上の上限を外す\n⑤ 増えた在庫を、事故なく回す', { color: '#333333', weight: 'bold' }),
    t('リサーチせずに仕入れた在庫は残ります。\n1つのサイトだけの運用には、天井が来ます。\n\nFurimAutoはこの5段階を、ぜんぶ1つの拡張機能に入れました。\n\nそして──\n入り口の①と②は、無料です。\n無料期間が終わっても、ずっと無料のままです。\n\nなぜそんなことをするのか。\n\nお金をお支払いいただいて活用してほしいのは、\n「商品が増えて、手が回らなくなった時」\nその時だけだからです。\n\nお客様のニーズは、百種百様です。\n商材・戦略・資金力・お使いのPCスペックまで、すべて異なります。\n\nそのニーズに応えられるように、FurimAutoは様々なサービス・機能を用意しています。\n\n"人手が欲しくなった作業"から、少しずつ任せてください。\n\nあなたが売れる。忙しくなる。\n「もう手作業には戻れない」と感じる。\nその時はじめて、次の段が目の前に現れる。\n\nFurimAutoは、そういう順番で使ってもらえるように作られています。\n\nさて、いまのあなたは、どの段にいますか？👇'),
    bimg(LINE_IMG + 'roadmap_5steps.png', '1:1', 'md'),
  ],
}));

// Day1 9:00（旧2通 → 1バブル）
const d1m = flexMsg('おはようございます☀ 今日はまず、この1分動画だけ見てください', bubble({
  color: COLORS.step,
  label: 'DAY 7｜1分で分かる全自動化',
  hero: {
    type: 'image', url: 'https://img.youtube.com/vi/uQjheVeAuww/maxresdefault.jpg',
    size: 'full', aspectRatio: '16:9', aspectMode: 'cover',
    action: { type: 'uri', uri: 'https://www.youtube.com/watch?v=uQjheVeAuww' },
  },
  body: [
    heading('おはようございます☀'),
    t('FurimAutoです。\n\n今日はまず、この動画だけ見てください。\n\nFurimAutoが目指す「全自動化」──新規出品と梱包発送以外の毎日の作業をぜんぶ任せる、という世界が1分で分かります。'),
    t('長ったらしい説明はナシ！です🙅‍♀️\n使い方と他社ツールと比べた特徴を1分でまとめました!!', { size: 'xs', color: '#888888', margin: 'md' }),
  ],
  footer: [uriBtn('YouTubeで見る', 'https://www.youtube.com/watch?v=uQjheVeAuww', { color: '#FF0000' })],
}));

// Day1 13:00
const d1n = flexMsg('【15大特典への道 1/6】今日のミッション: 1問アンケートに回答（30秒）', bubble({
  color: COLORS.tokuten,
  label: '15大特典への道 1/6',
  body: [
    t('FurimAutoです🎁\n\n無料期間中に集められる15大特典、①②のロードマップは受け取りましたか？'),
    hlBox('今日のミッション🎯\n▶ 1問アンケートに回答（30秒）', '#FFF6E5', '#E8730C', 'sm'),
    t('クリアでもらえる特典\n📘 ③ ロードマップ❸\n📘 ④ ロードマップ❹\n\n物販で稼ぐ道筋の"続き"です。\n今朝ご案内したリサーチ機能とセットでどうぞ。\n\n特典の受け取りは、リッチメニューの「限定特典GET」をタップ👇', { margin: 'md' }),
  ],
  footer: [SURVEY_BTN],
}));

// Day2 9:00（旧3通 → 1バブル）
const d2m = flexMsg('【値下げと再出品は、何のためにやるのか】フリマサイト内のSEO対策の話です', bubble({
  color: COLORS.step,
  label: 'DAY 8｜今日はここ：出品一覧ページ',
  hero: bimg(LINE_IMG + 'pages3_day2.png', '1:1'),
  body: [
    heading('値下げと再出品は、何のためにやるのか'),
    t('先に言い切ります。\n値下げや再出品を"するだけ"で売れるわけではありません。\n\nでも、フリマサイトにははっきりした傾向があります。\n\n値下げ・再出品をした商品は検索結果の上位に戻り、閲覧数が増え、いいねが集まる。'),
    hlBox('つまりこれは【フリマサイト内のSEO対策】です'),
    bimg(LINE_IMG + 'seo_cycle.png', '1:1', 'md'),
    t('問題は、それを毎日手作業で続けられるか、です。\n\nFurimAutoなら、出品一覧ページの作業──値下げ・再出品・コメント管理・底値設定──を日時指定でまとめて予約でき、継続的に自動化できます。\n\nたとえば毎日の値段変更の予約の合間に、再出品を「朝10品・夜10品」で予約するだけで、1日20商品×30日、1ヶ月で約600品をフレッシュな商品ページとして回せます。', { margin: 'md' }),
    hlBox('今日はまず、自動値下げか自動再出品をどちらか1つだけ予約してみてください😊', '#FFF6E5', '#333333', 'sm'),
  ],
  footer: [ytBtn('いいね対応の設定を見る')],
}));

// Day2 13:00
const d2n = flexMsg('【15大特典への道 2/6】今日のミッション: キーコードを発行する（無料・30秒）', bubble({
  color: COLORS.tokuten,
  label: '15大特典への道 2/6',
  body: [
    t('いい商品も、写真が悪いと売れません📷'),
    hlBox('今日のミッション🎯\n▶ キーコードを発行する（無料・30秒）', '#FFF6E5', '#E8730C', 'sm'),
    t('クリアでもらえる特典\n📕 ⑤ 撮影方法マニュアル 前編\n📕 ⑥ 撮影方法マニュアル 後編\n\n"売れる写真"の撮り方を体系化した教材です。\n出品の質が、今日から変わります。\n\n発行は下のボタンから。特典はリッチメニューの「限定特典GET」から受け取れます👇', { margin: 'md' }),
  ],
  // 利用方法説明書ボタン: キーコード発行の応答をコードのみに変えた(2026-08-27)ため、
  // 発行文脈のこのカードに設定手順への導線を持たせる
  footer: [KEYCODE_BTN, uriBtn('利用方法説明書を見る', 'https://furimauto.com/howto/index.html', { style: 'secondary' })],
}));

// Day3 9:00（旧3通 → 1バブル）
const d3m = flexMsg('【売る側は高く、買う側は安くのギャップがチャンス】自動いいね対応の話です', bubble({
  color: COLORS.step,
  label: 'DAY 9｜今日はここ：お知らせページ',
  hero: bimg(LINE_IMG + 'pages3_day3.png', '1:1'),
  body: [
    heading('売る側は高く、買う側は安くのギャップがチャンス'),
    t('物販の売上は、突き詰めるとこの綱引きです。\n\n売る側は、できるだけ高く売りたい。\n買う側は、できるだけ安く買いたい。\n\nこの"価格のギャップ"をどれだけ上手に詰められるかが、フリマサイトで売上を伸ばすいちばん大事な施策です。\n\nそして、昨日お伝えしたSEOで閲覧といいねを集めた"その先"にあるのが【価格交渉】です。'),
    bimg(LINE_IMG + 'price_gap.png', '1:1', 'md'),
    t('いいねを付けた人は、「気になっているけど、あと一歩」の人。\n\nその人に向けてセールコメントを投稿し、こちらから能動的に"交渉の場"へお客さんを連れてくる──それがFurimAutoの【自動いいね対応】です。\n\n商品にいいねが付いたら、その人に向けたセールコメントを自動で投稿。\n\n買い手は少し安く買えて、あなたの在庫は現金に変わる。', { margin: 'md' }),
    hlBox('ギャップが縮まる瞬間を、体験してみてください😊', '#FFF6E5', '#333333', 'sm'),
  ],
  footer: [ytBtn('予約のやり方を動画で見る')],
}));

// Day3 13:00
const d3n = flexMsg('【15大特典への道 3/6】今日のミッション: キーコードを拡張機能に入力して自動化を1つ実行', bubble({
  color: COLORS.tokuten,
  label: '15大特典への道 3/6',
  body: [
    t('昨日発行したキーコード、もう使ってみましたか？'),
    hlBox('今日のミッション🎯\n▶ 発行したキーコードを拡張機能に入力して\n　自動化を1つ実行する', '#FFF6E5', '#E8730C', 'sm'),
    t('クリアでもらえる特典\n📗 ⑦ 外注化マニュアル 前編\n📗 ⑧ 外注化マニュアル 後編\n\n自分の作業を"人に任せる"仕組み化の教科書。\n自動化と外注化で、稼働はさらに減らせます。\n\n受け取りはリッチメニューの「限定特典GET」をタップ👇', { margin: 'md' }),
  ],
}));

// Day4 9:00（旧3通 → 1バブル）
const d4m = flexMsg('【売れるほど、忙しくなる問題】取引メッセージも自動化できます', bubble({
  color: COLORS.step,
  label: 'DAY 10｜今日はここ：取引中ページ',
  hero: bimg(LINE_IMG + 'pages3_day4.png', '1:1'),
  body: [
    heading('売れるほど、忙しくなる問題'),
    t('ここまでの自動化（値段変更・セールコメント施策・再出品）がうまく回り始めると、閲覧が増え、いいねが増え、月間の取引数も増えやすくなります。\n\nすると、次に重くなるのが──\n【取引メッセージのやり取り】です。\n\n購入のお礼、発送のご連絡、受取確認。\n\nメッセージ1通の処理は、スマホでコピペしても1分〜1分半。1つの取引で3〜4通やり取りするので、取引1件あたり4〜5分かかる計算です。'),
    bimg(LINE_IMG + 'msg_workload.png', '1:1', 'md'),
    t('取引が増えるほど、これが毎日積み上がっていきます。\n\nFurimAutoは、ここも自動化できます。\n\n取引メッセージを自動で送信。対応の早い出品者として購入者からの印象・評価にもつながります。', { margin: 'md' }),
    hlBox('売れるほど、ラクになる。\n全自動化の完成が、近づいてきました。', '#FFF6E5', '#333333', 'sm'),
  ],
  footer: [ytBtn('取引自動化の設定を見る')],
}));

// Day4 13:00（旧2通 → 2バブル維持: ミッション＋チケット）
const d4n1 = flexMsg('【15大特典への道 4/6】今日のミッション: 無料チケット30枚を受け取ってコピー出品を試す', bubble({
  color: COLORS.tokuten,
  label: '15大特典への道 4/6',
  body: [
    t('無料のコピー出品チケット30枚、もう受け取りましたか？🎫'),
    hlBox('今日のミッション🎯\n▶ 無料チケット30枚を受け取って\n　自動コピー出品を試す', '#FFF6E5', '#E8730C', 'sm'),
    t('クリアでもらえる特典\n📄 ⑨ 外注募集テンプレート\n📄 ⑩ 外注先業務委託契約書テンプレ\n\n昨日のマニュアルを"今日から実行"できる実物のテンプレートです。\n\nチケットは下のカードから、特典はリッチメニューの「限定特典GET」から👇', { margin: 'md' }),
  ],
}));
const d4n2 = flexMsg('コピー出品チケット30枚無料でプレゼント！', bubble({
  color: COLORS.tokuten,
  label: 'コピー出品チケット30枚 無料',
  hero: bimg(GCS_IMG + 'copy_function.png', '16:9'),
  body: [
    heading('コピー出品チケット30枚無料でプレゼント！'),
    t('🎉【30枚のコピー出品チケットを無料でプレゼント！】🎉\n\nこのチケットは【全自動の連続コピー出品】に使えます。メルカリShops・ラクマ・ヤフオク・Yahoo!フリマへ、1品の出品完了ごとに1枚消費。\n\n手動のワンクリックコピーはチケット不要・無料のままです。自動コピー出品だけなら、サブスクプランへの加入も不要🙅‍♀️\n\n💬下のボタンをタップした後、キーコードの入力ボタンを押すだけですぐにご利用いただけます！'),
  ],
  footer: [msgBtn('GETする', '【ボタン】コピー出品チケット30枚GET', { color: COLORS.step })],
}));

// Day5 9:00（旧2通 → 1バブル）
const d5m = flexMsg('【1つのサイトで回ったら、次のステージへ】販路拡大はコピー出品で', bubble({
  color: COLORS.step,
  label: 'DAY 11｜販路拡大',
  body: [
    heading('1つのサイトで回ったら、次のステージへ'),
    t('メルカリの運用が自動で回るようになったら、次にやるべきは【販路拡大】です。\n\n同じ商品でも、サイトが違えばお客さんも違う。出す場所を増やすだけで、売れるチャンスは単純に増えます。\n\n「でも、他のサイトに出品し直すのは面倒…」\n\nFurimAutoなら、メルカリの商品データをもとに他のフリマサイトへ一気にコピー出品できます。'),
    bimg(LINE_IMG + 'copy_compare.png', '1:1', 'md'),
    t('・手動のワンクリックコピーは、無料で使えます\n・全自動の連続出品は、1品あたり10〜15円のチケット制（Day4で配った無料30枚も使えます）', { margin: 'md' }),
    hlBox('販路拡大は、思っているよりずっと簡単です。\nまずは1品だけ、試しにコピーしてみてください😊', '#FFF6E5', '#333333', 'sm'),
  ],
  footer: [ytBtn('コピー出品のやり方を見る')],
}));

// Day5 13:00（旧3通 → 1バブル）
const d5n = flexMsg('【15大特典への道 5/6】今日のミッション: YouTube動画講座を見てキーワードを送る', bubble({
  color: COLORS.tokuten,
  label: '15大特典への道 5/6',
  body: [
    hlBox('今日のミッション🎯\n▶ YouTube動画講座を見て、\n　動画内のキーワードをこのLINEに送る', '#FFF6E5', '#E8730C', 'sm'),
    t('クリアでもらえる特典\n📙 ⑪ コメントセールの手法と効果の解説\n\n商品にいいねした人へ"追いセールコメント"を打つ手法を深掘りした資料です。値引き幅の考え方まで分かります。\n\n動画講座は下のボタンからどうぞ👇', { margin: 'md' }),
    bimg(GCS_IMG + 'youtube_coupon.png', '16:9', 'md'),
    hlBox('【お得に使えるクーポンをGET!!】\n動画内のキーワードをLINEに送っていただいた方には、\n・友達登録から1週間以内 → 月額半額クーポン\n・それ以外 → 月額20%引きクーポン\nをそれぞれプレゼントいたします！', '#FFF1EC', '#D94A3D', 'sm'),
  ],
  footer: [ytBtn('半額クーポンを獲得する！')],
}));

// Day6 9:00（旧2通 → 1バブル）
const d6m = flexMsg('【最後の壁は、在庫管理】自動併売在庫管理で売り違いは構造的に起きません', bubble({
  color: COLORS.step,
  label: 'DAY 12｜最後の壁は在庫管理',
  body: [
    heading('最後の壁は、在庫管理'),
    t('販路を広げると、最後にぶつかる壁があります。\n\n「メルカリで売れたのに、ラクマにも出したままだった…」\n\n複数サイトでの在庫管理は地味で、そしてミスが命取りです。\n\nFurimAutoの【自動併売在庫管理】は、どこかのサイトで売れたら、他のサイトの同じ商品を自動で取り下げます。'),
    bimg(LINE_IMG + 'inventory_sync.png', '1:1', 'md'),
    t('売り違いの恐怖から解放されて、あなたがやるのは仕入れて、出品して、発送するだけ。\n\nリサーチ → 出品 → 自動化 → 販路拡大 → 在庫管理。\n\nこの2週間でご案内した階段をのぼり切ると、"片手間なのに、ちゃんと伸びる物販"が完成します。', { margin: 'md' }),
    hlBox('その形、このまま続けませんか？\n今夜、継続してご利用になりたい方へ向けたご案内をお送りします😊', '#FFF6E5', '#333333', 'sm'),
  ],
  footer: [ytBtn('在庫管理の始め方を見る')],
}));

// Day6 13:00
const d6n = flexMsg('【15大特典への道 6/6】最終日。いちばん大きい特典です', bubble({
  color: COLORS.tokuten,
  label: '15大特典への道 6/6',
  body: [
    t('最終日。いちばん大きい特典です。'),
    hlBox('今日のミッション🎯\n▶ 完全解説動画を見て、動画内で案内される\n　キーワードをこのLINEに送る', '#FFF6E5', '#E8730C', 'sm'),
    t('クリアでもらえる特典\n📒 ⑫ 売れるブランドリスト\n📒 ⑬ 売れるアカウント説明&プロフィール解説', { margin: 'md' }),
    hlBox('さらに──\n🎁 無料試用期間が1週間延長されます', '#FFF1EC', '#D94A3D', 'sm'),
    t('「まだ試し切れていない」という方も、これでもう1週間、じっくり使えます。\n\n完全解説動画は下のボタンから。動画内で案内されるキーワードを送るだけです👇', { margin: 'md' }),
  ],
  footer: [fullBtn('無料期間を延長する！')],
}));

// 14日試用の分散スケジュール（2026-08-27 くろさん決定）
// Week1(Day0-6)=無料機能＋15大特典への道 / Week2(Day7-12)=全自動化教育。
// クロージングは残日数駆動（14日試用では残5日=Day9夜・残3日=Day11夜・残2日=Day12夜・残1日=Day13夜）
export const SETS = [
  { schedule: { offsetDays: 0, offsetMinutes: 30 }, label: 'Day0+30分 アンケート', messages: [set0] },
  { schedule: { offsetDays: 1, deliveryTime: '09:00' }, label: 'Day1朝 検索カードリサーチ', messages: [set1] },
  { schedule: { offsetDays: 1, deliveryTime: '13:00' }, label: 'Day1昼 特典への道1/6', messages: [d1n] },
  { schedule: { offsetDays: 2, deliveryTime: '09:00' }, label: 'Day2朝 リサーチカルーセル＋15大特典', messages: [set2a, set2b] },
  { schedule: { offsetDays: 2, deliveryTime: '13:00' }, label: 'Day2昼 特典への道2/6', messages: [d2n] },
  { schedule: { offsetDays: 3, deliveryTime: '09:00' }, label: 'Day3朝 コピー出品', messages: [set3a] },
  { schedule: { offsetDays: 3, deliveryTime: '13:00' }, label: 'Day3昼 特典への道3/6', messages: [d3n] },
  { schedule: { offsetDays: 4, deliveryTime: '09:00' }, label: 'Day4朝 FurimAutoの5段階', messages: [set3b] },
  { schedule: { offsetDays: 4, deliveryTime: '13:00' }, label: 'Day4昼 特典への道4/6＋チケット', messages: [d4n1, d4n2] },
  { schedule: { offsetDays: 5, deliveryTime: '13:00' }, label: 'Day5昼 特典への道5/6', messages: [d5n] },
  { schedule: { offsetDays: 6, deliveryTime: '13:00' }, label: 'Day6昼 特典への道6/6', messages: [d6n] },
  { schedule: { offsetDays: 7, deliveryTime: '09:00' }, label: 'Day7朝 全自動化1分動画', messages: [d1m] },
  { schedule: { offsetDays: 8, deliveryTime: '09:00' }, label: 'Day8朝 フリマSEO', messages: [d2m] },
  { schedule: { offsetDays: 9, deliveryTime: '09:00' }, label: 'Day9朝 価格ギャップ', messages: [d3m] },
  { schedule: { offsetDays: 10, deliveryTime: '09:00' }, label: 'Day10朝 取引メッセージの重荷', messages: [d4m] },
  { schedule: { offsetDays: 11, deliveryTime: '09:00' }, label: 'Day11朝 販路拡大', messages: [d5m] },
  { schedule: { offsetDays: 12, deliveryTime: '09:00' }, label: 'Day12朝 在庫管理', messages: [d6m] },
];

// ──────────────── クロージング（closing_daily・レッド） ────────────────

// automation経路(event-bus)のflexは「contentsのみ+altText別持ち」形式。
// ラッパー({"type":"flex",...})を渡すと二重ラップでLINE APIに拒否されるため、ここで剥がす
function closingMsg(altText, contents) {
  return { messageType: 'flex', altText, content: JSON.stringify(contents) };
}

/** WELCOME_MESSAGES(シナリオ形式)をautomation params形式に変換する */
export function welcomeAsAutomationMessages() {
  return WELCOME_MESSAGES.map((m) => {
    if (m.messageType !== 'flex') return { messageType: m.messageType, content: m.messageContent };
    const parsed = JSON.parse(m.messageContent);
    return { messageType: 'flex', altText: parsed.altText, content: JSON.stringify(parsed.contents) };
  });
}

export const CLOSING_ACTIONS = [
  {
    stepOrder: 0,
    label: '残5日: 現在地の確認（Flex版）',
    condition: { remaining_days_gte: 5, remaining_days_lte: 5 },
    messages: [
      closingMsg('【現在地の確認です】無料期間は残り5日になりました', bubble({
        color: COLORS.closing,
        label: '無料期間 残り5日',
        body: [
          heading('現在地の確認です'),
          t('FurimAutoです。\n無料期間は残り5日になりました。\n\nいま、自分がどこまで来たか確認してみてください。'),
          hlBox('✅ リサーチで売れるものが分かる（無料）\n✅ 出品まわりの補助機能（無料）\n⬜ 値下げ・再出品などの自動化（無料期間中に体験できます）\n⬜ コピー出品での販路拡大\n⬜ 併売の在庫管理', '#FFF6E5', '#333333', 'sm'),
          t('正直にお伝えすると、基本のリサーチと出品まわりの機能は期間が終わっても無料のまま使えます。\n\n有料になるのは「自動化」から先です。\n\n残り5日。まだ試していない自動化があれば、今のうちに動かしてみてください。\n\n「使い方がよく分からない…」という方は、【Youtube動画講座】が近道です🎬\n入門から上級まで、段階的に理解できます👇', { margin: 'md' }),
          t('"手放せるかどうか"は、体験した人にしか分かりません。', { color: '#333333', weight: 'bold', margin: 'md' }),
        ],
        footer: [ytBtn('使い方を動画講座で見る')],
      })),
    ],
  },
  {
    stepOrder: 1,
    label: '残3日: 時給換算＋クーポン導線（Flex版）',
    condition: { remaining_days_gte: 3, remaining_days_lte: 3 },
    messages: [
      closingMsg('【時給換算、してみませんか】いちばんお得に始める方法をご案内します', bubble({
        color: COLORS.closing,
        label: '無料期間 残り3日',
        body: [
          heading('時給換算、してみませんか'),
          t('毎日の値下げ・コメント・取引メッセージ。\n仮に1日30分なら、1ヶ月で約15時間です。\n\n時給1,000円で換算すると、月15,000円ぶん。\n\nFurimAutoの自動化は最安480円/月〜から始められます。'),
          hlBox('そして、いちばんお得に始める方法がこちら🎁\nリッチメニューの【Youtube動画講座】を見て、動画内で案内されるキーワードをこのLINEに送ってください。', '#FFF1EC', '#D94A3D', 'sm'),
          bimg(GCS_IMG + 'youtube_coupon.png', '16:9', 'md'),
          t('【お得に使えるクーポンをGET!!】\n\n動画内のキーワードをLINEに送っていただいた方には、\n\n・友達登録から1週間以内 → 月額半額クーポン\n・それ以外 → 月額20%引きクーポン\n\nをそれぞれプレゼントいたします！\n\nFurimAutoの"全自動化"を理解できるうえに、初回決済で使える割引クーポンが届きます👇', { margin: 'md' }),
        ],
        footer: [ytBtn('割引クーポンを獲得する'), PLAN_BTN],
      })),
    ],
  },
  {
    stepOrder: 2,
    label: '残2日: 登録は簡単（Flex版）',
    condition: { remaining_days_gte: 2, remaining_days_lte: 2 },
    messages: [
      closingMsg('【登録は、思っているより簡単です】最短3分で自動化がそのまま続きます', bubble({
        color: COLORS.closing,
        label: '無料期間 残り2日',
        body: [
          heading('登録は、思っているより簡単です'),
          t('「手続きが面倒そう」と思っていませんか？\n\nFurimAutoの登録に、説明会や面談はありません。'),
          hlBox('① プラン診断で自分に合うプランを確認（1分）\n② そのまま画面から申し込み\n③ クレジットカード決済で完了', '#FFF6E5', '#333333', 'sm'),
          t('これだけです。最短3分で、いま体験中の自動化がそのまま続きます。\n\n無料期間は残り2日。\nプラン選びに迷ったら、このLINEにそのまま返信してください😊', { margin: 'md' }),
        ],
        footer: [PLAN_BTN],
      })),
    ],
  },
  {
    stepOrder: 3,
    label: '残1日: 本日で無料期間終了（Flex版）',
    condition: { remaining_days_gte: 1, remaining_days_lte: 1 },
    messages: [
      closingMsg('【本日で無料期間が終了します】最後にもう一度だけ、背中を押させてください', bubble({
        color: COLORS.closing,
        label: '本日で無料期間終了',
        body: [
          heading('本日で無料期間が終了します'),
          t('FurimAutoです。\n\n明日以降、キーコードが無効になり、設定済みの自動化（値下げ・再出品・いいね対応など）は停止します。'),
          hlBox('ただ、ご安心ください。\nリサーチなどの無料機能はこれからも、ずっと使えます。', '#F0FAF4', '#2FA25B', 'sm'),
          t('そのうえで──\n\nこの2週間で「もう手作業には戻りたくない」と感じたなら、それが答えだと思います。\n\n登録はプラン診断から最短3分。\n\nまだ迷いがある方は、完全解説動画をどうぞ。動画内で案内されるキーワードを送ると、無料試用期間の延長も受け取れます。\n\n最後にもう一度だけ、背中を押させてください👇', { margin: 'md' }),
        ],
        footer: [
          fullBtn('無料期間を延長する！'),
          PLAN_BTN,
        ],
      })),
    ],
  },
];

// ──────────────── プレビュー出力 ────────────────

const outDir = process.argv[2];
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  const payloads = [];
  const memo = (text) => payloads.push({ messageType: 'text', content: `📝 ${text}` });
  // プレビュー送信先の /api/chats/:id/send はFlexの「contents のみ」を期待する
  // （{"type":"flex","altText",...} のラッパーを渡すと二重ラップでLINE APIに拒否される）
  const push = (m) => {
    let content = m.messageContent ?? m.content;
    if (m.messageType === 'flex') {
      const parsed = JSON.parse(content);
      if (parsed && parsed.type === 'flex' && parsed.contents) content = JSON.stringify(parsed.contents);
    }
    payloads.push({ messageType: m.messageType, content });
  };

  memo('【Flexデザイン版・全通プレビュー】ここから順に本番と同じ内容を送ります。帯色: 緑=無料ステップ／オレンジ=段階ステップ／赤=クロージング');
  memo('▼ ウェルカム（友だち追加の瞬間・2通）');
  WELCOME_MESSAGES.forEach(push);
  for (const set of SETS) {
    memo(`▼ ${set.label}`);
    set.messages.forEach(push);
  }
  for (const a of CLOSING_ACTIONS) {
    memo(`▼ クロージング ${a.label}`);
    a.messages.forEach(push);
  }
  memo('プレビューは以上です（計' + payloads.length + '通・メモ含む）。FBください！');

  payloads.forEach((p, i) => {
    writeFileSync(join(outDir, `p${String(i).padStart(3, '0')}.json`), JSON.stringify(p, null, 0));
  });
  console.log(`${payloads.length} payloads -> ${outDir}`);
}
