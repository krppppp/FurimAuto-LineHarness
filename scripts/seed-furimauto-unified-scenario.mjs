#!/usr/bin/env node
/**
 * FurimAuto 統合版シナリオ投入SQL生成スクリプト（2026-08-24 シナリオ一本化）
 *
 * 旧14本（通常/紹介×セグメント1-7）を置き換える1本のシナリオと、
 * friend_add / closing_daily オートメーションの更新SQLを生成する。
 *
 * 文面の正: Vault `.claude-company/departments/marketing/furim-auto/2026-08-20-scenario-drafts.md`
 * 設計の正: 同 `2026-08-20-scenario-redesign.md`
 *
 * 使い方:
 *   node scripts/seed-furimauto-unified-scenario.mjs
 *   → scripts/data/unified-scenario.gen.sql（シナリオ本体＋39ステップ）
 *   → scripts/data/unified-automations.gen.sql（friend_add組み替え＋closing差し替え）
 *
 *   適用（workerを先にデプロイしておく。elapsed+deliveryTime対応が必要）:
 *     npx wrangler d1 execute <db名> --remote --file scripts/data/unified-scenario.gen.sql
 *     npx wrangler d1 execute <db名> --remote --file scripts/data/unified-automations.gen.sql
 *   旧14本の無効化SQL（標準出力に表示）は本番有効化の号令が出てから流す。
 *
 * 注意: 生成SQLは冪等ではない。同じDBに2回流すと scenario/automation が二重になる。
 * 流す前に `SELECT id FROM scenarios WHERE name = 'FurimAuto ステップ配信 統合版'` で確認すること。
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCENARIO_NAME = 'FurimAuto ステップ配信 統合版';

// ──────────────── message helpers ────────────────

function txt(text) {
  return { messageType: 'text', messageContent: text };
}
function img(url) {
  return { messageType: 'image', messageContent: JSON.stringify({ originalContentUrl: url, previewImageUrl: url }) };
}
function vid(originalContentUrl, previewImageUrl, trackingId) {
  return { messageType: 'video', messageContent: JSON.stringify({ originalContentUrl, previewImageUrl, trackingId }) };
}
function flex(altText, contents) {
  return { messageType: 'flex', messageContent: JSON.stringify({ type: 'flex', altText, contents }) };
}

// ──────────────── Flex 素材（既存資産・本番D1/コードから回収した実物） ────────────────

const youtubeFlex = {"type":"bubble","hero":{"type":"image","url":"https://img.youtube.com/vi/uQjheVeAuww/maxresdefault.jpg","size":"full","aspectRatio":"16:9","aspectMode":"cover","action":{"type":"uri","uri":"https://www.youtube.com/watch?v=uQjheVeAuww"}},"body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"FurimAuto紹介動画","weight":"bold","size":"xl","wrap":true},{"type":"text","text":"1番初めに見るべき動画はコレ👆👆👆\n\n長ったらしい説明はナシ！です🙅‍♀️\n\nFurimAutoの使い方と\n他者ツールと比べた特徴を\n1分でまとめました!!\n\n断言しますが\nこのツールより簡単で\n全局面での自動化を実現した\n自動化ツールはこの世にはないです🤫","size":"sm","color":"#666666","margin":"md","wrap":true}]},"footer":{"type":"box","layout":"vertical","spacing":"sm","contents":[{"type":"button","style":"primary","height":"sm","action":{"type":"uri","label":"YouTubeで見る","uri":"https://www.youtube.com/watch?v=uQjheVeAuww"},"color":"#FF0000"}]}};

const tokutenFlex = {"type":"bubble","hero":{"type":"image","url":"https://furimauto.com/service/images/special_offer.png","size":"full","aspectRatio":"1:1","aspectMode":"cover"},"body":{"type":"box","layout":"vertical","spacing":"md","contents":[{"type":"text","text":"🎁 無料期間中に15大特典をGETしよう！","weight":"bold","size":"lg","wrap":true,"color":"#FF6B35"},{"type":"text","text":"友達登録から1週間の無料試用期間中に、段階的に15種類の特典をプレゼントします！","size":"sm","color":"#555555","wrap":true,"margin":"sm"},{"type":"separator","margin":"md"},{"type":"box","layout":"vertical","margin":"md","spacing":"xs","contents":[{"type":"text","text":"📦 今すぐもらえる特典","weight":"bold","size":"sm","color":"#333333"},{"type":"button","style":"link","height":"sm","margin":"xs","action":{"type":"uri","label":"① ロードマップ❶ ダウンロード","uri":"https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B81%E3%83%AD%E3%83%BC%E3%83%88%E3%82%99%E3%83%9E%E3%83%83%E3%83%95%E3%82%9A%E2%9D%B6.pdf"}},{"type":"button","style":"link","height":"sm","action":{"type":"uri","label":"② ロードマップ❷ ダウンロード","uri":"https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B82%E3%83%AD%E3%83%BC%E3%83%88%E3%82%99%E3%83%9E%E3%83%83%E3%83%95%E3%82%9A%E2%9D%B7.pdf"}}]},{"type":"box","layout":"vertical","margin":"md","spacing":"xs","contents":[{"type":"text","text":"🔓 使うほどもらえる特典（リッチメニューから）","weight":"bold","size":"sm","color":"#333333","wrap":true},{"type":"text","text":"③ ロードマップ❸","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"④ ロードマップ❹","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑤ 撮影方法マニュアル前編","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑥ 撮影方法マニュアル後編","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑦ 外注化マニュアル前編","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑧ 外注化マニュアル後編","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑨ 外注募集テンプレート","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑩ 外注先業務委託契約書テンプレ","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑪ コメントセールの手法と効果の解説","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑫ 売れるブランドリスト","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑬ 売れるアカウント説明&プロフィール解説","size":"sm","color":"#444444","margin":"xs","wrap":true}]},{"type":"box","layout":"vertical","margin":"md","spacing":"xs","contents":[{"type":"text","text":"🎬 YouTubeを視聴の上キーワード入力でもらえる特典","weight":"bold","size":"sm","color":"#333333","wrap":true},{"type":"text","text":"⑭ 初月半額クーポン","size":"sm","color":"#444444","margin":"xs"},{"type":"text","text":"⑮ 無料試用期間1週間延長","size":"sm","color":"#444444"}]},{"type":"separator","margin":"md"},{"type":"text","text":"リッチメニューの「限定特典GET」をタップすると、あなたの利用状況に応じて次の特典が届きます！","size":"xs","color":"#888888","wrap":true,"margin":"md"}]}};

const surveyFlex = {"type":"bubble","hero":{"type":"image","url":"https://storage.googleapis.com/furimauto_line/images/messageEvent/follow_event_img3.png","size":"full","aspectRatio":"16:9","aspectMode":"cover"},"body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"▼ 1問アンケートはこちら ▼","weight":"bold","size":"lg","wrap":true,"align":"center"}]},"footer":{"type":"box","layout":"vertical","spacing":"sm","contents":[{"type":"button","style":"primary","height":"sm","action":{"type":"message","label":"開始する","text":"【ボタン】アンケート開始"}}]}};

const planFlex = {"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"あなたに最適なプランを1分診断","weight":"bold","size":"md","wrap":true,"color":"#D94A3D"},{"type":"text","text":"使い方に合ったプランと料金がその場でわかり、割引クーポンも使ってそのまま登録できます。","size":"sm","color":"#666666","wrap":true,"margin":"md"}]},"footer":{"type":"box","layout":"vertical","spacing":"sm","contents":[{"type":"button","style":"primary","color":"#D94A3D","height":"sm","action":{"type":"uri","label":"プラン診断をはじめる","uri":"https://liff.line.me/1660804123-ZfTZnrBV"}}]}};

const productResearchFlex = {"type":"bubble","hero":{"type":"image","url":"https://furimauto.com/howto/images/freeToolCard_overview.png","size":"full","aspectRatio":"1420:1536","aspectMode":"cover"},"body":{"type":"box","layout":"vertical","spacing":"md","contents":[{"type":"text","text":"🔍 商品ページでできるリサーチ","weight":"bold","size":"lg","wrap":true,"color":"#D94A3D"},{"type":"box","layout":"vertical","backgroundColor":"#FFF1EC","cornerRadius":"8px","paddingAll":"12px","spacing":"xs","contents":[{"type":"text","text":"💰 出品者の\"期間別売上金額\"が見える","weight":"bold","size":"md","color":"#D94A3D","wrap":true},{"type":"text","text":"直近90日の販売実績を自動表示。期間別に何個・いくら売れたかが丸わかりです。","size":"sm","color":"#555555","wrap":true}]},{"type":"box","layout":"vertical","backgroundColor":"#FFF6E5","cornerRadius":"8px","paddingAll":"12px","spacing":"xs","contents":[{"type":"text","text":"📤 ワンクリックでコピー出品","weight":"bold","size":"md","color":"#E8730C","wrap":true},{"type":"text","text":"メルカリの商品を、そのまま他のフリマサイトへ。出品し直しの手間がなくなります。","size":"sm","color":"#555555","wrap":true}]},{"type":"text","text":"ほかにも、8サイト横断リサーチ・商品画像の一括保存がこのカードから使えます。","size":"xs","color":"#888888","wrap":true}]}};

const sellerResearchFlex = {"type":"bubble","hero":{"type":"image","url":"https://furimauto.com/howto/images/shopResearch_panels.png","size":"full","aspectRatio":"2874:1630","aspectMode":"cover"},"body":{"type":"box","layout":"vertical","spacing":"md","contents":[{"type":"text","text":"🏪 出品者ページでできるリサーチ","weight":"bold","size":"lg","wrap":true,"color":"#D94A3D"},{"type":"text","text":"参考にしたいアカウント、競合アカウントの\"戦略\"を丸裸にします。","size":"sm","color":"#555555","wrap":true},{"type":"box","layout":"vertical","backgroundColor":"#FFF1EC","cornerRadius":"8px","paddingAll":"12px","spacing":"xs","contents":[{"type":"text","text":"⚡ 数百ページを、数分で分析","weight":"bold","size":"md","color":"#D94A3D","wrap":true},{"type":"text","text":"出品傾向・価格帯を自動で集計。手作業では追い切れない量を一気に分析できます。","size":"sm","color":"#555555","wrap":true}]},{"type":"box","layout":"vertical","backgroundColor":"#FFF6E5","cornerRadius":"8px","paddingAll":"12px","spacing":"xs","contents":[{"type":"text","text":"⭐ 評価も、その場で確認","weight":"bold","size":"md","color":"#E8730C","wrap":true},{"type":"text","text":"購入者からの評価一覧をページ内に表示。\"信頼される売り方\"まで研究できます。","size":"sm","color":"#555555","wrap":true}]}]}};

const copyTicketFlex = {"type":"bubble","hero":{"type":"image","url":"https://storage.googleapis.com/furimauto_line/images/messageEvent/copy_function.png","size":"full","aspectRatio":"16:9","aspectMode":"cover"},"body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"コピー出品チケット30枚無料でプレゼント！","weight":"bold","size":"xl","wrap":true},{"type":"text","text":"🎉【30枚のコピー出品チケットを無料でプレゼント！】🎉\n\nメルカリShops・ラクマ・ヤフオク・Yahoo!フリマへのコピー出品が可能！\n\n商品をコピー出品完了したら1枚消費するチケット制度で、コピー出品だけならサブスクプランへの加入は不要🙅‍♀️\n\n💬下のボタンをタップした後、\nキーコードの入力ボタンを押すだけですぐにご利用いただけます！","size":"sm","color":"#666666","margin":"md","wrap":true}]},"footer":{"type":"box","layout":"vertical","spacing":"sm","contents":[{"type":"button","style":"primary","height":"sm","action":{"type":"message","label":"GETする","text":"【ボタン】コピー出品チケット30枚GET"}}]}};

// ──────────────── 画像URL ────────────────

const LINE_IMG = 'https://furimauto.com/line_images/';
const GCS_IMG = 'https://storage.googleapis.com/furimauto_line/images/messageEvent/';
const HOWTO_IMG = 'https://furimauto.com/howto/images/';

// ──────────────── 本編シナリオ（Day0 +30分〜Day6。Day0 +0分は friend_add automation が送る） ────────────────
// elapsed モード: offsetMinutes のステップは登録からの経過分、deliveryTime のステップは
// 登録 offsetDays 日後のその時刻（JST）に配信される。同一スケジュールの連続ステップは
// 1回のpushにまとまる（step-delivery のバンドル仕様・最大5通）。

const SETS = [
  {
    schedule: { offsetDays: 0, offsetMinutes: 30 },
    label: 'Day0+30分 導入した瞬間から、変わります',
    messages: [
      txt(`【導入した瞬間から、変わります】

FurimAutoです。
拡張機能は導入できましたか？

導入すると、無料のリサーチ機能が
あなたのメルカリですぐに動き始めます。

試しに、メルカリで何か検索してみてください🔍

検索結果のカードに
・出品者の評価/本人確認
・出品日時/更新日時
・SOLD商品の"売れた日時"
が自動で追加されます。
（↓導入前と導入後の画面です）

設定も操作もいりません。
「いつ・何が・どれだけ売れているか」が
見えるだけで、仕入れの精度は大きく変わります。

まだの方は、1分で導入できます👇
https://furimauto.com/install`),
      img(HOWTO_IMG + 'freeFeature_mercari_search_before.png'),
      img(HOWTO_IMG + 'freeFeature_mercari_search_after.png'),
      txt(`最後に、30秒だけください。

あなたに合ったご案内をお届けするため、
1問だけアンケートにご協力お願いします👇`),
      flex('▼ 1問アンケートはこちら ▼', surveyFlex),
    ],
  },
  {
    schedule: { offsetDays: 0, offsetMinutes: 120 },
    label: 'Day0+2時間 リサーチ5通セット',
    messages: [
      txt(`【何が売れるかは、"事実"で分かります】

勘で仕入れると、在庫が残ります。

売れている人は「売れた事実」から
逆算して仕入れています。

FurimAutoの無料リサーチなら、
その事実が、ぜんぶ見えます👇`),
      flex('🔍 商品ページでできるリサーチ', productResearchFlex),
      flex('🏪 出品者ページでできるリサーチ', sellerResearchFlex),
      txt(`そして、リサーチと一緒に
受け取ってほしいものがあります🎁

無料期間中に段階的に解放される
【15大特典】です。

物販ロードマップから撮影マニュアルまで。
まずは"今すぐもらえる特典"からどうぞ👇`),
      flex('🎁 無料期間中に15大特典をGETしよう！', tokutenFlex),
    ],
  },
  {
    schedule: { offsetDays: 0, offsetMinutes: 360 },
    label: 'Day0+6時間 出品もラクに＋存在意義',
    messages: [
      txt(`【出品作業も、無料機能でラクになります】

リサーチで「売れるもの」が見えたら、次は出品です。
FurimAutoには出品まわりの無料機能もあります。

📸 商品画像の一括保存（zipでまとめてDL）
ℹ️ 商品情報の追加表示
🔍 8サイト横断リサーチ（相場の比較に）

──ここまでが、ずっと無料で使える機能です。

ただ、正直にお伝えします。

リサーチと出品が整っても、
毎日の値下げ・コメント対応・取引メッセージは
消えません。商品数が増えるほど、手が止まります。

そこでFurimAutoの本体です。
いまの無料期間中は、
【自動化の全機能】もすべて使えます。

発行はリッチメニューの
「キーコード発行」をタップするだけ。
クレジットカードの登録は不要、
期間が終わっても勝手に課金されることはありません👇`),
      txt(`【FurimAutoが、リサーチを無料で配る理由】

少しだけ、私たちの話をさせてください。

FurimAutoは、現役のフリマ物販プレイヤーが
作っている自動化ツールです。

先に、身も蓋もない事実からお伝えします。

フリマ物販に適したジャンルは、
すでに世の中に出きっています。

そして、いま売上が立っているアカウントこそが
"答え合わせの済んだ成功例"です。

だから、自分に合ったジャンルの
トッププレイヤーを丸ごと真似する。
それだけの、シンプルな事業です。

オリジナリティは、むしろ邪魔になります。

その上で。
私たちが「今のフリマサイトでの成功の順番」だと
確信しているのが、この5段階です。
重要度も、①から順になっています。

① 何が売れるかを、事実で知る
② 売れる商品を仕入れて、
　いい写真・丁寧な情報を添えて出品する
③ 毎日の作業を自動化して、売上を継続させる
④ 販路を広げて、売上の上限を外す
⑤ 増えた在庫を、事故なく回す

リサーチせずに仕入れた在庫は残ります。
1つのサイトだけの運用には、天井が来ます。

FurimAutoはこの5段階を、
ぜんぶ1つの拡張機能に入れました。

そして──
入り口の①と②は、無料です。
無料期間が終わっても、ずっと無料のままです。

なぜそんなことをするのか。

お金をお支払いいただいて活用してほしいのは、
「商品が増えて、手が回らなくなった時」
その時だけだからです。

お客様のニーズは、百種百様です。
商材・戦略・資金力・お使いのPCスペックまで、
すべて異なります。

そのニーズに応えられるように、
FurimAutoは様々なサービス・機能を
用意しています。

"人手が欲しくなった作業"から、
少しずつ任せてください。

あなたが売れる。忙しくなる。
「もう手作業には戻れない」と感じる。
その時はじめて、次の段が目の前に現れる。

FurimAutoは、そういう順番で
使ってもらえるように作られています。

さて、いまのあなたは、どの段にいますか？👇`),
      img(LINE_IMG + 'roadmap_5steps.png'),
    ],
  },
  {
    schedule: { offsetDays: 1, deliveryTime: '09:00' },
    label: 'Day1朝 1分で分かる全自動化',
    messages: [
      txt(`おはようございます☀
FurimAutoです。

今日はまず、この動画だけ見てください。

FurimAutoが目指す「全自動化」──
新規出品と梱包発送以外の毎日の作業を
ぜんぶ任せる、という世界が1分で分かります👇`),
      flex('FurimAuto紹介動画', youtubeFlex),
    ],
  },
  {
    schedule: { offsetDays: 1, deliveryTime: '13:00' },
    label: 'Day1昼 特典への道1/6',
    messages: [
      txt(`【15大特典への道 1/6】

FurimAutoです🎁

無料期間中に集められる15大特典、
①②のロードマップは受け取りましたか？

今日のミッション🎯
▶ 1問アンケートに回答（30秒）

クリアでもらえる特典
📘 ③ ロードマップ❸
📘 ④ ロードマップ❹

物販で稼ぐ道筋の"続き"です。
今朝の動画とセットでどうぞ。

回答と受け取りは、リッチメニューの
「限定特典GET」をタップ👇`),
    ],
  },
  {
    schedule: { offsetDays: 1, deliveryTime: '20:00' },
    label: 'Day1夜 今夜のうちに準備だけ',
    messages: [
      txt(`【今夜のうちに、準備だけ】

FurimAutoです。

フリマサイトの運用には、
"自動化すべきページ"が3つあります。

📋 出品一覧ページ
　→ 値下げ・再出品・コメント管理 などなど

🔔 お知らせページ
　→ いいねした人へのセールコメント

💬 取引中ページ
　→ 取引メッセージの自動送信

明日から1日1ページずつ、
この3つの"手作業が消える体験"を
ご案内していきます。

キーコードの発行がまだの方は、
今夜のうちに済ませておくのがおすすめです。
（リッチメニュー「キーコード発行」→ 拡張機能に入力するだけ）

発行済みの方は、明日の朝をお楽しみに😊`),
      img(LINE_IMG + 'pages3_all.png'),
    ],
  },
  {
    schedule: { offsetDays: 2, deliveryTime: '09:00' },
    label: 'Day2朝 値下げと再出品は何のため',
    messages: [
      img(LINE_IMG + 'pages3_day2.png'),
      txt(`【値下げと再出品は、何のためにやるのか】

先に言い切ります。
値下げや再出品を"するだけ"で
売れるわけではありません。

でも、フリマサイトにははっきりした傾向があります。

値下げ・再出品をした商品は
検索結果の上位に戻り、
閲覧数が増え、いいねが集まる。

つまりこれは
【フリマサイト内のSEO対策】です。

問題は、それを毎日
手作業で続けられるか、です。

FurimAutoなら、出品一覧ページの作業──
値下げ・再出品・コメント管理・底値設定──を
日時指定でまとめて予約することができ
継続的に自動化することが可能です。

たとえば毎日の値段変更の予約の合間に
再出品を「朝10品・夜10品」で予約するだけで、
1日20商品×30日、
1ヶ月で約600品を
フレッシュな商品ページとして回せます。

今日はまず、自動値下げか自動再出品を
どちらか1つだけ予約してみてください😊`),
      img(LINE_IMG + 'seo_cycle.png'),
    ],
  },
  {
    schedule: { offsetDays: 2, deliveryTime: '13:00' },
    label: 'Day2昼 特典への道2/6',
    messages: [
      txt(`【15大特典への道 2/6】

いい商品も、写真が悪いと売れません📷

今日のミッション🎯
▶ キーコードを発行する（無料・30秒）

クリアでもらえる特典
📕 ⑤ 撮影方法マニュアル 前編
📕 ⑥ 撮影方法マニュアル 後編

"売れる写真"の撮り方を体系化した教材です。
出品の質が、今日から変わります。

発行はリッチメニューの
「キーコード発行」をタップ。
特典は「限定特典GET」から受け取れます👇`),
    ],
  },
  {
    schedule: { offsetDays: 3, deliveryTime: '09:00' },
    label: 'Day3朝 売る側は高く買う側は安く',
    messages: [
      img(LINE_IMG + 'pages3_day3.png'),
      txt(`【売る側は高く、買う側は安くのギャップがチャンス】

物販の売上は、突き詰めるとこの綱引きです。

売る側は、できるだけ高く売りたい。
買う側は、できるだけ安く買いたい。

この"価格のギャップ"をどれだけ上手に
詰められるかが、フリマサイトで
売上を伸ばすいちばん大事な施策です。

そして、昨日お伝えしたSEOで
閲覧といいねを集めた"その先"にあるのが
【価格交渉】です。

いいねを付けた人は、
「気になっているけど、あと一歩」の人。

その人に向けてセールコメントを投稿し、
こちらから能動的に
"交渉の場"へお客さんを連れてくる──
それがFurimAutoの【自動いいね対応】です。

商品にいいねが付いたら、
その人に向けたセールコメントを自動で投稿。

買い手は少し安く買えて、
あなたの在庫は現金に変わる。

ギャップが縮まる瞬間を、体験してみてください😊`),
      img(LINE_IMG + 'price_gap.png'),
    ],
  },
  {
    schedule: { offsetDays: 3, deliveryTime: '13:00' },
    label: 'Day3昼 特典への道3/6',
    messages: [
      txt(`【15大特典への道 3/6】

自動化、もう1つは動かしましたか？

今日のミッション🎯
▶ 発行したキーコードを拡張機能に入力して
　自動化を1つ実行する

クリアでもらえる特典
📗 ⑦ 外注化マニュアル 前編
📗 ⑧ 外注化マニュアル 後編

自分の作業を"人に任せる"仕組み化の教科書。
自動化と外注化で、稼働はさらに減らせます。

受け取りはリッチメニューの
「限定特典GET」をタップ👇`),
    ],
  },
  {
    schedule: { offsetDays: 4, deliveryTime: '09:00' },
    label: 'Day4朝 売れるほど忙しくなる問題',
    messages: [
      img(LINE_IMG + 'pages3_day4.png'),
      txt(`【売れるほど、忙しくなる問題】

ここまでの自動化
（値段変更・セールコメント施策・再出品）が
うまく回り始めると、
閲覧が増え、いいねが増え、
月間の取引数も増えやすくなります。

すると、次に重くなるのが──
【取引メッセージのやり取り】です。

購入のお礼、発送のご連絡、受取確認。

メッセージ1通の処理は、
スマホでコピペしても1分〜1分半。
1つの取引で3〜4通やり取りするので、
取引1件あたり4〜5分かかる計算です。

取引が増えるほど、
これが毎日積み上がっていきます。

FurimAutoは、ここも自動化できます。

取引メッセージを自動で送信。
対応の早い出品者として
購入者からの印象・評価にもつながります。

売れるほど、ラクになる。
全自動化の完成が、近づいてきました。`),
      img(LINE_IMG + 'msg_workload.png'),
    ],
  },
  {
    schedule: { offsetDays: 4, deliveryTime: '13:00' },
    label: 'Day4昼 特典への道4/6',
    messages: [
      txt(`【15大特典への道 4/6】

無料のコピー出品チケット30枚、
もう受け取りましたか？🎫

今日のミッション🎯
▶ 無料チケット30枚を受け取って
　コピー出品を試す

クリアでもらえる特典
📄 ⑨ 外注募集テンプレート
📄 ⑩ 外注先業務委託契約書テンプレ

昨日のマニュアルを"今日から実行"できる
実物のテンプレートです。

チケットも特典も、リッチメニューの
「限定特典GET」から👇`),
      flex('コピー出品チケット30枚無料！', copyTicketFlex),
    ],
  },
  {
    schedule: { offsetDays: 5, deliveryTime: '09:00' },
    label: 'Day5朝 次のステージへ（販路拡大）',
    messages: [
      txt(`【1つのサイトで回ったら、次のステージへ】

メルカリの運用が自動で回るようになったら、
次にやるべきは【販路拡大】です。

同じ商品でも、サイトが違えばお客さんも違う。
出す場所を増やすだけで、
売れるチャンスは単純に増えます。

「でも、他のサイトに
　出品し直すのは面倒…」

FurimAutoなら、メルカリの商品データをもとに
他のフリマサイトへ一気にコピー出品できます。

・無料でも、ワンクリックの手動コピーが使えます
・有料なら、1品あたり10〜15円のチケット制で
　全自動の連続出品

販路拡大は、思っているよりずっと簡単です。
まずは1品だけ、試しにコピーしてみてください😊`),
      img(LINE_IMG + 'copy_compare.png'),
    ],
  },
  {
    schedule: { offsetDays: 5, deliveryTime: '13:00' },
    label: 'Day5昼 特典への道5/6',
    messages: [
      txt(`【15大特典への道 5/6】

今日のミッション🎯
▶ YouTube動画講座を見て、
　動画内のキーワードをこのLINEに送る

クリアでもらえる特典
📙 ⑪ コメントセールの手法と効果の解説

先日ご紹介した"セールコメント"を
深掘りした資料です。
値引き幅の考え方まで分かります。

動画はリッチメニューの
「Youtube動画講座」からどうぞ👇`),
      img(GCS_IMG + 'youtube_coupon.png'),
      txt(`【お得に使えるクーポンをGET!!】

動画内のキーワードをLINEに送っていただいた方には、

・友達登録から1週間以内 → 月額半額クーポン
・それ以外 → 月額20%引きクーポン

をそれぞれプレゼントいたします！`),
    ],
  },
  {
    schedule: { offsetDays: 6, deliveryTime: '09:00' },
    label: 'Day6朝 最後の壁は在庫管理',
    messages: [
      txt(`【最後の壁は、在庫管理】

販路を広げると、
最後にぶつかる壁があります。

「メルカリで売れたのに、
　ラクマにも出したままだった…」

複数サイトでの在庫管理は地味で、
そしてミスが命取りです。

FurimAutoの【自動併売在庫管理】は、
どこかのサイトで売れたら、
他のサイトの同じ商品を自動で取り下げます。

売り違いの恐怖から解放されて、
あなたがやるのは
仕入れて、出品して、発送するだけ。

リサーチ → 出品 → 自動化 → 販路拡大 → 在庫管理。

この1週間でご案内した階段をのぼり切ると、
"片手間なのに、ちゃんと伸びる物販"が完成します。

その形、このまま続けませんか？

今夜、継続してご利用になりたい方へ向けた
ご案内をお送りします😊`),
      img(LINE_IMG + 'inventory_sync.png'),
    ],
  },
  {
    schedule: { offsetDays: 6, deliveryTime: '13:00' },
    label: 'Day6昼 特典への道6/6',
    messages: [
      txt(`【15大特典への道 6/6】

最終日。いちばん大きい特典です。

今日のミッション🎯
▶ 完全解説動画を見て、動画内で案内される
　キーワードをこのLINEに送る

クリアでもらえる特典
📒 ⑫ 売れるブランドリスト
📒 ⑬ 売れるアカウント説明&プロフィール解説

さらに──
🎁 無料試用期間が1週間延長されます

「まだ試し切れていない」という方も、
これでもう1週間、じっくり使えます。

動画はリッチメニューからどうぞ👇`),
    ],
  },
];

// ──────────────── friend_add automation: 新ウェルカム（Day0+0分） ────────────────

const WELCOME_MESSAGES = [
  {
    messageType: 'text',
    content: `友だち追加ありがとうございます🎉
FurimAuto（フリマート）です。

たった今からFurimAuto内の全ての機能を解放した
【1週間の無料試用期間】がスタートしました！

まずはChrome拡張機能の導入から。

▼ 導入ページはこちら
https://furimauto.com/install

下の動画のとおりに進めるだけ、1分で終わります👇`,
  },
  {
    messageType: 'video',
    content: JSON.stringify({
      originalContentUrl: 'https://storage.googleapis.com/furimauto_line/video/install.mp4',
      previewImageUrl: 'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png',
      trackingId: 'setup',
    }),
  },
];

// ──────────────── closing_daily: 新4通（残5/3/2/1日・v2） ────────────────

const CLOSING_ACTIONS = [
  {
    stepOrder: 0,
    label: '残5日: 現在地の確認（v2）',
    condition: { remaining_days_gte: 5, remaining_days_lte: 5 },
    messages: [
      {
        messageType: 'text',
        content: `【現在地の確認です】

FurimAutoです。
無料期間は残り5日になりました。

いま、自分がどこまで来たか
確認してみてください。

✅ リサーチで売れるものが分かる（無料）
✅ 出品まわりの補助機能（無料）
⬜ 値下げ・再出品などの自動化（無料期間中に体験できます）
⬜ コピー出品での販路拡大
⬜ 併売の在庫管理

正直にお伝えすると、
基本のリサーチと出品まわりの機能は
期間が終わっても無料のまま使えます。

有料になるのは「自動化」から先です。

残り5日。まだ試していない自動化があれば、
今のうちに動かしてみてください。

「使い方がよく分からない…」という方は、
【Youtube動画講座】が近道です🎬
入門から上級まで、段階的に理解できます。

▼ 再生リストはこちら
https://youtube.com/playlist?list=PLUhATsy78sfvUHMVmeQpKMyxATlHOCEeF&si=4ZT_HFKCIGcuHibG

"手放せるかどうか"は、
体験した人にしか分かりません。`,
      },
    ],
  },
  {
    stepOrder: 1,
    label: '残3日: 時給換算＋Youtube動画講座→クーポン（v2）',
    condition: { remaining_days_gte: 3, remaining_days_lte: 3 },
    messages: [
      {
        messageType: 'text',
        content: `【時給換算、してみませんか】

毎日の値下げ・コメント・取引メッセージ。
仮に1日30分なら、1ヶ月で約15時間です。

時給1,000円で換算すると、月15,000円ぶん。

FurimAutoの自動化は
最安480円/月〜から始められます。

そして、いちばんお得に始める方法がこちら🎁

リッチメニューの【Youtube動画講座】を見て、
動画内で案内されるキーワードを
このLINEに送ってください。

FurimAutoの"全自動化"を理解できるうえに、
初回決済で使える割引クーポンが届きます👇`,
      },
      {
        messageType: 'image',
        content: JSON.stringify({
          originalContentUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/youtube_coupon.png',
          previewImageUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/youtube_coupon.png',
        }),
      },
      {
        messageType: 'text',
        content: `【お得に使えるクーポンをGET!!】

動画内のキーワードをLINEに送っていただいた方には、

・友達登録から1週間以内 → 月額半額クーポン
・それ以外 → 月額20%引きクーポン

をそれぞれプレゼントいたします！`,
      },
      { messageType: 'flex', altText: 'あなたに最適なプランを1分診断', content: JSON.stringify(planFlex) },
    ],
  },
  {
    stepOrder: 2,
    label: '残2日: 登録は簡単（v2）',
    condition: { remaining_days_gte: 2, remaining_days_lte: 2 },
    messages: [
      {
        messageType: 'text',
        content: `【登録は、思っているより簡単です】

「手続きが面倒そう」と
思っていませんか？

FurimAutoの登録に、
説明会や面談はありません。

① プラン診断で自分に合うプランを確認（1分）
② そのまま画面から申し込み
③ クレジットカード決済で完了

これだけです。最短3分で、
いま体験中の自動化がそのまま続きます。

無料期間は残り2日。
プラン選びに迷ったら、
このLINEにそのまま返信してください😊`,
      },
      { messageType: 'flex', altText: 'あなたに最適なプランを1分診断', content: JSON.stringify(planFlex) },
    ],
  },
  {
    stepOrder: 3,
    label: '残1日: 本日で無料期間終了（v2）',
    condition: { remaining_days_gte: 1, remaining_days_lte: 1 },
    messages: [
      {
        messageType: 'text',
        content: `【本日で無料期間が終了します】

FurimAutoです。

明日以降、キーコードが無効になり、
設定済みの自動化（値下げ・再出品・
いいね対応など）は停止します。

ただ、ご安心ください。
リサーチなどの無料機能は
これからも、ずっと使えます。

そのうえで──

この1週間で
「もう手作業には戻りたくない」
と感じたなら、それが答えだと思います。

登録はプラン診断から最短3分。
割引クーポンがまだの方は、
動画内で案内されるキーワードを
送るだけで受け取れます。

▼ 完全解説動画はこちら
https://youtu.be/jhaCPxgE_Sk

最後にもう一度だけ、
背中を押させてください👇`,
      },
      { messageType: 'flex', altText: 'あなたに最適なプランを1分診断', content: JSON.stringify(planFlex) },
    ],
  },
];

// ──────────────── SQL生成 ────────────────

function sq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function buildAutomationSql(scenarioId) {
  const lines = [
    '-- 自動生成: seed-furimauto-unified-scenario.mjs (2026-08-24 シナリオ一本化)',
    '-- friend_add ウェルカム組み替え + 統合版シナリオ自動enroll + closing_daily 4通(v2)差し替え',
    '',
    '-- 1) friend_add step7: ウェルカム5通 → 新2通（テキスト＋導入動画）。アンケートはDay0+30分へ移動',
    `UPDATE automation_actions SET
  params = ${sq(JSON.stringify({ messages: WELCOME_MESSAGES }))},
  label = 'ウェルカム2通送信（統合版）',
  updated_at = datetime('now', '+9 hours')
WHERE automation_id = (SELECT id FROM automations WHERE event_type = 'friend_add' LIMIT 1)
  AND step_order = 7;`,
    '',
    '-- 2) friend_add: 統合版シナリオへの自動enroll（新規友だちのみ）。GAS毎時のscenario-switchは安全網として併存',
    `INSERT INTO automation_actions (id, automation_id, step_order, action_type, params, condition_json, is_active, label, created_at, updated_at)
SELECT ${sq(randomUUID())}, id, 10, 'start_scenario', ${sq(JSON.stringify({ scenarioId }))}, ${sq(JSON.stringify({ isNewUser: true }))}, 1, '統合版シナリオ登録', datetime('now', '+9 hours'), datetime('now', '+9 hours')
FROM automations WHERE event_type = 'friend_add' LIMIT 1;`,
    '',
    '-- 3) closing_daily: 旧5通（残7/5/3/2/1）を削除し、新4通（残5/3/2/1・v2）へ差し替え',
    `DELETE FROM automation_actions WHERE automation_id = (SELECT id FROM automations WHERE event_type = 'closing_daily' LIMIT 1);`,
  ];
  for (const a of CLOSING_ACTIONS) {
    lines.push(`INSERT INTO automation_actions (id, automation_id, step_order, action_type, params, condition_json, is_active, label, created_at, updated_at)
SELECT ${sq(randomUUID())}, id, ${a.stepOrder}, 'send_messages', ${sq(JSON.stringify({ messages: a.messages }))}, ${sq(JSON.stringify(a.condition))}, 1, ${sq(a.label)}, datetime('now', '+9 hours'), datetime('now', '+9 hours')
FROM automations WHERE event_type = 'closing_daily' LIMIT 1;`);
  }
  return lines.join('\n') + '\n';
}

const DEACTIVATE_OLD_SQL = `-- 旧14シナリオの無効化（本番有効化の号令が出てから流す）
UPDATE scenarios SET is_active = 0, updated_at = datetime('now', '+9 hours')
WHERE name LIKE 'FurimAuto 通常 ステップ配信（セグメント%' OR name LIKE 'FurimAuto 紹介 ステップ配信（セグメント%';
`;

// ──────────────── main ────────────────

function buildScenarioSql(scenarioId) {
  const lines = [
    '-- 自動生成: seed-furimauto-unified-scenario.mjs (2026-08-24 シナリオ一本化)',
    `-- シナリオ本体＋${SETS.reduce((n, s) => n + s.messages.length, 0)}ステップ。冪等ではないので二重実行しないこと。`,
    '',
    `INSERT INTO scenarios (id, name, description, trigger_type, is_active, delivery_mode)
VALUES (${sq(scenarioId)}, ${sq(SCENARIO_NAME)}, ${sq('Day0=無料リサーチで完結(+30分/+2h/+6h)、Day1-6=朝9時の全自動化教育+昼13時の15大特典への道+Day1夜20時。全セグメント・通常/紹介共通の1本(2026-08-24一本化)。Day0+0分のウェルカムはfriend_add automationが送る。')}, 'manual', 1, 'elapsed');`,
    '',
  ];
  let stepOrder = 0;
  for (const set of SETS) {
    lines.push(`-- ${set.label}`);
    for (const m of set.messages) {
      const offsetMinutes = set.schedule.deliveryTime ? 'NULL' : String(set.schedule.offsetMinutes);
      const deliveryTime = set.schedule.deliveryTime ? sq(set.schedule.deliveryTime) : 'NULL';
      lines.push(
        `INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES (${sq(randomUUID())}, ${sq(scenarioId)}, ${stepOrder}, 0, ${sq(m.messageType)}, ${sq(m.messageContent)}, ${set.schedule.offsetDays}, ${offsetMinutes}, ${deliveryTime});`,
      );
      stepOrder++;
    }
    lines.push('');
  }
  return lines.join('\n');
}

const scenarioId = process.env.SCENARIO_ID || randomUUID();
const outDir = join(dirname(fileURLToPath(import.meta.url)), 'data');
mkdirSync(outDir, { recursive: true });

const scenarioSqlPath = join(outDir, 'unified-scenario.gen.sql');
writeFileSync(scenarioSqlPath, buildScenarioSql(scenarioId));
const automationSqlPath = join(outDir, 'unified-automations.gen.sql');
writeFileSync(automationSqlPath, buildAutomationSql(scenarioId));

console.log(`scenarioId: ${scenarioId}`);
console.log(`書き出し: ${scenarioSqlPath}`);
console.log(`書き出し: ${automationSqlPath}`);
console.log('適用: npx wrangler d1 execute <db名> --remote --file <ファイル>');
console.log('\n──── 旧14シナリオ無効化SQL（号令待ち） ────\n' + DEACTIVATE_OLD_SQL);
