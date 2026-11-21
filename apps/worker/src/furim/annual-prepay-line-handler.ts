import type { LineClient, Message } from '@line-crm/line-sdk';
import { addTagToFriend, jstNow } from '@line-crm/db';
import {
  ANNUAL_AGREED_TAG,
  ANNUAL_CONFIRM_LABEL,
  annualConfirmMessages,
  annualQuoteMessages,
} from './annual-prepay-line.js';
import { chargeAnnualPrepay, quoteAnnualCharge, type AnnualPrepayEnv, type ChargeResult, type QuoteResult } from './annual-prepay.js';

async function logOutgoing(db: D1Database, friendId: string, messages: Message[], lineAccountId: string | null) {
  const { messageToLogPayload } = await import('../services/step-delivery.js');
  for (const m of messages) {
    const p = messageToLogPayload(m);
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'auto_reply', ?, ?)`,
      )
      .bind(crypto.randomUUID(), friendId, p.messageType, p.content, lineAccountId, jstNow())
      .run();
  }
}

/** 「年払い」→ 金額の案内。replyToken を使えたら true */
export async function replyAnnualQuote(
  db: D1Database,
  env: AnnualPrepayEnv,
  lineClient: LineClient,
  replyToken: string,
  friend: { id: string; line_user_id: string },
  lineAccountId: string | null,
): Promise<boolean> {
  let result: QuoteResult;
  try {
    result = await quoteAnnualCharge(db, env, { lineUserId: friend.line_user_id });
  } catch (err) {
    console.error('[annual-prepay-line] quote failed', friend.line_user_id, err);
    result = { ok: false, reason: 'error', message: String(err), customerAction: 'staff_contact' };
  }
  if (!result.ok) console.warn('[annual-prepay-line] quote blocked', friend.line_user_id, result.reason, result.message);
  const messages = annualQuoteMessages(result);
  try {
    await lineClient.replyMessage(replyToken, messages);
  } catch (err) {
    console.error('[annual-prepay-line] quote reply failed', err);
    return false;
  }
  await logOutgoing(db, friend.id, messages, lineAccountId);
  return true;
}

/** 「この内容で申し込む」（postback）→ 決済 → 結果の返事。押した記録を同意の記録として残す */
export async function replyAnnualConfirm(
  db: D1Database,
  env: AnnualPrepayEnv,
  lineClient: LineClient,
  replyToken: string,
  friend: { id: string; line_user_id: string },
  lineAccountId: string | null,
  expectedAnnual?: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, line_account_id, created_at)
       VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, NULL, ?, ?)`,
    )
    .bind(crypto.randomUUID(), friend.id, `【ボタン】${ANNUAL_CONFIRM_LABEL}`, lineAccountId, jstNow())
    .run();
  const tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(ANNUAL_AGREED_TAG).first<{ id: string }>();
  if (tag) await addTagToFriend(db, friend.id, tag.id);

  let result: ChargeResult;
  try {
    result = await chargeAnnualPrepay(db, env, { lineUserId: friend.line_user_id, expectedAnnual });
  } catch (err) {
    console.error('[annual-prepay-line] charge failed', friend.line_user_id, err);
    result = { ok: false, reason: 'error', message: String(err), customerAction: 'staff_contact' };
  }
  console.log('[annual-prepay-line] confirm', friend.line_user_id, JSON.stringify(result));
  const messages = annualConfirmMessages(result);
  try {
    await lineClient.replyMessage(replyToken, messages);
  } catch (err) {
    console.error('[annual-prepay-line] confirm reply failed, push instead', err);
    await lineClient.pushMessage(friend.line_user_id, messages);
  }
  await logOutgoing(db, friend.id, messages, lineAccountId);
}
