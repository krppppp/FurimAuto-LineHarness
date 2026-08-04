import { jstNow, toJstString } from './utils.js';
// Stripe決済連携クエリヘルパー

export interface StripeEventRow {
  id: string;
  stripe_event_id: string;
  event_type: string;
  friend_id: string | null;
  amount: number | null;
  currency: string | null;
  metadata: string | null;
  processed_at: string;
  payload: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  last_attempt_at: string | null;
  completed_at: string | null;
}

export async function getStripeEvents(db: D1Database, opts: { friendId?: string; eventType?: string; limit?: number } = {}): Promise<StripeEventRow[]> {
  const limit = opts.limit ?? 100;
  if (opts.friendId) {
    const result = await db.prepare(`SELECT * FROM stripe_events WHERE friend_id = ? ORDER BY processed_at DESC LIMIT ?`)
      .bind(opts.friendId, limit).all<StripeEventRow>();
    return result.results;
  }
  if (opts.eventType) {
    const result = await db.prepare(`SELECT * FROM stripe_events WHERE event_type = ? ORDER BY processed_at DESC LIMIT ?`)
      .bind(opts.eventType, limit).all<StripeEventRow>();
    return result.results;
  }
  const result = await db.prepare(`SELECT * FROM stripe_events ORDER BY processed_at DESC LIMIT ?`)
    .bind(limit).all<StripeEventRow>();
  return result.results;
}

export async function getStripeEventByStripeId(db: D1Database, stripeEventId: string): Promise<StripeEventRow | null> {
  return db.prepare(`SELECT * FROM stripe_events WHERE stripe_event_id = ?`).bind(stripeEventId).first<StripeEventRow>();
}

export async function createStripeEvent(
  db: D1Database,
  input: { stripeEventId: string; eventType: string; friendId?: string; amount?: number; currency?: string; metadata?: string; payload?: string; status?: 'pending' | 'completed' },
): Promise<StripeEventRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db.prepare(`INSERT INTO stripe_events (id, stripe_event_id, event_type, friend_id, amount, currency, metadata, processed_at, payload, status, attempts, last_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.stripeEventId, input.eventType, input.friendId ?? null, input.amount ?? null, input.currency ?? null, input.metadata ?? null, now, input.payload ?? null, input.status ?? 'completed', input.status === 'pending' ? 1 : 0, input.status === 'pending' ? now : null).run();
  return (await db.prepare(`SELECT * FROM stripe_events WHERE id = ?`).bind(id).first<StripeEventRow>())!;
}

/**
 * cron再処理対象: pendingのまま一定時間経過したイベント。
 * waitUntil打ち切りで途中死した場合は completed マークが打たれずここに残る。
 */
export async function getStalePendingStripeEvents(
  db: D1Database,
  opts: { staleMinutes: number; maxAttempts: number; limit?: number },
): Promise<StripeEventRow[]> {
  const cutoff = toJstString(new Date(Date.now() - opts.staleMinutes * 60_000));
  const result = await db.prepare(
    `SELECT * FROM stripe_events WHERE status = 'pending' AND attempts < ? AND (last_attempt_at IS NULL OR last_attempt_at < ?) ORDER BY processed_at LIMIT ?`,
  ).bind(opts.maxAttempts, cutoff, opts.limit ?? 10).all<StripeEventRow>();
  return result.results;
}

/**
 * 再処理の排他クレーム。attempts をインクリメントし last_attempt_at を更新する。
 * 別のcron tickが先にクレームしていた場合は false（changes=0）。
 */
export async function claimStripeEventForRetry(db: D1Database, id: string, prevAttempts: number): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE stripe_events SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ? AND status = 'pending' AND attempts = ?`,
  ).bind(jstNow(), id, prevAttempts).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function markStripeEventCompleted(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE stripe_events SET status = 'completed', completed_at = ?, last_error = NULL WHERE id = ?`)
    .bind(jstNow(), id).run();
}

/** 処理失敗を記録。keepPending=trueならcron再処理対象のまま残す。 */
export async function markStripeEventFailed(db: D1Database, id: string, error: string, keepPending: boolean): Promise<void> {
  await db.prepare(`UPDATE stripe_events SET status = ?, last_error = ? WHERE id = ?`)
    .bind(keepPending ? 'pending' : 'failed', error.slice(0, 500), id).run();
}

/**
 * 冪等: この (stripe_event_id, action_key) が既に成功記録済みか。
 * cron再処理で「実行済みアクション」を判定し、非冪等なGAS書き込み等の二重実行を防ぐ。
 */
export async function hasProcessedStripeAction(
  db: D1Database,
  stripeEventId: string,
  actionKey: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 FROM stripe_processed_actions WHERE stripe_event_id = ? AND action_key = ? LIMIT 1`)
    .bind(stripeEventId, actionKey)
    .first();
  return !!row;
}

/** アクション成功を記録（成功時のみ呼ぶ）。既存なら何もしない。 */
export async function markStripeActionProcessed(
  db: D1Database,
  stripeEventId: string,
  actionKey: string,
): Promise<void> {
  await db
    .prepare(`INSERT OR IGNORE INTO stripe_processed_actions (stripe_event_id, action_key) VALUES (?, ?)`)
    .bind(stripeEventId, actionKey)
    .run();
}
