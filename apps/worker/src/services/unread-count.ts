// FurimAuto fork 独自: 未読チャット件数の単一ソース。
// サイドバーの未読バッジ(/api/furim/chats/unread-count)と PWA アイコンバッジ
// (push の badge)で同じ定義を使うため共通化。chats.status='unread' の単純カウント。
export async function countUnreadChats(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total FROM chats WHERE COALESCE(status, 'resolved') = 'unread'`)
    .first<{ total: number }>();
  return row?.total ?? 0;
}
