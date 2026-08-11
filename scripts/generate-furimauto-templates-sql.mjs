#!/usr/bin/env node
/**
 * FurimAuto テンプレート付きシナリオ SQL 生成スクリプト（統合版）
 *
 * - 通常/紹介を統合して6シナリオ（Seg1〜6）
 * - 1日 = 1ステップ（delay_minutes は前ステップからの差分日数×1440）
 * - 1ステップ = 1テンプレート、複数メッセージは template_messages で管理
 * - kaisetsu セクション7は独立したテンプレート3件（cronドリブン）
 *
 * 使い方:
 *   node scripts/generate-furimauto-templates-sql.mjs > /tmp/furimauto-templates.sql
 *   cd apps/worker && npx wrangler d1 execute line-crm --remote --file=/tmp/furimauto-templates.sql
 */

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function esc(s) {
  return String(s).replace(/'/g, "''");
}

const NOW = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
const IMG = 'https://storage.googleapis.com/furimauto_line/images/messageEvent/';
const I = {
  follow2:   IMG + 'follow_event_img2.png',
  follow1:   IMG + 'follow_event_img1.png',
  only5days: IMG + 'only5days.png',
  only1day:  IMG + 'only1day.png',
  bye:       IMG + 'bye.png',
};

const VID_INSTALL = {
  messageType: 'video',
  messageContent: JSON.stringify({
    originalContentUrl: 'https://storage.googleapis.com/furimauto_line/video/install.mp4',
    previewImageUrl:    'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png',
    trackingId: 'setup',
  }),
};

function img(url)   { return { messageType: 'image', messageContent: JSON.stringify({ originalContentUrl: url, previewImageUrl: url }) }; }
function txt(text)  { return { messageType: 'text',  messageContent: text }; }
function flex(altText, contents) {
  return { messageType: 'flex', messageContent: JSON.stringify({ type: 'flex', altText, contents }) };
}

const surveyFlex = flex('▼ 1問アンケートはこちら ▼', {
  type: 'bubble',
  hero: { type: 'image', url: IMG + 'follow_event_img3.png', size: 'full', aspectRatio: '16:9', aspectMode: 'cover' },
  body: {
    type: 'box', layout: 'vertical',
    contents: [{ type: 'text', text: '▼ 1問アンケートはこちら ▼', weight: 'bold', size: 'lg', wrap: true, align: 'center' }],
  },
  footer: {
    type: 'box', layout: 'vertical', spacing: 'sm',
    contents: [{
      type: 'button', style: 'primary', height: 'sm',
      action: { type: 'message', label: '開始する', text: '【ボタン】アンケート開始' },
    }],
  },
});

// ─── 6シナリオ定義（通常/紹介統合）────────────────────────────────────────
// days: 各日のメッセージ群。1要素 = 1ステップ = 1テンプレート（複数 messages 可）

const SCENARIOS = [
  {
    name: 'FurimAuto セグメント1: アンケート未回答',
    triggerType: 'friend_add',
    days: [
      { day: 0, label: 'Seg1 Day0: 友達追加初日', messages: [
        img(I.follow2),
        txt(`【無料お試し期間スタート！特典①②は受け取り済みです🎁】

FurimAutoです。
7日間の無料期間はすでにスタートしています！🎉

ご登録時に限定特典①②はすでにお届けしました！
リッチメニューの「限定特典GET」からすぐ確認できます。

次のステップ👇
▼アンケートに回答してキーコードをもらう

アンケート回答でさらに特典③④もプレゼント！
キーコードを拡張機能に入れれば全機能が使えます。

使い方は動画が全部教えてくれます👇

✅入門編1
https://youtu.be/FY8GUB-CoaY

✅入門編2
https://youtu.be/vfJzKP8K0yY

▼アンケートはこちらから`),
        surveyFlex,
      ]},
      { day: 1, label: 'Seg1 Day1: アンケートリマインド①', messages: [
        txt(`【アンケートの回答をお待ちしています！】

FurimAutoです。

特典①②はすでにお届け済みです🎁
アンケートに回答してキーコードをゲットすると特典③④もプレゼントしています！

キーコードを拡張機能に入力すれば、すぐにFurimAutoが使えます。

✅入門編1
https://youtu.be/FY8GUB-CoaY

残り6日です。今すぐ始めましょう！

▼アンケートはこちらから`),
        surveyFlex,
      ]},
      { day: 2, label: 'Seg1 Day2: あと5日', messages: [
        img(I.only5days),
        txt(`【無料で使えるのはあと5日です】

FurimAutoです。

無料期間は"友達登録してから"7日間です⚠️
キーコードを発行してから、ではありません。

今からでも全然間に合います！
アンケートに回答して、3分だけツールを試してみてください😄

特典①②はすでにお届け済みです🎁
アンケート回答で特典③④もゲットしてください！

▼アンケートはこちらから`),
        surveyFlex,
      ]},
      { day: 3, label: 'Seg1 Day3: お悩み訴求', messages: [
        txt(`【こんなお悩みありませんか？】

FurimAutoです。

「毎日手動で値下げするのが大変…」
「なかなか売れなくて困っている…」
「もっと出品に集中したいのに作業に追われている…」

FurimAutoが全部解決します！

✅ 自動値下げで毎日の作業をゼロに
✅ コピー出品・まとめ買い割引の自動設定
✅ 売れ筋商品のリサーチ支援

まずアンケートに回答してキーコードをゲット！
回答すると特典③④もプレゼントしています🎁
（①②はすでにお届け済みです）

▼アンケートはこちらから`),
        surveyFlex,
      ]},
      { day: 4, label: 'Seg1 Day4: ユーザーの声', messages: [
        txt(`【実際のユーザーの声をご紹介】

FurimAutoです。

「本当に効果があるの？」と思っていませんか？

✨「月利が2倍になりました！」
✨「作業時間が激減してプライベートが充実！」
✨「初心者でも簡単に使えました！」

▼お客様の声はこちら
https://furimauto.com/service/#scroll_voice

残り3日です！今すぐアンケートに回答して
キーコードをゲットし特典③④も受け取ってください🎁
（①②はすでにお届け済みです）

▼アンケートはこちらから`),
        surveyFlex,
      ]},
      { day: 5, label: 'Seg1 Day5: 残り2日', messages: [
        txt(`【無料で使えるのはあと2日です！】

FurimAutoです。

残り2日！まだアンケートに回答されていない方へ

1問だけ答えるだけでキーコードをゲットできます🔑
特典③④のプレゼントもまだ間に合います🎁
（特典①②はすでにお届け済みです）

今すぐ回答してみてください👇`),
        surveyFlex,
      ]},
      { day: 6, label: 'Seg1 Day6: 明日終了', messages: [
        img(I.only1day),
        txt(`【明日で無料期間が終了します！】

FurimAutoです。

まだ間に合います！
アンケートに回答して、今日だけでもFurimAutoを体験してください。

有料プランへの移行を検討される方は、
こちらの解説動画が全てを教えてくれます👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

動画を見た後動画内で案内されるキーワードをLINEに送ると
✨無料試用期間が延長されます
✨限定特典⑫⑬もプレゼント！

Meetは任意です。動画だけで十分わかります。

▼アンケートはこちらから`),
        surveyFlex,
      ]},
      { day: 7, label: 'Seg1 Day7: 最終メッセージ', messages: [
        img(I.bye),
        txt(`【本日が最後のメッセージです】

FurimAutoです。

無料期間が終了します。

少しでも気になっていただけているなら、
ぜひこちらの解説動画だけ見てみてください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・効果、全部動画で説明しています。
Meetなしでそのままご加入いただけます。

またいつでもお声がけください😊`),
      ]},
    ],
  },

  {
    name: 'FurimAuto セグメント2: アンケート回答済み',
    triggerType: 'manual',
    days: [
      { day: 0, label: 'Seg2 Day0: キーコード発行促進', messages: [
        txt(`【キーコードを発行して特典⑤⑥をゲット！】

アンケートのご回答ありがとうございます🎉
特典③④はすでにお届け済みです🎁

次はキーコードを発行しましょう🔑

リッチメニューの「キーコード発行」をタップするだけ！
発行したら、リッチメニューの「限定特典GET」をタップして
特典⑤⑥を受け取ってください🎁

✅入門編1
https://youtu.be/FY8GUB-CoaY

✅入門編2
https://youtu.be/vfJzKP8K0yY`),
      ]},
      { day: 1, label: 'Seg2 Day1: キーコードリマインド①', messages: [
        txt(`【キーコード発行で物販が変わります！】

FurimAutoです。

キーコード発行はまだお済みでしょうか？

リッチメニューの「キーコード発行」をタップするだけです。
発行後はPCのChrome拡張機能にキーコードを入力すれば
すぐにFurimAutoが動き始めます！

キーコード発行で限定特典⑤⑥もゲット🎁
リッチメニュー「限定特典GET」をお忘れなく！

✅入門編1
https://youtu.be/FY8GUB-CoaY`),
      ]},
      { day: 2, label: 'Seg2 Day2: あと5日', messages: [
        img(I.only5days),
        txt(`【残り5日！キーコードを発行しよう】

FurimAutoです。

無料期間はカウントダウン中です😫

3分だけ時間をとってキーコードを発行してみてください！
リッチメニューの「キーコード発行」をタップするだけです。

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI`),
      ]},
      { day: 3, label: 'Seg2 Day3: 物販ライフ訴求', messages: [
        txt(`【FurimAutoで理想の物販ライフへ】

FurimAutoです。

✅ 朝起きたら自動で値下げ完了
✅ 面倒な作業から解放されて出品に集中
✅ 毎月の売上がじわじわアップ

難しい操作は一切ありません。

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o`),
      ]},
      { day: 4, label: 'Seg2 Day4: ユーザーの声', messages: [
        txt(`【ユーザーの声をご紹介】

FurimAutoです。

✨「発行してすぐ使い始め、月利が安定しました！」
✨「こんなに簡単なのに効果抜群で驚きました！」

▼お客様の声
https://furimauto.com/service/#scroll_voice

残り3日！今すぐキーコードを発行してください🔑

✅上級編1
https://youtu.be/-HmR263oHyk`),
      ]},
      { day: 5, label: 'Seg2 Day5: 残り2日', messages: [
        txt(`【無料で使えるのはあと2日です！】

FurimAutoです。

残り2日！キーコードの入力はお済みですか？

キーコードを入力するとFurimAutoの全機能が使えます🔑
特典⑤⑥の受け取りもまだ間に合います🎁

入力方法の動画はこちら👇
✅中級編2: https://youtu.be/-dlzv6sbh4o`),
      ]},
      { day: 6, label: 'Seg2 Day6: 明日終了', messages: [
        img(I.only1day),
        txt(`【明日で無料期間終了です！】

FurimAutoです。

「プランを継続したいけどどうすれば？」という方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

動画を見た後動画内で案内されるキーワードをLINEに送ると試用期間が延長されます✨

✅上級編3
https://youtu.be/EbhveXLO1FI`),
      ]},
      { day: 7, label: 'Seg2 Day7: 最終メッセージ', messages: [
        img(I.bye),
        txt(`【本日が最後のメッセージです】

FurimAutoです。

気になっている方はこちらの動画だけでもご覧ください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

Meetなしでそのままご加入いただけます。

またいつでもお声がけお待ちしております😊`),
      ]},
    ],
  },

  {
    name: 'FurimAuto セグメント3: キーコード発行済み',
    triggerType: 'manual',
    days: [
      { day: 0, label: 'Seg3 Day0: インストール案内', messages: [
        VID_INSTALL,
        txt(`【あと3分！キーコードを入力して特典⑦⑧をゲット】

キーコードの発行ありがとうございます🎉

次はPCでの作業です。動画を見ながらやってみてください☝️

1️⃣ リッチメニュー「キーコード発行」でキーコードを確認
2️⃣ キーコードを長押しでコピー
3️⃣ PCのChromeでFurimAutoの拡張機能を開く
4️⃣ 入力欄にキーコードをペーストして確定！

終わったらリッチメニューの「限定特典GET」をタップ！
特典⑦⑧がプレゼントされます🎁`),
      ]},
      { day: 1, label: 'Seg3 Day1: 入力リマインド①', messages: [
        txt(`【キーコード入力はお済みですか？】

FurimAutoです。

手順を再掲します👇

1️⃣ リッチメニュー「キーコード発行」でキーコードをコピー
2️⃣ PCのChromeでFurimAutoの拡張機能を開く
3️⃣ 入力欄にペーストして確定！

入力が完了すると特典⑦⑧がゲットできます🎁`),
      ]},
      { day: 2, label: 'Seg3 Day2: インストール動画再掲', messages: [
        VID_INSTALL,
        txt(`【まだ入力できていない方へ】

FurimAutoです。

上の動画を見ながらキーコードを入力してください！

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o`),
      ]},
      { day: 3, label: 'Seg3 Day3: 物販ライフ訴求', messages: [
        txt(`【FurimAutoで理想の物販ライフへ！】

FurimAutoです。

✅ 毎日の値下げ作業が完全自動に
✅ 出品数を増やして売上アップ
✅ ストレスフリーで物販を楽しめる

✅中級編3
https://youtu.be/gAtxMiysWsY`),
      ]},
      { day: 4, label: 'Seg3 Day4: サポート案内', messages: [
        txt(`【サポートします！お気軽にどうぞ】

FurimAutoです。

拡張機能の入力でお困りの方はこのLINEにメッセージください。

✅上級編1
https://youtu.be/-HmR263oHyk

✅上級編2
https://youtu.be/8rAdmKTYsUs`),
      ]},
      { day: 5, label: 'Seg3 Day5: 明日終了・解説動画', messages: [
        img(I.only1day),
        txt(`【明日で無料期間終了！最後のチャンス】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

動画を見てキーワードをLINEに送ると
✨無料試用期間が延長されます
✨限定特典⑫⑬もプレゼント！`),
      ]},
      { day: 6, label: 'Seg3 Day6: 延長案内', messages: [
        txt(`【試用期間を延長する方法があります！】

FurimAutoです。

「もう少し使ってから決めたい」という方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

▼料金表
https://furimauto.com/service/#scroll_plan`),
      ]},
      { day: 7, label: 'Seg3 Day7: 最終メッセージ', messages: [
        img(I.bye),
        txt(`【本日が最後のメッセージです】

FurimAutoです。

またいつでもお声がけください😊`),
      ]},
    ],
  },

  {
    name: 'FurimAuto セグメント4: 拡張インストール済み',
    triggerType: 'manual',
    days: [
      { day: 0, label: 'Seg4 Day0: 自動値下げ＆特典⑨⑩', messages: [
        txt(`【まずは自動値下げを試してみて！】

FurimAutoの導入おめでとうございます🎉

メルカリの出品一覧ページを開いてみてください！

✅入門編1
https://youtu.be/FY8GUB-CoaY

✅入門編2
https://youtu.be/vfJzKP8K0yY`),
        txt(`【🎫 無料コピー出品チケットを受け取ろう！】

リッチメニューの「限定特典GET」をタップしてください！

特典⑨⑩として【無料コピー出品チケット】がプレゼントされています🎁`),
      ]},
      { day: 1, label: 'Seg4 Day1: 特典⑨⑩リマインド', messages: [
        txt(`【限定特典⑨⑩を受け取ろう！】

FurimAutoです。

リッチメニューの「限定特典GET」をタップしてみてください！

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI`),
      ]},
      { day: 2, label: 'Seg4 Day2: 時短ツール訴求', messages: [
        txt(`【時短・コストカットの最強ツール】

FurimAutoです。

✅ コピー出品で出品数を一気に増やす
✅ まとめ買い割引の自動設定
✅ 売れ筋商品のリサーチ支援

✅初級編3
https://youtu.be/TgnC29kkbW4`),
      ]},
      { day: 3, label: 'Seg4 Day3: よくある質問', messages: [
        txt(`【よくある質問に答えます！】

FurimAutoです。

Q. 自動値下げが動かない？
A. リッチメニューの「ガイド」に手順があります。

Q. 複数商品を同時に値下げできる？
A. できます！

解決しない場合はこのLINEにメッセージください👍

✅中級編2
https://youtu.be/-dlzv6sbh4o`),
      ]},
      { day: 4, label: 'Seg4 Day4: 有料プラン案内', messages: [
        txt(`【有料プランへの移行方法について】

FurimAutoです。

継続を検討されている方はまずこちらをご覧ください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

✅ Meetなしで申し込みOK！
✅ 動画を見てキーワードを送ると試用期間延長＋特典⑫⑬！

▼料金表
https://furimauto.com/service/#scroll_plan`),
      ]},
      { day: 5, label: 'Seg4 Day5: 明日終了・解説動画', messages: [
        img(I.only1day),
        txt(`【明日で無料期間終了！動画を見て延長しよう】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

✨無料試用期間が延長されます
✨限定特典⑫⑬もプレゼント！`),
      ]},
      { day: 6, label: 'Seg4 Day6: ラストチャンス', messages: [
        txt(`【試用期間延長のラストチャンス！】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

▼料金表
https://furimauto.com/service/#scroll_plan`),
      ]},
      { day: 7, label: 'Seg4 Day7: 最終メッセージ', messages: [
        img(I.bye),
        txt(`【本日が最後のメッセージです】

FurimAutoです。

またいつでもお声がけください😊`),
      ]},
    ],
  },

  {
    name: 'FurimAuto セグメント5: Free30未取得',
    triggerType: 'manual',
    days: [
      { day: 0, label: 'Seg5 Day0: コピー出品チケットを使おう', messages: [
        txt(`【無料コピー出品チケットが使えます！🎫】

FurimAutoです。

メルカリURLの設定ありがとうございます！

次は【無料コピー出品チケット】を使ってみてください🎁
リッチメニューの「限定特典GET」をタップするとチケットを受け取れます。

コピー出品を使うと…
✅ 売れた商品を1クリックで再出品
✅ 出品数を一気に増やせる
✅ 作業時間が激減！

✅入門編1
https://youtu.be/FY8GUB-CoaY

✅入門編2
https://youtu.be/vfJzKP8K0yY`),
      ]},
      { day: 1, label: 'Seg5 Day1: チケットリマインド', messages: [
        txt(`【無料チケットを使いましたか？】

FurimAutoです。

「限定特典GET」からコピー出品チケットを受け取っていない方はぜひ今すぐ！

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI

✅初級編3
https://youtu.be/TgnC29kkbW4`),
      ]},
      { day: 2, label: 'Seg5 Day2: フル活用tips', messages: [
        txt(`【FurimAutoをもっと活用しよう】

FurimAutoです。

✅ コピー出品で出品数アップ
✅ まとめ買い割引の自動設定
✅ 売れ筋商品のリサーチ支援

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o

✅中級編3
https://youtu.be/gAtxMiysWsY`),
      ]},
      { day: 3, label: 'Seg5 Day3: ユーザーの声', messages: [
        txt(`【実際のユーザーの声をご紹介】

FurimAutoです。

✨「コピー出品で月の出品数が3倍になりました！」
✨「チケットを使ったら売上がすぐ変わった！」
✨「これなしではもう無理です笑」

▼お客様の声
https://furimauto.com/service/#scroll_voice

残り4日！チケットをまだ使っていない方は今すぐ！`),
      ]},
      { day: 4, label: 'Seg5 Day4: 有料プラン案内', messages: [
        txt(`【有料プランへの移行方法について】

FurimAutoです。

残り3日！有料プランなら…
✅ コピー出品チケットが毎月もらえる
✅ 全機能が無制限で使い放題
✅ 自動値下げが無制限で稼働

▼まずこちらをご覧ください
https://www.youtube.com/watch?v=jhaCPxgE_Sk

Meetなしで申し込みOK！
▼料金表
https://furimauto.com/service/#scroll_plan`),
      ]},
      { day: 5, label: 'Seg5 Day5: 残り2日', messages: [
        txt(`【無料で使えるのはあと2日です！】

FurimAutoです。

残り2日！コピー出品チケットはお試しになりましたか？

動画を見てキーワードをLINEに送ると…
✨無料試用期間が延長されます
✨限定特典⑫⑬もプレゼント！

▼FurimAuto完全解説動画
https://www.youtube.com/watch?v=jhaCPxgE_Sk`),
      ]},
      { day: 6, label: 'Seg5 Day6: 明日終了', messages: [
        img(I.only1day),
        txt(`【明日で無料期間終了！動画を見て延長しよう】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

✨無料試用期間が延長されます✨
✨限定特典⑫⑬もプレゼント✨`),
      ]},
      { day: 7, label: 'Seg5 Day7: 最終メッセージ', messages: [
        img(I.bye),
        txt(`【本日が最後のメッセージです】

FurimAutoです。

無料期間が終了します。

少しでも気になっていただけているなら、
ぜひこちらの解説動画だけ見てみてください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

Meetなしでそのままご加入いただけます。

またいつでもお声がけください😊`),
      ]},
    ],
  },

  {
    name: 'FurimAuto セグメント6: Free30取得済み',
    triggerType: 'manual',
    days: [
      { day: 0, label: 'Seg6 Day0: 特典⑨⑩取得・⑪へ', messages: [
        img(I.follow1),
        txt(`【特典⑨⑩受け取り完了！次は⑪をゲット！】

FurimAutoを積極的にご利用いただきありがとうございます！😆

1分解説シリーズのYoutubeを全部見て、
YoutubeのコメントにFurimAutoと入力してください！
コメントのスクショをLINEに送っていただくと特典⑪が受け取れます。

✅入門編1
https://youtu.be/FY8GUB-CoaY

✅入門編2
https://youtu.be/vfJzKP8K0yY`),
      ]},
      { day: 1, label: 'Seg6 Day1: 1分解説シリーズ', messages: [
        txt(`【1分解説シリーズで特典⑪をゲット！】

FurimAutoです。

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI

✅初級編3
https://youtu.be/TgnC29kkbW4

YoutubeのコメントにFurimAutoと入力してスクショをLINEに送ると特典⑪がもらえます🎁`),
      ]},
      { day: 2, label: 'Seg6 Day2: フル活用', messages: [
        txt(`【FurimAutoをフル活用しよう】

FurimAutoです。

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o

✅中級編3
https://youtu.be/gAtxMiysWsY`),
      ]},
      { day: 3, label: 'Seg6 Day3: 特典⑫⑬・解説動画', messages: [
        txt(`【特典⑫⑬ゲットのチャンス！】

FurimAutoです。

▼FurimAuto完全解説動画
https://www.youtube.com/watch?v=jhaCPxgE_Sk

この動画を見た後キーワードをLINEに送ってください！
✨無料試用期間が延長されます
✨限定特典⑫⑬をプレゼント！`),
      ]},
      { day: 4, label: 'Seg6 Day4: 有料プラン案内', messages: [
        txt(`【有料プランへの移行方法について】

FurimAutoです。

残り3日！
▼まずこちらをご覧ください
https://www.youtube.com/watch?v=jhaCPxgE_Sk

✅ Meetなしで申し込みOK！
▼料金表
https://furimauto.com/service/#scroll_plan`),
      ]},
      { day: 5, label: 'Seg6 Day5: 残り2日', messages: [
        txt(`【無料で使えるのはあと2日です！】

FurimAutoです。

残り2日！動画を見てキーワードをLINEに送ると試用期間が延長されます✨

▼FurimAuto完全解説動画
https://www.youtube.com/watch?v=jhaCPxgE_Sk

✨限定特典⑫⑬もプレゼント！`),
      ]},
      { day: 6, label: 'Seg6 Day6: 明日終了・延長', messages: [
        img(I.only1day),
        txt(`【明日で無料期間終了！動画を見て延長しよう】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

✨無料試用期間が延長されます✨
✨限定特典⑫⑬もプレゼント✨`),
      ]},
      { day: 7, label: 'Seg6 Day7: 最終メッセージ', messages: [
        img(I.bye),
        txt(`【本日が最後のメッセージです】

FurimAutoです。

気になっている方はこちらの動画だけでもご覧ください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

Meetなしでそのままご加入いただけます。

またいつでもお声がけお待ちしております😊`),
      ]},
    ],
  },

  {
    name: 'FurimAuto セグメント7: Youtubeクーポン取得済み',
    triggerType: 'manual',
    days: [
      { day: 0, label: 'Seg7 Day0: クーポン取得おめでとう', messages: [
        txt(`【Youtubeクーポン取得ありがとうございます！🎉】

FurimAutoです。

クーポンをゲットしましたね！素晴らしいです✨

次は有料プランへの移行方法を確認してみてください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

動画内で案内されるキーワードをLINEに送ると
✨無料試用期間がさらに延長されます
✨限定特典⑫⑬もプレゼント！`),
      ]},
      { day: 1, label: 'Seg7 Day1: 有料プラン案内', messages: [
        txt(`【有料プランで物販を自動化しよう】

FurimAutoです。

✅ 自動値下げ無制限
✅ コピー出品チケット毎月付与
✅ 全機能フル活用

今なら試用期間延長の特典も！
▼今すぐ申し込む
https://furimauto.com/service/#scroll_plan

Meetなし・動画確認だけでご加入いただけます😊`),
      ]},
      { day: 2, label: 'Seg7 Day2: 解説動画ラストプッシュ', messages: [
        txt(`【最後のご案内です】

FurimAutoです。

まだ迷っている方は、この動画だけ見てみてください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・申し込み手順、全部この動画に入っています。
Meetなしでそのまま加入できます。

「少し話を聞いてみたい」という方は
このLINEに一言メッセージください。直接対応します😊`),
      ]},
    ],
  },
];

// ─── kaisetsu セクション7（cronドリブン・夜9時配信） ──────────────────────

const KAISETSU_TEMPLATES = [
  {
    name: 'kaisetsu: >=5日 プランメリット案内',
    messages: [txt(`【FurimAuto 有料プランのご案内】

動画をご視聴いただきありがとうございます！

改めて有料プランの魅力をお伝えします✨

✅ 自動値下げで毎日の作業を完全ゼロに
✅ コピー出品・まとめ買い割引の自動設定
✅ 売れ筋商品のリサーチ支援
✅ 全機能無制限で使い放題

▼料金・プラン一覧はこちら
https://furimauto.com/service/#scroll_plan

気になる方は今すぐ↑をチェック！
申し込みはMeetなしでできます😊`)],
  },
  {
    name: 'kaisetsu: 2-4日 申し込み方法',
    messages: [txt(`【無料期間終了まであとN日】

FurimAutoです。

有料プランへの申し込み方法をご案内します👇

▼FurimAuto完全解説動画（申し込み手順あり）
https://www.youtube.com/watch?v=jhaCPxgE_Sk

申し込みはMeetなしでOK！
動画を見れば全ての疑問が解決します。

▼今すぐ申し込みはこちら
https://furimauto.com/service/#scroll_plan`)],
  },
  {
    name: 'kaisetsu: 1日 最後のチャンス',
    messages: [txt(`【明日で無料期間終了！最後のご案内】

FurimAutoです。

今日が最後のチャンスです。

▼今すぐ有料プランに申し込む
https://furimauto.com/service/#scroll_plan

Meetなし・動画確認だけでそのままご加入いただけます。

「まだ迷っている」という方は
このLINEに一言メッセージください。
直接ご相談に乗ります😊`)],
  },
];

// ─── SQL 生成 ─────────────────────────────────────────────────────────────

const lines = [];

// 旧データ削除
lines.push(`-- 既存 FurimAuto テンプレートを全パターンで削除`);

// 現在の scenario_steps に紐づくもの
lines.push(`DELETE FROM template_messages WHERE template_id IN (
  SELECT DISTINCT template_id FROM scenario_steps
  WHERE template_id IS NOT NULL
    AND scenario_id IN (SELECT id FROM scenarios WHERE name LIKE 'FurimAuto%')
);`);
lines.push(`DELETE FROM templates WHERE id IN (
  SELECT DISTINCT template_id FROM scenario_steps
  WHERE template_id IS NOT NULL
    AND scenario_id IN (SELECT id FROM scenarios WHERE name LIKE 'FurimAuto%')
);`);

// 名前パターンで残存テンプレートを一掃
// - migrated_step_XXXX : migration 016 が自動生成したもの
// - FurimAuto * Step*  : 旧 generate-scenarios-sql 由来
// - 通常Seg*/紹介Seg*  : 過去シード由来
// - Seg* Day*          : 前バージョンのシード由来
// - kaisetsu:*         : kaisetsu テンプレート
lines.push(`DELETE FROM template_messages WHERE template_id IN (
  SELECT id FROM templates WHERE
    name LIKE 'migrated_step_%' OR
    name LIKE 'FurimAuto%Step%' OR
    name LIKE '通常Seg%' OR
    name LIKE '紹介Seg%' OR
    name LIKE 'Seg% Day%' OR
    name LIKE 'kaisetsu:%'
);`);
lines.push(`DELETE FROM templates WHERE
  name LIKE 'migrated_step_%' OR
  name LIKE 'FurimAuto%Step%' OR
  name LIKE '通常Seg%' OR
  name LIKE '紹介Seg%' OR
  name LIKE 'Seg% Day%' OR
  name LIKE 'kaisetsu:%';`);

lines.push(`DELETE FROM scenario_steps WHERE scenario_id IN (SELECT id FROM scenarios WHERE name LIKE 'FurimAuto%');`);
lines.push(`DELETE FROM scenarios WHERE name LIKE 'FurimAuto%';`);
lines.push('');

// kaisetsu テンプレート
lines.push(`-- === kaisetsu セクション7 テンプレート ===`);
for (const kt of KAISETSU_TEMPLATES) {
  const tId = uuid();
  lines.push(`INSERT INTO templates (id, name, category, categories, message_type, message_content, created_at, updated_at) VALUES ('${tId}', '${esc(kt.name)}', 'scenario', '["scenario"]', '${kt.messages[0].messageType}', '${esc(kt.messages[0].messageContent)}', '${NOW}', '${NOW}');`);
  for (let i = 0; i < kt.messages.length; i++) {
    const mId = uuid();
    const tmId = uuid();
    lines.push(`INSERT INTO messages (id, message_type, content, created_at, updated_at) VALUES ('${mId}', '${kt.messages[i].messageType}', '${esc(kt.messages[i].messageContent)}', '${NOW}', '${NOW}');`);
    lines.push(`INSERT INTO template_messages (id, template_id, message_id, step_order, created_at) VALUES ('${tmId}', '${tId}', '${mId}', ${i}, '${NOW}');`);
  }
}
lines.push('');

// シナリオ + ステップ + テンプレート
for (const scenario of SCENARIOS) {
  const scenarioId = uuid();
  lines.push(`-- === ${scenario.name} ===`);
  lines.push(`INSERT INTO scenarios (id, name, trigger_type, is_active, created_at, updated_at) VALUES ('${scenarioId}', '${esc(scenario.name)}', '${scenario.triggerType}', 1, '${NOW}', '${NOW}');`);

  for (let i = 0; i < scenario.days.length; i++) {
    const { day, label, messages } = scenario.days[i];
    // 友達登録からの絶対時間（分）= day * 1440
    const absoluteMinutes = day * 1440;
    const triggerCondition = JSON.stringify({ type: 'delay_from_follow', minutes: absoluteMinutes });

    const stepId = uuid();
    const tId   = uuid();

    // テンプレートの代表タイプ・コンテンツは最初のメッセージ
    const firstMsg = messages[0];
    lines.push(`INSERT INTO templates (id, name, category, categories, message_type, message_content, created_at, updated_at) VALUES ('${tId}', '${esc(label)}', 'scenario', '["scenario"]', '${firstMsg.messageType}', '${esc(firstMsg.messageContent)}', '${NOW}', '${NOW}');`);

    for (let j = 0; j < messages.length; j++) {
      const mId  = uuid();
      const tmId = uuid();
      lines.push(`INSERT INTO messages (id, message_type, content, created_at, updated_at) VALUES ('${mId}', '${messages[j].messageType}', '${esc(messages[j].messageContent)}', '${NOW}', '${NOW}');`);
      lines.push(`INSERT INTO template_messages (id, template_id, message_id, step_order, created_at) VALUES ('${tmId}', '${tId}', '${mId}', ${j}, '${NOW}');`);
    }

    // scenario_step: trigger_condition に delay_from_follow を設定
    lines.push(`INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, template_id, trigger_condition, created_at) VALUES ('${stepId}', '${scenarioId}', ${i}, ${absoluteMinutes}, '${firstMsg.messageType}', '${esc(firstMsg.messageContent)}', '${tId}', '${esc(triggerCondition)}', '${NOW}');`);
  }
  lines.push('');
}

console.log(lines.join('\n'));
