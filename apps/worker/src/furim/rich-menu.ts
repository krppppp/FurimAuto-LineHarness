import type { LineClient } from '@line-crm/line-sdk';

export const RICHMENU_KEYWORD_PREFIX = '【リッチメニュー】';

export type RichMenuEnv = {
  RICHMENU_DEFAULT_HOME?: string;
  RICHMENU_MEMBER_HOME?: string;
  RICHMENU_GUIDE?: string;
  RICHMENU_QANDA?: string;
};

async function isMember(db: D1Database, friendId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `SELECT 1 FROM friend_tags ft
       INNER JOIN tags t ON t.id = ft.tag_id
       WHERE ft.friend_id = ? AND t.name = '会員'
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
  } else if (tab === 'AIチャットボットを終了する') {
    const member = await isMember(db, friendId);
    richMenuId = member ? env.RICHMENU_MEMBER_HOME : env.RICHMENU_DEFAULT_HOME;
  }

  if (!richMenuId) {
    console.warn(`[furim] RichMenu switch: unknown tab or missing env: "${tab}"`);
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
