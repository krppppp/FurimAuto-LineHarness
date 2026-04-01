#!/usr/bin/env node
/**
 * FurimAuto 全シナリオ一括登録スクリプト (v2)
 * 通常7本 + 紹介7本 = 計14シナリオを正しいrelative delayで登録する
 *
 * 使い方:
 *   WORKER_URL=https://line-harness.furimuato.workers.dev API_KEY=xxx node scripts/seed-furimauto-all-scenarios.mjs
 *
 * オプション:
 *   DELETE_OLD=1  既存の旧シナリオ（DEV DBに入っている壊れたもの）を事前に削除する
 */

const BASE_URL = process.env.WORKER_URL || 'https://line-harness.furimuato.workers.dev';
const API_KEY = process.env.API_KEY;
const DELETE_OLD = process.env.DELETE_OLD === '1';

if (!API_KEY) {
  console.error('Error: API_KEY 環境変数が未設定です');
  process.exit(1);
}

// DEV DBに入っている旧シナリオID（delay bugあり・DELETE_OLD=1時に削除）
const OLD_SCENARIO_IDS = [
  'b88f0db6-1123-46d6-bae7-b443e3f954cf', // 旧: Normal Seg1
  '0c594c7e-3c24-41be-a63c-8a3acad7bda8', // 旧: Referral Seg1
];

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`,
};

async function req(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`${method} ${path} status=${res.status} body=${text}`);
  }
  if (!res.ok && !json.success) throw new Error(`${method} ${path} failed: ${JSON.stringify(json)}`);
  return json.data;
}

// ──────────────── helpers ────────────────

function img(url) {
  return { messageType: 'image', messageContent: JSON.stringify({ originalContentUrl: url, previewImageUrl: url }) };
}
function txt(text) {
  return { messageType: 'text', messageContent: text };
}
function vid(originalContentUrl, previewImageUrl, trackingId) {
  return { messageType: 'video', messageContent: JSON.stringify({ originalContentUrl, previewImageUrl, trackingId }) };
}
function flex(altText, contents) {
  return { messageType: 'flex', messageContent: JSON.stringify({ type: 'flex', altText, contents }) };
}

// 画像URL
const IMG = 'https://storage.googleapis.com/furimauto_line/images/messageEvent/';
const I = {
  follow2:   IMG + 'follow_event_img2.png',
  follow1:   IMG + 'follow_event_img1.png',
  only5days: IMG + 'only5days.png',
  only1day:  IMG + 'only1day.png',
  only10days:IMG + 'only10days.png',
  bye:       IMG + 'bye.png',
};
const VID_INSTALL = vid(
  'https://storage.googleapis.com/furimauto_line/video/install.mp4',
  'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png',
  'setup',
);

// アンケートボタン Flex
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

/**
 * dayGroupsをSTEPSに変換する
 * dayGroups: [{ day: number, messages: [{messageType, messageContent}] }, ...]
 * 最初のgroupのday0は delay=0、以降は (day - prevDay) * 1440 を先頭messageに設定し、同日残りは delay=0
 */
function toSteps(dayGroups) {
  const steps = [];
  let stepOrder = 0;
  let prevDay = 0;

  for (let i = 0; i < dayGroups.length; i++) {
    const { day, messages } = dayGroups[i];
    const firstDelay = i === 0 ? 0 : (day - prevDay) * 1440;
    prevDay = day;

    for (let j = 0; j < messages.length; j++) {
      steps.push({
        stepOrder: stepOrder++,
        delayMinutes: j === 0 ? firstDelay : 0,
        ...messages[j],
      });
    }
  }
  return steps;
}

// ──────────────── シナリオ定義 ────────────────

const SCENARIOS = [
  // ═══════════════════════════════════════════
  //  通常 (7日間) セグメント1-6
  // ═══════════════════════════════════════════
  {
    name: 'FurimAuto 通常 ステップ配信（セグメント1: アンケート未回答）',
    triggerType: 'friend_add',
    isActive: true,
    days: [
      { day: 0, messages: [
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
      { day: 1, messages: [
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
      { day: 2, messages: [
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
      { day: 3, messages: [
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
      { day: 4, messages: [
        txt(`【実際のユーザーの声をご紹介】

FurimAutoです。

「本当に効果があるの？」と思っていませんか？

✨「月利が2倍になりました！」
✨「作業時間が激減してプライベートが充実！」
✨「初心者でも簡単に使えました！」

▼お客様の声はこちら
https://furimauto.com/lp0/#scroll_voice

残り3日です！今すぐアンケートに回答して
キーコードをゲットし特典③④も受け取ってください🎁
（①②はすでにお届け済みです）

▼アンケートはこちらから`),
        surveyFlex,
      ]},
      { day: 5, messages: [
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
      { day: 6, messages: [
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
    name: 'FurimAuto 通常 ステップ配信（セグメント2: アンケート回答済み）',
    triggerType: 'manual',
    isActive: true,
    days: [
      { day: 0, messages: [
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
      { day: 1, messages: [
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
      { day: 2, messages: [
        img(I.only5days),
        txt(`【残り5日！キーコードを発行しよう】

FurimAutoです。

無料期間はカウントダウン中です😫

3分だけ時間をとってキーコードを発行してみてください！
リッチメニューの「キーコード発行」をタップするだけです。

発行後の拡張機能への入力方法も動画で確認できます👇

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI`),
      ]},
      { day: 3, messages: [
        txt(`【FurimAutoで理想の物販ライフへ】

FurimAutoです。

キーコードを発行して拡張機能を入れるだけで、
こんな生活が実現します！

✅ 朝起きたら自動で値下げ完了
✅ 面倒な作業から解放されて出品に集中
✅ 毎月の売上がじわじわアップ

難しい操作は一切ありません。
動画の通りにやれば誰でもできます😄

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o`),
      ]},
      { day: 4, messages: [
        txt(`【ユーザーの声をご紹介】

FurimAutoです。

「キーコードを発行する価値あるの？」と思っていませんか？

