export async function logOutgoing(
  db: D1Database,
  friendId: string,
  messageType: string,
  content: string,
): Promise<void> {
  const id = crypto.randomUUID();
  const jst = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  await db
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
       VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, ?)`,
    )
    .bind(id, friendId, messageType, content, jst)
    .run();
}
