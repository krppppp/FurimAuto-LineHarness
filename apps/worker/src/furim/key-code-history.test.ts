import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// vite 5 は node:sqlite を組み込みと見なさず解決に失敗するので require で読む
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

let clock = 0;
vi.mock('@line-crm/db', () => ({ jstNow: () => `2026-10-08T10:00:${String(clock++).padStart(2, '0')}.000+09:00` }));

const { upsertFurimCustomer, clearFurimCustomerKeyCode } = await import('./customer-store.js');
const { findOwnerOfReplacedKeyCode } = await import('./key-code-history.js');

const migration = (name: string) => readFileSync(fileURLToPath(new URL(`../../../../packages/db/migrations/${name}`, import.meta.url).href), 'utf8');

/** node:sqlite を D1 の形に包む（トリガーを本物の SQLite で動かすため） */
function asD1(sqlite: DatabaseSync): D1Database {
  const prepare = (sql: string) => {
    const bound = (args: unknown[]) => ({
      run: async () => {
        const r = sqlite.prepare(sql).run(...(args as never[]));
        return { meta: { changes: Number(r.changes) } };
      },
      first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
    });
    return { bind: (...args: unknown[]) => bound(args), ...bound([]) };
  };
  return { prepare } as unknown as D1Database;
}

type HistoryRow = { line_user_id: string; key_code: string; reason: string; issued_at: string | null; replaced_at: string | null };

function setup(before?: (sqlite: DatabaseSync) => void) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(migration('068_furim_customers.sql'));
  sqlite.exec('ALTER TABLE furim_customers ADD COLUMN device_code TEXT'); // 071
  before?.(sqlite);
  sqlite.exec(migration('090_furim_key_code_history.sql'));
  const history = (lineUserId: string) =>
    sqlite.prepare('SELECT line_user_id, key_code, reason, issued_at, replaced_at FROM furim_key_code_history WHERE line_user_id = ? ORDER BY id').all(lineUserId) as unknown as HistoryRow[];
  return { sqlite, db: asD1(sqlite), history };
}

beforeEach(() => {
  clock = 0;
});

describe('furim_key_code_history（migration 090 のトリガー）', () => {
  it('新規発行で 1 行（issued）。キーコード以外の更新では増えない', async () => {
    const { db, history } = setup();
    await upsertFurimCustomer(db, 'U1', { key_code: '2weektrial_aaaa' });
    await upsertFurimCustomer(db, 'U1', { device_activated: 1 });
    await upsertFurimCustomer(db, 'U1', { key_code: '2weektrial_aaaa' });
    expect(history('U1')).toEqual([
      { line_user_id: 'U1', key_code: '2weektrial_aaaa', reason: 'issued', issued_at: '2026-10-08T10:00:00.000+09:00', replaced_at: null },
    ]);
  });

  it('プラン変更で置き換えると、前の行に置き換え日時が入り、新しい行（replaced）が増える', async () => {
    const { db, history } = setup();
    await upsertFurimCustomer(db, 'U1', { key_code: '2weektrial_aaaa' });
    await upsertFurimCustomer(db, 'U1', { key_code: 'pb_bbbb', key_code_issued: 1 });
    expect(history('U1')).toEqual([
      { line_user_id: 'U1', key_code: '2weektrial_aaaa', reason: 'issued', issued_at: '2026-10-08T10:00:00.000+09:00', replaced_at: '2026-10-08T10:00:01.000+09:00' },
      { line_user_id: 'U1', key_code: 'pb_bbbb', reason: 'replaced', issued_at: '2026-10-08T10:00:01.000+09:00', replaced_at: null },
    ]);
  });

  it('解約で消えたら置き換え日時だけ入る。再加入の発行は issued', async () => {
    const { db, history } = setup();
    await upsertFurimCustomer(db, 'U1', { key_code: 'pb_bbbb' });
    await clearFurimCustomerKeyCode(db, 'U1');
    await upsertFurimCustomer(db, 'U1', { key_code: 'pb_cccc' });
    expect(history('U1').map((r) => [r.key_code, r.reason, r.replaced_at])).toEqual([
      ['pb_bbbb', 'issued', '2026-10-08T10:00:01.000+09:00'],
      ['pb_cccc', 'issued', null],
    ]);
  });

  it('migration 時点のキーコードは backfill で 1 行（発行日時は不明なので NULL）。空の人は入れない', async () => {
    const { db, history } = setup((sqlite) => {
      sqlite.exec(`INSERT INTO furim_customers (line_user_id, key_code, created_at, updated_at) VALUES
        ('U1', 'pb_old', '2026-09-01', '2026-09-01'), ('U2', NULL, '2026-09-01', '2026-09-01'), ('U3', '', '2026-09-01', '2026-09-01')`);
    });
    expect(history('U1')).toEqual([{ line_user_id: 'U1', key_code: 'pb_old', reason: 'backfill', issued_at: null, replaced_at: null }]);
    expect(history('U2')).toEqual([]);
    expect(history('U3')).toEqual([]);
    await upsertFurimCustomer(db, 'U1', { key_code: 'pb_new' });
    expect(history('U1').map((r) => [r.key_code, r.reason, r.replaced_at])).toEqual([
      ['pb_old', 'backfill', '2026-10-08T10:00:00.000+09:00'],
      ['pb_new', 'replaced', null],
    ]);
  });
});

describe('findOwnerOfReplacedKeyCode', () => {
  it('置き換えられた古いキーコードなら持ち主を返す', async () => {
    const { db } = setup();
    await upsertFurimCustomer(db, 'U1', { key_code: '2weektrial_aaaa' });
    await upsertFurimCustomer(db, 'U1', { key_code: 'pb_bbbb' });
    expect(await findOwnerOfReplacedKeyCode(db, '2weektrial_aaaa')).toBe('U1');
  });

  it('いま使っているキーコード・履歴に無いキーコードは null', async () => {
    const { db } = setup();
    await upsertFurimCustomer(db, 'U1', { key_code: 'pb_bbbb' });
    expect(await findOwnerOfReplacedKeyCode(db, 'pb_bbbb')).toBeNull();
    expect(await findOwnerOfReplacedKeyCode(db, 'zzz')).toBeNull();
  });

  it('解約でキーコードが無い人の古いキーコードは null（「更新された」とは言わない）', async () => {
    const { db } = setup();
    await upsertFurimCustomer(db, 'U1', { key_code: 'pb_bbbb' });
    await clearFurimCustomerKeyCode(db, 'U1');
    expect(await findOwnerOfReplacedKeyCode(db, 'pb_bbbb')).toBeNull();
  });

  it('テーブルがまだ無い（migration 前）なら null', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(migration('068_furim_customers.sql'));
    expect(await findOwnerOfReplacedKeyCode(asD1(sqlite), 'pb_bbbb')).toBeNull();
  });
});
