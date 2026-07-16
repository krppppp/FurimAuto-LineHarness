import { Hono } from 'hono';
import type { Env } from '../index.js';
import { countUnreadChats } from '../services/unread-count.js';

// FurimAuto fork 独自: サイドバーの未読バッジ用の軽量カウント。
// upstream の /api/inbox/unanswered/count(messages_log 全走査の重い集計)ではなく、
// chats.status='unread' の単純カウントを返す。バッジの意味を「未対応」→「未読」に
// 変更したため(2026-07-16)。全アカウント合算(バッジはグローバル表示)。
export const furimChats = new Hono<Env>();

furimChats.get('/api/furim/chats/unread-count', async (c) => {
  try {
    const total = await countUnreadChats(c.env.DB);
    return c.json({ success: true, data: { total } });
  } catch (err) {
    console.error('GET /api/furim/chats/unread-count error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
