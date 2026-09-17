import { jstNow } from '@line-crm/db';
import { columnLabel, getAdminTable } from './admin-schema.js';

/**
 * 1 人分の変更履歴（Capsec #308・2026-09-17 くろさん OK）。
 * 個別チャットの顧客パネルの下に、その人の直近の変更（顧客データ・機能フラグ・タグ・クーポン）を並べる。
 *
 * - 顧客データ（furim_customers）と機能フラグ（furim_feature_flags）は既存の管理 API が furim_admin_audit に書いている
 * - タグ（friends.ts の付け外し）とクーポン（furim-coupons.ts の付与・削除）は、ここの recordPersonAudit で同じ表に書く。
 *   table_name は friend_tags / coupons、row_id はその人の line_user_id（1 人分を row_id で引けるように）
 */

export const AUDIT_FRIEND_TAGS = 'friend_tags';
export const AUDIT_COUPONS = 'coupons';

type Staff = { id: string; name: string };

export async function recordPersonAudit(
  db: D1Database,
  staff: Staff | undefined,
  entry: { tableName: string; lineUserId: string; column: string; oldValue: string | null; newValue: string | null },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO furim_admin_audit (id, staff_id, staff_name, table_name, row_id, column_name, old_value, new_value, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        staff?.id ?? '',
        staff?.name ?? '(不明)',
        entry.tableName,
        entry.lineUserId,
        entry.column,
        entry.oldValue,
        entry.newValue,
        jstNow(),
      )
      .run();
  } catch (e) {
    // 記録に失敗しても操作そのものは成功させる
    console.error(`[furim/person-audit] ${entry.tableName} ${entry.lineUserId} の記録に失敗:`, e);
  }
}

/** タグの付け外しの前に呼ぶ: そのタグが今付いているか */
export async function friendHasTag(db: D1Database, friendId: string, tagId: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS x FROM friend_tags WHERE friend_id = ? AND tag_id = ?').bind(friendId, tagId).first();
  return Boolean(row);
}

/** friends.ts のタグの付け外しのあとに呼ぶ（upstream への注入は 1 行ずつ）。状態が変わった時だけ残す */
export async function recordFriendTagAudit(
  db: D1Database,
  staff: Staff | undefined,
  friendId: string,
  tagId: string,
  action: 'add' | 'remove',
  hadBefore: boolean,
): Promise<void> {
  if ((action === 'add') === hadBefore) return;
  try {
    const [friend, tag] = await Promise.all([
      db.prepare('SELECT line_user_id FROM friends WHERE id = ?').bind(friendId).first<{ line_user_id: string | null }>(),
      db.prepare('SELECT name FROM tags WHERE id = ?').bind(tagId).first<{ name: string | null }>(),
    ]);
    if (!friend?.line_user_id) return;
    const name = tag?.name ?? tagId;
    await recordPersonAudit(db, staff, {
      tableName: AUDIT_FRIEND_TAGS,
      lineUserId: friend.line_user_id,
      column: 'tag',
      oldValue: action === 'remove' ? name : null,
      newValue: action === 'add' ? name : null,
    });
  } catch (e) {
    console.error(`[furim/person-audit] タグの記録に失敗（${friendId}/${tagId}）:`, e);
  }
}

export type PersonAuditItem = {
  id: string;
  staff_name: string;
  table_name: string;
  column_name: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
  /** 「顧客データ・キーコード」「機能フラグ・○○」「タグ」「クーポン」 */
  label: string;
};

const FEATURE_FLAGS_TABLE = 'furim_feature_flags';
const CUSTOMERS_TABLE = 'furim_customers';

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** featureLabels: 機能フラグの feature_key → 見出し（routes/furim-admin.ts の loadFeatureColumns を渡す） */
export async function listPersonAudit(
  db: D1Database,
  lineUserId: string,
  limit: number,
  featureLabels: () => Promise<Map<string, string>>,
): Promise<PersonAuditItem[]> {
  // 機能フラグの row_id は「line_user_id|feature_key」（rowIdOf の複合主キー・各値は encodeURIComponent）
  const flagPrefix = `${escapeLike(encodeURIComponent(lineUserId))}|%`;
  const rows = await db
    .prepare(
      `SELECT id, staff_name, table_name, row_id, column_name, old_value, new_value, created_at
       FROM furim_admin_audit
       WHERE (table_name IN (?, ?, ?) AND row_id = ?)
          OR (table_name = ? AND row_id LIKE ? ESCAPE '\\')
       ORDER BY substr(replace(created_at, ' ', 'T'), 1, 23) DESC
       LIMIT ?`,
    )
    .bind(CUSTOMERS_TABLE, AUDIT_FRIEND_TAGS, AUDIT_COUPONS, lineUserId, FEATURE_FLAGS_TABLE, flagPrefix, limit)
    .all<PersonAuditItem & { row_id: string }>();
  const results = rows.results ?? [];

  const customers = getAdminTable(CUSTOMERS_TABLE);
  const features = results.some((r) => r.table_name === FEATURE_FLAGS_TABLE) ? await featureLabels() : new Map<string, string>();

  return results.map(({ row_id, ...r }) => {
    let label: string;
    if (r.table_name === AUDIT_FRIEND_TAGS) label = 'タグ';
    else if (r.table_name === AUDIT_COUPONS) label = 'クーポン';
    else if (r.table_name === FEATURE_FLAGS_TABLE) {
      const featureKey = decodeURIComponent(row_id.split('|')[1] ?? '');
      const name = features.get(featureKey) ?? featureKey;
      label = `機能フラグ・${name}${r.column_name === 'locked' ? '（固定）' : ''}`;
    } else {
      const column = r.column_name === '(insert)' ? '行の追加' : r.column_name === '(delete)' ? '行の削除' : customers ? columnLabel(customers, r.column_name) : r.column_name;
      label = `顧客データ・${column}`;
    }
    return { ...r, label };
  });
}
