// コピー出品チケットの残数（furim_customers.copy_tickets）を記録行と 1 batch で動かす。
// 段階2.5（Capsec #250・#254）から残数は D1 が正。段階4-D（Capsec #258）から記録先を分けた:
// - 付与（Free30 / 解説見た +100 / プレミアム +200 / 購入）→ furim_ticket_ledger（applyTicketDelta）
// - 拡張の消費（/api/ext/v1/copy-credit と、旧拡張の GAS updateCopyCredit → /api/furim/ticket-consumed）
//   → furim_auto_copy_logs（applyTicketConsume）
// どちらも idempotency_key の UNIQUE で再送・二重経路の二重計上を防ぐ。
import { jstNow, toJstString } from '@line-crm/db';
import { invalidateExtCache, type ExtCache } from './ext-auth.js';

export type TicketDeltaInput = {
  delta: number;
  reason: string;            // 'consume' | 'purchase' | 'premium_monthly' | 'free30' | 'extend_keyword' | 'manual' ...
  idempotencyKey: string;
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
        `INSERT OR IGNORE INTO furim_ticket_ledger (id, line_user_id, delta, reason, idempotency_key, payment_intent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, customer.line_user_id, delta, input.reason, input.idempotencyKey, input.paymentIntentId ?? null, now),
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

export type TicketConsumeInput = {
  delta: number;
  dedupeKey: string;
  sourceUrl?: string | null;
  targetUrl?: string | null;
};

/** 自動コピー出品履歴に 1 行（consume:<dedupeKey> の UNIQUE で冪等）→ 残数を MAX(0, 残+delta) に更新 → KV を無効化 */
export async function applyTicketConsume(
  db: D1Database,
  kv: ExtCache | undefined,
  customer: { line_user_id: string; key_code: string | null },
  input: TicketConsumeInput,
): Promise<TicketDeltaResult> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const delta = Math.trunc(input.delta);
  const key = `consume:${input.dedupeKey}`;
  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO furim_auto_copy_logs (id, line_user_id, source_url, target_url, remaining_tickets, processed_at, imported_at, delta, idempotency_key)
         SELECT ?, ?, ?, ?, (SELECT MAX(0, COALESCE(copy_tickets, 0) + ?) FROM furim_customers WHERE line_user_id = ?), ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM furim_ticket_ledger WHERE idempotency_key = ?)`,
      )
      .bind(id, customer.line_user_id, input.sourceUrl ?? null, input.targetUrl ?? null, delta, customer.line_user_id, now, now, delta, key, key),
    db
      .prepare(
        `UPDATE furim_customers SET copy_tickets = MAX(0, COALESCE(copy_tickets, 0) + ?), updated_at = ?
         WHERE line_user_id = ? AND EXISTS (SELECT 1 FROM furim_auto_copy_logs WHERE id = ?)`,
      )
      .bind(delta, now, customer.line_user_id, id),
  ]);
  const applied = (results[0]?.meta?.changes ?? 0) > 0;
  const row = await db.prepare('SELECT copy_tickets FROM furim_customers WHERE line_user_id = ?').bind(customer.line_user_id).first<{ copy_tickets: number | null }>();
  await invalidateExtCache(kv, customer.key_code);
  return { applied, copyTickets: Number(row?.copy_tickets ?? 0) || 0 };
}

export const CONSUME_MATCH_WINDOW_MS = 120_000;

export type ConsumeLike = { line_user_id: string | null; source_url: string | null; target_url: string | null; at: string };

/** 冪等キーを持たない行どうしを同じ消費とみなす条件: コピー元/先 URL が同じ・処理日時が 2 分以内・line_user_id が食い違わない */
export function isSameConsume(a: ConsumeLike, b: ConsumeLike): boolean {
  if ((a.source_url ?? null) !== (b.source_url ?? null)) return false;
  if ((a.target_url ?? null) !== (b.target_url ?? null)) return false;
  if (a.line_user_id && b.line_user_id && a.line_user_id !== b.line_user_id) return false;
  const ta = Date.parse(a.at);
  const tb = Date.parse(b.at);
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) <= CONSUME_MATCH_WINDOW_MS;
}

type LedgerConsumeRow = { id: string; line_user_id: string; delta: number; idempotency_key: string; source_url: string | null; target_url: string | null; created_at: string };
type AutoCopyRow = { id: string; line_user_id: string | null; source_url: string | null; target_url: string | null; processed_at: string; idempotency_key: string | null };

export type MoveConsumeResult = {
  dryRun: boolean;
  ledgerConsumeBefore: number;
  ledgerConsumeAfter: number;
  autoCopyBefore: number;
  autoCopyAfter: number;
  merged: number;
  inserted: number;
  alreadyMoved: number;
  deleted: number;
  copyTicketsBefore: Record<string, number>;
  copyTicketsAfter: Record<string, number>;
  rows: Array<{ ledgerId: string; idempotencyKey: string; action: 'merge' | 'insert' | 'already'; autoCopyId: string }>;
};

async function countOf(db: D1Database, sql: string): Promise<number> {
  const r = await db.prepare(sql).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

async function copyTicketsOf(db: D1Database, userIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const u of userIds) {
    const r = await db.prepare('SELECT copy_tickets FROM furim_customers WHERE line_user_id = ?').bind(u).first<{ copy_tickets: number | null }>();
    out[u] = Number(r?.copy_tickets ?? 0) || 0;
  }
  return out;
}

