#!/usr/bin/env node
/**
 * FurimAuto Referral ステップ配信シナリオ登録スクリプト
 * 友達紹介コード入力ユーザー向け / 14日間 / 手動enroll
 *
 * 使い方:
 *   WORKER_URL=https://line-harness.furimuato.workers.dev API_KEY=xxx node scripts/seed-furimauto-scenario-referral.mjs
 */

const BASE_URL = process.env.WORKER_URL || 'https://line-harness.furimuato.workers.dev';
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error('Error: API_KEY 環境変数が未設定です');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`,
};

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`POST ${path} status=${res.status} body=${text}`);
  }
  if (!json.success) throw new Error(`POST ${path} failed: ${JSON.stringify(json)}`);
  return json.data;
}

function imageContent(url) {
  return JSON.stringify({ originalContentUrl: url, previewImageUrl: url });
}

const surveyButtonFlex = JSON.stringify({
  type: 'flex',
  altText: '▼ 1問アンケートはこちら ▼',
  contents: {
    type: 'bubble',
    hero: {
      type: 'image',
      url: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/follow_event_img3.png',
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
  },
});

const STEPS = [
  // Day 0 (delay: 0)
  {
    stepOrder: 0, delayMinutes: 0, messageType: 'image',
    messageContent: imageContent('https://storage.googleapis.com/furimauto_line/images/messageEvent/follow_event_img2.png'),
  },
  {
    stepOrder: 1, delayMinutes: 0, messageType: 'text',
    messageContent: `【2週間の無料お試し期間スタート！特典①②は受け取り済みです🎁】

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

▼アンケートはこちらから`,
  },
  {
    stepOrder: 2, delayMinutes: 0, messageType: 'flex',
    messageContent: surveyButtonFlex,
  },

  // Day 1 (delay: 1440)
  {
    stepOrder: 3, delayMinutes: 1440, messageType: 'text',
    messageContent: `【アンケートの回答をお待ちしています！】

FurimAutoです。

特典①②はすでにお届け済みです🎁
アンケートに回答してキーコードをゲットすると特典③④もプレゼントしています！

キーコードを拡張機能に入力すれば、すぐにFurimAutoが使えます。

ご紹介者様は実際にご利用いただいての紹介ですので
きっとすぐにその効果を実感いただけるはずです😊

✅入門編1
https://youtu.be/FY8GUB-CoaY

残り13日です。今すぐ始めましょう！

▼アンケートはこちらから`,
  },
  {
    stepOrder: 4, delayMinutes: 1440, messageType: 'flex',
    messageContent: surveyButtonFlex,
  },

  // Day 4 (delay: 5760)
  {
    stepOrder: 5, delayMinutes: 5760, messageType: 'image',
    messageContent: imageContent('https://storage.googleapis.com/furimauto_line/images/messageEvent/only5days.png'),
  },
  {
    stepOrder: 6, delayMinutes: 5760, messageType: 'text',
    messageContent: `【無料で使えるのはあと10日です】

FurimAutoです。

無料期間は"友達登録してから"14日間です⚠️
キーコードを発行してから、ではありません。

今からでも全然間に合います！
アンケートに回答して、3分だけツールを試してみてください😄

特典①②はすでにお届け済みです🎁
アンケート回答で特典③④もゲットしてください！

▼アンケートはこちらから`,
  },
  {
    stepOrder: 7, delayMinutes: 5760, messageType: 'flex',
    messageContent: surveyButtonFlex,
  },

  // Day 6 (delay: 8640)
  {
    stepOrder: 8, delayMinutes: 8640, messageType: 'text',
    messageContent: `【こんなお悩みありませんか？】

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

▼アンケートはこちらから`,
  },
  {
    stepOrder: 9, delayMinutes: 8640, messageType: 'flex',
    messageContent: surveyButtonFlex,
  },

  // Day 8 (delay: 11520)
  {
    stepOrder: 10, delayMinutes: 11520, messageType: 'text',
    messageContent: `【実際のユーザーの声をご紹介】

FurimAutoです。

「本当に効果があるの？」と思っていませんか？

✨「月利が2倍になりました！」
✨「作業時間が激減してプライベートが充実！」
✨「初心者でも簡単に使えました！」

▼お客様の声はこちら
https://furimauto.com/service/#scroll_voice

ご紹介者様も同様の効果を実感されていますよ😊

残り6日です！今すぐアンケートに回答して
キーコードをゲットし特典③④も受け取ってください🎁

▼アンケートはこちらから`,
  },
  {
    stepOrder: 11, delayMinutes: 11520, messageType: 'flex',
    messageContent: surveyButtonFlex,
  },

  // Day 10 (delay: 14400) ← 通常版にはないreferral専用ステップ
  {
    stepOrder: 12, delayMinutes: 14400, messageType: 'text',
    messageContent: `【有料プランへの移行を真剣に考えてみてください】

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

Meetは任意です。動画だけで十分わかります。`,
  },

  // Day 12 (delay: 17280)
  {
    stepOrder: 13, delayMinutes: 17280, messageType: 'image',
    messageContent: imageContent('https://storage.googleapis.com/furimauto_line/images/messageEvent/only1day.png'),
  },
  {
    stepOrder: 14, delayMinutes: 17280, messageType: 'text',
    messageContent: `【明日で無料期間が終了します！】

FurimAutoです。

まだ間に合います！
アンケートに回答して、今日だけでもFurimAutoを体験してください。

有料プランへの移行を検討される方は、
こちらの解説動画が全てを教えてくれます👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

動画を見た後動画内で案内されるキーワードをLINEに送ると
✨無料試用期間が延長されます
✨限定特典⑫⑬もプレゼント！

▼アンケートはこちらから`,
  },
  {
    stepOrder: 15, delayMinutes: 17280, messageType: 'flex',
    messageContent: surveyButtonFlex,
  },

  // Day 13 (delay: 18720)
  {
    stepOrder: 16, delayMinutes: 18720, messageType: 'image',
    messageContent: imageContent('https://storage.googleapis.com/furimauto_line/images/messageEvent/bye.png'),
  },
  {
    stepOrder: 17, delayMinutes: 18720, messageType: 'text',
    messageContent: `【本日が最後のメッセージです】

FurimAutoです。

無料期間が終了します。

少しでも気になっていただけているなら、
ぜひこちらの解説動画だけ見てみてください👇
https://www.youtube.com/watch?v=jhaCPxgE_Sk

料金・機能・効果、全部動画で説明しています。
Meetなしでそのままご加入いただけます。

ご紹介いただいたお友達の方にも
弊社から一言感謝のご連絡をさせていただきますm(_ _)m

またいつでもお声がけください😊`,
  },
];

async function main() {
  console.log('Referralシナリオを作成中...');
  const scenario = await post('/api/scenarios', {
    name: 'FurimAuto 友達紹介 ステップ配信（14日間）',
    triggerType: 'manual',
    isActive: true,
  });
  console.log(`シナリオ作成完了: id=${scenario.id}`);
  console.log(`このIDをコードに設定してください: REFERRAL_SCENARIO_ID="${scenario.id}"`);

  for (const step of STEPS) {
    process.stdout.write(`  stepOrder=${step.stepOrder} delay=${step.delayMinutes}min ${step.messageType} ... `);
    await post(`/api/scenarios/${scenario.id}/steps`, step);
    console.log('OK');
  }

  console.log(`\n完了: ${STEPS.length}件のステップを登録しました`);
  console.log(`シナリオID: ${scenario.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
