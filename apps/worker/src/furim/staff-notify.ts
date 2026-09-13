// スタッフ（くろさん）への通知: LINE push と Web Push の二段。
// plan-change-watch.ts の通知部と同じ形を切り出したもの。どちらが落ちても本処理を巻き込まない
import type { LineClient } from '@line-crm/line-sdk';
import { sendPushToAll, type PushEnv } from '../services/push-notify.js';

export const STAFF_LINE_USER_ID = 'U5d35c3e6b2be0a6ec699b2a1de2aba93';

export async function notifyStaff(
  db: D1Database,
  lineClient: LineClient | null,
  env: PushEnv,
  msg: { title: string; body: string; url?: string; lineText?: string },
  tag = 'staff-notify',
): Promise<void> {
  if (lineClient) {
    try {
      await lineClient.pushMessage(STAFF_LINE_USER_ID, [{ type: 'text', text: msg.lineText ?? `${msg.title}\n${msg.body}` } as never]);
    } catch (e) {
      console.error(`[${tag}] staff LINE push failed:`, e);
    }
  }
  try {
    await sendPushToAll(db, env, { title: msg.title, body: msg.body, url: msg.url ?? '/friends' });
  } catch (e) {
    console.error(`[${tag}] web push failed:`, e);
  }
}
