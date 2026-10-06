import { describe, it, expect, vi } from 'vitest';

vi.mock('@line-crm/db', () => ({ jstNow: () => '2026-09-13T12:00:00.000+09:00' }));

const uid = (n: string) => 'U' + n.padStart(32, '0');
type Write = { sql: string; args: unknown[] };

function makeDb() {
  const writes: Write[] = [];
  const stmtFor = (sql: string, args: unknown[]) => ({ sql, args });
  const db = {
    prepare(sql: string) {
      return { ...stmtFor(sql, []), bind: (...args: unknown[]) => stmtFor(sql, args) };
    },
    batch: async (stmts: Write[]) => {
      for (const s of stmts) writes.push({ sql: s.sql, args: s.args });
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  } as unknown as D1Database;
  return { db, writes };
}

const { upsertFeatureFlags } = await import('./customer-sync.js');

describe('upsertFeatureFlags（#261 案 A）', () => {
  it('legacy-keywords・trial-promo・在庫お試しボタン・決済時の再計算が使う UPSERT も固定の行を更新しない', async () => {
    for (const source of ['plan', 'promo', 'clear', 'worker']) {
      const { db, writes } = makeDb();
      await upsertFeatureFlags(db, uid('1'), { InventorySheet: '1', AutoMultiChannel: 'メルカリ' }, source);
      expect(writes).toHaveLength(2);
      for (const w of writes) {
        expect(w.args[3]).toBe(source);
        expect(w.sql.replace(/\s+/g, ' ')).toMatch(/WHERE furim_feature_flags\.locked = 0$/);
      }
    }
  });
});
