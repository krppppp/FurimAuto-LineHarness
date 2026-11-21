import type { LineClient, Message } from '@line-crm/line-sdk';
import { addTagToFriend, jstNow } from '@line-crm/db';
import {
  ANNUAL_AGREED_TAG,
  ANNUAL_CONFIRM_LABEL,
  annualConfirmMessages,
  annualQuoteMessages,
  type AnnualChargeResult,
  type AnnualQuoteResult,
} from './annual-prepay-line.js';
import { addMonths, createAnnualCheckout, type AnnualPrepayEnv } from './annual-prepay.js';
import { formatJstIso } from './customer-store.js';

type ChargeFn = (
  db: D1Database,
  env: AnnualPrepayEnv,
  input: { lineUserId: string; dryRun?: boolean },
) => Promise<AnnualQuoteResult | AnnualChargeResult>;

/** TB-3963 の決済の関数。まだ無い版では Checkout のリンクで代える */
async function resolveCharge(): Promise<ChargeFn | null> {
  const mod = (await import('./annual-prepay.js')) as unknown as { chargeAnnualPrepay?: ChargeFn };
  return mod.chargeAnnualPrepay ?? null;
}

export async function quoteAnnual(db: D1Database, env: AnnualPrepayEnv, lineUserId: string): Promise<AnnualQuoteResult> {
  const charge = await resolveCharge();
  if (charge) return (await charge(db, env, { lineUserId, dryRun: true })) as AnnualQuoteResult;
  const r = await createAnnualCheckout(db, env, { lineUserId, dryRun: true });
  if (!r.ok) return r;
  if (!('dryRun' in r)) return { ok: false, reason: 'unexpected', message: 'dryRun が返りませんでした' };
  const startSec = Math.floor(Date.parse(r.periodStart) / 1000);
  const endSec = addMonths(startSec, 12) - 86400;
  const tax = Math.round(r.annual * 0.1);
  return {
    ok: true, dryRun: true, kind: r.kind, priceMonths: r.priceMonths, monthly: r.monthly, annual: r.annual,
    tax, total: r.annual + tax, startAt: r.periodStart, endAt: formatJstIso(endSec * 1000),
  };
}

export async function chargeAnnual(db: D1Database, env: AnnualPrepayEnv, lineUserId: string): Promise<AnnualChargeResult> {
  const charge = await resolveCharge();
  if (charge) return (await charge(db, env, { lineUserId })) as AnnualChargeResult;
  const r = await createAnnualCheckout(db, env, { lineUserId, createdBy: 'line' });
  if (!r.ok) return r;
  if ('dryRun' in r) return { ok: false, reason: 'unexpected', message: 'dryRun が返りました' };
  return { ok: false, reason: 'checkout_only', message: '決済の関数が無いため Checkout を返す', checkoutUrl: r.url };
}

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
  let result: AnnualQuoteResult;
  try {
    result = await quoteAnnual(db, env, friend.line_user_id);
  } catch (err) {
    console.error('[annual-prepay-line] quote failed', friend.line_user_id, err);
    result = { ok: false, reason: 'error', message: String(err) };
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

  let result: AnnualChargeResult;
  try {
    result = await chargeAnnual(db, env, friend.line_user_id);
  } catch (err) {
    console.error('[annual-prepay-line] charge failed', friend.line_user_id, err);
    result = { ok: false, reason: 'error', message: String(err) };
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