✨「発行してすぐ使い始め、月利が安定しました！」
✨「こんなに簡単なのに効果抜群で驚きました！」

▼お客様の声はこちら
https://furimauto.com/lp0/#scroll_voice

残り3日！今すぐキーコードを発行してください🔑

✅上級編1
https://youtu.be/-HmR263oHyk`),
      ]},
      { day: 5, messages: [
        img(I.only1day),
        txt(`【明日で無料期間終了です！】

FurimAutoです。

「プランを継続したいけどどうすれば？」という方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・申し込み方法、全部この動画で解説しています。
動画を見た後動画内で案内されるキーワードをLINEに送ると試用期間が延長されます✨

Meetは任意です。動画だけで全部わかります！

✅上級編3
https://youtu.be/EbhveXLO1FI`),
      ]},
      { day: 6, messages: [
        img(I.bye),
        txt(`【本日が最後のメッセージです】

FurimAutoです。

無料期間が終了します。

気になっている方はこちらの動画だけでもご覧ください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

全ての疑問がこの動画で解決します。
Meetなしでそのままご加入いただけます。

またいつでもお声がけお待ちしております😊`),
      ]},
    ],
  },

  {
    name: 'FurimAuto 通常 ステップ配信（セグメント3: キーコード発行済み）',
    triggerType: 'manual',
    isActive: true,
    days: [
      { day: 0, messages: [
        VID_INSTALL,
        txt(`【あと3分！キーコードを入力して特典⑦⑧をゲット】

キーコードの発行ありがとうございます🎉

次はPCでの作業です。動画を見ながらやってみてください☝️

1️⃣ このLINEのリッチメニュー「キーコード発行」でキーコードを確認
2️⃣ キーコードを長押しでコピー
3️⃣ PCのChromeでFurimAutoの拡張機能を開く
4️⃣ 入力欄にキーコードをペーストして確定！

これだけです。本当に3分で終わります😎

終わったらリッチメニューの「限定特典GET」をタップ！
特典⑦⑧がプレゼントされます🎁`),
      ]},
      { day: 1, messages: [
        txt(`【キーコード入力はお済みですか？】

FurimAutoです。

PCへのキーコード入力がまだの方へ、手順を再掲します👇

1️⃣ リッチメニュー「キーコード発行」でキーコードを確認・コピー
2️⃣ PCのChromeでFurimAutoの拡張機能を開く
3️⃣ 入力欄にペーストして確定！

迷ったらこのLINEにメッセージください！すぐにサポートします😊

入力が完了すると特典⑦⑧がゲットできます🎁
リッチメニューの「限定特典GET」をタップ！`),
      ]},
      { day: 2, messages: [
        VID_INSTALL,
        txt(`【まだ入力できていない方へ】

FurimAutoです。

上の動画を見ながらキーコードを入力してください！

✅ キーコードはリッチメニュー「キーコード発行」で確認できます
✅ 表示されたキーコードをコピーしてPCの拡張機能にペーストするだけ

入力完了したらリッチメニュー「限定特典GET」もお忘れなく🎁

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o`),
      ]},
      { day: 3, messages: [
        txt(`【FurimAutoで理想の物販ライフへ！】

FurimAutoです。

拡張機能の入力が完了すると、
あなたのメルカリ物販はこう変わります！

✅ 毎日の値下げ作業が完全自動に
✅ 出品数を増やして売上アップ
✅ ストレスフリーで物販を楽しめる

朝起きたら値下げが完了していて、
あとは売れた商品を発送するだけ…

そんな生活が3分で手に入ります！

✅中級編3
https://youtu.be/gAtxMiysWsY`),
      ]},
      { day: 4, messages: [
        txt(`【サポートします！お気軽にどうぞ】

FurimAutoです。

拡張機能の入力でお困りではありませんか？

もし上手くいかない場合はこのLINEにメッセージください。
丁寧にサポートいたします😊

✅上級編1
https://youtu.be/-HmR263oHyk

✅上級編2
https://youtu.be/8rAdmKTYsUs`),
      ]},
      { day: 5, messages: [
        img(I.only1day),
        txt(`【明日で無料期間終了！最後のチャンス】

FurimAutoです。

有料プランへの継続を検討されている方は、
まずこちらの動画をご覧ください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・申し込み方法、全てこの動画で解説しています。

動画を見た後動画内で案内されるキーワードをLINEに送ると
✨無料試用期間が延長されます
✨限定特典⑫⑬もプレゼント！

Meetは任意です。動画だけで全部わかります！`),
      ]},
      { day: 6, messages: [
        txt(`【試用期間を延長する方法があります！】

FurimAutoです。

「もう少し使ってから決めたい」という方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

この動画を見て動画内で案内されるキーワードをLINEに送ると
無料試用期間が延長されます✨

そのまま有料プランへのお申し込みもできます（Meetなしでok）
▼料金表はこちら
https://furimauto.com/lp0/#scroll_plan`),
      ]},
      { day: 7, messages: [
        img(I.bye),
        txt(`【本日が最後のメッセージです】

FurimAutoです。

無料期間が終了しました。

またいつでもお声がけください😊
有料プランへの切り替えはいつでも受け付けています。

またいずれ、その時にお会いできることを楽しみにしております,,,!`),
      ]},
    ],
  },

  {
    name: 'FurimAuto 通常 ステップ配信（セグメント4: 拡張インストール済み）',
    triggerType: 'manual',
    isActive: true,
    days: [
      { day: 0, messages: [
        txt(`【まずは自動値下げを試してみて！】

FurimAutoの導入おめでとうございます🎉

メルカリの出品一覧ページを開いてみてください！
FurimAutoの機能が有効になっているはずです✨

まずは自動値下げをスタートさせてみましょう！

✅入門編1
https://youtu.be/FY8GUB-CoaY

✅入門編2
https://youtu.be/vfJzKP8K0yY`),
        txt(`【🎫 無料コピー出品チケットを受け取ろう！】

リッチメニューの「限定特典GET」をタップしてください！

特典⑨⑩として【無料コピー出品チケット】がプレゼントされています🎁

コピー出品チケットを使うと
他の商品をワンクリックでコピー出品できるようになります！

出品数を一気に増やして売上を伸ばしましょう📈`),
      ]},
      { day: 1, messages: [
        txt(`【限定特典⑨⑩を受け取ろう！】

FurimAutoです。

ツールの使い方に慣れてきましたか？

リッチメニューの「限定特典GET」をタップしてみてください！
解放済みの特典はいつでも受け取れます🎁

1分解説シリーズのYoutubeを見ると特典⑪もゲットできます！
（リッチメニューの「1分解説シリーズ」からチェック）

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI`),
      ]},
      { day: 2, messages: [
        txt(`【時短・コストカットの最強ツール】

FurimAutoです。

自動値下げは動いていますか？

FurimAutoにはまだまだ便利な機能があります！

✅ コピー出品で出品数を一気に増やす
✅ まとめ買い割引の自動設定
✅ 売れ筋商品のリサーチ支援

全部リッチメニューの「ガイド」から確認できます。
動画を見ながら色々試してみてください😄

✅初級編3
https://youtu.be/TgnC29kkbW4`),
      ]},
      { day: 3, messages: [
        txt(`【よくある質問に答えます！】

FurimAutoです。

Q. 自動値下げが動かない？
A. 設定を確認してみてください。リッチメニューの「ガイド」に手順があります。

Q. 複数商品を同時に値下げできる？
A. できます！まとめて設定する方法も動画で解説しています。

Q. 他に便利な機能は？
A. コピー出品・まとめ買い割引など機能が多数あります。

解決しない場合はこのLINEにメッセージください👍

✅中級編2
https://youtu.be/-dlzv6sbh4o`),
      ]},
      { day: 4, messages: [
        txt(`【有料プランへの移行方法について】

FurimAutoです。

無料期間がもうすぐ終わります。

継続を検討されている方はまずこちらの解説動画をご覧ください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・申し込み方法、全てこの動画で解説しています。

✅ Meetなしで申し込みOK！
✅ 動画を見てキーワードを送ると試用期間延長＋特典⑫⑬！

▼料金表はこちら
https://furimauto.com/lp0/#scroll_plan`),
      ]},
      { day: 5, messages: [
        img(I.only1day),
        txt(`【明日で無料期間終了！動画を見て延長しよう】

FurimAutoです。

「もう少し使いたい！」という方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

動画を見た後動画内で案内されるキーワードをLINEに送ってください！
✨無料試用期間が延長されます
✨限定特典⑫⑬（ブランドリスト・プロフィール解説）もプレゼント！

Meetは任意です。このまま申し込みもできます😊`),
      ]},
      { day: 6, messages: [
        txt(`【試用期間延長のラストチャンス！】

FurimAutoです。

まだ動画を見ていない方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

この動画を見て動画内で案内されるキーワードをLINEに送ると：
✨ 無料試用期間が延長されます
✨ 特典⑫⑬がプレゼントされます

そのままお申し込みもできます（Meetなしでok）
▼料金表はこちら
https://furimauto.com/lp0/#scroll_plan`),
      ]},
      { day: 7, messages: [
        img(I.bye),
        txt(`【本日が最後のメッセージです】

FurimAutoです。

無料期間が終了しました。

またいつでもお声がけください😊
有料プランへの切り替えはいつでも受け付けています。

またいずれ、その時にお会いできることを楽しみにしております,,,!`),
      ]},
    ],
  },

  {
    name: 'FurimAuto 通常 ステップ配信（セグメント5: メルカリURL登録済み）',
    triggerType: 'manual',
    isActive: true,
    days: [
      { day: 0, messages: [
        img(I.follow1),
        txt(`【自動化スタート！無料コピー出品チケットを受け取ろう🎫】

FurimAutoです。

自動化が動き始めましたね！素晴らしいです😆

次のステップは「無料コピー出品チケット」の受け取りです🎁
リッチメニューの「限定特典GET」をタップしてください！

コピー出品チケットを使うと
他のフリマサイトへワンクリックでコピー出品できます！
出品数を一気に増やして売上を伸ばしましょう📈

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI`),
      ]},
      { day: 1, messages: [
        txt(`【コピーチケットは受け取りましたか？】

FurimAutoです。

リッチメニューの「限定特典GET」からコピー出品チケットを受け取れます🎫

コピー出品チケットを受け取ると
さらに特典⑨⑩もプレゼントされます🎁

困ったことがあればこのLINEにメッセージください👍

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o`),
      ]},
      { day: 2, messages: [
        txt(`【FurimAutoをもっとフル活用しよう！】

FurimAutoです。

自動値下げに慣れてきましたか？

FurimAutoにはまだまだ便利な機能があります！

✅ まとめ買い割引の自動設定
✅ 売れ筋商品のリサーチ支援
✅ ショップ調査機能

リッチメニューの「ガイド」から全機能を確認できます😄

✅中級編3
https://youtu.be/gAtxMiysWsY`),
      ]},
      { day: 3, messages: [
        txt(`【1分解説シリーズでさらに上を目指そう！】

FurimAutoです。

FurimAutoの全機能を1分動画で解説しています📹

✅上級編1
https://youtu.be/-HmR263oHyk

✅上級編2
https://youtu.be/8rAdmKTYsUs

✅上級編3
https://youtu.be/EbhveXLO1FI

動画を見てリッチメニューの「Furimanです」と送ると
嬉しい特典があります🎁`),
      ]},
      { day: 4, messages: [
        txt(`【有料プランへの移行方法について】

FurimAutoです。

無料期間がもうすぐ終わります。

継続を検討されている方はまずこちらの解説動画をご覧ください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・申し込み方法、全てこの動画で解説しています。

✅ Meetなしで申し込みOK！
✅ 動画を見てキーワードを送ると試用期間延長＋特典⑫⑬！

▼料金表はこちら
https://furimauto.com/lp0/#scroll_plan`),
      ]},
      { day: 5, messages: [
        img(I.only1day),
        txt(`【明日で無料期間終了！動画を見て延長しよう】

FurimAutoです。

「もう少し使いたい！」という方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

動画を見た後動画内で案内されるキーワードをLINEに送ってください！
✨無料試用期間が延長されます
✨限定特典⑫⑬（ブランドリスト・プロフィール解説）もプレゼント！

Meetは任意です。このまま申し込みもできます😊`),
      ]},
      { day: 6, messages: [
        img(I.bye),
        txt(`【本日が最後のメッセージです】

FurimAutoです。

無料期間が終了します。

「試用期間を延長したい」という方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

この動画を見て動画内で案内されるキーワードをLINEに送ると無料試用期間が延長されます✨

またいつでもお声がけください😊`),
      ]},
    ],
  },

  {
    name: 'FurimAuto 通常 ステップ配信（セグメント6: FREEコピー出品チケット取得）',
    triggerType: 'manual',
    isActive: true,
    days: [
      { day: 0, messages: [
        img(I.follow1),
        txt(`【コピー出品チケット受け取り完了！次は特典⑪をゲット！】

FurimAutoを積極的にご利用いただきありがとうございます！😆

次の目標は限定特典⑪です🎁

1分解説シリーズのYoutubeを全部見て、
動画内で案内されるキーワード「Furimanです」をこのLINEに送ってください！
送っていただくと特典⑪が受け取れます。

✅入門編1
https://youtu.be/FY8GUB-CoaY

✅入門編2
https://youtu.be/vfJzKP8K0yY

リッチメニュー「限定特典GET」からいつでも確認を！`),
      ]},
      { day: 1, messages: [
        txt(`【1分解説シリーズで特典⑪をゲット！】

FurimAutoです。

1分解説シリーズを見ながらFurimAutoを使いこなしましょう！

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI

✅初級編3
https://youtu.be/TgnC29kkbW4

動画内で案内されるキーワードをこのLINEに送ると
特典⑪がもらえます🎁

さらに！特典⑫⑬のゲット方法も近日ご案内します🔜`),
      ]},
      { day: 2, messages: [
        txt(`【FurimAutoをフル活用しよう】

FurimAutoです。

順調にご利用いただいていますか？

リッチメニューはタブになっています。
「ガイド」に全機能の使い方が載っていますので
色々試してみてください😄

困ったことがあればこのLINEにメッセージください👍

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o

✅中級編3
https://youtu.be/gAtxMiysWsY`),
      ]},
      { day: 3, messages: [
        txt(`【特典⑫⑬ゲットのチャンス！長尺動画公開中🎬】

FurimAutoです。

特典⑫⑬のゲット方法をお伝えします🎁

▼FurimAuto完全解説動画
https://www.youtube.com/watch?v=jhaCPxgE_Sk

この動画を見た後動画内で案内されるキーワードをLINEに送ってください！
✨無料試用期間が延長されます
✨限定特典⑫⑬（売れるブランドリスト・プロフィール解説）をプレゼント！

Meetなしで申し込みもできます😊`),
      ]},
      { day: 4, messages: [
        txt(`【有料プランへの移行方法について】

FurimAutoです。

無料期間がもうすぐ終わります。

▼まずこちらの解説動画をご覧ください
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・申し込み方法、全てこの動画で解説しています。

✅ Meetなしで申し込みOK！
✅ 動画を見てキーワードを送ると試用期間延長＋特典⑫⑬！

▼料金表はこちら
https://furimauto.com/lp0/#scroll_plan`),
      ]},
      { day: 5, messages: [
        img(I.only1day),
        txt(`【明日で無料期間終了！】

FurimAutoです。

「もう少し使ってみたい！」という方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

動画を見た後動画内で案内されるキーワードをLINEに送ってください！
✨無料試用期間が延長されます✨
✨限定特典⑫⑬もプレゼント✨

今すぐ動画を見て、特典を受け取ってください🎁`),
      ]},
    ],
  },

  {
    name: 'FurimAuto 通常 ステップ配信（セグメント7: Youtubeクーポン取得）',
    triggerType: 'manual',
    isActive: true,
    days: [
      { day: 0, messages: [
        txt(`【Youtubeキーワードありがとうございます！次は完全解説動画へ】

FurimAutoです。

クーポンのご取得ありがとうございます😊

次は完全解説動画をご覧ください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

この動画の中で案内されるキーワードをLINEに送っていただくと
✨無料試用期間がさらに延長されます
✨限定特典⑫⑬（売れるブランドリスト・プロフィール解説）をプレゼント！

Meetなしでそのままご加入いただけます。`),
      ]},
      { day: 1, messages: [
        txt(`【完全解説動画は見ましたか？】

FurimAutoです。

▼完全解説動画はこちら
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・申し込み方法、全てこの動画でわかります。

動画を最後まで見てキーワードをLINEに送ると
✨試用期間延長
✨特典⑫⑬プレゼント

▼今すぐ有料プランへ
https://furimauto.com/lp0/#scroll_plan`),
      ]},
      { day: 2, messages: [
        img(I.bye),
        txt(`【最後のご案内です】

FurimAutoです。

まだ動画を見ていない方へ、最後のご案内です👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

この動画を見てキーワードをLINEに送ると：
✨ 無料試用期間が延長されます
✨ 特典⑫⑬がプレゼントされます

またいつでもお声がけください😊
有料プランへの切り替えはいつでも受け付けています。`),
      ]},
    ],
  },

  // ═══════════════════════════════════════════
  //  紹介 (14日間) セグメント1-8
  // ═══════════════════════════════════════════
  {
    name: 'FurimAuto 紹介 ステップ配信（セグメント1: アンケート未回答）',
    triggerType: 'manual',
    isActive: true,
    days: [
      { day: 0, messages: [
        img(I.follow2),
        txt(`【2週間の無料お試し期間スタート！特典①②は受け取り済みです🎁】

FurimAutoです。
ご紹介いただきありがとうございます！
14日間の無料期間はすでにスタートしています！🎉

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
      { day: 1, messages: [
        txt(`【アンケートの回答をお待ちしています！】

FurimAutoです。

特典①②はすでにお届け済みです🎁
アンケートに回答してキーコードをゲットすると特典③④もプレゼントしています！

キーコードを拡張機能に入力すれば、すぐにFurimAutoが使えます。

ご紹介者様は実際にご利用いただいての紹介ですので
きっとすぐにその効果を実感いただけるはずです😊

✅入門編1
https://youtu.be/FY8GUB-CoaY

▼アンケートはこちらから`),
        surveyFlex,
      ]},
      { day: 4, messages: [
        img(I.only5days),
        txt(`【無料で使えるのはあと10日です】

FurimAutoです。

無料期間は"友達登録してから"14日間です⚠️
キーコードを発行してから、ではありません。

今からでも全然間に合います！
アンケートに回答して、3分だけツールを試してみてください😄

特典①②はすでにお届け済みです🎁
アンケート回答で特典③④もゲットしてください！

✅初級編1
https://youtu.be/HVHKhbnZe6M

▼アンケートはこちらから`),
        surveyFlex,
      ]},
      { day: 6, messages: [
        txt(`【こんなお悩みありませんか？】

FurimAutoです。

「毎日手動で値下げするのが大変…」
「なかなか売れなくて困っている…」
「もっと出品に集中したいのに作業に追われている…」

FurimAutoが全部解決します！

✅ 自動値下げで毎日の作業をゼロに
✅ コピー出品・まとめ買い割引の自動設定
✅ 売れ筋商品のリサーチ支援

ご紹介者様はこれを実感されての紹介です！

まずアンケートに回答してキーコードをゲット！
回答すると特典③④もプレゼントしています🎁
（①②はすでにお届け済みです）

▼アンケートはこちらから`),
        surveyFlex,
      ]},
      { day: 8, messages: [
        txt(`【実際のユーザーの声をご紹介】

FurimAutoです。

「本当に効果があるの？」と思っていませんか？

✨「月利が2倍になりました！」
✨「作業時間が激減してプライベートが充実！」
✨「初心者でも簡単に使えました！」

▼お客様の声はこちら
https://furimauto.com/lp0/#scroll_voice

ご紹介者様も同様の効果を実感されていますよ😊

残り6日です！今すぐアンケートに回答して
キーコードをゲットし特典③④も受け取ってください🎁
（①②はすでにお届け済みです）

▼アンケートはこちらから`),
        surveyFlex,
      ]},
      { day: 10, messages: [
        txt(`【有料プランへの移行を真剣に考えてみてください】

FurimAutoです。

残り4日になりました。
この機会に、有料プランについて知っておいてください👇

▼FurimAuto完全解説動画
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・効果・申し込み方法、全部この動画で解説しています。

動画を見た後動画内で案内されるキーワードをLINEに送ると
✨無料試用期間がさらに延長されます
✨限定特典⑫⑬もプレゼント！

ご紹介者様も実際にご加入されていますので
気になることがあれば直接聞いてみてください😊

Meetは任意です。動画だけで十分わかります。`),
      ]},
      { day: 12, messages: [
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
      { day: 13, messages: [
        img(I.bye),
        txt(`【本日が最後のメッセージです】

FurimAutoです。

無料期間が終了します。

少しでも気になっていただけているなら、
ぜひこちらの解説動画だけ見てみてください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・効果、全部動画で説明しています。
Meetなしでそのままご加入いただけます。

ご紹介いただいたお友達の方にも弊社から一言感謝のご連絡をさせていただきますm(_ _)m

またいつでもお声がけください😊`),
      ]},
    ],
  },

  {
    name: 'FurimAuto 紹介 ステップ配信（セグメント2: アンケート回答済み）',
    triggerType: 'manual',
    isActive: true,
    days: [
      { day: 0, messages: [
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
      { day: 1, messages: [
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
      { day: 4, messages: [
        img(I.only10days),
        txt(`【残り10日！キーコードを発行しよう】

FurimAutoです。

無料期間は"友達登録してから"14日間です⚠️
キーコードを発行してから、ではありません。

3分だけ時間をとってキーコードを発行してみてください！
リッチメニューの「キーコード発行」をタップするだけです。

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI

✅初級編3
https://youtu.be/TgnC29kkbW4`),
      ]},
      { day: 6, messages: [
        VID_INSTALL,
        txt(`【「キーコード発行」をタップするだけ!!】

FurimAutoです。

キーコード発行はもうお済みでしょうか？
上の動画の通りにやれば3分で完了します！

発行したらリッチメニューの「限定特典GET」もお忘れなく🎁
特典④⑤⑥が一括でプレゼントされます！

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o`),
      ]},
      { day: 8, messages: [
        txt(`【ユーザーの声をご紹介】

FurimAutoです。

ご紹介者様はしっかり利用してご納得いただいた上で紹介していただいていますが、
改めてFurimAutoの効果をご紹介します！

✨「キーコード発行からすぐに使い始め、月利が安定しました！」
✨「こんなに簡単なのに効果抜群で驚きました！」

▼お客様の声はこちら
https://furimauto.com/lp0/#scroll_voice

残り6日！今すぐキーコードを発行してください🔑

✅上級編1
https://youtu.be/-HmR263oHyk

✅上級編2
https://youtu.be/8rAdmKTYsUs`),
      ]},
      { day: 12, messages: [
        img(I.only1day),
        txt(`【明日で無料期間終了です！】

FurimAutoです。

「プランを継続したいけどどうすれば？」という方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・申し込み方法、全部この動画で解説しています。
動画を見た後動画内で案内されるキーワードをLINEに送ると試用期間が延長されます✨

Meetは任意です。動画だけで全部わかります！`),
      ]},
      { day: 13, messages: [
        img(I.bye),
        txt(`【本日が最後のメッセージです】

FurimAutoです。

無料期間が終了します。

気になっている方はこちらの動画だけでもご覧ください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

全ての疑問がこの動画で解決します。
Meetなしでそのままご加入いただけます。

ご紹介いただいたお友達の方にも弊社から一言感謝のご連絡をさせていただきますm(_ _)m

またいつでもお声がけお待ちしております😊`),
      ]},
    ],
  },

  {
    name: 'FurimAuto 紹介 ステップ配信（セグメント3: キーコード発行済み）',
    triggerType: 'manual',
    isActive: true,
    days: [
      { day: 0, messages: [
        VID_INSTALL,
        txt(`【あと3分！キーコードを入力して特典⑦⑧をゲット】

キーコードの発行ありがとうございます🎉

次はPCでの作業です。動画を見ながらやってみてください☝️

1️⃣ このLINEのリッチメニュー「キーコード発行」でキーコードを確認
2️⃣ キーコードを長押しでコピー
3️⃣ PCのChromeでFurimAutoの拡張機能を開く
4️⃣ 入力欄にキーコードをペーストして確定！

これだけです。本当に3分で終わります😎

終わったらリッチメニューの「限定特典GET」をタップ！
特典⑦⑧がプレゼントされます🎁`),
      ]},
      { day: 1, messages: [
        txt(`【キーコード入力はお済みですか？】

FurimAutoです。

PCへのキーコード入力がまだの方へ、手順を再掲します👇

1️⃣ リッチメニュー「キーコード発行」でキーコードを確認・コピー
2️⃣ PCのChromeでFurimAutoの拡張機能を開く
3️⃣ 入力欄にペーストして確定！

迷ったらこのLINEにメッセージください！すぐにサポートします😊

入力が完了すると特典⑦⑧がゲットできます🎁
リッチメニューの「限定特典GET」をタップ！`),
      ]},
      { day: 2, messages: [
        VID_INSTALL,
        txt(`【まだ入力できていない方へ】

FurimAutoです。

上の動画を見ながらキーコードを入力してください！

✅ キーコードはリッチメニュー「キーコード発行」で確認できます
✅ 表示されたキーコードをコピーしてPCの拡張機能にペーストするだけ

入力完了したらリッチメニュー「限定特典GET」もお忘れなく🎁

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o`),
      ]},
      { day: 3, messages: [
        txt(`【FurimAutoで理想の物販ライフへ！】

FurimAutoです。

拡張機能の入力が完了すると、
あなたのメルカリ物販はこう変わります！

✅ 毎日の値下げ作業が完全自動に
✅ 出品数を増やして売上アップ
✅ ストレスフリーで物販を楽しめる

ご紹介者様はこれを実感されての紹介です！
3分で手に入る理想の物販ライフ、始めましょう😄

✅中級編3
https://youtu.be/gAtxMiysWsY`),
      ]},
      { day: 4, messages: [
        txt(`【サポートします！お気軽にどうぞ】

FurimAutoです。

拡張機能の入力でお困りではありませんか？

もし上手くいかない場合はこのLINEにメッセージください。
丁寧にサポートいたします😊

✅上級編1
https://youtu.be/-HmR263oHyk

✅上級編2
https://youtu.be/8rAdmKTYsUs

✅上級編3（最終まとめ編）
https://youtu.be/EbhveXLO1FI`),
      ]},
      { day: 12, messages: [
        img(I.only1day),
        txt(`【明日で無料期間終了！最後のチャンス】

FurimAutoです。

有料プランへの継続を検討されている方は、
まずこちらの動画をご覧ください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・申し込み方法、全てこの動画で解説しています。

動画を見た後動画内で案内されるキーワードをLINEに送ると
✨無料試用期間が延長されます
✨限定特典⑫⑬もプレゼント！

Meetは任意です。動画だけで全部わかります！`),
      ]},
      { day: 13, messages: [
        img(I.bye),
        txt(`【本日が最後のメッセージです】

FurimAutoです。

無料期間が終了します。

「もう少し使ってから決めたい」という方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

この動画を見て動画内で案内されるキーワードをLINEに送ると無料試用期間が延長されます✨

Meetなしでもご加入いただけます。

ご紹介いただいたお友達の方にも弊社から一言感謝のご連絡をさせていただきますm(_ _)m

またいつでもお声がけお待ちしております😊`),
      ]},
    ],
  },

  {
    name: 'FurimAuto 紹介 ステップ配信（セグメント4: 拡張インストール済み）',
    triggerType: 'manual',
    isActive: true,
    days: [
      { day: 0, messages: [
        txt(`【まずは自動値下げを試してみて！】

FurimAutoの導入おめでとうございます🎉

メルカリの出品一覧ページを開いてみてください！
FurimAutoの機能が有効になっているはずです✨

まずは自動値下げをスタートさせてみましょう！

✅入門編1
https://youtu.be/FY8GUB-CoaY

✅入門編2
https://youtu.be/vfJzKP8K0yY`),
        txt(`【🎫 無料コピー出品チケットを受け取ろう！】

リッチメニューの「限定特典GET」をタップしてください！

特典⑨⑩として【無料コピー出品チケット】がプレゼントされています🎁

コピー出品チケットを使うと
他の商品をワンクリックでコピー出品できるようになります！

出品数を一気に増やして売上を伸ばしましょう📈`),
      ]},
      { day: 1, messages: [
        txt(`【限定特典⑨⑩を受け取ろう！】

FurimAutoです。

ツールの使い方に慣れてきましたか？

リッチメニューの「限定特典GET」をタップしてみてください！
解放済みの特典はいつでも受け取れます🎁

1分解説シリーズのYoutubeを見ると特典⑪もゲットできます！

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI`),
      ]},
      { day: 2, messages: [
        txt(`【時短・コストカットの最強ツール】

FurimAutoです。

自動値下げは動いていますか？

FurimAutoにはまだまだ便利な機能があります！

✅ コピー出品で出品数を一気に増やす
✅ まとめ買い割引の自動設定
✅ 売れ筋商品のリサーチ支援

全部リッチメニューの「ガイド」から確認できます。
動画を見ながら色々試してみてください😄

✅初級編3
https://youtu.be/TgnC29kkbW4`),
      ]},
      { day: 3, messages: [
        txt(`【よくある質問に答えます！】

FurimAutoです。

Q. 自動値下げが動かない？
A. 設定を確認してみてください。リッチメニューの「ガイド」に手順があります。

Q. 複数商品を同時に値下げできる？
A. できます！まとめて設定する方法も動画で解説しています。

Q. 他に便利な機能は？
A. コピー出品・まとめ買い割引など機能が多数あります。

解決しない場合はこのLINEにメッセージください👍

✅中級編2
https://youtu.be/-dlzv6sbh4o`),
      ]},
      { day: 4, messages: [
        txt(`【有料プランへの移行方法について】

FurimAutoです。

有料プランへの移行をご検討の方へ：

▼まずこちらの解説動画をご覧ください
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・申し込み方法、全てこの動画で解説しています。

✅ Meetなしで申し込みOK！
✅ 動画を見てキーワードを送ると試用期間延長＋特典⑫⑬！

▼料金表はこちら
https://furimauto.com/lp0/#scroll_plan`),
      ]},
      { day: 12, messages: [
        img(I.only1day),
        txt(`【明日で無料期間終了！動画を見て延長しよう】

FurimAutoです。

「もう少し使いたい！」という方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

動画を見た後動画内で案内されるキーワードをLINEに送ってください！
✨無料試用期間が延長されます
✨限定特典⑫⑬（ブランドリスト・プロフィール解説）もプレゼント！

Meetは任意です。このまま申し込みもできます😊`),
      ]},
      { day: 13, messages: [
        img(I.bye),
        txt(`【本日が最後のメッセージです】

FurimAutoです。

無料期間が終了します。

「試用期間を延長したい」という方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

この動画を見て動画内で案内されるキーワードをLINEに送ると無料試用期間が延長されます✨
Meetなしでもご加入いただけます。

ご紹介いただいたお友達の方にも弊社から一言感謝のご連絡をさせていただきますm(_ _)m

またいつでもお声がけお待ちしております😊`),
      ]},
    ],
  },

  {
    name: 'FurimAuto 紹介 ステップ配信（セグメント5: メルカリURL登録済み）',
    triggerType: 'manual',
    isActive: true,
    days: [
      { day: 0, messages: [
        img(I.follow1),
        txt(`【自動化スタート！無料コピー出品チケットを受け取ろう🎫】

FurimAutoです。

自動化が動き始めましたね！素晴らしいです😆

次のステップは「無料コピー出品チケット」の受け取りです🎁
リッチメニューの「限定特典GET」をタップしてください！

コピー出品チケットを使うと
他のフリマサイトへワンクリックでコピー出品できます！
出品数を一気に増やして売上を伸ばしましょう📈

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI`),
      ]},
      { day: 1, messages: [
        txt(`【コピーチケットは受け取りましたか？】

FurimAutoです。

リッチメニューの「限定特典GET」からコピー出品チケットを受け取れます🎫

コピー出品チケットを受け取ると
さらに特典⑨⑩もプレゼントされます🎁

困ったことがあればこのLINEにメッセージください👍

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o`),
      ]},
      { day: 2, messages: [
        txt(`【FurimAutoをもっとフル活用しよう！】

FurimAutoです。

自動値下げに慣れてきましたか？

FurimAutoにはまだまだ便利な機能があります！

✅ まとめ買い割引の自動設定
✅ 売れ筋商品のリサーチ支援
✅ ショップ調査機能

リッチメニューの「ガイド」から全機能を確認できます😄

✅中級編3
https://youtu.be/gAtxMiysWsY`),
      ]},
      { day: 3, messages: [
        txt(`【1分解説シリーズでさらに上を目指そう！】

FurimAutoです。

FurimAutoの全機能を1分動画で解説しています📹

✅上級編1
https://youtu.be/-HmR263oHyk

✅上級編2
https://youtu.be/8rAdmKTYsUs

✅上級編3
https://youtu.be/EbhveXLO1FI

動画を見てリッチメニューの「Furimanです」と送ると
嬉しい特典があります🎁`),
      ]},
      { day: 4, messages: [
        txt(`【有料プランへの移行方法について】

FurimAutoです。

有料プランへの移行をご検討の方へ：

▼まずこちらの解説動画をご覧ください
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・申し込み方法、全てこの動画で解説しています。

✅ Meetなしで申し込みOK！
✅ 動画を見てキーワードを送ると試用期間延長＋特典⑫⑬！

▼料金表はこちら
https://furimauto.com/lp0/#scroll_plan`),
      ]},
      { day: 12, messages: [
        img(I.only1day),
        txt(`【明日で無料期間終了！動画を見て延長しよう】

FurimAutoです。

「もう少し使いたい！」という方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

動画を見た後動画内で案内されるキーワードをLINEに送ってください！
✨無料試用期間が延長されます
✨限定特典⑫⑬（ブランドリスト・プロフィール解説）もプレゼント！

Meetは任意です。このまま申し込みもできます😊`),
      ]},
      { day: 13, messages: [
        img(I.bye),
        txt(`【本日が最後のメッセージです】

FurimAutoです。

無料期間が終了します。

「試用期間を延長したい」という方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

この動画を見て動画内で案内されるキーワードをLINEに送ると無料試用期間が延長されます✨
Meetなしでもご加入いただけます。

ご紹介いただいたお友達の方にも弊社から一言感謝のご連絡をさせていただきますm(_ _)m

またいつでもお声がけお待ちしております😊`),
      ]},
    ],
  },

  {
    name: 'FurimAuto 紹介 ステップ配信（セグメント6: FREEコピー出品チケット取得）',
    triggerType: 'manual',
    isActive: true,
    days: [
      { day: 0, messages: [
        img(I.follow1),
        txt(`【コピー出品チケット受け取り完了！次は特典⑪をゲット！】

FurimAutoを積極的にご利用いただきありがとうございます！😆

次の目標は限定特典⑪です🎁

1分解説シリーズのYoutubeを全部見て、
動画内で案内されるキーワード「Furimanです」をこのLINEに送ってください！
送っていただくと特典⑪が受け取れます。

✅入門編1
https://youtu.be/FY8GUB-CoaY

✅入門編2
https://youtu.be/vfJzKP8K0yY

リッチメニュー「限定特典GET」からいつでも確認を！`),
      ]},
      { day: 1, messages: [
        txt(`【1分解説シリーズで特典⑪をゲット！】

FurimAutoです。

1分解説シリーズを見ながらFurimAutoを使いこなしましょう！

✅初級編1
https://youtu.be/HVHKhbnZe6M

✅初級編2
https://youtu.be/5q5SXWbDjPI

✅初級編3
https://youtu.be/TgnC29kkbW4

動画内で案内されるキーワードをこのLINEに送ると
特典⑪がもらえます🎁

さらに！特典⑫⑬のゲット方法も近日ご案内します🔜`),
      ]},
      { day: 2, messages: [
        txt(`【FurimAutoをフル活用しよう】

FurimAutoです。

順調にご利用いただいていますか？

リッチメニューはタブになっています。
「ガイド」に全機能の使い方が載っていますので
色々試してみてください😄

困ったことがあればこのLINEにメッセージください👍

✅中級編1
https://youtu.be/95ASUMEotMM

✅中級編2
https://youtu.be/-dlzv6sbh4o

✅中級編3
https://youtu.be/gAtxMiysWsY`),
      ]},
      { day: 3, messages: [
        txt(`【特典⑫⑬ゲットのチャンス！長尺動画公開中🎬】

FurimAutoです。

特典⑫⑬のゲット方法をお伝えします🎁

▼FurimAuto完全解説動画
https://www.youtube.com/watch?v=jhaCPxgE_Sk

この動画を見た後動画内で案内されるキーワードをLINEに送ってください！
✨無料試用期間が延長されます
✨限定特典⑫⑬（売れるブランドリスト・プロフィール解説）をプレゼント！

Meetなしで申し込みもできます😊`),
      ]},
      { day: 4, messages: [
        txt(`【有料プランへの移行方法について】

FurimAutoです。

有料プランへの移行をご検討の方へ：

▼まずこちらの解説動画をご覧ください
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・申し込み方法、全てこの動画で解説しています。

✅ Meetなしで申し込みOK！
✅ 動画を見てキーワードを送ると試用期間延長＋特典⑫⑬！

▼料金表はこちら
https://furimauto.com/lp0/#scroll_plan`),
      ]},
      { day: 12, messages: [
        img(I.only1day),
        txt(`【明日で無料期間終了！】

FurimAutoです。

「もう少し使ってみたい！」という方へ👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

動画を見た後動画内で案内されるキーワードをLINEに送ってください！
✨無料試用期間が延長されます✨
✨限定特典⑫⑬もプレゼント✨

今すぐ動画を見て、特典を受け取ってください🎁`),
      ]},
    ],
  },

  {
    name: 'FurimAuto 紹介 ステップ配信（セグメント7: Youtubeクーポン取得）',
    triggerType: 'manual',
    isActive: true,
    days: [
      { day: 0, messages: [
        txt(`【Youtubeキーワードありがとうございます！次は完全解説動画へ】

FurimAutoです。

クーポンのご取得ありがとうございます😊

次は完全解説動画をご覧ください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

この動画の中で案内されるキーワードをLINEに送っていただくと
✨無料試用期間がさらに延長されます
✨限定特典⑫⑬（売れるブランドリスト・プロフィール解説）をプレゼント！

Meetなしでそのままご加入いただけます。`),
      ]},
      { day: 1, messages: [
        txt(`【完全解説動画は見ましたか？】

FurimAutoです。

▼完全解説動画はこちら
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・申し込み方法、全てこの動画でわかります。

動画を最後まで見てキーワードをLINEに送ると
✨試用期間延長
✨特典⑫⑬プレゼント

▼今すぐ有料プランへ
https://furimauto.com/lp0/#scroll_plan`),
      ]},
      { day: 12, messages: [
        img(I.bye),
        txt(`【最後のご案内です】

FurimAutoです。

まだ動画を見ていない方へ、最後のご案内です👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

この動画を見てキーワードをLINEに送ると：
✨ 無料試用期間が延長されます
✨ 特典⑫⑬がプレゼントされます

ご紹介いただいたお友達の方にも弊社から感謝のご連絡をさせていただきますm(_ _)m

またいつでもお声がけください😊
有料プランへの切り替えはいつでも受け付けています。`),
      ]},
    ],
  },
];

