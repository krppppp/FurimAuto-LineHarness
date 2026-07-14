import { Hono } from 'hono';
import { verifySignature, LineClient } from '@line-crm/line-sdk';
import type { WebhookRequestBody, WebhookEvent, TextEventMessage } from '@line-crm/line-sdk';
import {
  upsertFriend,
  updateFriendFollowStatus,
  getFriendByLineUserId,
  upsertChatOnMessage,
  getLineAccounts,
  jstNow,
} from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage, expandVariables } from '../services/step-delivery.js';
import { handleRichMenuSwitch } from '../furim/rich-menu.js';
import type { RichMenuEnv } from '../furim/rich-menu.js';
import { handleFurimAction, actionFurimanCoupon, actionExtendTrial } from '../furim/actions.js';
import type { FurimActionsEnv } from '../furim/actions.js';
import { handleButtonAction } from '../furim/button-actions.js';
import { handleKeywordAction } from '../furim/keyword-actions.js';
import { handleAIChat } from '../furim/ai-chat.js';
import { getAiMode } from '../furim/firebase-client.js';
import { withOutgoingLog } from '../utils/message-log.js';

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

    // タグ付与・リッチメニュー設定・ウェルカムメッセージ・リフォロー処理は friend_add Automation で管理

    // イベントバス発火: friend_add（replyToken を渡してオートメーション内で使用）
    await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName: friend.display_name, isNewUser }, replyToken: event.replyToken }, lineAccessToken, lineAccountId, {
      lineAccessToken,
      gasDeployId: env?.GAS_DEPLOY_ID,
      stripeSecretKey: env?.STRIPE_SECRET_KEY,
    });
    return;
  }

  if (event.type === 'unfollow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    await updateFriendFollowStatus(db, userId, false);

    // タグ操作・通知は unfollow Automation で管理
    const unfollowedFriend = await getFriendByLineUserId(db, userId);
    if (unfollowedFriend) {
      await fireEvent(db, 'unfollow', { friendId: unfollowedFriend.id, eventData: {} }, lineAccessToken, lineAccountId, { lineAccessToken });
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

    // furim系ハンドラーのreply/push送信をチャット履歴(messages_log)に残す
    const loggingClient = withOutgoingLog(lineClient, db, friend.id);

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

    // 【プラン変更】PB-XXXXXX: 既存契約者のLIFF申込。新規Checkoutではなく
    // 既存サブスクをin-place更新し、残り期間の差額を日割りで即時決済する
    if (incomingText.startsWith('【プラン変更】') && env?.STRIPE_SECRET_KEY && env?.GAS_DEPLOY_ID) {
      const { handlePlanChangeMessage } = await import('../furim/plan-change.js');
      await handlePlanChangeMessage(db, loggingClient, userId, event.replyToken, incomingText, {
        STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
        GAS_DEPLOY_ID: env.GAS_DEPLOY_ID,
        WORKER_PUBLIC_URL: workerUrl,
      });
      return;
    }

    // 【プラン申し込み】PB-XXXXXX: plan-builder LIFFの申込ボタンから送られる申込メッセージ。
    // 申込コードで選択内容を引き、Checkoutリンク（1時間有効）をFlexで返信する
    if (incomingText.startsWith('【プラン申し込み】') && env?.STRIPE_SECRET_KEY && env?.GAS_DEPLOY_ID) {
      const { handlePlanApplyMessage } = await import('../furim/plan-apply.js');
      await handlePlanApplyMessage(db, loggingClient, userId, event.replyToken, incomingText, {
        STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
        GAS_DEPLOY_ID: env.GAS_DEPLOY_ID,
        WORKER_PUBLIC_URL: workerUrl,
      });
      return;
    }

    // 【ボタン】アクション
    if (incomingText.includes('【ボタン】') && env?.GAS_DEPLOY_ID) {
      await handleButtonAction(loggingClient, userId, event.replyToken, incomingText, { GAS_DEPLOY_ID: env.GAS_DEPLOY_ID, STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY }, db);
      return;
    }

    // リッチメニュー切り替え: 【リッチメニュー】プレフィックスのメッセージを処理
    if (env) {
      const richMenuHandled = await handleRichMenuSwitch(db, loggingClient, userId, friend.id, incomingText, event.replyToken, env);
      if (richMenuHandled) return;
    }

    // FurimAutoアクション: GAS連携等の業務処理
    if (env?.GAS_DEPLOY_ID) {
      const furimHandled = await handleFurimAction(loggingClient, userId, event.replyToken, incomingText, {
        GAS_DEPLOY_ID: env.GAS_DEPLOY_ID,
        FIREBASE_DATABASE_URL: env.FIREBASE_DATABASE_URL,
        STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
        PLAN_BUILDER_LIFF_URL: env.PLAN_BUILDER_LIFF_URL,
      }, db);
      if (furimHandled) return;
    }

    // 【キーワード】アクション
    if (incomingText.includes('【キーワード】') && env?.GAS_DEPLOY_ID) {
      await handleKeywordAction(loggingClient, userId, event.replyToken, incomingText, { GAS_DEPLOY_ID: env.GAS_DEPLOY_ID, STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY }, db);
      return;
    }

    // AIチャットモード
    if (env?.FIREBASE_DATABASE_URL && env?.GEMINI_API_KEY && env?.GITHUB_PAT) {
      const isAIMode = await getAiMode(env.FIREBASE_DATABASE_URL, userId);
      if (isAIMode) {
        await handleAIChat(loggingClient, userId, event.replyToken, incomingText, { GEMINI_API_KEY: env.GEMINI_API_KEY, GITHUB_PAT: env.GITHUB_PAT, FIREBASE_DATABASE_URL: env.FIREBASE_DATABASE_URL });
        return;
      }
    }

    // Furimanですクーポン
    if ((incomingText.includes('furimanです') || incomingText.includes('Furimanです')) && env?.GAS_DEPLOY_ID && env?.STRIPE_SECRET_KEY) {
      await actionFurimanCoupon(loggingClient, userId, event.replyToken, { GAS_DEPLOY_ID: env.GAS_DEPLOY_ID, FIREBASE_DATABASE_URL: env.FIREBASE_DATABASE_URL, STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY }, db);
      return;
    }

    // 解説見た/解説みたキーワード
    if ((incomingText.trim() === '解説見た' || incomingText.trim() === '解説みた') && env?.GAS_DEPLOY_ID) {
      await actionExtendTrial(loggingClient, userId, event.replyToken, env.GAS_DEPLOY_ID, db);
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
          await loggingClient.replyMessage(event.replyToken, [
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
    }, lineAccessToken, lineAccountId, {
      lineAccessToken,
      gasDeployId: env?.GAS_DEPLOY_ID,
      stripeSecretKey: env?.STRIPE_SECRET_KEY,
    });

    return;
  }
}

export { webhook };