/**
 * 台帳の consume 行を自動コピー出品履歴へ移して台帳から消す（段階4-D の一度きりの移行・冪等）。
 * シートから取り込み済みの同じ消費（冪等キー NULL・URL 同じ・2 分以内）があればその行にキーを付けて 1 行に寄せ、無ければ新しく入れる。
 * 残数（copy_tickets）は触らない。書き込みと削除は全行 1 batch
 */
export async function moveConsumeRowsToAutoCopyLogs(db: D1Database, opts: { dryRun: boolean; now?: string }): Promise<MoveConsumeResult> {
  const now = opts.now ?? jstNow();
  const ledger = (
    await db
      .prepare("SELECT id, line_user_id, delta, idempotency_key, NULL AS source_url, NULL AS target_url, created_at FROM furim_ticket_ledger WHERE reason = 'consume' ORDER BY created_at, id")
      .all<LedgerConsumeRow>()
  ).results ?? [];
  const ledgerConsumeBefore = ledger.length;
  const autoCopyBefore = await countOf(db, 'SELECT COUNT(*) AS n FROM furim_auto_copy_logs');
  const userIds = [...new Set(ledger.map((l) => l.line_user_id))];
  const copyTicketsBefore = await copyTicketsOf(db, userIds);
  const rows: MoveConsumeResult['rows'] = [];
  const stmts: D1PreparedStatement[] = [];
  if (ledger.length > 0) {
    const times = ledger.map((l) => Date.parse(l.created_at)).filter(Number.isFinite);
    const from = toJstString(new Date(Math.min(...times) - CONSUME_MATCH_WINDOW_MS));
    const to = toJstString(new Date(Math.max(...times) + CONSUME_MATCH_WINDOW_MS));
    const keys = ledger.map((l) => l.idempotency_key);
    const candidates = (
      await db
        .prepare(
          `SELECT id, line_user_id, source_url, target_url, processed_at, idempotency_key FROM furim_auto_copy_logs
           WHERE (processed_at >= ? AND processed_at <= ?) OR idempotency_key IN (${keys.map(() => '?').join(', ')})`,
        )
        .bind(from, to, ...keys)
        .all<AutoCopyRow>()
    ).results ?? [];
    const used = new Set<string>();
    for (const l of ledger) {
      const already = candidates.find((c) => c.idempotency_key === l.idempotency_key);
      if (already) {
        rows.push({ ledgerId: l.id, idempotencyKey: l.idempotency_key, action: 'already', autoCopyId: already.id });
      } else {
        const match = candidates.find(
          (c) => c.idempotency_key == null && !used.has(c.id) && isSameConsume({ ...l, at: l.created_at }, { ...c, at: c.processed_at }),
        );
        if (match) {
          used.add(match.id);
          rows.push({ ledgerId: l.id, idempotencyKey: l.idempotency_key, action: 'merge', autoCopyId: match.id });
          stmts.push(
            db
              .prepare('UPDATE furim_auto_copy_logs SET idempotency_key = ?, delta = ?, line_user_id = COALESCE(line_user_id, ?) WHERE id = ? AND idempotency_key IS NULL')
              .bind(l.idempotency_key, l.delta, l.line_user_id, match.id),
          );
        } else {
          rows.push({ ledgerId: l.id, idempotencyKey: l.idempotency_key, action: 'insert', autoCopyId: l.id });
          stmts.push(
            db
              .prepare(
                `INSERT OR IGNORE INTO furim_auto_copy_logs (id, line_user_id, source_url, target_url, remaining_tickets, processed_at, imported_at, delta, idempotency_key)
                 VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
              )
              .bind(l.id, l.line_user_id, l.source_url, l.target_url, l.created_at, now, l.delta, l.idempotency_key),
          );
        }
      }
      stmts.push(
        db
          .prepare("DELETE FROM furim_ticket_ledger WHERE id = ? AND reason = 'consume' AND EXISTS (SELECT 1 FROM furim_auto_copy_logs WHERE idempotency_key = ?)")
          .bind(l.id, l.idempotency_key),
      );
    }
  }
  const merged = rows.filter((r) => r.action === 'merge').length;
  const inserted = rows.filter((r) => r.action === 'insert').length;
  const alreadyMoved = rows.filter((r) => r.action === 'already').length;
  const base = { ledgerConsumeBefore, autoCopyBefore, merged, inserted, alreadyMoved, copyTicketsBefore, rows };
  if (opts.dryRun || stmts.length === 0) {
    return { dryRun: opts.dryRun, ...base, deleted: 0, ledgerConsumeAfter: ledgerConsumeBefore, autoCopyAfter: autoCopyBefore, copyTicketsAfter: copyTicketsBefore };
  }
  await db.batch(stmts);
  const ledgerConsumeAfter = await countOf(db, "SELECT COUNT(*) AS n FROM furim_ticket_ledger WHERE reason = 'consume'");
  const autoCopyAfter = await countOf(db, 'SELECT COUNT(*) AS n FROM furim_auto_copy_logs');
  const copyTicketsAfter = await copyTicketsOf(db, userIds);
  console.log('[furim/move-consume]', JSON.stringify({ ledgerConsumeBefore, ledgerConsumeAfter, autoCopyBefore, autoCopyAfter, merged, inserted, alreadyMoved }));
  return { dryRun: false, ...base, deleted: ledgerConsumeBefore - ledgerConsumeAfter, ledgerConsumeAfter, autoCopyAfter, copyTicketsAfter };
}
