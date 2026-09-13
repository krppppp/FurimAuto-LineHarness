// コピー出品チケットの台帳（furim_ticket_ledger）と残数（furim_customers.copy_tickets）を 1 batch で動かす。
// 段階2.5（Capsec #250・#254）から残数は D1 が正: 拡張の消費（/api/ext/v1/copy-credit と、旧拡張の
// GAS updateCopyCredit → /api/furim/ticket-consumed）・付与（Free30 / 解説見た +100 / プレミアム +200 / 購入）
// はすべてここを通る。idempotency_key の UNIQUE で再送・二重経路の二重計上を防ぐ。
import { jstNow } from '@line-crm/db';
import { invalidateExtCache, type ExtCache } from './ext-auth.js';

export type TicketDeltaInput = {
  delta: number;
  reason: string;            // 'consume' | 'purchase' | 'premium_monthly' | 'free30' | 'extend_keyword' | 'manual' ...
  idempotencyKey: string;
  sourceUrl?: string | null;
  targetUrl?: string | null;
  invoiceId?: string | null;
  paymentIntentId?: string | null;
};

export type TicketDeltaResult = { applied: boolean; copyTickets: number };

/** 台帳に 1 行（UNIQUE で冪等）→ 残数を MAX(0, 残+delta) に更新 → KV を無効化。返り値は更新後の残数 */
export async function applyTicketDelta(
  db: D1Database,
  kv: ExtCache | undefined,
  customer: { line_user_id: string; key_code: string | null },
  input: TicketDeltaInput,
): Promise<TicketDeltaResult> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const delta = Math.trunc(input.delta);
  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO furim_ticket_ledger (id, line_user_id, delta, reason, idempotency_key, payment_intent_id, invoice_id, source_url, target_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, customer.line_user_id, delta, input.reason, input.idempotencyKey, input.paymentIntentId ?? null, input.invoiceId ?? null, input.sourceUrl ?? null, input.targetUrl ?? null, now),
    db
      .prepare(
        `UPDATE furim_customers SET copy_tickets = MAX(0, COALESCE(copy_tickets, 0) + ?), updated_at = ?
         WHERE line_user_id = ? AND EXISTS (SELECT 1 FROM furim_ticket_ledger WHERE id = ?)`,
      )
      .bind(delta, now, customer.line_user_id, id),
  ]);
  const applied = (results[0]?.meta?.changes ?? 0) > 0;
  const row = await db.prepare('SELECT copy_tickets FROM furim_customers WHERE line_user_id = ?').bind(customer.line_user_id).first<{ copy_tickets: number | null }>();
  await invalidateExtCache(kv, customer.key_code);
  return { applied, copyTickets: Number(row?.copy_tickets ?? 0) || 0 };
}
