// D1 furim_feature_flags への機能フラグの書き込み。
// 顧客マスター（スプレッドシート）との初期投入・差分検知は、シートと CRM の GAS の廃止で外した（TB-940）
import { jstNow } from '@line-crm/db';

function buildFeatureFlagUpserts(db: D1Database, lineUserId: string, flags: Record<string, string>, now: string, source: string): D1PreparedStatement[] {
  return Object.entries(flags).map(([key, value]) =>
    db
      .prepare(
        `INSERT INTO furim_feature_flags (line_user_id, feature_key, value, source, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(line_user_id, feature_key) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at
         WHERE furim_feature_flags.locked = 0`,
      )
      .bind(lineUserId, key, value, source, now),
  );
}

/** Worker が値を決めて書く機能フラグ（在庫管理シート無料お試しなど） */
export async function upsertFeatureFlags(db: D1Database, lineUserId: string, flags: Record<string, string>, source = 'worker'): Promise<void> {
  const stmts = buildFeatureFlagUpserts(db, lineUserId, flags, jstNow(), source);
  if (stmts.length) await db.batch(stmts);
}
