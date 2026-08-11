#!/usr/bin/env node
/**
 * 全12シナリオのINSERT SQLを生成してstdoutに出力
 * 使い方:
 *   node scripts/generate-scenarios-sql.mjs > /tmp/scenarios.sql
 *   npx wrangler d1 execute line-crm --remote --file=/tmp/scenarios.sql
 */

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function esc(s) {
  return s.replace(/'/g, "''");
}

const IMG = 'https://storage.googleapis.com/furimauto_line/images/messageEvent/';
const I = {
  follow2:    IMG + 'follow_event_img2.png',
  follow1:    IMG + 'follow_event_img1.png',
  only5days:  IMG + 'only5days.png',
  only1day:   IMG + 'only1day.png',
  only10days: IMG + 'only10days.png',
  bye:        IMG + 'bye.png',
};
const VID_INSTALL = {
  messageType: 'video',
  messageContent: JSON.stringify({
    originalContentUrl: 'https://storage.googleapis.com/furimauto_line/video/install.mp4',
    previewImageUrl:    'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png',
    trackingId: 'setup',
  }),
};

function img(url) {
  return { messageType: 'image', messageContent: JSON.stringify({ originalContentUrl: url, previewImageUrl: url }) };
}
function txt(text) {
  return { messageType: 'text', messageContent: text };
}
function flex(altText, contents) {
  return { messageType: 'flex', messageContent: JSON.stringify({ type: 'flex', altText, contents }) };
}

const surveyFlex = flex('▼ 1問アンケートはこちら ▼', {
  type: 'bubble',
  hero: {
    type: 'image',
    url: IMG + 'follow_event_img3.png',
    size: 'full',
    aspectRatio: '16:9',
    aspectMode: 'cover',
  },
  body: {
    type: 'box',
    layout: 'vertical',
    contents: [
      { type: 'text', text: '▼ 1問アンケートはこちら ▼', weight: 'bold', size: 'lg', wrap: true, align: 'center' },
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
        height: 'sm',
        action: { type: 'message', label: '開始する', text: '【ボタン】アンケート開始' },
      },
    ],
  },
});

function toSteps(dayGroups) {
  const steps = [];
  let stepOrder = 0;
  let prevDay = 0;
  for (let i = 0; i < dayGroups.length; i++) {
    const { day, messages } = dayGroups[i];
    const firstDelay = i === 0 ? 0 : (day - prevDay) * 1440;
    prevDay = day;
    for (let j = 0; j < messages.length; j++) {
      steps.push({ stepOrder: stepOrder++, delayMinutes: j === 0 ? firstDelay : 0, ...messages[j] });
    }
  }
  return steps;
}

