import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMocks = {
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
  jstNow: () => '2026-09-14T00:30:00.000+09:00',
};
vi.mock('@line-crm/db', () => dbMocks);

const worker = (await import('../index.js')).default;

type Stmt = { sql: string; args: unknown[] };

function makeDb(opts: { firstRows?: Array<Record<string, unknown> | null>; allRows?: Record<string, unknown>[][]; batchThrows?: string } = {}) {
  const statements: Stmt[] = [];
  const batches: Stmt[][] = [];
  const firstRows = [...(opts.firstRows ?? [])];
  const allRows = [...(opts.allRows ?? [])];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const stmt = { sql, args };
          statements.push(stmt);
          return {
            ...stmt,
            first: async () => (firstRows.length ? firstRows.shift() : null),
            all: async () => ({ results: allRows.shift() ?? [] }),
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      };
    },
    batch: async (stmts: Stmt[]) => {
      batches.push(stmts);
      if (opts.batchThrows) throw new Error(opts.batchThrows);
      return [];
    },
  } as unknown as D1Database;
  return { db, statements, batches };
}

const OWNER_KEY = 'owner-key';
const STAFF_KEY = 'staff-key';

function envWith(db: D1Database) {
  return {
    DB: db,
    LINE_LOGIN_CHANNEL_ID: '2000000000',
    API_KEY: OWNER_KEY,
    WORKER_URL: 'https://worker.example.com',
  } as unknown as import('../index.js').Env['Bindings'];
}