// ──────────────── main ────────────────

async function main() {
  if (DELETE_OLD) {
    console.log('旧シナリオを削除中...');
    for (const id of OLD_SCENARIO_IDS) {
      try {
        await req('DELETE', `/api/scenarios/${id}`);
        console.log(`  削除: ${id}`);
      } catch (err) {
        console.log(`  スキップ（存在しない可能性）: ${id} - ${err.message}`);
      }
    }
  }

  console.log(`\n${SCENARIOS.length}件のシナリオを登録中...\n`);
  const results = [];

  for (const scenario of SCENARIOS) {
    const steps = toSteps(scenario.days);
    process.stdout.write(`[${scenario.name.slice(0, 40)}...] `);

    const created = await req('POST', '/api/scenarios', {
      name: scenario.name,
      triggerType: scenario.triggerType,
      isActive: scenario.isActive,
    });
    process.stdout.write(`id=${created.id} `);

    for (const step of steps) {
      await req('POST', `/api/scenarios/${created.id}/steps`, step);
      process.stdout.write('.');
    }
    console.log(` (${steps.length}steps)`);
    results.push({ name: scenario.name, id: created.id });
  }

  console.log('\n=== 登録完了 ===');
  for (const r of results) {
    console.log(`${r.id}  ${r.name}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
