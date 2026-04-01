import { Hono } from 'hono';
import { verifySignature, LineClient } from '@line-crm/line-sdk';
import type { WebhookRequestBody, WebhookEvent, TextEventMessage } from '@line-crm/line-sdk';
import {
  upsertFriend,
  updateFriendFollowStatus,
  getFriendByLineUserId,
  getScenarios,
  enrollFriendInScenario,
  getScenarioSteps,
  advanceFriendScenario,
  completeFriendScenario,
  upsertChatOnMessage,
  getLineAccounts,
  jstNow,
} from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage, expandVariables } from '../services/step-delivery.js';
import { handleRichMenuSwitch, linkDefaultRichMenuOnFollow } from '../furim/rich-menu.js';
import type { RichMenuEnv } from '../furim/rich-menu.js';
import { handleFurimAction, actionFurimanCoupon, actionExtendTrial } from '../furim/actions.js';
import type { FurimActionsEnv } from '../furim/actions.js';
import { handleButtonAction } from '../furim/button-actions.js';
import { handleKeywordAction } from '../furim/keyword-actions.js';
import { handleAIChat } from '../furim/ai-chat.js';
import { getAiMode } from '../furim/firebase-client.js';
import { gasGet, gasPost } from '../furim/gas-client.js';
import { surveyButton } from '../furim/messages.js';

type WebhookEnv = RichMenuEnv & FurimActionsEnv & { LIFF_URL?: string; GAS_DEPLOY_ID?: string; GEMINI_API_KEY?: string; GITHUB_PAT?: string };
import type { Env } from '../index.js';

const webhook = new Hono<Env>();

