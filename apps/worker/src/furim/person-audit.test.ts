import { describe, expect, it } from 'vitest';
import { getAdminTable } from './admin-schema.js';
import { AUDIT_COUPONS, AUDIT_FRIEND_TAGS, listPersonAudit, recordFriendTagAudit, recordPersonAudit } from './person-audit.js';

type Call = { sql: string; binds: unknown[] };

function makeDb(opts: { auditRows?: Array<Record<string, unknown>>; friendLine?: string | null; tagName?: string } = {}) {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind: (...binds: unknown[]) => {
          calls.push({ sql, binds });
          return {
            run: async () => ({ success: true }),
            first: async () => {
              if (/FROM friends/.test(sql)) return opts.friendLine === undefined ? { line_user_id: 'U1' } : opts.friendLine === null ? null : { line_user_id: opts.friendLine };
              if (/FROM tags/.test(sql)) return { name: opts.tagName ?? '有料会員' };
              return null;
            },
            all: async () => ({ results: opts.auditRows ?? [] }),
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

const staff = { id: 's1', name: 'くろ' };
const inserts = (calls: Call[]) => calls.filter((c) => c.sql.includes('INSERT INTO furim_admin_audit'));

describe('1 人分の変更履歴（Capsec #308）', () => {
  it('タグは状態が変わったときだけ、その人の line_user_id で残す', async () => {
    const added = makeDb();
    await recordFriendTagAudit(added.db, staff, 'f1', 't1', 'add', false);
    const [row] = inserts(added.calls);
    expect(row.binds.slice(1, 8)).toEqual(['s1', 'くろ', AUDIT_FRIEND_TAGS, 'U1', 'tag', null, '有料会員']);

    const removed = makeDb();
    await recordFriendTagAudit(removed.db, staff, 'f1', 't1', 'remove', true);
    expect(inserts(removed.calls)[0].binds.slice(5, 8)).toEqual(['tag', '有料会員', null]);

    const noop = makeDb();
    await recordFriendTagAudit(noop.db, staff, 'f1', 't1', 'add', true);
    await recordFriendTagAudit(noop.db, staff, 'f1', 't1', 'remove', false);
    expect(noop.calls).toEqual([]);
  });

  it('記録の書き込みが失敗しても例外を投げない（操作そのものは成功させる）', async () => {
    const db = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error('D1 down'); } }) }) } as unknown as D1Database;
    await expect(
      recordPersonAudit(db, staff, { tableName: AUDIT_COUPONS, lineUserId: 'U1', column: 'coupon', oldValue: null, newValue: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('顧客データ・機能フラグ・タグ・クーポンを 1 本の新しい順で引き、日本語の見出しを付ける', async () => {
    const { db, calls } = makeDb({
      auditRows: [
        { id: 'a1', staff_name: 'くろ', table_name: 'furim_customers', row_id: 'U1', column_name: 'key_code', old_value: 'A', new_value: 'B', created_at: '2026-09-17T19:00:00.000+09:00' },
        { id: 'a2', staff_name: 'くろ', table_name: 'furim_feature_flags', row_id: 'U1|mercari_relist', column_name: 'locked', old_value: '0', new_value: '1', created_at: '2026-09-17T18:00:00.000+09:00' },
        { id: 'a3', staff_name: 'くろ', table_name: AUDIT_FRIEND_TAGS, row_id: 'U1', column_name: 'tag', old_value: null, new_value: '有料会員', created_at: '2026-09-17T17:00:00.000+09:00' },
        { id: 'a4', staff_name: 'くろ', table_name: AUDIT_COUPONS, row_id: 'U1', column_name: 'coupon', old_value: null, new_value: '10%オフ（c1）', created_at: '2026-09-17T16:00:00.000+09:00' },
      ],
    });
    const items = await listPersonAudit(db, 'U1', 5, async () => new Map([['mercari_relist', 'メルカリ・再出品']]));
    expect(items.map((i) => i.label)).toEqual(['顧客データ・キーコード', '機能フラグ・メルカリ・再出品（固定）', 'タグ', 'クーポン']);
    expect(items[0]).not.toHaveProperty('row_id');
    const q = calls[0];
    expect(q.sql).toMatch(/ORDER BY substr\(replace\(created_at, ' ', 'T'\), 1, 23\) DESC/);
    expect(q.binds).toEqual(['furim_customers', AUDIT_FRIEND_TAGS, AUDIT_COUPONS, 'U1', 'furim_feature_flags', 'U1|%', 5]);
  });

  it('機能フラグが無ければ機能マスタを読まない', async () => {
    const { db } = makeDb({ auditRows: [] });
    let loaded = false;
    await listPersonAudit(db, 'U1', 5, async () => {
      loaded = true;
      return new Map();
    });
    expect(loaded).toBe(false);
  });

  it('顧客データでは、キーコード・Stripe 顧客 ID・サブスク ID を保存前に確認する列として持つ', () => {
    expect(getAdminTable('furim_customers')?.confirmColumns).toEqual(['stripe_customer_id', 'subscription_id', 'key_code']);
  });
});