function req(db: D1Database, method: string, path: string, body?: unknown, key = OWNER_KEY) {
  const headers = new Headers({ Authorization: `Bearer ${key}` });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return worker.fetch(
    new Request(`https://worker.example.com${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    envWith(db),
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
}

const CUSTOMER = {
  line_user_id: 'U1',
  stripe_customer_id: 'cus_1',
  key_code: 'ABC',
  key_code_issued: 1,
  device_activated: 0,
  copy_tickets: 3,
  plan_label: 'PBプラン',
  created_at: '2026-09-13 00:00:00',
  updated_at: '2026-09-13 00:00:00',
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getLineAccounts.mockResolvedValue([]);
  dbMocks.getStaffByApiKey.mockImplementation(async (_db: unknown, key: string) => {
    if (key === STAFF_KEY) return { id: 's1', name: 'スタッフ', role: 'staff' };
    return null;
  });
});

describe('GET /api/furim/admin/tables', () => {
  it('ホワイトリストのテーブルとスキーマを返す', async () => {
    const { db } = makeDb();
    const res = await req(db, 'GET', '/api/furim/admin/tables');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Array<{ name: string; pk: string; columns: Array<{ name: string; editable: boolean }> }> };
    const names = body.data.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['furim_customers', 'furim_payments', 'furim_referrals', 'affiliates']));
    const customers = body.data.find((t) => t.name === 'furim_customers')!;
    expect(customers.pk).toBe('line_user_id');
    expect(customers.columns.find((c) => c.name === 'line_user_id')!.editable).toBe(false);
    expect(customers.columns.find((c) => c.name === 'key_code')!.editable).toBe(true);
  });

  it('認証なしは 401', async () => {
    const { db } = makeDb();
    const res = await worker.fetch(
      new Request('https://worker.example.com/api/furim/admin/tables'),
      envWith(db),
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /api/furim/admin/:table', () => {
  it('未許可テーブルは 404（SQL を発行しない）', async () => {
    const { db, statements } = makeDb();
    const res = await req(db, 'GET', '/api/furim/admin/staff');
    expect(res.status).toBe(404);
    expect(statements).toHaveLength(0);
  });

  it('q は検索可能列の LIKE、limit+1 で nextCursor を出す', async () => {
    const { db, statements } = makeDb({
      firstRows: [{ n: 3 }],
      allRows: [[{ line_user_id: 'U1' }, { line_user_id: 'U2' }, { line_user_id: 'U3' }]],
    });
    const res = await req(db, 'GET', '/api/furim/admin/furim_customers?q=cus_&limit=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: { total: number; nextCursor: string | null } };
    expect(body.data).toHaveLength(2);
    expect(body.meta.total).toBe(3);
    expect(body.meta.nextCursor).toBe('2');
    const select = statements.find((s) => s.sql.startsWith('SELECT * FROM furim_customers'))!;
    expect(select.sql).toContain('stripe_customer_id LIKE ?');
    expect(select.sql).toContain('key_code LIKE ?');
    expect(select.sql).toContain('ORDER BY updated_at DESC');
    expect(select.args).toContain('%cus_%');
    expect(select.args.slice(-2)).toEqual([3, 0]);
  });
});

describe('GET /api/furim/admin/:table/:id', () => {
  it('行が無ければ 404', async () => {
    const { db } = makeDb({ firstRows: [null] });
    const res = await req(db, 'GET', '/api/furim/admin/furim_customers/U9');
    expect(res.status).toBe(404);
  });

  it('1 行を返す', async () => {
    const { db, statements } = makeDb({ firstRows: [CUSTOMER] });
    const res = await req(db, 'GET', '/api/furim/admin/furim_customers/U1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { key_code: string } };
    expect(body.data.key_code).toBe('ABC');
    expect(statements[0].sql).toBe('SELECT * FROM furim_customers WHERE line_user_id = ?');
    expect(statements[0].args).toEqual(['U1']);
  });
});

describe('PATCH /api/furim/admin/:table/:id', () => {
  it('編集可能列だけ UPDATE し、変更列ごとに監査ログを 1 行入れる', async () => {
    const { db, batches } = makeDb({ firstRows: [CUSTOMER, { ...CUSTOMER, key_code: 'XYZ', copy_tickets: 5 }] });
    const res = await req(db, 'PATCH', '/api/furim/admin/furim_customers/U1', {
      changes: { key_code: 'XYZ', copy_tickets: '5', plan_label: 'PBプラン' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { key_code: string }; meta: { changed: string[] } };
    expect(body.meta.changed).toEqual(['key_code', 'copy_tickets']);
    expect(body.data.key_code).toBe('XYZ');

    expect(batches).toHaveLength(1);
    const [update, ...audits] = batches[0];
    expect(update.sql).toBe('UPDATE furim_customers SET key_code = ?, copy_tickets = ?, updated_at = ? WHERE line_user_id = ?');
    expect(update.args).toEqual(['XYZ', 5, '2026-09-14T00:30:00.000+09:00', 'U1']);
    expect(audits).toHaveLength(2);
    expect(audits[0].sql).toContain('INSERT INTO furim_admin_audit');
    expect(audits[0].args.slice(1)).toEqual(['env-owner', 'Owner', 'furim_customers', 'U1', 'key_code', 'ABC', 'XYZ', '2026-09-14T00:30:00.000+09:00']);
    expect(audits[1].args.slice(4)).toEqual(['U1', 'copy_tickets', '3', '5', '2026-09-14T00:30:00.000+09:00']);
  });

  it('読み取り専用列・未知の列・型違いは 400 で何も書かない', async () => {
    for (const changes of [{ line_user_id: 'U2' }, { nope: 1 }, { copy_tickets: 'abc' }, { copy_tickets: 1.5 }]) {
      const { db, batches } = makeDb({ firstRows: [CUSTOMER] });
      const res = await req(db, 'PATCH', '/api/furim/admin/furim_customers/U1', { changes });
      expect(res.status).toBe(400);
      expect(batches).toHaveLength(0);
    }
  });

  it('変更なしなら UPDATE しない', async () => {
    const { db, batches } = makeDb({ firstRows: [CUSTOMER] });
    const res = await req(db, 'PATCH', '/api/furim/admin/furim_customers/U1', { changes: { key_code: 'ABC' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { changed: string[] } };
    expect(body.meta.changed).toEqual([]);
    expect(batches).toHaveLength(0);
  });

  it('updated_at の無いテーブルでは touch しない', async () => {
    const { db, batches } = makeDb({ firstRows: [{ id: 'r1', trial_extended_days: 0 }, { id: 'r1', trial_extended_days: 7 }] });
    const res = await req(db, 'PATCH', '/api/furim/admin/furim_referrals/r1', { changes: { trial_extended_days: 7 } });
    expect(res.status).toBe(200);
    expect(batches[0][0].sql).toBe('UPDATE furim_referrals SET trial_extended_days = ? WHERE id = ?');
  });

  it('staff ロールは 403', async () => {
    const { db, batches } = makeDb({ firstRows: [CUSTOMER] });
    const res = await req(db, 'PATCH', '/api/furim/admin/furim_customers/U1', { changes: { key_code: 'XYZ' } }, STAFF_KEY);
    expect(res.status).toBe(403);
    expect(batches).toHaveLength(0);
  });

  it('D1 の失敗は 400 でメッセージを返す', async () => {
    const { db } = makeDb({ firstRows: [{ id: 'a1', code: 'AAA' }], batchThrows: 'UNIQUE constraint failed: affiliates.code' });
    const res = await req(db, 'PATCH', '/api/furim/admin/affiliates/a1', { changes: { code: 'BBB' } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('UNIQUE constraint failed');
  });
});

describe('GET /api/furim/admin/:table/:id/audit', () => {
  it('その行の監査ログを返す', async () => {
    const { db, statements } = makeDb({ allRows: [[{ column_name: 'key_code', old_value: 'ABC', new_value: 'XYZ' }]] });
    const res = await req(db, 'GET', '/api/furim/admin/furim_customers/U1/audit');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ column_name: string }> };
    expect(body.data[0].column_name).toBe('key_code');
    expect(statements[0].args).toEqual(['furim_customers', 'U1']);
  });
});