const SCENARIOS = [
  {
    name: 'FurimAuto 通常 ステップ配信（セグメント1: アンケート未回答）',
    triggerType: 'friend_add',
    days: [
      { day: 0, messages: [img(I.follow2), txt(`【無料お試し期間スタート！特典①②は受け取り済みです🎁】

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

▼アンケートはこちらから`), surveyFlex] },
      { day: 1, messages: [txt(`【アンケートの回答をお待ちしています！】

FurimAutoです。

特典①②はすでにお届け済みです🎁
アンケートに回答してキーコードをゲットすると特典③④もプレゼントしています！

キーコードを拡張機能に入力すれば、すぐにFurimAutoが使えます。

✅入門編1
https://youtu.be/FY8GUB-CoaY

残り6日です。今すぐ始めましょう！

▼アンケートはこちらから`), surveyFlex] },
      { day: 2, messages: [img(I.only5days), txt(`【無料で使えるのはあと5日です】

FurimAutoです。

無料期間は"友達登録してから"7日間です⚠️
キーコードを発行してから、ではありません。

今からでも全然間に合います！
アンケートに回答して、3分だけツールを試してみてください😄

特典①②はすでにお届け済みです🎁
アンケート回答で特典③④もゲットしてください！

▼アンケートはこちらから`), surveyFlex] },
      { day: 3, messages: [txt(`【こんなお悩みありませんか？】

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

▼アンケートはこちらから`), surveyFlex] },
      { day: 4, messages: [txt(`【実際のユーザーの声をご紹介】

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

▼アンケートはこちらから`), surveyFlex] },
      { day: 5, messages: [img(I.only1day), txt(`【明日で無料期間が終了します！】

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

▼アンケートはこちらから`), surveyFlex] },
      { day: 6, messages: [img(I.bye), txt(`【本日が最後のメッセージです】

FurimAutoです。

無料期間が終了します。

少しでも気になっていただけているなら、
ぜひこちらの解説動画だけ見てみてください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・効果、全部動画で説明しています。
Meetなしでそのままご加入いただけます。

またいつでもお声がけください😊`)] },
    ],
  },
  {
    name: 'FurimAuto 通常 ステップ配信（セグメント2: アンケート回答済み）',
    triggerType: 'manual',
    days: [
      { day: 0, messages: [txt(`【キーコードを発行して特典⑤⑥をゲット！】

アンケートのご回答ありがとうございます🎉
特典③④はすでにお届け済みです🎁

次はキーコードを発行しましょう🔑

リッチメニューの「キーコード発行」をタップするだけ！
発行したら、リッチメニューの「限定特典GET」をタップして
特典⑤⑥を受け取ってください🎁

✅入門編1
https://youtu.be/FY8GUB-CoaY

✅入門編2
https://youtu.be/vfJzKP8K0yY`)] },
      { day: 1, messages: [txt(`【キーコード発行で物販が変わります！】

FurimAutoです。

キーコード発行はまだお済みでしょうか？

リッチメニューの「キーコード発行」をタップするだけです。
発行後はPCのChrome拡張機能にキーコードを入力すれば
すぐにFurimAutoが動き始めます！

キーコード発行で限定特典⑤⑥もゲット🎁
リッチメニュー「限定特典GET」をお忘れなく！

✅入門編1
https://youtu.be/FY8GUB-CoaY`)] },
      { day: 2, messages: [img(I.only5days), txt(`【残り5日！キーコードを発行しよう】

FurimAutoです。

無料期間はカウントダウン中です😫

3分だけ時間をとってキーコードを発行してみてください！
リッチメニューの「キーコード発行」をタップするだけです。

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI`)] },
      { day: 3, messages: [txt(`【FurimAutoで理想の物販ライフへ】

FurimAutoです。

✅ 朝起きたら自動で値下げ完了
✅ 面倒な作業から解放されて出品に集中
✅ 毎月の売上がじわじわアップ

難しい操作は一切ありません。

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o`)] },
      { day: 4, messages: [txt(`【ユーザーの声をご紹介】

FurimAutoです。

✨「発行してすぐ使い始め、月利が安定しました！」
✨「こんなに簡単なのに効果抜群で驚きました！」

▼お客様の声
https://furimauto.com/service/#scroll_voice

残り3日！今すぐキーコードを発行してください🔑

✅上級編1
https://youtu.be/-HmR263oHyk`)] },
      { day: 5, messages: [img(I.only1day), txt(`【明日で無料期間終了です！】

FurimAutoです。

「プランを継続したいけどどうすれば？」という方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

動画を見た後動画内で案内されるキーワードをLINEに送ると試用期間が延長されます✨

✅上級編3
https://youtu.be/EbhveXLO1FI`)] },
      { day: 6, messages: [img(I.bye), txt(`【本日が最後のメッセージです】

FurimAutoです。

気になっている方はこちらの動画だけでもご覧ください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

Meetなしでそのままご加入いただけます。

またいつでもお声がけお待ちしております😊`)] },
    ],
  },
  {
    name: 'FurimAuto 通常 ステップ配信（セグメント3: キーコード発行済み）',
    triggerType: 'manual',
    days: [
      { day: 0, messages: [VID_INSTALL, txt(`【あと3分！キーコードを入力して特典⑦⑧をゲット】

キーコードの発行ありがとうございます🎉

次はPCでの作業です。動画を見ながらやってみてください☝️

1️⃣ リッチメニュー「キーコード発行」でキーコードを確認
2️⃣ キーコードを長押しでコピー
3️⃣ PCのChromeでFurimAutoの拡張機能を開く
4️⃣ 入力欄にキーコードをペーストして確定！

終わったらリッチメニューの「限定特典GET」をタップ！
特典⑦⑧がプレゼントされます🎁`)] },
      { day: 1, messages: [txt(`【キーコード入力はお済みですか？】

FurimAutoです。

手順を再掲します👇

1️⃣ リッチメニュー「キーコード発行」でキーコードをコピー
2️⃣ PCのChromeでFurimAutoの拡張機能を開く
3️⃣ 入力欄にペーストして確定！

入力が完了すると特典⑦⑧がゲットできます🎁`)] },
      { day: 2, messages: [VID_INSTALL, txt(`【まだ入力できていない方へ】

FurimAutoです。

上の動画を見ながらキーコードを入力してください！

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o`)] },
      { day: 3, messages: [txt(`【FurimAutoで理想の物販ライフへ！】

FurimAutoです。

✅ 毎日の値下げ作業が完全自動に
✅ 出品数を増やして売上アップ
✅ ストレスフリーで物販を楽しめる

✅中級編3
https://youtu.be/gAtxMiysWsY`)] },
      { day: 4, messages: [txt(`【サポートします！お気軽にどうぞ】

FurimAutoです。

拡張機能の入力でお困りの方はこのLINEにメッセージください。

✅上級編1
https://youtu.be/-HmR263oHyk

✅上級編2
https://youtu.be/8rAdmKTYsUs`)] },
      { day: 5, messages: [img(I.only1day), txt(`【明日で無料期間終了！最後のチャンス】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

動画を見てキーワードをLINEに送ると
✨無料試用期間が延長されます
✨限定特典⑫⑬もプレゼント！`)] },
      { day: 6, messages: [txt(`【試用期間を延長する方法があります！】

FurimAutoです。

「もう少し使ってから決めたい」という方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

▼料金表
https://furimauto.com/service/#scroll_plan`)] },
      { day: 7, messages: [img(I.bye), txt(`【本日が最後のメッセージです】

FurimAutoです。

またいつでもお声がけください😊`)] },
    ],
  },
  {
    name: 'FurimAuto 通常 ステップ配信（セグメント4: 拡張インストール済み）',
    triggerType: 'manual',
    days: [
      { day: 0, messages: [txt(`【まずは自動値下げを試してみて！】

FurimAutoの導入おめでとうございます🎉

メルカリの出品一覧ページを開いてみてください！

✅入門編1
https://youtu.be/FY8GUB-CoaY

✅入門編2
https://youtu.be/vfJzKP8K0yY`), txt(`【🎫 無料コピー出品チケットを受け取ろう！】

リッチメニューの「限定特典GET」をタップしてください！

特典⑨⑩として【無料コピー出品チケット】がプレゼントされています🎁`)] },
      { day: 1, messages: [txt(`【限定特典⑨⑩を受け取ろう！】

FurimAutoです。

リッチメニューの「限定特典GET」をタップしてみてください！

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI`)] },
      { day: 2, messages: [txt(`【時短・コストカットの最強ツール】

FurimAutoです。

✅ コピー出品で出品数を一気に増やす
✅ まとめ買い割引の自動設定
✅ 売れ筋商品のリサーチ支援

✅初級編3
https://youtu.be/TgnC29kkbW4`)] },
      { day: 3, messages: [txt(`【よくある質問に答えます！】

FurimAutoです。

Q. 自動値下げが動かない？
A. リッチメニューの「ガイド」に手順があります。

Q. 複数商品を同時に値下げできる？
A. できます！

解決しない場合はこのLINEにメッセージください👍

✅中級編2
https://youtu.be/-dlzv6sbh4o`)] },
      { day: 4, messages: [txt(`【有料プランへの移行方法について】

FurimAutoです。

継続を検討されている方はまずこちらをご覧ください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

✅ Meetなしで申し込みOK！
✅ 動画を見てキーワードを送ると試用期間延長＋特典⑫⑬！

▼料金表
https://furimauto.com/service/#scroll_plan`)] },
      { day: 5, messages: [img(I.only1day), txt(`【明日で無料期間終了！動画を見て延長しよう】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

✨無料試用期間が延長されます
✨限定特典⑫⑬もプレゼント！`)] },
      { day: 6, messages: [txt(`【試用期間延長のラストチャンス！】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

▼料金表
https://furimauto.com/service/#scroll_plan`)] },
      { day: 7, messages: [img(I.bye), txt(`【本日が最後のメッセージです】

FurimAutoです。

またいつでもお声がけください😊`)] },
    ],
  },
  {
    name: 'FurimAuto 通常 ステップ配信（セグメント5: Free30取得済み）',
    triggerType: 'manual',
    days: [
      { day: 0, messages: [img(I.follow1), txt(`【特典⑨⑩受け取り完了！次は⑪をゲット！】

FurimAutoを積極的にご利用いただきありがとうございます！😆

1分解説シリーズのYoutubeを全部見て、
YoutubeのコメントにFurimAutoと入力してください！
コメントのスクショをLINEに送っていただくと特典⑪が受け取れます。

✅入門編1
https://youtu.be/FY8GUB-CoaY

✅入門編2
https://youtu.be/vfJzKP8K0yY`)] },
      { day: 1, messages: [txt(`【1分解説シリーズで特典⑪をゲット！】

FurimAutoです。

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI

✅初級編3
https://youtu.be/TgnC29kkbW4

YoutubeのコメントにFurimAutoと入力してスクショをLINEに送ると特典⑪がもらえます🎁`)] },
      { day: 2, messages: [txt(`【FurimAutoをフル活用しよう】

FurimAutoです。

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o

✅中級編3
https://youtu.be/gAtxMiysWsY`)] },
      { day: 3, messages: [txt(`【特典⑫⑬ゲットのチャンス！】

FurimAutoです。

▼FurimAuto完全解説動画
https://www.youtube.com/watch?v=jhaCPxgE_Sk

この動画を見た後キーワードをLINEに送ってください！
✨無料試用期間が延長されます
✨限定特典⑫⑬をプレゼント！`)] },
      { day: 4, messages: [txt(`【有料プランへの移行方法について】

FurimAutoです。

▼まずこちらをご覧ください
https://www.youtube.com/watch?v=jhaCPxgE_Sk

✅ Meetなしで申し込みOK！
▼料金表
https://furimauto.com/service/#scroll_plan`)] },
      { day: 5, messages: [img(I.only1day), txt(`【明日で無料期間終了！動画を見て延長しよう】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

✨無料試用期間が延長されます✨
✨限定特典⑫⑬もプレゼント✨`)] },
      { day: 6, messages: [txt(`【試用期間延長 & 特典⑫⑬ゲットのラストチャンス】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

▼料金表
https://furimauto.com/service/#scroll_plan`)] },
    ],
  },
  {
    name: 'FurimAuto 通常 ステップ配信（セグメント6: 試用期間終了）',
    triggerType: 'manual',
    days: [
      { day: 0, messages: [img(I.bye), txt(`【無料期間終了のお知らせ】

FurimAutoです。

無料期間が終了しました。

「やっぱり続けたい！」という方はこちらから👇
https://furimauto.com/service/#scroll_plan

またいずれ、その時にお会いできることを楽しみにしております,,,!

(いつでも有料プランへのお切り替えはお声がけください👍)`)] },
    ],
  },
  // ─── 紹介 14日 ───────────────────────────
  {
    name: 'FurimAuto 紹介 ステップ配信（セグメント1: アンケート未回答）',
    triggerType: 'manual',
    days: [
      { day: 0, messages: [img(I.follow2), txt(`【2週間の無料お試し期間スタート！特典①②は受け取り済みです🎁】

FurimAutoです。
ご紹介いただきありがとうございます！
14日間の無料期間はすでにスタートしています！🎉

アンケート回答でさらに特典③④もプレゼント！

✅入門編1
https://youtu.be/FY8GUB-CoaY

✅入門編2
https://youtu.be/vfJzKP8K0yY

▼アンケートはこちらから`), surveyFlex] },
      { day: 1, messages: [txt(`【アンケートの回答をお待ちしています！】

FurimAutoです。

ご紹介者様は実際にご利用いただいての紹介ですので
きっとすぐにその効果を実感いただけるはずです😊

✅入門編1
https://youtu.be/FY8GUB-CoaY

▼アンケートはこちらから`), surveyFlex] },
      { day: 4, messages: [img(I.only5days), txt(`【無料で使えるのはあと10日です】

FurimAutoです。

今からでも全然間に合います！
アンケートに回答して、3分だけツールを試してみてください😄

✅初級編1
https://youtu.be/HVHKhbnZe6M

▼アンケートはこちらから`), surveyFlex] },
      { day: 6, messages: [txt(`【こんなお悩みありませんか？】

FurimAutoです。

「毎日手動で値下げするのが大変…」
「なかなか売れなくて困っている…」

FurimAutoが全部解決します！

ご紹介者様はこれを実感されての紹介です！

▼アンケートはこちらから`), surveyFlex] },
      { day: 8, messages: [txt(`【実際のユーザーの声をご紹介】

FurimAutoです。

ご紹介者様も同様の効果を実感されていますよ😊

残り6日です！今すぐアンケートに回答して
キーコードをゲットし特典③④も受け取ってください🎁

▼アンケートはこちらから`), surveyFlex] },
      { day: 10, messages: [txt(`【有料プランへの移行を真剣に考えてみてください】

FurimAutoです。

残り4日になりました。

▼FurimAuto完全解説動画
https://www.youtube.com/watch?v=jhaCPxgE_Sk

動画を見た後キーワードをLINEに送ると
✨無料試用期間がさらに延長されます
✨限定特典⑫⑬もプレゼント！`)] },
      { day: 12, messages: [img(I.only1day), txt(`【明日で無料期間が終了します！】

FurimAutoです。

まだ間に合います！
アンケートに回答して、今日だけでもFurimAutoを体験してください。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

▼アンケートはこちらから`), surveyFlex] },
      { day: 13, messages: [img(I.bye), txt(`【本日が最後のメッセージです】

FurimAutoです。

少しでも気になっていただけているなら、
ぜひこちらの解説動画だけ見てみてください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

Meetなしでそのままご加入いただけます。

ご紹介いただいたお友達の方にも弊社から一言感謝のご連絡をさせていただきますm(_ _)m

またいつでもお声がけください😊`)] },
    ],
  },
  {
    name: 'FurimAuto 紹介 ステップ配信（セグメント2: アンケート回答済み）',
    triggerType: 'manual',
    days: [
      { day: 0, messages: [txt(`【キーコードを発行して特典⑤⑥をゲット！】

アンケートのご回答ありがとうございます🎉

リッチメニューの「キーコード発行」をタップするだけ！

✅入門編1
https://youtu.be/FY8GUB-CoaY

✅入門編2
https://youtu.be/vfJzKP8K0yY`)] },
      { day: 1, messages: [txt(`【キーコード発行で物販が変わります！】

FurimAutoです。

✅入門編1
https://youtu.be/FY8GUB-CoaY`)] },
      { day: 4, messages: [img(I.only10days), txt(`【残り10日！キーコードを発行しよう】

FurimAutoです。

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI

✅初級編3
https://youtu.be/TgnC29kkbW4`)] },
      { day: 6, messages: [VID_INSTALL, txt(`【「キーコード発行」をタップするだけ!!】

FurimAutoです。

上の動画の通りにやれば3分で完了します！

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o`)] },
      { day: 8, messages: [txt(`【ユーザーの声をご紹介】

FurimAutoです。

✨「発行からすぐに使い始め、月利が安定しました！」

▼お客様の声
https://furimauto.com/service/#scroll_voice

残り6日！今すぐキーコードを発行してください🔑`)] },
      { day: 12, messages: [img(I.only1day), txt(`【明日で無料期間終了です！】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

動画を見てキーワードをLINEに送ると試用期間が延長されます✨`)] },
      { day: 13, messages: [img(I.bye), txt(`【本日が最後のメッセージです】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

ご紹介いただいたお友達の方にも弊社から一言感謝のご連絡をさせていただきますm(_ _)m

またいつでもお声がけお待ちしております😊`)] },
    ],
  },
  {
    name: 'FurimAuto 紹介 ステップ配信（セグメント3: キーコード発行済み）',
    triggerType: 'manual',
    days: [
      { day: 0, messages: [VID_INSTALL, txt(`【あと3分！キーコードを入力して特典⑦⑧をゲット】

キーコードの発行ありがとうございます🎉

1️⃣ リッチメニュー「キーコード発行」でキーコードを確認
2️⃣ キーコードを長押しでコピー
3️⃣ PCのChromeでFurimAutoの拡張機能を開く
4️⃣ 入力欄にキーコードをペーストして確定！

終わったらリッチメニューの「限定特典GET」をタップ！
特典⑦⑧がプレゼントされます🎁`)] },
      { day: 1, messages: [txt(`【キーコード入力はお済みですか？】

FurimAutoです。

迷ったらこのLINEにメッセージください！すぐにサポートします😊

入力が完了すると特典⑦⑧がゲットできます🎁`)] },
      { day: 2, messages: [VID_INSTALL, txt(`【まだ入力できていない方へ】

FurimAutoです。

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o`)] },
      { day: 3, messages: [txt(`【FurimAutoで理想の物販ライフへ！】

FurimAutoです。

ご紹介者様はこれを実感されての紹介です！

✅中級編3
https://youtu.be/gAtxMiysWsY`)] },
      { day: 4, messages: [txt(`【サポートします！お気軽にどうぞ】

FurimAutoです。

✅上級編1
https://youtu.be/-HmR263oHyk

✅上級編2
https://youtu.be/8rAdmKTYsUs

✅上級編3（最終まとめ編）
https://youtu.be/EbhveXLO1FI`)] },
      { day: 12, messages: [img(I.only1day), txt(`【明日で無料期間終了！最後のチャンス】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

✨無料試用期間が延長されます
✨限定特典⑫⑬もプレゼント！`)] },
      { day: 13, messages: [img(I.bye), txt(`【本日が最後のメッセージです】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

ご紹介いただいたお友達の方にも弊社から一言感謝のご連絡をさせていただきますm(_ _)m

またいつでもお声がけお待ちしております😊`)] },
    ],
  },
  {
    name: 'FurimAuto 紹介 ステップ配信（セグメント4: 拡張インストール済み）',
    triggerType: 'manual',
    days: [
      { day: 0, messages: [txt(`【まずは自動値下げを試してみて！】

FurimAutoの導入おめでとうございます🎉

✅入門編1
https://youtu.be/FY8GUB-CoaY

✅入門編2
https://youtu.be/vfJzKP8K0yY`), txt(`【🎫 無料コピー出品チケットを受け取ろう！】

リッチメニューの「限定特典GET」をタップしてください！

特典⑨⑩として【無料コピー出品チケット】がプレゼントされています🎁`)] },
      { day: 1, messages: [txt(`【限定特典⑨⑩を受け取ろう！】

FurimAutoです。

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI`)] },
      { day: 2, messages: [txt(`【時短・コストカットの最強ツール】

FurimAutoです。

✅初級編3
https://youtu.be/TgnC29kkbW4`)] },
      { day: 3, messages: [txt(`【よくある質問に答えます！】

FurimAutoです。

Q. 自動値下げが動かない？
A. リッチメニューの「ガイド」に手順があります。

解決しない場合はこのLINEにメッセージください👍

✅中級編2
https://youtu.be/-dlzv6sbh4o`)] },
      { day: 4, messages: [txt(`【有料プランへの移行方法について】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

✅ Meetなしで申し込みOK！
▼料金表
https://furimauto.com/service/#scroll_plan`)] },
      { day: 12, messages: [img(I.only1day), txt(`【明日で無料期間終了！動画を見て延長しよう】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

✨無料試用期間が延長されます
✨限定特典⑫⑬もプレゼント！`)] },
      { day: 13, messages: [img(I.bye), txt(`【本日が最後のメッセージです】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

ご紹介いただいたお友達の方にも弊社から一言感謝のご連絡をさせていただきますm(_ _)m

またいつでもお声がけお待ちしております😊`)] },
    ],
  },
  {
    name: 'FurimAuto 紹介 ステップ配信（セグメント5: Free30取得済み）',
    triggerType: 'manual',
    days: [
      { day: 0, messages: [img(I.follow1), txt(`【特典⑨⑩受け取り完了！次は⑪をゲット！】

FurimAutoを積極的にご利用いただきありがとうございます！😆

1分解説シリーズのYoutubeを全部見て、
YoutubeのコメントにFurimAutoと入力してください！
コメントのスクショをLINEに送っていただくと特典⑪が受け取れます。

✅入門編1
https://youtu.be/FY8GUB-CoaY

✅入門編2
https://youtu.be/vfJzKP8K0yY`)] },
      { day: 1, messages: [txt(`【1分解説シリーズで特典⑪をゲット！】

FurimAutoです。

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI

✅初級編3
https://youtu.be/TgnC29kkbW4`)] },
      { day: 2, messages: [txt(`【FurimAutoをフル活用しよう】

FurimAutoです。

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o

✅中級編3
https://youtu.be/gAtxMiysWsY`)] },
      { day: 3, messages: [txt(`【特典⑫⑬ゲットのチャンス！長尺動画公開中🎬】

FurimAutoです。

▼FurimAuto完全解説動画
https://www.youtube.com/watch?v=jhaCPxgE_Sk

この動画を見た後キーワードをLINEに送ってください！
✨無料試用期間が延長されます
✨限定特典⑫⑬をプレゼント！`)] },
      { day: 4, messages: [txt(`【有料プランへの移行方法について】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

✅ Meetなしで申し込みOK！
▼料金表
https://furimauto.com/service/#scroll_plan`)] },
      { day: 12, messages: [img(I.only1day), txt(`【明日で無料期間終了！動画を見て延長しよう】

FurimAutoです。

https://www.youtube.com/watch?v=jhaCPxgE_Sk

✨無料試用期間が延長されます✨
✨限定特典⑫⑬もプレゼント✨`)] },
    ],
  },
  {
    name: 'FurimAuto 紹介 ステップ配信（セグメント6: 試用期間終了）',
    triggerType: 'manual',
    days: [
      { day: 0, messages: [img(I.bye), txt(`【無料期間終了のお知らせ】

FurimAutoです。

無料期間が終了しました。

「やっぱり続けたい！」という方はこちらから👇
https://furimauto.com/service/#scroll_plan

またいずれ、その時にお会いできることを楽しみにしております,,,!

(いつでも有料プランへのお切り替えはお声がけください👍)`)] },
    ],
  },
];

