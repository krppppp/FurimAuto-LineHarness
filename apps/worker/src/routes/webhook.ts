import { Hono } from 'hono';
import { verifySignature, LineClient } from '@line-crm/line-sdk';
import type { WebhookRequestBody, WebhookEvent, TextEventMessage } from '@line-crm/line-sdk';
import { createStickerMessageContent } from '@line-crm/shared';
import {
  upsertFriend,
  updateFriendFollowStatus,
  getFriendByLineUserId,
  upsertChatOnMessage,
  getLineAccounts,
  jstNow,
} from '@line-crm/db';
import type { EntryRoute, Friend } from '@line-crm/db';
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
import { notifyStaffOfIncomingMessage } from '../services/push-notify.js';

type WebhookEnv = RichMenuEnv & FurimActionsEnv & { LIFF_URL?: string; GAS_DEPLOY_ID?: string; GEMINI_API_KEY?: string; GITHUB_PAT?: string; VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string };
import type { Env } from '../index.js';

const webhook = new Hono<Env>();

// LINE webhook bodies are small (events array). Cap defends against unauthenticated
// large-payload DoS before signature verification (#104). 1 MiB leaves room for
// bursty batched deliveries (~100 events × ~5 KB) while still well below the
// 128 MB Cloudflare Workers memory ceiling.
const MAX_WEBHOOK_BODY_SIZE = 1024 * 1024; // 1 MiB

async function ensureFriendFromWebhookUser(
  db: D1Database,
  lineClient: LineClient,
  userId: string,
  lineAccountId: string | null,
): Promise<Friend | null> {
  let friend = await getFriendByLineUserId(db, userId);

  if (!friend) {
    let profile: Awaited<ReturnType<LineClient['getProfile']>> | null = null;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      // A signed webhook already proves this user interacted with the bot.
      // If profile lookup is temporarily unavailable, keep the event processable
      // by creating the friend with the LINE userId and filling profile later.
      console.error('[webhook] Failed to get profile for unknown user', userId, err);
    }

    friend = await upsertFriend(db, {
      lineUserId: userId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });
    console.log(`[webhook] auto-registered existing friend userId=${userId} friendId=${friend.id}`);
  }

  if (lineAccountId && friend.line_account_id !== lineAccountId) {
    const now = jstNow();
    await db
      .prepare('UPDATE friends SET line_account_id = ?, is_following = 1, updated_at = ? WHERE id = ?')
      .bind(lineAccountId, now, friend.id)
      .run();
    friend = { ...friend, line_account_id: lineAccountId, is_following: 1, updated_at: now };
  }

  return friend;
}

