import type { LineClient } from '@line-crm/line-sdk';
import { setAiMode, deleteAiMode, clearChatHistory } from './firebase-client.js';

export const RICHMENU_KEYWORD_PREFIX = '【リッチメニュー】';

export type RichMenuEnv = {
  RICHMENU_DEFAULT_HOME?: string;
  RICHMENU_MEMBER_HOME?: string;
  RICHMENU_GUIDE?: string;
  RICHMENU_QANDA?: string;
  FIREBASE_DATABASE_URL?: string;
};

async function isMember(db: D1Database, friendId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `SELECT 1 FROM friend_tags ft
       INNER JOIN tags t ON t.id = ft.tag_id
       WHERE ft.friend_id = ? AND t.name = '月額会員'
       LIMIT 1`,
    )
    .bind(friendId)
    .first();
  return result !== null;
}

export async function handleRichMenuSwitch(
  db: D1Database,
  lineClient: LineClient,
  userId: string,
  friendId: string,
  text: string,
  replyToken: string,
  env: RichMenuEnv,
): Promise<boolean> {
  if (!text.startsWith(RICHMENU_KEYWORD_PREFIX)) return false;

  const tab = text.slice(RICHMENU_KEYWORD_PREFIX.length);
  let richMenuId: string | undefined;

  if (tab === 'ホームタブ') {
    const member = await isMember(db, friendId);
    richMenuId = member ? env.RICHMENU_MEMBER_HOME : env.RICHMENU_DEFAULT_HOME;
  } else if (tab === 'ガイドタブ') {
    richMenuId = env.RICHMENU_GUIDE;
  } else if (tab === 'Q&Aタブ') {
    richMenuId = env.RICHMENU_QANDA;
    if (richMenuId) {
      try {
        await lineClient.linkRichMenuToUser(userId, richMenuId);
      } catch (err) {
        console.error('[furim] RichMenu switch failed:', err);
      }
    }
    if (env.FIREBASE_DATABASE_URL) {
      await setAiMode(env.FIREBASE_DATABASE_URL, userId);
    }
    await lineClient.replyMessage(replyToken, [
      {
        type: 'text',
        text: `【AIが担当するQ&Aです！】\n\n簡単な質問をするとFurimAutoのマニュアルや説明書を参考にAIが適切な回答をいたします🤖\n\nこのやりとりは開発担当者が閲覧できるので回答が不十分な場合は後ほど開発担当者が直々に回答いたします🙇\n\n📝 メッセージは左下のキーボードボタンから入力できます。\n\n※AIチャットボットを終了する場合は、「AIチャットボットを終了する」をタップしてください。`,
      } as never,
      {
        type: 'image',
        originalContentUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/ai_chatbot.jpg',
        previewImageUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/ai_chatbot.jpg',
      } as never,
      {
        type: 'video',
        originalContentUrl: 'https://storage.googleapis.com/furimauto_line/video/ai_chatbot.mp4',
        previewImageUrl: 'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png',
        trackingId: 'setup',
      } as never,
    ]);
    return true;
  } else if (tab === 'AIチャットボットを終了する') {
    const member = await isMember(db, friendId);
    richMenuId = member ? env.RICHMENU_MEMBER_HOME : env.RICHMENU_DEFAULT_HOME;
    if (richMenuId) {
      try {
        await lineClient.linkRichMenuToUser(userId, richMenuId);
      } catch (err) {
        console.error('[furim] RichMenu switch failed:', err);
      }
    }
    if (env.FIREBASE_DATABASE_URL) {
      await deleteAiMode(env.FIREBASE_DATABASE_URL, userId);
      await clearChatHistory(env.FIREBASE_DATABASE_URL, userId);
    }
    await lineClient.replyMessage(replyToken, [
      {
        type: 'template',
        altText: '追加サポートの確認',
        template: {
          type: 'buttons',
          text: '担当者からの追加サポートが必要な場合は、下のボタンをタップしてください。',
          actions: [
            { type: 'message', label: '📞 追加サポートが必要', text: '【ボタン】追加サポート' },
          ],
        },
      } as never,
    ]);
    return true;
  } else {
    // 不明なタブ名 → handleFurimAction にフォールスルー
    return false;
  }

  if (!richMenuId) {
    console.warn(`[furim] RichMenu switch: missing env for tab: "${tab}"`);
    return true;
  }

  try {
    await lineClient.linkRichMenuToUser(userId, richMenuId);
    console.log(`[furim] RichMenu switched: ${userId} → ${tab} (${richMenuId})`);
  } catch (err) {
    console.error('[furim] RichMenu switch failed:', err);
  }

  return true;
}

export async function linkDefaultRichMenuOnFollow(
  lineClient: LineClient,
  userId: string,
  env: RichMenuEnv,
): Promise<void> {
  if (!env.RICHMENU_DEFAULT_HOME) return;
  try {
    await lineClient.linkRichMenuToUser(userId, env.RICHMENU_DEFAULT_HOME);
    console.log(`[furim] Default RichMenu linked on follow: ${userId}`);
  } catch (err) {
    console.error('[furim] Failed to link default RichMenu on follow:', err);
  }
}