// SQL生成
const lines = [];
// BEGIN; は D1 では使えないため省略

// 旧シナリオ削除
lines.push(`DELETE FROM scenarios WHERE name IN (
  'FurimAuto 友達紹介 ステップ配信（14日間）',
  'FurimAuto 友達追加 ステップ配信（セグメント1: アンケート未回答）'
);`);
lines.push(`DELETE FROM scenarios WHERE name LIKE 'FurimAuto 通常 ステップ配信%' OR name LIKE 'FurimAuto 紹介 ステップ配信%';`);

for (const scenario of SCENARIOS) {
  const scenarioId = uuid();
  const steps = toSteps(scenario.days);
  const now = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');

  lines.push(`INSERT INTO scenarios (id, name, trigger_type, is_active, created_at, updated_at) VALUES ('${scenarioId}', '${esc(scenario.name)}', '${scenario.triggerType}', 1, '${now}', '${now}');`);

  for (const step of steps) {
    const stepId = uuid();
    lines.push(`INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, created_at) VALUES ('${stepId}', '${scenarioId}', ${step.stepOrder}, ${step.delayMinutes}, '${step.messageType}', '${esc(step.messageContent)}', '${now}');`);
  }
}

// COMMIT; は D1 では使えないため省略
console.log(lines.join('\n'));
