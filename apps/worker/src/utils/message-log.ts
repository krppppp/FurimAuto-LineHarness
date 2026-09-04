import type { LineClient, Message } from '@line-crm/line-sdk';
import { jstNow } from '@line-crm/db';

export async function logOutgoing(
  db: D1Database,
  friendId: string,
  messageType: string,
  content: string,
): Promise<void> {
  const id = crypto.randomUUID();
  // incoming側(jstNow)と同一形式にする。形式が違うと文字列ソートで並び順が壊れる
  const jst = jstNow();
  await db
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
       VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, ?)`,
    )
    .bind(id, friendId, messageType, content, jst)
    .run();
}

/**
 * furim系ハンドラー（リッチメニュー/キーワード/ボタン/AIチャット等）のreply・push送信を
 * messages_logへ自動記録するLineClientラッパー。送信成功後にのみ記録する。
 *
 * push は宛先(to)を見て記録先を決める。紹介成立処理のように、1回の流れの中で
 * 被紹介者とアンバサダーの2人へ送るケースがあり、ラップ時の friendId で固定すると
 * 別人宛の文面が混ざるため（2026-09-04）。
 */
export function withOutgoingLog(client: LineClient, db: D1Database, friendId: string): LineClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'replyMessage' || prop === 'pushMessage') {
        return async (first: string, messages: Message[]) => {
          const isPush = prop === 'pushMessage';
          const result = isPush
            ? await target.pushMessage(first, messages)
            : await target.replyMessage(first, messages);

          // push の first は宛先の lineUserId。ラップ対象と違う相手なら、その人の履歴へ入れる。
          // reply の first は replyToken なので判定できず、ラップ対象のままでよい
          let logFriendId = friendId;
          if (isPush) {
            try {
              const own = await db
                .prepare('SELECT line_user_id FROM friends WHERE id = ?')
                .bind(friendId)
                .first<{ line_user_id: string }>();
              if (own && own.line_user_id !== first) {
                const other = await db
                  .prepare('SELECT id FROM friends WHERE line_user_id = ?')
                  .bind(first)
                  .first<{ id: string }>();
                // 友だちとして登録が無い相手はログを残さない（記録先が決められないため）
                logFriendId = other?.id ?? '';
              }
            } catch (e) {
              console.error('[message-log] resolve push target failed:', e);
            }
          }
          if (!logFriendId) return result;

          for (const m of messages ?? []) {
            const type = (m as { type?: string }).type ?? 'text';
            const content = type === 'text' ? ((m as { text?: string }).text ?? '') : JSON.stringify(m);
            try {
              await logOutgoing(db, logFriendId, type, content);
            } catch (e) {
              console.error('[message-log] outgoing log failed:', e);
            }
          }
          return result;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as LineClient;
}