webhook.post('/webhook', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('X-Line-Signature') ?? '';
  const db = c.env.DB;

  let body: WebhookRequestBody;
  try {
    body = JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    console.error('Failed to parse webhook body');
    return c.json({ status: 'ok' }, 200);
  }

  // Multi-account: resolve credentials from DB by destination (channel user ID)
  // or fall back to environment variables (default account)
  let channelSecret = c.env.LINE_CHANNEL_SECRET;
  let channelAccessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  let matchedAccountId: string | null = null;

  if ((body as { destination?: string }).destination) {
    const accounts = await getLineAccounts(db);
    for (const account of accounts) {
      if (!account.is_active) continue;
      const isValid = await verifySignature(account.channel_secret, rawBody, signature);
      if (isValid) {
        channelSecret = account.channel_secret;
        channelAccessToken = account.channel_access_token;
        matchedAccountId = account.id;
        break;
      }
    }
  }

  // Verify with resolved secret
  const valid = await verifySignature(channelSecret, rawBody, signature);
  if (!valid) {
    console.error('Invalid LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  const lineClient = new LineClient(channelAccessToken);

  // 非同期処理 — LINE は ~1s 以内のレスポンスを要求
  const processingPromise = (async () => {
    for (const event of body.events) {
      try {
        await handleEvent(db, lineClient, event, channelAccessToken, matchedAccountId, c.env.WORKER_URL || new URL(c.req.url).origin, c.env);
      } catch (err) {
        console.error('Error handling webhook event:', err);
      }
    }
  })();

  c.executionCtx.waitUntil(processingPromise);

  return c.json({ status: 'ok' }, 200);
});

async function handleEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId: string | null = null,
  workerUrl?: string,
  env?: WebhookEnv,
): Promise<void> {
  if (event.type === 'follow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    // プロフィール取得 & 友だち登録/更新
    let profile;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      console.error('Failed to get profile for', userId, err);
    }

    // 新規 vs ブロック解除の判別（upsert前にチェック）
    const existingFriend = await getFriendByLineUserId(db, userId);
    const isNewUser = !existingFriend;

    const friend = await upsertFriend(db, {
      lineUserId: userId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });

    // Set line_account_id for multi-account tracking
    if (lineAccountId) {
      await db.prepare('UPDATE friends SET line_account_id = ? WHERE id = ? AND line_account_id IS NULL')
        .bind(lineAccountId, friend.id).run();
    }

    // friend_add シナリオに登録（このアカウントのシナリオのみ）
    const scenarios = await getScenarios(db);
    for (const scenario of scenarios) {
      // Only trigger scenarios belonging to this account (or unassigned for backward compat)
      const scenarioAccountMatch = !scenario.line_account_id || !lineAccountId || scenario.line_account_id === lineAccountId;
      if (scenario.trigger_type === 'friend_add' && scenario.is_active && scenarioAccountMatch) {
        try {
          const existing = await db
            .prepare(`SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`)
            .bind(friend.id, scenario.id)
            .first<{ id: string }>();
          if (!existing) {
            const friendScenario = await enrollFriendInScenario(db, friend.id, scenario.id);

            // Immediate delivery: if the first step has delay=0, send it now via replyMessage (free)
            // Skip when GAS_DEPLOY_ID is set — replyToken is used for the GAS follow flow
            const steps = await getScenarioSteps(db, scenario.id);
            const firstStep = steps[0];
            if (firstStep && firstStep.delay_minutes === 0 && friendScenario.status === 'active' && !env?.GAS_DEPLOY_ID) {
              try {
                const expandedContent = expandVariables(firstStep.message_content, friend as { id: string; display_name: string | null; user_id: string | null });
                const message = buildMessage(firstStep.message_type, expandedContent);
                await lineClient.replyMessage(event.replyToken, [message]);
                console.log(`Immediate delivery: sent step ${firstStep.id} to ${userId}`);

                // Log outgoing message (replyMessage = 無料)
                const logId = crypto.randomUUID();
                await db
                  .prepare(
                    `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
                     VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, 'reply', ?)`,
                  )
                  .bind(logId, friend.id, firstStep.message_type, firstStep.message_content, firstStep.id, jstNow())
                  .run();

                // Advance or complete the friend_scenario
                const secondStep = steps[1] ?? null;
                if (secondStep) {
                  const nextDeliveryDate = new Date(Date.now() + 9 * 60 * 60_000);
                  nextDeliveryDate.setMinutes(nextDeliveryDate.getMinutes() + secondStep.delay_minutes);
                  // Enforce 9:00-21:00 JST delivery window
                  const h = nextDeliveryDate.getUTCHours();
                  if (h < 9 || h >= 21) {
                    if (h >= 21) nextDeliveryDate.setUTCDate(nextDeliveryDate.getUTCDate() + 1);
                    nextDeliveryDate.setUTCHours(9, 0, 0, 0);
                  }
                  await advanceFriendScenario(db, friendScenario.id, firstStep.step_order, nextDeliveryDate.toISOString().slice(0, -1) + '+09:00');
                } else {
                  await completeFriendScenario(db, friendScenario.id);
                }
              } catch (err) {
                console.error('Failed immediate delivery for scenario', scenario.id, err);
              }
            }
          }
        } catch (err) {
          console.error('Failed to enroll friend in scenario', scenario.id, err);
        }
      }
    }

    // ブロックタグ削除（新規・ブロック解除どちらも）
    const blockTag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind('ブロック').first<{ id: string }>();
    if (blockTag) await db.prepare('DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ?').bind(friend.id, blockTag.id).run();

    if (env?.GAS_DEPLOY_ID) {
      // ===== GASベースのフォローフロー（旧CloudFunctions eventFollow.ts 再現） =====
      let isUnblockedUser = false;
      try {
        const gasData = await gasGet(env.GAS_DEPLOY_ID, { method: 'getStripeIDwithLINEID', lineUserId: userId }) as Record<string, string>;
        if (gasData?.customer_stripe_id) isUnblockedUser = true;
      } catch (err) {
        console.error('[follow] GAS getStripeIDwithLINEID error:', err);
      }

      if (isUnblockedUser) {
        // ブロック解除ユーザー: デフォルトリッチメニュー → サブスク確認 → リフォロー返信
        await linkDefaultRichMenuOnFollow(lineClient, userId, env);
        try {
          const keyData = await gasGet(env.GAS_DEPLOY_ID, { method: 'getKeyCode', lineUserId: userId }) as Record<string, string>;
          if (keyData?.expiredDate && keyData.expiredDate !== '') {
            const expiredDate = new Date(keyData.expiredDate);
            if (expiredDate.getTime() >= Date.now() && env.RICHMENU_MEMBER_HOME) {
              await lineClient.linkRichMenuToUser(userId, env.RICHMENU_MEMBER_HOME);
            }
          }
        } catch (err) {
          console.error('[follow] GAS getKeyCode error:', err);
        }
        try {
          await lineClient.replyMessage(event.replyToken, [{
            type: 'text',
            text: '以前に友達登録されていらしたかと思いますので、キーコード無料利用期間の対象外になってしまっておりますm(_ _)m\n\nが、是非是非使っていただきたいのでもしご興味があれば"無料で試してみたい"と一言ください！',
          } as never]);
        } catch (err) {
          console.error('[follow] replyMessage re-follow error:', err);
        }
      } else {
        // 新規ユーザー: Stripe顧客作成 → GAS登録 → ウェルカムメッセージ5通
        let stripeCustomerId = '';
        if (env.STRIPE_SECRET_KEY) {
          try {
            const stripeRes = await fetch('https://api.stripe.com/v1/customers', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({
                name: profile?.displayName ?? userId,
                'metadata[lineUserId]': userId,
                'address[country]': 'JP',
                'address[postal_code]': '1050001',
                'preferred_locales[]': 'ja',
              }).toString(),
            });
            const stripeData = await stripeRes.json() as { id?: string };
            stripeCustomerId = stripeData.id ?? '';
          } catch (err) {
            console.error('[follow] Stripe customer create error:', err);
          }
        }

        // GAS setCustomerData (フォロー日時 + 試用期間終了日時)
        const nowJst = new Date(Date.now() + 9 * 60 * 60_000);
        const trialEndJst = new Date(nowJst.getTime() + 7 * 24 * 60 * 60_000);
        const fmtJst = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
        try {
          await gasPost(env.GAS_DEPLOY_ID, {
            method: 'setCustomerData',
            followEventDateTime: fmtJst(nowJst),
            lineUserDisplayName: profile?.displayName ?? '',
            lineUserId: userId,
            stripeCustomerId,
            trialFinishedDateTime: fmtJst(trialEndJst),
          });
        } catch (err) {
          console.error('[follow] GAS setCustomerData error:', err);
        }

        // ウェルカムメッセージ 5通
        const welcomeMessages: never[] = [];

        // ① YouTube紹介動画 Flex
        welcomeMessages.push({
          type: 'flex',
          altText: 'FurimAuto紹介動画',
          contents: {
            type: 'bubble',
            hero: {
              type: 'image',
              url: 'https://img.youtube.com/vi/uQjheVeAuww/maxresdefault.jpg',
              size: 'full',
              aspectRatio: '16:9',
              aspectMode: 'cover',
              action: { type: 'uri', uri: 'https://www.youtube.com/watch?v=uQjheVeAuww' },
            },
            body: {
              type: 'box',
              layout: 'vertical',
              contents: [
                { type: 'text', text: 'FurimAuto紹介動画', weight: 'bold', size: 'xl', wrap: true },
                {
                  type: 'text',
                  text: '1番初めに見るべき動画はコレ👆👆👆\n\n長ったらしい説明はナシ！です🙅‍♀️\n\nFurimAutoの使い方と\n他者ツールと比べた特徴を\n1分でまとめました!!\n\n断言しますが\nこのツールより簡単で\n全局面での自動化を実現した\n自動化ツールはこの世にはないです🤫',
                  size: 'sm', color: '#666666', margin: 'md', wrap: true,
                },
              ],
            },
            footer: {
              type: 'box',
              layout: 'vertical',
              spacing: 'sm',
              contents: [{
                type: 'button',
                style: 'primary',
                height: 'sm',
                action: { type: 'uri', label: 'YouTubeで見る', uri: 'https://www.youtube.com/watch?v=uQjheVeAuww' },
                color: '#FF0000',
              }],
            },
          },
        } as never);

        // ② テキスト（友達登録感謝 + 無料期間開始）
        welcomeMessages.push({
          type: 'text',
          text: '/／\n🗣 友達登録ありがとうございます！\n\\＼\n╭△━━━━━━━━━━━━━━━╮\nたった今から、\n1週間の無料試用期間が\n開始となります！🎉\n╰━━━━━━━━━━━━━━━━╯\n\nFurimAuto(フリマート)は\nメルカリを中心に、\nそのフリマサイト上で自動化を実現する\nChrome拡張機能型ツールです！💻\n\n---------------------------------------------------\n\n◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢\n\n👆どんな使い方をするのか、\n👆サクッと基本を知るには\n👆上の動画\n\n👇1週間の無料期間での\n👇ベストな使い方を知るには\n👇下の動画\n\n◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢',
        } as never);

        // ③ 動画 (meet.mp4)
        welcomeMessages.push({
          type: 'video',
          originalContentUrl: 'https://storage.googleapis.com/furimauto_line/video/meet.mp4',
          previewImageUrl: 'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png',
          trackingId: 'setup',
        } as never);

        // ④ 15大特典 Flex
        welcomeMessages.push({
          type: 'flex',
          altText: '🎁 無料期間中に15大特典をGETしよう！',
          contents: {
            type: 'bubble',
            hero: {
              type: 'image',
              url: 'https://furimauto.com/lp0/images/special_offer.png',
              size: 'full',
              aspectRatio: '1:1',
              aspectMode: 'cover',
            },
            body: {
              type: 'box',
              layout: 'vertical',
              spacing: 'md',
              contents: [
                { type: 'text', text: '🎁 無料期間中に15大特典をGETしよう！', weight: 'bold', size: 'lg', wrap: true, color: '#FF6B35' },
                { type: 'text', text: '友達登録から1週間の無料試用期間中に、段階的に15種類の特典をプレゼントします！', size: 'sm', color: '#555555', wrap: true, margin: 'sm' },
                { type: 'separator', margin: 'md' },
                {
                  type: 'box', layout: 'vertical', margin: 'md', spacing: 'xs',
                  contents: [
                    { type: 'text', text: '📦 今すぐもらえる特典', weight: 'bold', size: 'sm', color: '#333333' },
                    { type: 'button', style: 'link', height: 'sm', margin: 'xs', action: { type: 'uri', label: '① ロードマップ❶ ダウンロード', uri: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B81%E3%83%AD%E3%83%BC%E3%83%88%E3%82%99%E3%83%9E%E3%83%83%E3%83%95%E3%82%9A%E2%9D%B6.pdf' } },
                    { type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '② ロードマップ❷ ダウンロード', uri: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B82%E3%83%AD%E3%83%BC%E3%83%88%E3%82%99%E3%83%9E%E3%83%83%E3%83%95%E3%82%9A%E2%9D%B7.pdf' } },
                  ],
                },
                {
                  type: 'box', layout: 'vertical', margin: 'md', spacing: 'xs',
                  contents: [
                    { type: 'text', text: '🔓 使うほどもらえる特典（リッチメニューから）', weight: 'bold', size: 'sm', color: '#333333', wrap: true },
                    { type: 'text', text: '③ ロードマップ❸', size: 'sm', color: '#444444', margin: 'xs', wrap: true },
                    { type: 'text', text: '④ ロードマップ❹', size: 'sm', color: '#444444', margin: 'xs', wrap: true },
                    { type: 'text', text: '⑤ 撮影方法マニュアル前編', size: 'sm', color: '#444444', wrap: true },
                    { type: 'text', text: '⑥ 撮影方法マニュアル後編', size: 'sm', color: '#444444', wrap: true },
                    { type: 'text', text: '⑦ 外注化マニュアル前編', size: 'sm', color: '#444444', wrap: true },
                    { type: 'text', text: '⑧ 外注化マニュアル後編', size: 'sm', color: '#444444', wrap: true },
                    { type: 'text', text: '⑨ 外注募集テンプレート', size: 'sm', color: '#444444' },
                    { type: 'text', text: '⑩ 外注先業務委託契約書テンプレ', size: 'sm', color: '#444444', wrap: true },
                    { type: 'text', text: '⑪ コメントセールの手法と効果の解説', size: 'sm', color: '#444444', wrap: true },
                    { type: 'text', text: '⑫ 売れるブランドリスト', size: 'sm', color: '#444444' },
                    { type: 'text', text: '⑬ 売れるアカウント説明&プロフィール解説', size: 'sm', color: '#444444', wrap: true },
                  ],
                },
                {
                  type: 'box', layout: 'vertical', margin: 'md', spacing: 'xs',
                  contents: [
                    { type: 'text', text: '🎬 YouTubeを視聴の上キーワード入力でもらえる特典', weight: 'bold', size: 'sm', color: '#333333', wrap: true },
                    { type: 'text', text: '⑭ 初月半額クーポン', size: 'sm', color: '#444444', margin: 'xs' },
                    { type: 'text', text: '⑮ 無料試用期間1週間延長', size: 'sm', color: '#444444' },
                  ],
                },
                { type: 'separator', margin: 'md' },
                { type: 'text', text: 'リッチメニューの', size: 'xs', color: '#888888', wrap: true, margin: 'md' },
                { type: 'text', text: '「限定特典GET」をタップ', size: 'xs', weight: 'bold', color: '#333333', wrap: true },
                { type: 'text', text: 'すると、あなたの利用状況に応じて次の特典が届きます！', size: 'xs', color: '#888888', wrap: true, margin: 'md' },
              ],
            },
          },
        } as never);

        // ⑤ アンケートボタン
        welcomeMessages.push(surveyButton('【無料お試し期間が始まりました！】') as never);

        try {
          await lineClient.replyMessage(event.replyToken, welcomeMessages);
        } catch (err) {
          console.error('[follow] replyMessage welcome error:', err);
        }

        // デフォルトリッチメニューをリンク
        await linkDefaultRichMenuOnFollow(lineClient, userId, env);

        // 無料試用期間中 + セグメント1 タグ付与
        const trialTag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind('無料試用期間中').first<{ id: string }>();
        if (trialTag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)').bind(friend.id, trialTag.id, jstNow()).run();
        const seg1Tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind('セグメント1').first<{ id: string }>();
        if (seg1Tag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)').bind(friend.id, seg1Tag.id, jstNow()).run();
      }
    } else {
      // GAS未設定: シンプルな処理
      if (isNewUser) {
        const trialTag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind('無料試用期間中').first<{ id: string }>();
        if (trialTag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)').bind(friend.id, trialTag.id, jstNow()).run();
      }
      if (env) await linkDefaultRichMenuOnFollow(lineClient, userId, env);
    }

    // イベントバス発火: friend_add（replyToken は Step 0 で使用済みの可能性あり）
    await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName: friend.display_name } }, lineAccessToken, lineAccountId);
    return;
  }

  if (event.type === 'unfollow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    await updateFriendFollowStatus(db, userId, false);

    // ブロックタグ付与 + 無料試用期間中タグ削除
    const unfollowedFriend = await getFriendByLineUserId(db, userId);
    if (unfollowedFriend) {
      const [blockTag2, trialTag2] = await Promise.all([
        db.prepare('SELECT id FROM tags WHERE name = ?').bind('ブロック').first<{ id: string }>(),
        db.prepare('SELECT id FROM tags WHERE name = ?').bind('無料試用期間中').first<{ id: string }>(),
      ]);
      if (blockTag2) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)').bind(unfollowedFriend.id, blockTag2.id, jstNow()).run();
      if (trialTag2) await db.prepare('DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ?').bind(unfollowedFriend.id, trialTag2.id).run();
    }
    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const textMessage = event.message as TextEventMessage;
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await getFriendByLineUserId(db, userId);
    if (!friend) return;

    const incomingText = textMessage.text;
    const now = jstNow();
    const logId = crypto.randomUUID();

    // 受信メッセージをログに記録
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
         VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, ?)`,
      )
      .bind(logId, friend.id, incomingText, now)
      .run();

    // 【ボタン】アクション
    if (incomingText.includes('【ボタン】') && env?.GAS_DEPLOY_ID) {
      await handleButtonAction(lineClient, userId, event.replyToken, incomingText, { GAS_DEPLOY_ID: env.GAS_DEPLOY_ID, STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY }, db);
      return;
    }

    // リッチメニュー切り替え: 【リッチメニュー】プレフィックスのメッセージを処理
    if (env) {
      const richMenuHandled = await handleRichMenuSwitch(db, lineClient, userId, friend.id, incomingText, event.replyToken, env);
      if (richMenuHandled) return;
    }

    // FurimAutoアクション: GAS連携等の業務処理
    if (env?.GAS_DEPLOY_ID) {
      const furimHandled = await handleFurimAction(lineClient, userId, event.replyToken, incomingText, {
        GAS_DEPLOY_ID: env.GAS_DEPLOY_ID,
        FIREBASE_DATABASE_URL: env.FIREBASE_DATABASE_URL,
        STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
      }, db);
      if (furimHandled) return;
    }

    // 【キーワード】アクション
    if (incomingText.includes('【キーワード】') && env?.GAS_DEPLOY_ID) {
      await handleKeywordAction(lineClient, userId, event.replyToken, incomingText, { GAS_DEPLOY_ID: env.GAS_DEPLOY_ID, STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY }, db);
      return;
    }

    // AIチャットモード
    if (env?.FIREBASE_DATABASE_URL && env?.GEMINI_API_KEY && env?.GITHUB_PAT) {
      const isAIMode = await getAiMode(env.FIREBASE_DATABASE_URL, userId);
      if (isAIMode) {
        await handleAIChat(lineClient, userId, event.replyToken, incomingText, { GEMINI_API_KEY: env.GEMINI_API_KEY, GITHUB_PAT: env.GITHUB_PAT });
        return;
      }
    }

    // Furimanですクーポン
    if ((incomingText.includes('furimanです') || incomingText.includes('Furimanです')) && env?.GAS_DEPLOY_ID && env?.STRIPE_SECRET_KEY) {
      await actionFurimanCoupon(lineClient, userId, event.replyToken, { GAS_DEPLOY_ID: env.GAS_DEPLOY_ID, FIREBASE_DATABASE_URL: env.FIREBASE_DATABASE_URL, STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY }, db);
      return;
    }

    // 解説見た/解説みたキーワード
    if ((incomingText.trim() === '解説見た' || incomingText.trim() === '解説みた') && env?.GAS_DEPLOY_ID) {
      await actionExtendTrial(lineClient, userId, event.replyToken, env.GAS_DEPLOY_ID, db);
      return;
    }

    // チャットを作成/更新（ユーザーの自発的メッセージのみ unread にする）
    // ボタンタップ等の自動応答キーワードは除外
    const autoKeywords = ['料金', '機能', 'API', 'フォーム', 'ヘルプ', 'UUID', 'UUID連携について教えて', 'UUID連携を確認', '配信時間', '導入支援を希望します', 'アカウント連携を見る', '体験を完了する', 'BAN対策を見る', '連携確認'];
    const isRichMenuMessage = incomingText.startsWith('【リッチメニュー】');
    const isAutoKeyword = autoKeywords.some(k => incomingText === k);
    const isTimeCommand = /(?:配信時間|配信|届けて|通知)[はを]?\s*\d{1,2}\s*時/.test(incomingText);
    if (!isAutoKeyword && !isTimeCommand && !isRichMenuMessage) {
      await upsertChatOnMessage(db, friend.id);
    }

    // 配信時間設定: 「配信時間は○時」「○時に届けて」等のパターンを検出
    const timeMatch = incomingText.match(/(?:配信時間|配信|届けて|通知)[はを]?\s*(\d{1,2})\s*時/);
    if (timeMatch) {
      const hour = parseInt(timeMatch[1], 10);
      if (hour >= 6 && hour <= 22) {
        // Save preferred_hour to friend metadata
        const existing = await db.prepare('SELECT metadata FROM friends WHERE id = ?').bind(friend.id).first<{ metadata: string }>();
        const meta = JSON.parse(existing?.metadata || '{}');
        meta.preferred_hour = hour;
        await db.prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(meta), jstNow(), friend.id).run();

        // Reply with confirmation
        try {
          const period = hour < 12 ? '午前' : '午後';
          const displayHour = hour <= 12 ? hour : hour - 12;
          await lineClient.replyMessage(event.replyToken, [
            buildMessage('flex', JSON.stringify({
              type: 'bubble',
              body: { type: 'box', layout: 'vertical', contents: [
                { type: 'text', text: '配信時間を設定しました', size: 'lg', weight: 'bold', color: '#1e293b' },
                { type: 'box', layout: 'vertical', contents: [
                  { type: 'text', text: `${period} ${displayHour}:00`, size: 'xxl', weight: 'bold', color: '#f59e0b', align: 'center' },
                  { type: 'text', text: `（${hour}:00〜）`, size: 'sm', color: '#64748b', align: 'center', margin: 'sm' },
                ], backgroundColor: '#fffbeb', cornerRadius: 'md', paddingAll: '20px', margin: 'lg' },
                { type: 'text', text: '今後のステップ配信はこの時間以降にお届けします。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
              ], paddingAll: '20px' },
            })),
          ]);
        } catch (err) {
          console.error('Failed to reply for time setting', err);
        }
        return;
      }
    }

    // Cross-account trigger: send message from another account via UUID
    if (incomingText === '体験を完了する' && lineAccountId) {
      try {
        const friendRecord = await db.prepare('SELECT user_id FROM friends WHERE id = ?').bind(friend.id).first<{ user_id: string | null }>();
        if (friendRecord?.user_id) {
          // Find the same user on other accounts
          const otherFriends = await db.prepare(
            'SELECT f.line_user_id, la.channel_access_token FROM friends f INNER JOIN line_accounts la ON la.id = f.line_account_id WHERE f.user_id = ? AND f.line_account_id != ? AND f.is_following = 1'
          ).bind(friendRecord.user_id, lineAccountId).all<{ line_user_id: string; channel_access_token: string }>();

          for (const other of otherFriends.results) {
            const otherClient = new LineClient(other.channel_access_token);
            const { buildMessage: bm } = await import('../services/step-delivery.js');
            await otherClient.pushMessage(other.line_user_id, [bm('flex', JSON.stringify({
              type: 'bubble', size: 'giga',
              header: { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: '#fffbeb',
                contents: [{ type: 'text', text: `${friend.display_name || ''}さんへ`, size: 'lg', weight: 'bold', color: '#1e293b' }],
              },
              body: { type: 'box', layout: 'vertical', paddingAll: '20px',
                contents: [
                  { type: 'text', text: '別アカウントからのアクションを検知しました。', size: 'sm', color: '#06C755', weight: 'bold', wrap: true },
                  { type: 'text', text: 'アカウント連携が正常に動作しています。体験ありがとうございました。', size: 'sm', color: '#1e293b', wrap: true, margin: 'md' },
                  { type: 'separator', margin: 'lg' },
                  { type: 'text', text: 'ステップ配信・フォーム即返信・アカウント連携・リッチメニュー・自動返信 — 全て無料、全てOSS。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
                ],
              },
              footer: { type: 'box', layout: 'vertical', paddingAll: '16px',
                contents: [
                  { type: 'button', action: { type: 'message', label: '導入について相談する', text: '導入支援を希望します' }, style: 'primary', color: '#06C755' },
                  ...(env?.LIFF_URL ? [{ type: 'button', action: { type: 'uri', label: 'フィードバックを送る', uri: `${env.LIFF_URL}?page=form` }, style: 'secondary', margin: 'sm' }] : []),
                ],
              },
            }))]);
          }

          // Reply on Account ② confirming
          await lineClient.replyMessage(event.replyToken, [buildMessage('flex', JSON.stringify({
            type: 'bubble',
            body: { type: 'box', layout: 'vertical', paddingAll: '20px',
              contents: [
                { type: 'text', text: 'Account ① にメッセージを送りました', size: 'sm', color: '#06C755', weight: 'bold', align: 'center' },
                { type: 'text', text: 'Account ① のトーク画面を確認してください', size: 'xs', color: '#64748b', align: 'center', margin: 'md' },
              ],
            },
          }))]);
          return;
        }
      } catch (err) {
        console.error('Cross-account trigger error:', err);
      }
    }

    // 自動返信チェック（このアカウントのルール + グローバルルールのみ）
    // NOTE: Auto-replies use replyMessage (free, no quota) instead of pushMessage
    // The replyToken is only valid for ~1 minute after the message event
    const autoReplyQuery = lineAccountId
      ? `SELECT * FROM auto_replies WHERE is_active = 1 AND (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at ASC`
      : `SELECT * FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at ASC`;
    const autoReplyStmt = db.prepare(autoReplyQuery);
    const autoReplies = await (lineAccountId ? autoReplyStmt.bind(lineAccountId) : autoReplyStmt)
      .all<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains';
        response_type: string;
        response_content: string;
        is_active: number;
        created_at: string;
      }>();

    let matched = false;
    let replyTokenConsumed = false;
    for (const rule of autoReplies.results) {
      const isMatch =
        rule.match_type === 'exact'
          ? incomingText === rule.keyword
          : incomingText.includes(rule.keyword);

      if (isMatch) {
        try {
          // Expand template variables ({{name}}, {{uid}}, {{auth_url:CHANNEL_ID}})
          const expandedContent = expandVariables(rule.response_content, friend as { id: string; display_name: string | null; user_id: string | null }, workerUrl);
          const replyMsg = buildMessage(rule.response_type, expandedContent);
          await lineClient.replyMessage(event.replyToken, [replyMsg]);
          replyTokenConsumed = true;

          // 送信ログ（replyMessage = 無料）
          const outLogId = crypto.randomUUID();
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', ?)`,
            )
            .bind(outLogId, friend.id, rule.response_type, rule.response_content, jstNow())
            .run();
        } catch (err) {
          console.error('Failed to send auto-reply', err);
          // replyToken may still be unused if replyMessage threw before LINE accepted it
        }

        matched = true;
        break;
      }
    }

    // イベントバス発火: message_received
    // Pass replyToken only when auto_reply didn't actually consume it
    await fireEvent(db, 'message_received', {
      friendId: friend.id,
      eventData: { text: incomingText, matched },
      replyToken: replyTokenConsumed ? undefined : event.replyToken,
    }, lineAccessToken, lineAccountId);

    return;
  }
}

export { webhook };
