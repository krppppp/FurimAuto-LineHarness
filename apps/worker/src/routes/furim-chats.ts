import { Hono } from 'hono';
import type { Env } from '../index.js';

// FurimAuto fork 独自: サイドバーの未読バッジ用の軽量カウント。
// upstream の /api/inbox/unanswered/count(messages_log 全走査の重い集計)ではなく、
// chats.status='unread' の単純カウントを返す。バッジの意味を「未対応」→「未読」に
// 変更したため(2026-07-16)。全アカウント合算(バッジはグローバル表示)。
export const furimChats = new Hono<Env>();

furimChats.get('/api/furim/chats/unread-count', async (c) => {
  try {
    const row = await c.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM chats WHERE COALESCE(status, 'resolved') = 'unread'`,
    ).first<{ total: number }>();
    return c.json({ success: true, data: { total: row?.total ?? 0 } });
  } catch (err) {
    console.error('GET /api/furim/chats/unread-count error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
