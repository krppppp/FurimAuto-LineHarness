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
 */
export function withOutgoingLog(client: LineClient, db: D1Database, friendId: string): LineClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'replyMessage' || prop === 'pushMessage') {
        return async (first: string, messages: Message[]) => {
          const result =
            prop === 'replyMessage'
              ? await target.replyMessage(first, messages)
              : await target.pushMessage(first, messages);
          for (const m of messages ?? []) {
            const type = (m as { type?: string }).type ?? 'text';
            const content = type === 'text' ? ((m as { text?: string }).text ?? '') : JSON.stringify(m);
            try {
              await logOutgoing(db, friendId, type, content);
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