webhook.post('/webhook', async (c) => {
  // Pre-read size guard: reject before reading the body if Content-Length is oversized.
  const contentLengthHeader = c.req.header('Content-Length');
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_SIZE) {
      return c.json({ status: 'too_large' }, 413);
    }
  }

  const rawBody = await c.req.text();

  // Post-read size guard for the case where Content-Length was absent or untrustworthy.
  // Use UTF-8 byte count: `rawBody.length` counts UTF-16 code units, so multibyte
  // payloads (Japanese/emoji) would otherwise bypass the cap.
  const rawBodyByteLength = new TextEncoder().encode(rawBody).byteLength;
  if (rawBodyByteLength > MAX_WEBHOOK_BODY_SIZE) {
    return c.json({ status: 'too_large' }, 413);
  }

  const signature = c.req.header('X-Line-Signature') ?? '';
  const db = c.env.DB;

  // Cheap pre-reject for unsigned / malformed-signature requests. LINE signatures
  // are HMAC-SHA256 + base64 = 44 chars. This avoids D1 lookups and HMAC compute
  // for junk traffic on a public endpoint.
  const LINE_SIGNATURE_LENGTH = 44;
  if (signature.length !== LINE_SIGNATURE_LENGTH) {
    console.error('Missing or malformed LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  // Verify signature BEFORE JSON.parse so attacker-controlled bodies never reach the parser.
  // Fast path: try env default secret first so malformed/unauthenticated traffic
  //   fails fast without a D1 lookup. The main account is typically also registered
  //   in line_accounts; on env match we still look it up so matchedAccountId binds
  //   correctly for downstream account-scoped filters.
  // Slow path: iterate DB-registered accounts for genuinely multi-account installs.
  let channelAccessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  let matchedAccountId: string | null = null;
  let valid = false;

  const envSecret = c.env.LINE_CHANNEL_SECRET;
  if (envSecret) {
    valid = await verifySignature(envSecret, rawBody, signature);
    if (valid) {
      const accounts = await getLineAccounts(db);
      const main = accounts.find(
        (a) => a.is_active && a.channel_secret === envSecret,
      );
      if (main) {
        channelAccessToken = main.channel_access_token;
        matchedAccountId = main.id;
      }
    }
  }

  if (!valid) {
    const accounts = await getLineAccounts(db);
    for (const account of accounts) {
      if (!account.is_active) continue;
      if (envSecret && account.channel_secret === envSecret) continue; // already tried via fast path
      const isValid = await verifySignature(account.channel_secret, rawBody, signature);
      if (isValid) {
        channelAccessToken = account.channel_access_token;
        matchedAccountId = account.id;
        valid = true;
        break;
      }
    }
  }

  if (!valid) {
    console.error('Invalid LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  let body: WebhookRequestBody;
  try {
    body = JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    console.error('Failed to parse webhook body');
    return c.json({ status: 'ok' }, 200);
  }

  const lineClient = new LineClient(channelAccessToken);

  // 非同期処理 — LINE は ~1s 以内のレスポンスを要求
  const processingPromise = (async () => {
    for (const event of body.events) {
      try {
        await handleEvent(db, lineClient, event, channelAccessToken, matchedAccountId, c.env.WORKER_URL || new URL(c.req.url).origin, c.env.LIFF_URL, c.env.IMAGES, c.env);
      } catch (err) {
        console.error('Error handling webhook event:', err);
      }
    }
  })();

  c.executionCtx.waitUntil(processingPromise);

  return c.json({ status: 'ok' }, 200);
});

/**
 * ユーザーのメッセージに応答するハンドラを安全に実行する。
 *
 * GAS(Apps Script)は負荷が高いと doGet が DEADLINE_EXCEEDED で落ち、gasGet/gasPost が throw する。
 * ハンドラ内で握っていないとユーザーには「送ったのに一切返信が来ない」だけが残り、
 * GAS側のエラーシートにも出ないため気づけない
 * （2026-08-03 Keishi/なるやん さんの「キーコードリセット」が無言で消えた事例）。
 *
 * 失敗しても必ず何か返す。replyToken は消費済み/期限切れの可能性があるので push で送る。
 * 戻り値は「この分岐で処理を終える」= true。後続の分岐へは流さない。
 */
async function runHandlerSafely(
  label: string,
  lineClient: { pushMessage: (to: string, messages: never[]) => Promise<unknown> },
  userId: string,
  retryHint: string,
  fn: () => Promise<boolean | void>,
): Promise<boolean> {
  try {
    const handled = await fn();
    return handled !== false;
  } catch (err) {
    console.error(`[webhook] ${label} failed:`, userId, err);
    try {
      await lineClient.pushMessage(userId, [{
        type: 'text',
        text: `申し訳ございません。処理中に一時的なエラーが発生しました。\nお手数ですが、少し時間をおいて${retryHint}🙇`,
      } as never]);
    } catch (pushErr) {
      console.error(`[webhook] ${label} fallback push failed:`, pushErr);
    }
    return true;
  }
}

async function handleEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId: string | null = null,
  workerUrl?: string,
  liffUrl?: string,
  r2?: R2Bucket,
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
    // /api/liff/link が follow より先に ref 捕捉のため作成した friend は metadata.pendingFollow を
    // 持つ（is_following=0）。これは「初回追加」であってリフォローではないので isNewUser=true 扱いにする。
    const existingFriend = await getFriendByLineUserId(db, userId);
    let pendingFollow = false;
    if (existingFriend) {
      try { pendingFollow = !!JSON.parse((existingFriend as unknown as { metadata?: string }).metadata || '{}').pendingFollow; } catch { /* ignore */ }
    }
    const isNewUser = !existingFriend || pendingFollow;

    const friend = await upsertFriend(db, {
      lineUserId: userId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });

    // 本フォロー確認済み → 先行作成マーカーを消す
    if (pendingFollow) {
      await db.prepare(`UPDATE friends SET metadata = json_remove(metadata, '$.pendingFollow') WHERE id = ?`).bind(friend.id).run();
    }

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

  // Postback events — triggered by Flex buttons with action.type: "postback"
  // Uses the same auto_replies matching but without displaying text in chat
  if (event.type === 'postback') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const postbackData = (event as unknown as { postback: { data: string } }).postback.data;

    // Match postback data against auto_replies (exact match on keyword)
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
        template_id: string | null;
      }>();

    for (const rule of autoReplies.results) {
      const isMatch = rule.match_type === 'exact'
        ? postbackData === rule.keyword
        : postbackData.includes(rule.keyword);

      if (isMatch) {
        try {
          const { resolveMetadata } = await import('../services/step-delivery.js');
          const resolvedMeta = await resolveMetadata(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
          const resolved = await resolveAutoReplyContent(db, {
            template_id: rule.template_id,
            response_type: rule.response_type,
            response_content: rule.response_content,
          });
          const expandedContent = expandVariables(resolved.content, { ...friend, metadata: resolvedMeta } as Parameters<typeof expandVariables>[1], workerUrl, resolved.messageType);
          const replyMsg = buildMessage(resolved.messageType, expandedContent);
          await lineClient.replyMessage(event.replyToken, [replyMsg]);

          // 送信ログ — Rich Menu 経由の Flex 応答もチャット詳細に残るようにする。
          // テキスト auto_reply (line ~390) と同じパターン。
          const { messageToLogPayload: logPayload } = await import('../services/step-delivery.js');
          const replyPayload = logPayload(replyMsg);
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'auto_reply', ?, ?)`,
            )
            .bind(crypto.randomUUID(), friend.id, replyPayload.messageType, replyPayload.content, lineAccountId ?? null, jstNow())
            .run();
        } catch (err) {
          console.error('Failed to send postback reply', err);
        }
        break;
      }
    }
    return;
  }

  // 非テキストの受信メッセージ（スタンプ/画像/音声/動画/ファイル/位置情報等）もログに残す。
  // ここで早期 return することで、テキスト用の auto_reply / scenario 判定には進まない
  // （スタンプ単体に対するキーワードマッチは意味を持たないため）。inbox 抜けだけ防ぐ。
  if (event.type === 'message' && event.message.type !== 'text') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;
    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const msg = event.message as {
      id: string;
      type: string;
      fileName?: string;
      title?: string;
      packageId?: string | number;
      package_id?: string | number;
      stickerId?: string | number;
      sticker_id?: string | number;
      stickerResourceType?: string | number;
      sticker_resource_type?: string | number;
    };
    const labels: Record<string, string> = {
      sticker: '[スタンプ]',
      image: '[画像]',
      audio: '[音声]',
      video: '[動画]',
      file: msg.fileName ? `[ファイル: ${msg.fileName}]` : '[ファイル]',
      location: msg.title ? `[位置情報: ${msg.title}]` : '[位置情報]',
    };
    const content = labels[msg.type] ?? `[${msg.type}]`;

    // image / video の場合は LINE Content API でバイナリを取得 → R2 → JSON URL に置換。
    // 失敗時は labels[msg.type] のラベル文字列のまま (フォールバック)。
    let finalContent = content;
    if (msg.type === 'sticker') {
      const stickerContent = createStickerMessageContent(msg);
      if (stickerContent) {
        finalContent = JSON.stringify(stickerContent);
      }
    }
    if ((msg.type === 'image' || msg.type === 'video') && r2 && workerUrl) {
      const lineMessageId = msg.id;
      const { fetchAndStoreIncomingMedia } = await import('../services/incoming-image.js');
      const refs = await fetchAndStoreIncomingMedia({
        r2,
        workerUrl,
        channelAccessToken: lineAccessToken,
        accountId: lineAccountId ?? 'unknown',
        messageId: lineMessageId,
        messageType: msg.type as 'image' | 'video',
      });
      if (refs) {
        finalContent = JSON.stringify(refs);
      }
    }

    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, created_at)
         VALUES (?, ?, 'incoming', ?, ?, NULL, NULL, 'user', ?)`,
      )
      .bind(crypto.randomUUID(), friend.id, msg.type, finalContent, jstNow())
      .run();
    // text と同様、非 text の自発メッセージ (画像/スタンプ等) でも chat を unread に戻す。
    // これが無いと resolved 除外 (unanswered-inbox CANDIDATES_SQL) が「解決済み後に
    // 画像だけ送ってきた友だち」をバッジ・未対応一覧から永久に落としてしまう。
    // 非 text は auto_reply keyword にマッチし得ないので常に要対応扱いで正しい。
    await upsertChatOnMessage(db, friend.id);
    if (env) {
      await notifyStaffOfIncomingMessage(db, env, {
        friendId: friend.id,
        friendName: friend.display_name,
        accountId: lineAccountId,
        preview: content,
      });
    }
    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const textMessage = event.message as TextEventMessage;
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    // furim系ハンドラーのreply/push送信をチャット履歴(messages_log)に残す
    const loggingClient = withOutgoingLog(lineClient, db, friend.id);

    const incomingText = textMessage.text;
    const now = jstNow();
    const logId = crypto.randomUUID();

    // 受信メッセージをログに記録
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, quote_token, created_at)
         VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, ?, ?)`,
      )
      .bind(logId, friend.id, incomingText, textMessage.quoteToken ?? null, now)
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
      // クロージャに渡すと env の絞り込みが外れるので、ここで確定させる
      const gasDeployId = env.GAS_DEPLOY_ID;
      await runHandlerSafely('handleButtonAction', loggingClient, userId, 'もう一度ボタンをタップしてください', () =>
        handleButtonAction(loggingClient, userId, event.replyToken, incomingText, { GAS_DEPLOY_ID: gasDeployId, STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY }, db));
      return;
    }

    // リッチメニュー切り替え: 【リッチメニュー】プレフィックスのメッセージを処理
    if (env) {
      const richMenuHandled = await handleRichMenuSwitch(db, loggingClient, userId, friend.id, incomingText, event.replyToken, env);
      if (richMenuHandled) return;
    }

    // FurimAutoアクション: GAS連携等の業務処理
    if (env?.GAS_DEPLOY_ID) {
      const gasDeployId = env.GAS_DEPLOY_ID;
      const furimHandled = await runHandlerSafely('handleFurimAction', loggingClient, userId, 'もう一度お試しください', () => handleFurimAction(loggingClient, userId, event.replyToken, incomingText, {
        GAS_DEPLOY_ID: gasDeployId,
        FIREBASE_DATABASE_URL: env.FIREBASE_DATABASE_URL,
        STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
        PLAN_BUILDER_LIFF_URL: env.PLAN_BUILDER_LIFF_URL,
        WORKER_URL: env.WORKER_URL,
        WORKER_PUBLIC_URL: workerUrl,
        FURIM_AMBASSADOR_OFFER_ID: env.FURIM_AMBASSADOR_OFFER_ID,
      }, db));
      if (furimHandled) return;
    }

    // 【キーワード】アクション（"キーコードリセット"のみプレフィックスなしの単体文字列でも動く特別対応）
    if ((incomingText.includes('【キーワード】') || incomingText.includes('キーコードリセット')) && env?.GAS_DEPLOY_ID) {
      const retryHint = incomingText.includes('キーコードリセット')
        ? 'もう一度「キーコードリセット」と送信してください'
        : 'もう一度お試しください';
      const gasDeployId = env.GAS_DEPLOY_ID;
      await runHandlerSafely('handleKeywordAction', loggingClient, userId, retryHint, () =>
        handleKeywordAction(loggingClient, userId, event.replyToken, incomingText, { GAS_DEPLOY_ID: gasDeployId, STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY }, db));
      return;
    }

    // Furimanですクーポン（AIチャットモード中でも通す）
    if ((incomingText.includes('furimanです') || incomingText.includes('Furimanです')) && env?.GAS_DEPLOY_ID && env?.STRIPE_SECRET_KEY) {
      try {
        await actionFurimanCoupon(loggingClient, userId, event.replyToken, { GAS_DEPLOY_ID: env.GAS_DEPLOY_ID, FIREBASE_DATABASE_URL: env.FIREBASE_DATABASE_URL, STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY }, db);
      } catch (err) {
        // GAS/Stripeの一時障害で無言のまま終わらせない（2026-08-02 すがやさんの事例）。
        // replyTokenは消費済みの可能性があるためpushで通知する
        console.error('[webhook] actionFurimanCoupon failed:', userId, err);
        try {
          await loggingClient.pushMessage(userId, [{ type: 'text', text: '申し訳ございません。クーポン処理中に一時的なエラーが発生しました。お手数ですが、少し時間をおいてもう一度「Furimanです」と送信してください🙇' } as never]);
        } catch (pushErr) {
          console.error('[webhook] actionFurimanCoupon fallback push failed:', pushErr);
        }
      }
      return;
    }

    // 解説見た/解説みたキーワード（AIチャットモード中でも通す）
    if ((incomingText.trim() === '解説見た' || incomingText.trim() === '解説みた') && env?.GAS_DEPLOY_ID) {
      try {
        await actionExtendTrial(loggingClient, userId, event.replyToken, env.GAS_DEPLOY_ID, db);
      } catch (err) {
        // GASの応答遅延でreplyTokenが失効すると延長成功後でも無言死する
        // (2026-08-05 すがやさんの事例)。pushで結果を届ける
        console.error('[webhook] actionExtendTrial failed:', userId, err);
        try {
          await loggingClient.pushMessage(userId, [{ type: 'text', text: '申し訳ございません。処理に時間がかかっております。「解説見た」の特典が反映されているかこちらで確認いたしますので、少々お待ちください🙇' } as never]);
        } catch (pushErr) {
          console.error('[webhook] actionExtendTrial fallback push failed:', pushErr);
        }
      }
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

    // チャットを作成/更新（ユーザーの自発的メッセージのみ unread にする）
    // ボタンタップ等の自動応答キーワードは除外
    const autoKeywords = ['料金', '機能', 'API', 'フォーム', 'ヘルプ', 'UUID', 'UUID連携について教えて', 'UUID連携を確認', '配信時間', '導入支援を希望します', 'アカウント連携を見る', '体験を完了する', 'BAN対策を見る', '連携確認'];
    const isRichMenuMessage = incomingText.startsWith('【リッチメニュー】');
    const isAutoKeyword = autoKeywords.some(k => incomingText === k);
    const isTimeCommand = /(?:配信時間|配信|届けて|通知)[はを]?\s*\d{1,2}\s*時/.test(incomingText);
    if (!isAutoKeyword && !isTimeCommand && !isRichMenuMessage) {
      await upsertChatOnMessage(db, friend.id);
      if (env) {
        await notifyStaffOfIncomingMessage(db, env, {
          friendId: friend.id,
          friendName: friend.display_name,
          accountId: lineAccountId,
          preview: incomingText,
        });
      }
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
        template_id: string | null;
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
          const { resolveMetadata: resolveMeta2 } = await import('../services/step-delivery.js');
          const resolvedMeta2 = await resolveMeta2(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
          const resolved = await resolveAutoReplyContent(db, {
            template_id: rule.template_id,
            response_type: rule.response_type,
            response_content: rule.response_content,
          });
          const expandedContent = expandVariables(resolved.content, { ...friend, metadata: resolvedMeta2 } as Parameters<typeof expandVariables>[1], workerUrl, resolved.messageType);
          const replyMsg = buildMessage(resolved.messageType, expandedContent);
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


/**
 * auto_reply 行の content/type を resolve する。template_id が set なら templates
 * から取得、参照切れや NULL のときは inline response_content/response_type を使う。
 */
async function resolveAutoReplyContent(
  db: D1Database,
  rule: { template_id: string | null; response_type: string; response_content: string },
): Promise<{ messageType: string; content: string }> {
  if (rule.template_id) {
    const { getTemplateById } = await import('@line-crm/db');
    const tpl = await getTemplateById(db, rule.template_id);
    if (tpl) {
      return { messageType: tpl.message_type, content: tpl.message_content };
    }
  }
  return { messageType: rule.response_type, content: rule.response_content };
}

export { webhook };
