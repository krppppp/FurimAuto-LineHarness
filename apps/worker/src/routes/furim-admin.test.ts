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

function makeDb(
  opts: {
    firstRows?: Array<Record<string, unknown> | null>;
    allRows?: Record<string, unknown>[][];
    batchRows?: Record<string, unknown>[][];
    batchThrows?: string;
  } = {},
) {
  const statements: Stmt[] = [];
  const batches: Stmt[][] = [];
  const firstRows = [...(opts.firstRows ?? [])];
  const allRows = [...(opts.allRows ?? [])];
  const batchRows = [...(opts.batchRows ?? [])];
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
      return stmts.map(() => ({ results: batchRows.shift() ?? [] }));
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

  it('071 のログ系テーブルは読み取り専用で入り、keys を持つ', async () => {
    const { db } = makeDb();
    const res = await req(db, 'GET', '/api/furim/admin/tables');
    const body = (await res.json()) as {
      data: Array<{ name: string; columns: Array<{ editable: boolean }>; keys: Array<{ column: string; kind: string }> }>;
    };
    for (const name of ['furim_execution_logs', 'furim_ext_errors', 'furim_free_accounts', 'furim_manual_copy_logs', 'furim_shop_research_logs']) {
      const t = body.data.find((x) => x.name === name)!;
      expect(t, name).toBeDefined();
      expect(t.columns.every((c) => !c.editable), name).toBe(true);
      expect(t.keys.length, name).toBeGreaterThan(0);
    }
    expect(body.data.find((x) => x.name === 'furim_referrals')!.keys).toEqual([
      { column: 'introduced_friend_id', kind: 'friend_id' },
      { column: 'ambassador_friend_id', kind: 'friend_id' },
    ]);
    expect(body.data.find((x) => x.name === 'furim_coupons')!.keys).toEqual([]);
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
      allRows: [[{ invoice_id: 'in_1', line_user_id: 'U1' }, { invoice_id: 'in_2', line_user_id: 'U2' }, { invoice_id: 'in_3', line_user_id: 'U3' }]],
    });
    const res = await req(db, 'GET', '/api/furim/admin/furim_payments?q=cus_&limit=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: { total: number; nextCursor: string | null } };
    expect(body.data).toHaveLength(2);
    expect(body.meta.total).toBe(3);
    expect(body.meta.nextCursor).toBe('2');
    const select = statements.find((s) => s.sql.startsWith('SELECT * FROM furim_payments'))!;
    expect(select.sql).toContain('stripe_customer_id LIKE ?');
    expect(select.sql).toContain('plan_name LIKE ?');
    expect(select.sql).toContain('ORDER BY paid_at DESC');
    expect(select.args).toContain('%cus_%');
    expect(select.args.slice(-2)).toEqual([3, 0]);
  });

  it('顧客は friends を LEFT JOIN して友だち登録の新しい順・全件（limit/cursor を無視）', async () => {
    const { db, statements } = makeDb({
      firstRows: [{ n: 2 }],
      allRows: [
        [{ line_user_id: 'U1', _friend_created_at: '2026-09-14T07:00:00' }, { line_user_id: 'U2', _friend_created_at: null }],
        [{ id: 'f1', line_user_id: 'U1', display_name: 'たろう' }],
      ],
    });
    const res = await req(db, 'GET', '/api/furim/admin/furim_customers?q=cus_&limit=2&cursor=50');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ _friend_created_at: string | null; _display_name: string | null }>;
      meta: { total: number; limit: number; cursor: string; nextCursor: string | null; table: { joinFriends: boolean; allRows: boolean } };
    };
    expect(body.data.map((r) => r._friend_created_at)).toEqual(['2026-09-14T07:00:00', null]);
    expect(body.data[0]._display_name).toBe('たろう');
    expect(body.meta).toMatchObject({ total: 2, limit: 10000, cursor: '0', nextCursor: null });
    expect(body.meta.table.joinFriends).toBe(true);
    expect(body.meta.table.allRows).toBe(true);
    const count = statements[0];
    expect(count.sql).toBe('SELECT COUNT(*) AS n FROM furim_customers t LEFT JOIN friends f ON f.line_user_id = t.line_user_id WHERE t.line_user_id LIKE ? OR t.stripe_customer_id LIKE ? OR t.mercari_url LIKE ? OR t.shops_url LIKE ? OR t.rakuma_url LIKE ? OR t.yahoo_flea_url LIKE ? OR t.plan_label LIKE ? OR t.subscription_id LIKE ? OR t.key_code LIKE ?');
    const select = statements[1];
    expect(select.sql).toContain('SELECT t.*, f.created_at AS _friend_created_at FROM furim_customers t LEFT JOIN friends f ON f.line_user_id = t.line_user_id WHERE');
    expect(select.sql).toContain('ORDER BY f.created_at DESC, t.line_user_id LIMIT ? OFFSET ?');
    expect(select.args.slice(-2)).toEqual([10001, 0]);
  });

  it('他のテーブルは JOIN せず limit/cursor がそのまま効く', async () => {
    const { db, statements } = makeDb({ firstRows: [{ n: 0 }] });
    const res = await req(db, 'GET', '/api/furim/admin/furim_ticket_ledger?limit=10&cursor=20');
    const body = (await res.json()) as { meta: { limit: number; cursor: string; table: { joinFriends: boolean; allRows: boolean } } };
    expect(body.meta).toMatchObject({ limit: 10, cursor: '20' });
    expect(body.meta.table).toMatchObject({ joinFriends: false, allRows: false });
    expect(statements[1].sql).toBe('SELECT * FROM furim_ticket_ledger ORDER BY created_at DESC, id LIMIT ? OFFSET ?');
    expect(statements[1].args).toEqual([11, 20]);
  });
});

describe('_display_name の付与', () => {
  it('line_user_id 列から friends を 1 回の IN クエリで引き、解決できない行は null', async () => {
    const { db, statements } = makeDb({
      firstRows: [{ n: 2 }],
      allRows: [
        [{ id: 't1', line_user_id: 'U1' }, { id: 't2', line_user_id: 'U2' }, { id: 't3', line_user_id: null }],
        [{ id: 'f1', line_user_id: 'U1', display_name: 'たろう' }],
      ],
    });
    const res = await req(db, 'GET', '/api/furim/admin/furim_ticket_ledger');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; _display_name: string | null }> };
    expect(body.data.map((r) => r._display_name)).toEqual(['たろう', null, null]);
    const friends = statements.filter((s) => s.sql.includes('FROM friends'));
    expect(friends).toHaveLength(1);
    expect(friends[0].sql).toBe('SELECT id, line_user_id, display_name FROM friends WHERE line_user_id IN (?,?)');
    expect(friends[0].args).toEqual(['U1', 'U2']);
    expect(statements.some((s) => s.sql.includes('FROM furim_customers'))).toBe(false);
  });

  it('key_code しか無いテーブルは furim_customers → friends の順で解決する', async () => {
    const { db, statements } = makeDb({
      firstRows: [{ n: 1 }],
      allRows: [
        [{ install_id: 'i1', key_code: 'KEY1' }, { install_id: 'i2', key_code: 'KEY2' }],
        [{ line_user_id: 'U1', stripe_customer_id: 'cus_1', key_code: 'KEY1' }],
        [{ id: 'f1', line_user_id: 'U1', display_name: 'はなこ' }],
      ],
    });
    const res = await req(db, 'GET', '/api/furim/admin/furim_free_accounts');
    const body = (await res.json()) as { data: Array<{ _display_name: string | null }> };
    expect(body.data.map((r) => r._display_name)).toEqual(['はなこ', null]);
    const customers = statements.find((s) => s.sql.includes('FROM furim_customers WHERE key_code IN'))!;
    expect(customers.args).toEqual(['KEY1', 'KEY2']);
    const friends = statements.find((s) => s.sql.includes('FROM friends'))!;
    expect(friends.sql).toContain('WHERE line_user_id IN (?)');
    expect(friends.args).toEqual(['U1']);
  });

  it('friend_id（affiliates.friend_id）は friends.id で直接引く', async () => {
    const { db, statements } = makeDb({
      firstRows: [{ n: 1 }],
      allRows: [[{ id: 'a1', code: 'AAA', friend_id: 'f9' }], [{ id: 'f9', line_user_id: 'U9', display_name: 'アンバ' }]],
    });
    const res = await req(db, 'GET', '/api/furim/admin/affiliates');
    const body = (await res.json()) as { data: Array<{ _display_name: string | null }> };
    expect(body.data[0]._display_name).toBe('アンバ');
    const friends = statements.find((s) => s.sql.includes('FROM friends'))!;
    expect(friends.sql).toContain('WHERE id IN (?)');
    expect(friends.args).toEqual(['f9']);
  });

  it('1 行取得にも付く', async () => {
    const { db } = makeDb({ firstRows: [CUSTOMER], allRows: [[{ id: 'f1', line_user_id: 'U1', display_name: 'たろう' }]] });
    const res = await req(db, 'GET', '/api/furim/admin/furim_customers/U1');
    const body = (await res.json()) as { data: { _display_name: string | null } };
    expect(body.data._display_name).toBe('たろう');
  });
});

describe('GET /api/furim/admin/:table/:id/related', () => {
  it('顧客行から本人を特定し、keys のある全テーブルを batch 1 回で数える（自分の行は除外）', async () => {
    const { db, batches, statements } = makeDb({
      firstRows: [CUSTOMER, { id: 'f1', line_user_id: 'U1', display_name: 'たろう' }],
      batchRows: [
        [{ n: 0 }], [],                                   // furim_customers（自分以外）
        [{ n: 2 }], [{ invoice_id: 'in_1', line_user_id: 'U1' }, { invoice_id: 'in_2', line_user_id: 'U1' }], // furim_payments
      ],
      allRows: [[{ id: 'f1', line_user_id: 'U1', display_name: 'たろう' }]],
    });
    const res = await req(db, 'GET', '/api/furim/admin/furim_customers/U1/related');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        identity: Record<string, string | null>;
        related: Array<{ table: { name: string }; total: number; rows: Array<Record<string, unknown>>; q: string }>;
      };
    };
    expect(body.data.identity).toEqual({ line_user_id: 'U1', friend_id: 'f1', display_name: 'たろう', stripe_customer_id: 'cus_1', key_code: 'ABC' });

    const names = body.data.related.map((r) => r.table.name);
    expect(names).toEqual([
      'furim_customers', 'furim_payments', 'furim_ticket_ledger', 'furim_cancellations', 'furim_referrals', 'affiliates',
      'furim_execution_logs', 'furim_ext_errors', 'furim_free_accounts', 'furim_manual_copy_logs', 'furim_shop_research_logs',
      'furim_auto_copy_logs', 'furim_survey_answers', 'furim_coupon_applications', 'furim_referral_cashbacks',
      'furim_feature_flags',
    ]);
    const payments = body.data.related[1];
    expect(payments.total).toBe(2);
    expect(payments.rows).toHaveLength(2);
    expect(payments.rows[0]._display_name).toBe('たろう');
    expect(payments.q).toBe('U1');
    expect(body.data.related[0].total).toBe(0);
    expect(body.data.related.find((r) => r.table.name === 'furim_free_accounts')!.q).toBe('ABC');

    expect(batches).toHaveLength(1);
    const stmts = batches[0];
    expect(stmts).toHaveLength(32);
    expect(stmts[0].sql).toBe('SELECT COUNT(*) AS n FROM furim_customers WHERE (line_user_id = ? OR stripe_customer_id = ? OR key_code = ?) AND NOT (line_user_id = ?)');
    expect(stmts[0].args).toEqual(['U1', 'cus_1', 'ABC', 'U1']);
    expect(stmts[3].sql).toBe('SELECT * FROM furim_payments WHERE (line_user_id = ? OR stripe_customer_id = ?) ORDER BY paid_at DESC, invoice_id LIMIT ?');
    expect(stmts[3].args).toEqual(['U1', 'cus_1', 20]);
    const referrals = stmts.find((s) => s.sql.startsWith('SELECT COUNT(*) AS n FROM furim_referrals'))!;
    expect(referrals.sql).toContain('(introduced_friend_id = ? OR ambassador_friend_id = ?)');
    expect(referrals.args).toEqual(['f1', 'f1']);
    expect(stmts.some((s) => s.sql.includes('furim_coupons'))).toBe(false);
    // furim_customers 自身なので顧客の再取得はしない
    expect(statements.filter((s) => s.sql.includes('FROM furim_customers WHERE line_user_id = ?'))).toHaveLength(1);
  });

  it('key_code だけの行（無料アカウント台帳）は furim_customers → friends で本人を補完する', async () => {
    const { db, statements } = makeDb({
      firstRows: [
        { install_id: 'i1', key_code: 'KEY1' },
        { line_user_id: 'U1', stripe_customer_id: 'cus_1', key_code: 'KEY1' },
        { id: 'f1', line_user_id: 'U1', display_name: 'たろう' },
        { line_user_id: 'U1', stripe_customer_id: 'cus_1', key_code: 'KEY1' },
      ],
    });
    const res = await req(db, 'GET', '/api/furim/admin/furim_free_accounts/i1/related');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { identity: Record<string, string | null>; related: Array<{ table: { name: string } }> } };
    expect(body.data.identity).toEqual({ line_user_id: 'U1', friend_id: 'f1', display_name: 'たろう', stripe_customer_id: 'cus_1', key_code: 'KEY1' });
    expect(statements[1].sql).toContain('FROM furim_customers WHERE stripe_customer_id = ? OR key_code = ?');
    expect(statements[1].args).toEqual(['', 'KEY1']);
    expect(body.data.related.map((r) => r.table.name)).toContain('furim_customers');
  });

  it('本人を特定できない行（クーポン）は related が空', async () => {
    const { db, batches } = makeDb({ firstRows: [{ name: 'c1', coupon_id: 'x', is_active: 1 }] });
    const res = await req(db, 'GET', '/api/furim/admin/furim_coupons/c1/related');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { identity: Record<string, string | null>; related: unknown[] } };
    expect(body.data.identity.line_user_id).toBeNull();
    expect(body.data.related).toEqual([]);
    expect(batches).toHaveLength(0);
  });

  it('行が無ければ 404、未許可テーブルは 404', async () => {
    const { db } = makeDb({ firstRows: [null] });
    expect((await req(db, 'GET', '/api/furim/admin/furim_customers/U9/related')).status).toBe(404);
    expect((await req(db, 'GET', '/api/furim/admin/staff/U9/related')).status).toBe(404);
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

describe('#246 段階4 本体: 複合主キー・追加・削除・CSV', () => {
  it('tables に pkColumns / insertable / deletable が付き、複合主キーは pk を "," で表す', async () => {
    const { db } = makeDb();
    const res = await req(db, 'GET', '/api/furim/admin/tables');
    const body = (await res.json()) as { data: Array<{ name: string; pk: string; pkColumns: string[]; insertable: boolean; deletable: boolean }> };
    const flags = body.data.find((t) => t.name === 'furim_feature_flags')!;
    expect(flags.pk).toBe('line_user_id,feature_key');
    expect(flags.pkColumns).toEqual(['line_user_id', 'feature_key']);
    expect(flags.insertable).toBe(true);
    const logs = body.data.find((t) => t.name === 'furim_execution_logs')!;
    expect(logs.insertable).toBe(false);
    expect(logs.deletable).toBe(true);
    expect(body.data.find((t) => t.name === 'furim_master')!.pkColumns).toEqual(['kind', 'key']);
  });

  it('一覧の各行に _id が付き、複合主キーは値を | で連結した id になる', async () => {
    const { db, statements } = makeDb({ firstRows: [{ n: 1 }], allRows: [[{ line_user_id: 'U1', feature_key: 'mChangePrice', value: '1' }]] });
    const res = await req(db, 'GET', '/api/furim/admin/furim_feature_flags?limit=10');
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]._id).toBe('U1|mChangePrice');
    expect(statements.find((st) => st.sql.startsWith('SELECT * FROM furim_feature_flags'))?.sql).toContain('ORDER BY updated_at DESC, line_user_id, feature_key');
  });

  it('複合主キーの 1 行取得・PATCH は AND 条件で引く', async () => {
    const before = { line_user_id: 'U1', feature_key: 'mChangePrice', value: '0', updated_at: 'x' };
    const { db, statements, batches } = makeDb({ firstRows: [before, { ...before, value: '1' }] });
    const res = await req(db, 'PATCH', '/api/furim/admin/furim_feature_flags/U1%7CmChangePrice', { changes: { value: '1' } });
    expect(res.status).toBe(200);
    expect(statements[0].sql).toBe('SELECT * FROM furim_feature_flags WHERE line_user_id = ? AND feature_key = ?');
    expect(statements[0].args).toEqual(['U1', 'mChangePrice']);
    expect(batches[0][0].sql).toBe('UPDATE furim_feature_flags SET value = ?, updated_at = ? WHERE line_user_id = ? AND feature_key = ?');
    expect(batches[0][1].args[4]).toBe('U1|mChangePrice');
  });

  it('POST は列を型チェックして INSERT し、id 主キーは UUID・created_at は現在時刻で埋め、監査 (insert) を残す', async () => {
    const { db, batches } = makeDb({ firstRows: [{ id: 'x', line_user_id: 'U1', delta: 5 }] });
    const res = await req(db, 'POST', '/api/furim/admin/furim_ticket_ledger', {
      values: { line_user_id: 'U1', delta: '5', reason: 'manual', idempotency_key: 'manual:U1:1' },
    });
    expect(res.status).toBe(201);
    const [insert, audit] = batches[0];
    expect(insert.sql).toBe('INSERT INTO furim_ticket_ledger (line_user_id, delta, reason, idempotency_key, id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    expect(insert.args[1]).toBe(5);
    expect(String(insert.args[4])).toMatch(/^[0-9a-f-]{36}$/);
    expect(insert.args[5]).toBe('2026-09-14T00:30:00.000+09:00');
    expect(audit.args[5]).toBe('(insert)');
    expect(JSON.parse(String(audit.args[7])).reason).toBe('manual');
  });

  it('POST: 主キー未指定（複合）・未知の列・追加不可テーブル・staff ロールは弾く', async () => {
    let r = await req(makeDb().db, 'POST', '/api/furim/admin/furim_feature_flags', { values: { line_user_id: 'U1', value: '1' } });
    expect(r.status).toBe(400);
    r = await req(makeDb().db, 'POST', '/api/furim/admin/furim_coupons', { values: { name: 'x', coupon_id: 'c', nope: 1 } });
    expect(r.status).toBe(400);
    r = await req(makeDb().db, 'POST', '/api/furim/admin/furim_execution_logs', { values: { id: 'a' } });
    expect(r.status).toBe(400);
    r = await req(makeDb().db, 'POST', '/api/furim/admin/furim_coupons', { values: { name: 'x', coupon_id: 'c' } }, STAFF_KEY);
    expect(r.status).toBe(403);
  });

  it('DELETE は行を消して監査 (delete) に消した行の JSON を残す。無ければ 404', async () => {
    const { db, batches } = makeDb({ firstRows: [{ name: 'c1', coupon_id: 'X', is_active: 1 }] });
    const res = await req(db, 'DELETE', '/api/furim/admin/furim_coupons/c1');
    expect(res.status).toBe(200);
    const [del, audit] = batches[0];
    expect(del.sql).toBe('DELETE FROM furim_coupons WHERE name = ?');
    expect(del.args).toEqual(['c1']);
    expect(audit.args[5]).toBe('(delete)');
    expect(JSON.parse(String(audit.args[6]))).toEqual({ name: 'c1', coupon_id: 'X', is_active: 1 });
    const gone = await req(makeDb().db, 'DELETE', '/api/furim/admin/furim_coupons/none');
    expect(gone.status).toBe(404);
  });

  it('export.csv は BOM 付き CSV を返し、先頭列は LINE 表示名', async () => {
    const { db } = makeDb({ allRows: [[{ name: 'クーポン,A', coupon_id: 'c"1', is_active: 1 }]] });
    const res = await req(db, 'GET', '/api/furim/admin/furim_coupons/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('furim_coupons-');
    // Body.text() は仕様で先頭の BOM を落とすのでバイト列で確認する
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe('LINE表示名,クーポン名,クーポンID,有効');
    expect(lines[1]).toBe(',"クーポン,A","c""1",1');
  });
});

describe('#253 decision #372: 列順・内部 ID・日本語ラベル・日時表示', () => {
  it('tables の各列に日本語ラベル・内部 ID・日時の保存形式が付き、基準日時と一覧の列順を返す', async () => {
    const { db } = makeDb();
    const res = await req(db, 'GET', '/api/furim/admin/tables');
    type Col = { name: string; label: string; internal: boolean; datetime: string | null };
    type Tbl = { name: string; timeColumn: string | null; timeColumnLabel: string | null; listColumns: string[]; columns: Col[]; virtualColumns: Array<{ name: string }> };
    const body = (await res.json()) as { data: Tbl[] };
    const by = (name: string) => body.data.find((t) => t.name === name)!;

    expect(Object.fromEntries(body.data.map((t) => [t.name, t.timeColumn]))).toEqual({
      furim_customers: '_friend_created_at',
      furim_payments: 'paid_at',
      furim_ticket_ledger: 'created_at',
      furim_cancellations: 'canceled_at',
      furim_referrals: 'created_at',
      affiliates: 'created_at',
      furim_coupons: null,
      furim_execution_logs: 'created_at',
      furim_ext_errors: 'created_at',
      furim_free_accounts: 'created_at',
      furim_manual_copy_logs: 'started_at',
      furim_shop_research_logs: 'created_at',
      furim_auto_copy_logs: 'processed_at',
      furim_survey_answers: 'created_at',
      furim_coupon_applications: 'created_at',
      furim_referral_cashbacks: 'occurred_at',
      furim_feature_flags: 'updated_at',
      furim_master: 'fetched_at',
    });
    expect(by('furim_customers').timeColumnLabel).toBe('友だち登録日時');
    expect(by('furim_payments').timeColumnLabel).toBe('決済日時');

    // 基準日時が先頭、残りは schema 順
    const payments = by('furim_payments');
    expect(payments.listColumns[0]).toBe('paid_at');
    expect(payments.listColumns.slice(1, 4)).toEqual(['plan_name', 'billing_reason', 'subscription_price']);
    expect(payments.listColumns.filter((n) => n === 'paid_at')).toHaveLength(1);
    expect(by('furim_customers').listColumns.slice(0, 3)).toEqual(['_friend_created_at', 'line_user_id', 'stripe_customer_id']);

    // 内部 ID は一覧から外れ、外部 ID は残る
    const referrals = by('furim_referrals');
    expect(referrals.columns.filter((c) => c.internal).map((c) => c.name)).toEqual(['id', 'affiliate_id', 'ambassador_friend_id', 'introduced_friend_id', 'ref_code', 'reward_coupon_id', 'introduced_coupon_id']);
    expect(referrals.listColumns).not.toContain('introduced_friend_id');
    expect(referrals.listColumns[0]).toBe('created_at');
    expect(by('affiliates').listColumns).not.toContain('friend_id');
    expect(by('furim_ticket_ledger').listColumns).not.toContain('id');
    expect(by('furim_customers').columns.filter((c) => c.internal).map((c) => c.name)).toEqual(['inventory_sheet_created_at']);
    for (const t of body.data) {
      expect(t.listColumns.length + t.columns.filter((c) => c.internal).length + t.virtualColumns.filter((v) => (v as { internal?: boolean }).internal).length, t.name).toBe(
        t.columns.length + t.virtualColumns.length + (t.timeColumn?.startsWith('_') ? 1 : 0),
      );
    }

    // ラベルと日時
    const col = (t: string, n: string) => by(t).columns.find((c) => c.name === n)!;
    expect(col('furim_customers', 'key_code').label).toBe('キーコード');
    expect(col('furim_cancellations', 'display_name').label).toBe('LINE表示名（解約時点）');
    expect(col('furim_customers', 'subscription_end_at').datetime).toBe('jst');
    expect(col('furim_customers', 'updated_at').datetime).toBe('jst');
    expect(col('furim_execution_logs', 'mypage_info_updated_date').datetime).toBe('utc');
    expect(col('furim_customers', 'plan_label').datetime).toBeNull();
  });

  it('ラベル未定義の列は英名のまま', async () => {
    const { columnLabel, getAdminTable } = await import('../furim/admin-schema.js');
    expect(columnLabel(getAdminTable('furim_payments')!, 'no_such_column')).toBe('no_such_column');
  });

  it('CSV の見出しは日本語で一覧と同じ列順（内部 ID は末尾）、日時列は表示形式・日時以外は保存値のまま', async () => {
    const { db } = makeDb({
      allRows: [
        [{ id: 'r1', affiliate_id: 'a1', ambassador_friend_id: 'f2', introduced_friend_id: 'f1', ref_code: 'R', source: 'url', trial_extended_days: 7, reward_applied_at: '2026-09-04 19:12:54', created_at: '2026-09-13T23:45:43.193+09:00' }],
        [{ id: 'f1', line_user_id: 'U1', display_name: 'たろう' }],
        [
          { id: 'f1', line_user_id: 'U1', display_name: 'たろう' },
          { id: 'f2', line_user_id: 'U2', display_name: 'はなこ' },
        ],
      ],
    });
    const res = await req(db, 'GET', '/api/furim/admin/furim_referrals/export.csv');
    const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
    const [head, first] = text.replace(/^\ufeff/, '').trim().split('\r\n');
    expect(head).toBe(
      '被紹介者LINE表示名,紹介日時,アンバサダーLINE表示名,アンバサダーLINE_ID,プラン名（アンバサダー）,クーポン名（アンバサダー報酬）,クーポン適用日時,被紹介者LINE_ID,紹介コード,経路,報酬クーポンID,被紹介者クーポンID,試用延長日数,内部ID,アンバサダー内部ID,アンバサダー友だち内部ID,被紹介者友だち内部ID',
    );
    expect(first).toBe('たろう,2026/09/13 23:45:43,はなこ,U2,,,2026/09/04 19:12:54,U1,R,url,,,7,r1,a1,f2,f1');
  });

  it('顧客 CSV は 2 列目が友だち登録日時（表示形式）', async () => {
    const { db } = makeDb({
      allRows: [
        [{ ...CUSTOMER, subscription_end_at: '2026-12-31 20:44:41', _friend_created_at: '2023-05-25T19:53:19.000+09:00' }],
        [{ id: 'f1', line_user_id: 'U1', display_name: 'たろう' }],
      ],
    });
    const res = await req(db, 'GET', '/api/furim/admin/furim_customers/export.csv');
    const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
    const lines = text.replace(/^\ufeff/, '').trim().split('\r\n');
    const head = lines[0].split(',');
    const row = lines[1].split(',');
    expect(head.slice(0, 3)).toEqual(['LINE表示名', '友だち登録日時', 'LINEユーザーID']);
    expect(row.slice(0, 3)).toEqual(['たろう', '2023/05/25 19:53:19', 'U1']);
    expect(row[head.indexOf('サブスク終了日時')]).toBe('2026/12/31 20:44:41');
    expect(row[head.indexOf('作成日時')]).toBe('2026/09/13 00:00:00');
    expect(row[head.indexOf('プラン名')]).toBe('PBプラン');
  });

  it('顧客の 1 行取得に友だち登録日時が付き、関連データの顧客行も friends を JOIN する', async () => {
    const one = makeDb({ firstRows: [CUSTOMER, { created_at: '2023-05-25T19:53:19.000+09:00' }] });
    const res = await req(one.db, 'GET', '/api/furim/admin/furim_customers/U1');
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data._friend_created_at).toBe('2023-05-25T19:53:19.000+09:00');
    expect(one.statements[1].sql).toBe('SELECT created_at FROM friends WHERE line_user_id = ?');

    const rel = makeDb({ firstRows: [{ invoice_id: 'in_1', line_user_id: 'U1', stripe_customer_id: 'cus_1' }] });
    await req(rel.db, 'GET', '/api/furim/admin/furim_payments/in_1/related');
    const stmts = rel.batches[0];
    expect(stmts[0].sql).toBe('SELECT COUNT(*) AS n FROM furim_customers WHERE (line_user_id = ? OR stripe_customer_id = ?)');
    expect(stmts[1].sql).toBe(
      'SELECT t.*, f.created_at AS _friend_created_at FROM furim_customers t LEFT JOIN friends f ON f.line_user_id = t.line_user_id WHERE (t.line_user_id = ? OR t.stripe_customer_id = ?) ORDER BY t.updated_at DESC, t.line_user_id LIMIT ?',
    );
    expect(stmts[1].args).toEqual(['U1', 'cus_1', 20]);
  });

  it('同じテーブルの関連データ（顧客→顧客）は JOIN 側でも自分の行を t. 付きで除外する', async () => {
    const { db, batches } = makeDb({ firstRows: [CUSTOMER, { id: 'f1', line_user_id: 'U1', display_name: 'たろう' }] });
    await req(db, 'GET', '/api/furim/admin/furim_customers/U1/related');
    expect(batches[0][1].sql).toContain('WHERE (t.line_user_id = ? OR t.stripe_customer_id = ? OR t.key_code = ?) AND NOT (t.line_user_id = ?)');
    expect(batches[0][1].args).toEqual(['U1', 'cus_1', 'ABC', 'U1', 20]);
  });
});

describe('日時の相互変換（表示 2026/09/13 23:45:43 ⇔ 保存形式）', () => {
  it('保存値を JST の表示形式にする（ミリ秒・T・オフセットを落とし、UTC は +9 時間）。読めない値はそのまま', async () => {
    const { toDisplayDateTime } = await import('../furim/admin-schema.js');
    expect(toDisplayDateTime('2026-09-13T23:45:43.193+09:00')).toBe('2026/09/13 23:45:43');
    expect(toDisplayDateTime('2026-09-13T23:45:43+09:00')).toBe('2026/09/13 23:45:43');
    expect(toDisplayDateTime('2026-09-13T19:54:32.847')).toBe('2026/09/13 19:54:32');
    expect(toDisplayDateTime('2026-12-31 20:44:41')).toBe('2026/12/31 20:44:41');
    expect(toDisplayDateTime('2026-09-13T14:45:43.000Z')).toBe('2026/09/13 23:45:43');
    expect(toDisplayDateTime('2026-09-13T20:00:00.000Z')).toBe('2026/09/14 05:00:00');
    expect(toDisplayDateTime('2026/09/14 08:07:35')).toBe('2026/09/14 08:07:35');
    expect(toDisplayDateTime('2026年9月13日')).toBe('2026年9月13日');
    expect(toDisplayDateTime('2026-13-40 99:00:00')).toBe('2026-13-40 99:00:00');
    expect(toDisplayDateTime(null)).toBe('');
  });

  it('表示形式のまま保存すると元の値が変わらない（全保存形式で往復）', async () => {
    const { toDisplayDateTime, toStorageDateTime } = await import('../furim/admin-schema.js');
    for (const original of [
      '2026-09-13T23:45:43.193+09:00',
      '2026-09-13T23:45:43+09:00',
      '2026-09-13T19:54:32.847',
      '2026-12-31 20:44:41',
      '2026-09-13T14:45:43.123Z',
      '2026/09/14 08:07:35',
      'よくわからない値',
    ]) {
      expect(toStorageDateTime(toDisplayDateTime(original), original, 'jst'), original).toBe(original);
    }
    expect(toStorageDateTime('2026/9/13 23:45:43', '2026-09-13T23:45:43.193+09:00', 'jst')).toBe('2026-09-13T23:45:43.193+09:00');
  });

  it('時刻を変えたら元の値の保存形式で返し、表示に戻すと入力どおり', async () => {
    const { toDisplayDateTime, toStorageDateTime } = await import('../furim/admin-schema.js');
    const cases: Array<[string, string, string]> = [
      ['2026-09-13T23:45:43.193+09:00', '2026/09/14 00:10:00', '2026-09-14T00:10:00.000+09:00'],
      ['2026-09-13T23:45:43+09:00', '2026/09/14 00:10:00', '2026-09-14T00:10:00+09:00'],
      ['2026-09-13T19:54:32.847', '2026/09/14 00:10:00', '2026-09-14T00:10:00.000'],
      ['2026-12-31 20:44:41', '2027/01/07 20:44:41', '2027-01-07 20:44:41'],
      ['2026-09-13T14:45:43.000Z', '2026/09/14 00:10:00', '2026-09-13T15:10:00.000Z'],
      ['2026/09/14 08:07:35', '2026/09/14 09:00:00', '2026/09/14 09:00:00'],
    ];
    for (const [original, input, stored] of cases) {
      expect(toStorageDateTime(input, original, 'jst'), original).toBe(stored);
      expect(toDisplayDateTime(stored), original).toBe(input);
    }
  });

  it('元の値が空なら列の既定形式、空入力は空、表示形式でない入力はそのまま', async () => {
    const { toStorageDateTime } = await import('../furim/admin-schema.js');
    expect(toStorageDateTime('2026/09/13 23:45:43', null, 'jst')).toBe('2026-09-13T23:45:43.000+09:00');
    expect(toStorageDateTime('2026/09/13 23:45:43', '', 'space')).toBe('2026-09-13 23:45:43');
    expect(toStorageDateTime('2026/09/13 23:45:43', null, 'utc')).toBe('2026-09-13T14:45:43.000Z');
    expect(toStorageDateTime('', '2026-09-13T23:45:43.193+09:00', 'jst')).toBe('');
    expect(toStorageDateTime('2026-09-13T23:00:00.000+09:00', '2026-09-13T23:45:43.193+09:00', 'jst')).toBe('2026-09-13T23:00:00.000+09:00');
    expect(toStorageDateTime('2026/02/30 10:00:00', '2026-09-13T23:45:43.193+09:00', 'jst')).toBe('2026/02/30 10:00:00');
  });
});

describe('#253 decision #378: アンバサダー・紹介履歴をスプシの列に合わせる（表示のみ）', () => {
  const AFFILIATES = [
    { id: 'a1', name: 'Ambassador AAA', code: 'AAA', commission_rate: 0, is_active: 1, friend_id: 'f1', created_at: '2026-09-13T22:54:22.413' },
    { id: 'a2', name: 'Ambassador BBB', code: 'BBB', commission_rate: 0, is_active: 1, friend_id: 'f2', created_at: '2026-09-13T22:54:22.413' },
  ];
  const FRIENDS = [
    { id: 'f1', line_user_id: 'U1', display_name: 'たろう' },
    { id: 'f2', line_user_id: 'U2', display_name: 'はなこ' },
  ];

  it('アンバサダーの一覧は LINE_ID・コード・集計列の順で、上流由来の name / commission_rate / is_active は内部情報に回す', async () => {
    const { db } = makeDb();
    const res = await req(db, 'GET', '/api/furim/admin/tables');
    type Tbl = { name: string; listColumns: string[]; displayNameLabel: string; columns: Array<{ name: string; internal: boolean }>; virtualColumns: Array<{ name: string; label: string }> };
    const body = (await res.json()) as { data: Tbl[] };
    const aff = body.data.find((t) => t.name === 'affiliates')!;
    expect(aff.listColumns).toEqual([
      'created_at', 'code', '_referral_count', '_reward_coupon_count', '_applied_coupon_count', '_cashback_count', '_cashback_total',
    ]);
    expect(aff.columns.filter((c) => c.internal).map((c) => c.name)).toEqual(['id', 'name', 'commission_rate', 'is_active', 'friend_id']);
    expect(aff.virtualColumns.map((v) => v.label)).toEqual(['LINE_ID', '紹介数', 'クーポン付与数', '適用済み数', 'キャッシュバック件数', 'キャッシュバック合計']);
    expect(aff.displayNameLabel).toBe('LINE表示名');

    const ref = body.data.find((t) => t.name === 'furim_referrals')!;
    expect(ref.listColumns).toEqual([
      'created_at', '_ambassador_display_name', 'ambassador_plan_name', 'reward_coupon_name', 'reward_applied_at',
      'source', 'trial_extended_days',
    ]);
    expect(ref.displayNameLabel).toBe('被紹介者LINE表示名');
    expect(body.data.find((t) => t.name === 'furim_customers')!.virtualColumns.map((v) => v.name)).toEqual(['_last_paid_amount', '_payment_count', '_payment_total']);
  });

  it('アンバサダーの一覧に紹介数・クーポン付与数・適用済み数・キャッシュバック件数/合計を GROUP BY 2 回で付ける', async () => {
    const { db, statements } = makeDb({
      firstRows: [{ n: 2 }],
      allRows: [
        AFFILIATES,
        FRIENDS,
        FRIENDS,
        [{ k: 'a1', n: 3, rewarded: 2, applied: 1, total: null }],
        [{ k: 'U1', n: 2, rewarded: null, applied: null, total: 4000 }],
      ],
    });
    const res = await req(db, 'GET', '/api/furim/admin/affiliates');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toMatchObject({
      name: 'Ambassador AAA',
      code: 'AAA',
      _display_name: 'たろう',
      _line_user_id: 'U1',
      _referral_count: 3,
      _reward_coupon_count: 2,
      _applied_coupon_count: 1,
      _cashback_count: 2,
      _cashback_total: 4000,
    });
    expect(body.data[1]).toMatchObject({ _line_user_id: 'U2', _referral_count: 0, _reward_coupon_count: 0, _applied_coupon_count: 0, _cashback_count: 0, _cashback_total: 0 });

    const grouped = statements.filter((s) => s.sql.includes('GROUP BY'));
    expect(grouped).toHaveLength(2);
    expect(grouped[0].sql).toBe(
      'SELECT affiliate_id AS k, COUNT(*) AS n, SUM(reward_coupon_name IS NOT NULL) AS rewarded, SUM(reward_applied_at IS NOT NULL) AS applied FROM furim_referrals WHERE affiliate_id IN (?,?) GROUP BY affiliate_id',
    );
    expect(grouped[0].args).toEqual(['a1', 'a2']);
    expect(grouped[1].sql).toBe(
      'SELECT ambassador_line_user_id AS k, COUNT(*) AS n, COALESCE(SUM(cashback_amount), 0) AS total FROM furim_referral_cashbacks WHERE ambassador_line_user_id IN (?,?) GROUP BY ambassador_line_user_id',
    );
    expect(grouped[1].args).toEqual(['U1', 'U2']);
    expect(statements.filter((s) => /UPDATE|INSERT|DELETE/.test(s.sql))).toHaveLength(0);
  });

  it('紹介履歴はアンバサダーと被紹介者の表示名・LINE_ID を friends から 1 回の IN クエリで引く', async () => {
    const { db, statements } = makeDb({
      firstRows: [{ n: 2 }],
      allRows: [
        [
          { id: 'r1', affiliate_id: 'a1', ambassador_friend_id: 'f1', introduced_friend_id: 'f2', reward_coupon_name: 'アンバサダー3000円引きクーポン', created_at: '2024-04-13 15:16:04' },
          { id: 'r2', affiliate_id: 'a1', ambassador_friend_id: 'f1', introduced_friend_id: 'f9', created_at: '2024-04-20 20:00:00' },
        ],
        FRIENDS,
        FRIENDS,
      ],
    });
    const res = await req(db, 'GET', '/api/furim/admin/furim_referrals');
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toMatchObject({
      _display_name: 'はなこ',
      _ambassador_display_name: 'たろう',
      _ambassador_line_user_id: 'U1',
      _introduced_line_user_id: 'U2',
    });
    expect(body.data[1]).toMatchObject({ _ambassador_display_name: 'たろう', _ambassador_line_user_id: 'U1', _introduced_line_user_id: null });
    const friends = statements.filter((s) => s.sql.includes('FROM friends WHERE id IN'));
    expect(friends).toHaveLength(2);
    expect(friends[1].args).toEqual(['f1', 'f2', 'f9']);
    expect(statements.some((s) => s.sql.includes('GROUP BY'))).toBe(false);
  });

  it('付加列は PATCH / POST で編集できず、UPDATE / INSERT しない', async () => {
    const patch = makeDb({ firstRows: [AFFILIATES[0]] });
    const res = await req(patch.db, 'PATCH', '/api/furim/admin/affiliates/a1', { changes: { _referral_count: 0 } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('集計・表示用の列');
    expect(patch.batches).toHaveLength(0);

    const post = makeDb();
    const res2 = await req(post.db, 'POST', '/api/furim/admin/furim_referrals', { values: { _ambassador_line_user_id: 'U1' } });
    expect(res2.status).toBe(400);
    expect(post.batches).toHaveLength(0);
  });

  it('アンバサダーの CSV に付加列が出る（内部情報は末尾）', async () => {
    const { db } = makeDb({
      allRows: [[AFFILIATES[0]], [FRIENDS[0]], [FRIENDS[0]], [{ k: 'a1', n: 3, rewarded: 2, applied: 1 }], [{ k: 'U1', n: 2, total: 4000 }]],
    });
    const res = await req(db, 'GET', '/api/furim/admin/affiliates/export.csv');
    const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
    const [head, first] = text.replace(/^\ufeff/, '').trim().split('\r\n');
    expect(head).toBe(
      'LINE表示名,登録日時,LINE_ID,アンバサダーコード,紹介数,クーポン付与数,適用済み数,キャッシュバック件数,キャッシュバック合計,内部ID,アンバサダー名,報酬率,有効,友だち内部ID',
    );
    expect(first).toBe('たろう,2026/09/13 22:54:22,U1,AAA,3,2,1,2,4000,a1,Ambassador AAA,0,1,f1');
  });
});

describe('#263 顧客マスター以外の ID 類は一覧から外しドロワーの内部情報へ・CSV は全列', () => {
  const ID_COLUMNS: Record<string, string[]> = {
    furim_payments: ['invoice_id', 'stripe_event_id', 'line_user_id', 'stripe_customer_id', 'subscription_id'],
    furim_ticket_ledger: ['id', 'line_user_id', 'idempotency_key', 'payment_intent_id'],
    furim_cancellations: ['id', 'line_user_id', 'stripe_event_id', 'subscription_id'],
    furim_referrals: ['id', 'affiliate_id', 'ambassador_friend_id', 'introduced_friend_id', 'ref_code', 'reward_coupon_id', 'introduced_coupon_id', '_ambassador_line_user_id', '_introduced_line_user_id'],
    affiliates: ['id', 'friend_id', 'name', 'commission_rate', 'is_active', '_line_user_id'],
    furim_coupons: ['coupon_id'],
    furim_execution_logs: ['id', 'line_user_id', 'key_code'],
    furim_ext_errors: ['id', 'line_user_id', 'key_code', 'discrimination_code'],
    furim_free_accounts: ['install_id', 'key_code'],
    furim_manual_copy_logs: ['id', 'install_id', 'key_code', 'line_user_id', 'item_id'],
    furim_shop_research_logs: ['id', 'install_id', 'key_code', 'line_user_id'],
    furim_auto_copy_logs: ['id', 'line_user_id', 'idempotency_key'],
    furim_survey_answers: ['id', 'line_user_id'],
    furim_coupon_applications: ['id', 'line_user_id', 'stripe_customer_id', 'coupon_id'],
    furim_referral_cashbacks: ['id', 'introduced_line_user_id', 'stripe_customer_id', 'ambassador_line_user_id'],
    furim_feature_flags: ['line_user_id'],
    furim_master: ['stripe_price_id'],
  };

  type Tbl = {
    name: string;
    listColumns: string[];
    columns: Array<{ name: string; internal: boolean }>;
    virtualColumns: Array<{ name: string; internal: boolean }>;
  };

  async function tables(): Promise<Tbl[]> {
    const res = await req(makeDb().db, 'GET', '/api/furim/admin/tables');
    return ((await res.json()) as { data: Tbl[] }).data;
  }

  it('顧客マスター以外は ID 類が一覧に無く、列・付加列の internal が立つ。顧客マスターは内部情報なし', async () => {
    const data = await tables();
    for (const t of data) {
      if (t.name === 'furim_customers') {
        expect(t.columns.filter((c) => c.internal).map((c) => c.name)).toEqual(['inventory_sheet_created_at']);
        expect(t.virtualColumns.some((v) => v.internal)).toBe(false);
        expect(t.listColumns).toEqual(expect.arrayContaining(['line_user_id', 'stripe_customer_id', 'subscription_id', 'key_code']));
        expect(t.listColumns).not.toContain('inventory_sheet_created_at');
        continue;
      }
      const ids = ID_COLUMNS[t.name];
      expect(ids, t.name).toBeDefined();
      for (const n of ids) expect(t.listColumns, `${t.name}.${n}`).not.toContain(n);
      const internal = [...t.columns.filter((c) => c.internal), ...t.virtualColumns.filter((v) => v.internal)].map((c) => c.name);
      expect(internal.sort(), t.name).toEqual([...ids].sort());
    }
  });

  it('サブスク取引の一覧は 決済日時 → プラン名 → 請求理由 → サブスク金額 → 割引額 → 税抜金額 → 消費税額 → 実支払額 → 残り', async () => {
    const payments = (await tables()).find((t) => t.name === 'furim_payments')!;
    expect(payments.listColumns).toEqual([
      'paid_at', 'plan_name', 'billing_reason', 'subscription_price', 'discount_amount', 'price_excl_tax', 'tax_amount', 'actual_paid_amount', 'customer_email', 'created_at',
    ]);
  });

  it('CSV は ID 類も含めた全列を出す（チケット取引）', async () => {
    const { db } = makeDb({
      allRows: [
        [{ id: 'l1', line_user_id: 'U1', delta: 10, reason: 'purchase', idempotency_key: 'pi_1:10', payment_intent_id: 'pi_1', amount: 1000, currency: 'jpy', created_at: '2026-09-13T23:45:43.193+09:00' }],
        [{ id: 'f1', line_user_id: 'U1', display_name: 'たろう' }],
      ],
    });
    const res = await req(db, 'GET', '/api/furim/admin/furim_ticket_ledger/export.csv');
    const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
    const [head, first] = text.replace(/^\ufeff/, '').trim().split('\r\n');
    expect(head).toBe('LINE表示名,付与日時,LINEユーザーID,付与枚数,付与の種類,重複防止キー,PaymentIntent ID,金額,通貨,内部ID');
    expect(first).toBe('たろう,2026/09/13 23:45:43,U1,10,purchase,pi_1:10,pi_1,1000,jpy,l1');
  });

  it('ID 類を一覧から外しても表示名は ID で解決し、関連データも ID で紐づける', async () => {
    const list = makeDb({ firstRows: [{ n: 1 }], allRows: [[{ invoice_id: 'in_1', line_user_id: 'U1', plan_name: 'PB' }], [{ id: 'f1', line_user_id: 'U1', display_name: 'たろう' }]] });
    const res = await req(list.db, 'GET', '/api/furim/admin/furim_payments');
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toMatchObject({ _display_name: 'たろう', line_user_id: 'U1', invoice_id: 'in_1' });

    const rel = makeDb({ firstRows: [{ invoice_id: 'in_1', line_user_id: 'U1', stripe_customer_id: 'cus_1' }] });
    await req(rel.db, 'GET', '/api/furim/admin/furim_payments/in_1/related');
    expect(rel.batches[0][0].sql).toBe('SELECT COUNT(*) AS n FROM furim_customers WHERE (line_user_id = ? OR stripe_customer_id = ?)');
  });
});

describe('#261 顧客に機能フラグを横持ちで出す', () => {
  const MASTER = [
    { key: 'AutoMultiChannel', display_name: '自動併売・巡回オプション', payload: JSON.stringify({ site: 'cross', value_type: 'sitelist' }) },
    { key: 'rChangePrice', display_name: '値段変更', payload: JSON.stringify({ site: 'rakuma', value_type: 'bool' }) },
    { key: 'zNewFeature', display_name: '新機能', payload: JSON.stringify({ site: 'mercari', value_type: 'bool' }) },
    { key: 'mBackup', display_name: 'バックアップ', payload: JSON.stringify({ site: 'mercari', value_type: 'bool' }) },
    { key: 'mChangePrice', display_name: '値段変更', payload: JSON.stringify({ site: 'mercari', value_type: 'bool' }) },
  ];
  const FLAG_COLUMNS = ['_flag_mChangePrice', '_flag_mBackup', '_flag_rChangePrice', '_flag_AutoMultiChannel', '_flag_zNewFeature'];
  const grouped = (u: string, flags: Record<string, string>) => ({
    line_user_id: u,
    f: Object.entries(flags).map(([k, v]) => `${k}${v}`).join(''),
  });

  const kv = () => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) });

  function reqWithKv(db: D1Database, cache: ReturnType<typeof kv>, method: string, path: string, body?: unknown, key = OWNER_KEY) {
    const headers = new Headers({ Authorization: `Bearer ${key}` });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return worker.fetch(
      new Request(`https://worker.example.com${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }),
      { ...envWith(db), FURIM_EXT_CACHE: cache } as unknown as import('../index.js').Env['Bindings'],
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
  }

  it('一覧（全件表示）は機能列を付けず、マスタも flags も読まない（描画を軽くする・機能は行ドロワーで出す）', async () => {
    const customers = Array.from({ length: 250 }, (_, i) => ({ ...CUSTOMER, line_user_id: `U${i}` }));
    const { db, statements } = makeDb({ firstRows: [{ n: 250 }], allRows: [customers, [], [], []] });
    const res = await req(db, 'GET', '/api/furim/admin/furim_customers');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>>; meta: { table: { featureFlags: boolean; listColumns: string[]; virtualColumns: Array<{ name: string }> } } };
    expect(body.data).toHaveLength(250);
    expect(body.meta.table.featureFlags).toBe(true);
    expect(body.meta.table.listColumns.some((n) => n.startsWith('_flag_'))).toBe(false);
    expect(body.meta.table.virtualColumns.some((v) => v.name.startsWith('_flag_'))).toBe(false);
    expect(Object.keys(body.data[0]).some((k) => k.startsWith('_flag'))).toBe(false);
    expect(statements.some((s) => s.sql.includes('furim_master') || s.sql.includes('furim_feature_flags'))).toBe(false);
  });

  it('行ドロワーの機能: その 1 人分だけ読み、シートの順・サイト名＋マスタ名・0/1 か文字列・固定を返す（行が無い機能は null）', async () => {
    const { db, statements } = makeDb({
      allRows: [
        MASTER,
        [
          { feature_key: 'mChangePrice', value: '1', locked: 0 },
          { feature_key: 'mBackup', value: '0', locked: 1 },
          { feature_key: 'AutoMultiChannel', value: 'メルカリ/ラクマ', locked: 0 },
        ],
      ],
    });
    const res = await req(db, 'GET', '/api/furim/admin/furim_customers/U1/feature-flags');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data).toEqual([
      { feature_key: 'mChangePrice', label: 'メルカリ値段変更', flag: 'bool', value: '1', locked: 0 },
      { feature_key: 'mBackup', label: 'メルカリバックアップ', flag: 'bool', value: '0', locked: 1 },
      { feature_key: 'rChangePrice', label: 'ラクマ値段変更', flag: 'bool', value: null, locked: 0 },
      { feature_key: 'AutoMultiChannel', label: '自動併売・巡回オプション', flag: 'text', value: 'メルカリ/ラクマ', locked: 0 },
      { feature_key: 'zNewFeature', label: 'メルカリ新機能', flag: 'bool', value: null, locked: 0 },
    ]);
    const flagStmts = statements.filter((s) => s.sql.includes('FROM furim_feature_flags'));
    expect(flagStmts).toHaveLength(1);
    expect(flagStmts[0].sql).toBe('SELECT feature_key, value, locked FROM furim_feature_flags WHERE line_user_id = ?');
    expect(flagStmts[0].args).toEqual(['U1']);
  });

  it('他のテーブルには機能列を付けず、マスタも flags も読まない', async () => {
    const { db, statements } = makeDb({ firstRows: [{ n: 0 }] });
    await req(db, 'GET', '/api/furim/admin/furim_payments');
    expect(statements.some((s) => s.sql.includes('furim_master') || s.sql.includes('furim_feature_flags'))).toBe(false);
  });

  it('CSV に機能列が日本語の見出しで 0/1 のまま出る', async () => {
    const { db } = makeDb({
      allRows: [
        [{ ...CUSTOMER, _friend_created_at: '2023-05-25T19:53:19.000+09:00' }],
        [{ id: 'f1', line_user_id: 'U1', display_name: 'たろう' }],
        [],
        MASTER,
        [grouped('U1', { mChangePrice: '1', mBackup: '0', rChangePrice: '1', AutoMultiChannel: 'メルカリ' })],
      ],
    });
    const res = await req(db, 'GET', '/api/furim/admin/furim_customers/export.csv');
    const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
    const [head, first] = text.replace(/^﻿/, '').trim().split('\r\n').map((l) => l.split(','));
    expect(head.slice(-5)).toEqual(['メルカリ値段変更', 'メルカリバックアップ', 'ラクマ値段変更', '自動併売・巡回オプション', 'メルカリ新機能']);
    expect(first.slice(-5)).toEqual(['1', '0', '1', 'メルカリ', '']);
    expect(first.slice(0, 2)).toEqual(['たろう', '2023/05/25 19:53:19']);
  });

  it('チェックボックス保存: 値が変わったら UPSERT（source=worker・固定でも手動なので書く）・監査ログ 1 行・KV 無効化', async () => {
    const cache = kv();
    const { db, statements, batches } = makeDb({ firstRows: [CUSTOMER, { value: '0' }], allRows: [MASTER] });
    const res = await reqWithKv(db, cache, 'PATCH', '/api/furim/admin/furim_customers/U1/feature-flags', { feature_key: 'mBackup', value: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { feature_key: string; value: string }; meta: { changed: boolean } };
    expect(body.meta.changed).toBe(true);
    expect(body.data).toMatchObject({ feature_key: 'mBackup', value: '1' });
    expect(batches).toHaveLength(0);
    const upserts = statements.filter((s) => s.sql.includes('INSERT INTO furim_feature_flags'));
    expect(upserts).toHaveLength(1);
    expect(upserts[0].sql).not.toContain('locked');
    expect(upserts[0].args).toEqual(['U1', 'mBackup', '1', 'worker', '2026-09-14T00:30:00.000+09:00']);
    const audits = statements.filter((s) => s.sql.includes('INSERT INTO furim_admin_audit'));
    expect(audits).toHaveLength(1);
    expect(audits[0].args.slice(1)).toEqual(['env-owner', 'Owner', 'furim_feature_flags', 'U1|mBackup', 'value', '0', '1', '2026-09-14T00:30:00.000+09:00']);
    expect(cache.delete).toHaveBeenCalledWith('kc:ABC');
  });

  it('同じ値を送っても書かず、監査ログも KV 無効化もしない', async () => {
    const cache = kv();
    const { db, statements, batches } = makeDb({ firstRows: [CUSTOMER, { value: '1' }], allRows: [MASTER] });
    const res = await reqWithKv(db, cache, 'PATCH', '/api/furim/admin/furim_customers/U1/feature-flags', { feature_key: 'mBackup', value: '1' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { meta: { changed: boolean } }).meta.changed).toBe(false);
    expect(batches).toHaveLength(0);
    expect(statements.some((s) => s.sql.includes('furim_admin_audit'))).toBe(false);
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it('0/1 以外は 400・文字列値の機能とマスタに無い機能は 400・顧客が無ければ 404（何も書かない）', async () => {
    for (const value of [2, 'true', true, null, '']) {
      const { db, batches, statements } = makeDb();
      const res = await req(db, 'PATCH', '/api/furim/admin/furim_customers/U1/feature-flags', { feature_key: 'mBackup', value });
      expect(res.status, String(value)).toBe(400);
      expect(batches).toHaveLength(0);
      expect(statements).toHaveLength(0);
    }
    for (const featureKey of ['AutoMultiChannel', 'nope']) {
      const { db, batches } = makeDb({ firstRows: [CUSTOMER], allRows: [MASTER] });
      const res = await req(db, 'PATCH', '/api/furim/admin/furim_customers/U1/feature-flags', { feature_key: featureKey, value: 1 });
      expect(res.status, featureKey).toBe(400);
      expect(batches).toHaveLength(0);
    }
    const missing = makeDb({ firstRows: [null], allRows: [MASTER] });
    const res = await req(missing.db, 'PATCH', '/api/furim/admin/furim_customers/U9/feature-flags', { feature_key: 'mBackup', value: 1 });
    expect(res.status).toBe(404);
    expect(missing.batches).toHaveLength(0);
  });

  it('staff ロールは 403', async () => {
    const { db, batches, statements } = makeDb({ firstRows: [CUSTOMER, { value: '0' }], allRows: [MASTER] });
    const res = await req(db, 'PATCH', '/api/furim/admin/furim_customers/U1/feature-flags', { feature_key: 'mBackup', value: 1 }, STAFF_KEY);
    expect(res.status).toBe(403);
    expect(batches).toHaveLength(0);
    expect(statements).toHaveLength(0);
  });
  it('固定の切り替え: 状態が変わったら locked を UPDATE・監査ログ（column=locked）1 行・KV 無効化。値は触らない', async () => {
    const cache = kv();
    const { db, statements } = makeDb({ firstRows: [CUSTOMER, { value: '1', locked: 0 }], allRows: [MASTER] });
    const res = await reqWithKv(db, cache, 'PATCH', '/api/furim/admin/furim_customers/U1/feature-flags/lock', { feature_key: 'mBackup', locked: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { locked: number }; meta: { changed: boolean } };
    expect(body).toMatchObject({ data: { locked: 1 }, meta: { changed: true } });
    const updates = statements.filter((s) => s.sql.includes('furim_feature_flags') && !s.sql.startsWith('SELECT'));
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toBe('UPDATE furim_feature_flags SET locked = ? WHERE line_user_id = ? AND feature_key = ?');
    expect(updates[0].args).toEqual([1, 'U1', 'mBackup']);
    const audits = statements.filter((s) => s.sql.includes('INSERT INTO furim_admin_audit'));
    expect(audits).toHaveLength(1);
    expect(audits[0].args.slice(1)).toEqual(['env-owner', 'Owner', 'furim_feature_flags', 'U1|mBackup', 'locked', '0', '1', '2026-09-14T00:30:00.000+09:00']);
    expect(cache.delete).toHaveBeenCalledWith('kc:ABC');

    const off = makeDb({ firstRows: [CUSTOMER, { value: '1', locked: 1 }], allRows: [MASTER] });
    const offRes = await reqWithKv(off.db, kv(), 'PATCH', '/api/furim/admin/furim_customers/U1/feature-flags/lock', { feature_key: 'mBackup', locked: 0 });
    expect(((await offRes.json()) as { meta: { changed: boolean } }).meta.changed).toBe(true);
    const offAudit = off.statements.find((s) => s.sql.includes('INSERT INTO furim_admin_audit'));
    expect(offAudit?.args.slice(5, 8)).toEqual(['locked', '1', '0']);
    expect(off.statements.some((s) => /SET value|INSERT INTO furim_feature_flags/.test(s.sql))).toBe(false);
  });

  it('固定の切り替え: 行が無い機能は値を既定（0/1 は 0・文字列は空）で作って固定する', async () => {
    const { db, statements } = makeDb({ firstRows: [CUSTOMER, null], allRows: [MASTER] });
    const res = await req(db, 'PATCH', '/api/furim/admin/furim_customers/U1/feature-flags/lock', { feature_key: 'AutoMultiChannel', locked: 1 });
    expect(res.status).toBe(200);
    const ins = statements.find((s) => s.sql.includes('INSERT INTO furim_feature_flags'));
    expect(ins?.args).toEqual(['U1', 'AutoMultiChannel', '', 'worker', '2026-09-14T00:30:00.000+09:00', 1]);
  });

  it('固定の切り替え: 同じ状態を送っても書かず、監査ログも KV 無効化もしない', async () => {
    const cases: Array<[Record<string, unknown> | null, number | string]> = [[{ value: '1', locked: 1 }, 1], [{ value: '1', locked: 0 }, 0], [null, '0']];
    for (const [before, locked] of cases) {
      const cache = kv();
      const { db, statements } = makeDb({ firstRows: [CUSTOMER, before], allRows: [MASTER] });
      const res = await reqWithKv(db, cache, 'PATCH', '/api/furim/admin/furim_customers/U1/feature-flags/lock', { feature_key: 'mBackup', locked });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { meta: { changed: boolean } }).meta.changed).toBe(false);
      expect(statements.some((s) => s.sql.includes('furim_admin_audit') || /UPDATE|INSERT/.test(s.sql))).toBe(false);
      expect(cache.delete).not.toHaveBeenCalled();
    }
  });

  it('固定の切り替え: locked が 0/1 以外・マスタに無い機能は 400、顧客が無ければ 404、staff は 403', async () => {
    for (const locked of [2, true, null, '']) {
      const { db, statements } = makeDb();
      const res = await req(db, 'PATCH', '/api/furim/admin/furim_customers/U1/feature-flags/lock', { feature_key: 'mBackup', locked });
      expect(res.status, String(locked)).toBe(400);
      expect(statements).toHaveLength(0);
    }
    const nope = makeDb({ firstRows: [CUSTOMER], allRows: [MASTER] });
    expect((await req(nope.db, 'PATCH', '/api/furim/admin/furim_customers/U1/feature-flags/lock', { feature_key: 'nope', locked: 1 })).status).toBe(400);
    const missing = makeDb({ firstRows: [null], allRows: [MASTER] });
    expect((await req(missing.db, 'PATCH', '/api/furim/admin/furim_customers/U9/feature-flags/lock', { feature_key: 'mBackup', locked: 1 })).status).toBe(404);
    const staff = makeDb({ firstRows: [CUSTOMER, { value: '0', locked: 0 }], allRows: [MASTER] });
    expect((await req(staff.db, 'PATCH', '/api/furim/admin/furim_customers/U1/feature-flags/lock', { feature_key: 'mBackup', locked: 1 }, STAFF_KEY)).status).toBe(403);
    expect(staff.statements).toHaveLength(0);
  });
});

describe('#262 顧客マスターの列をシートの並びに合わせる・不要列を外す・サブスク 4 列', () => {
  const SHEET_ORDER = [
    '_friend_created_at',
    'line_user_id',
    'stripe_customer_id',
    'mercari_url',
    'shops_url',
    'rakuma_url',
    'yahoo_flea_url',
    'plan_label',
    'subscription_id',
    'subscription_start_at',
    'subscription_end_at',
    'subscription_price',
    '_last_paid_amount',
    '_payment_count',
    '_payment_total',
    'youtube_coupon',
    'extend_keyword',
    'survey_answer',
    'key_code_issued',
    'key_code',
    'device_code',
    'free30_ticket',
    'copy_tickets',
    'inventory_sheet_url',
    'sheet_synced_at',
    'created_at',
    'updated_at',
  ];
  const HIDDEN = [
    'subscription_source',
    'multi_channel_sites',
    'features',
    'packages',
    'device_activated',
  ];
  const FULL = {
    ...CUSTOMER,
    subscription_source: 'plan-builder',
    multi_channel_sites: 'メルカリ/ラクマ',
    features: 'mChangePrice',
    packages: 'basic',
    shops_url: 'https://mercari-shops.com/shops/s1',
    rakuma_url: 'https://fril.jp/shop/r1',
    yahoo_flea_url: 'https://paypayfleamarket.yahoo.co.jp/user/y1',
    subscription_price: 8980,
  };

  it('一覧・ドロワーの列はシートの並び（友だち登録日時→LINE_ID→…→在庫管理シート→シートに無い D1 の列）で、外した列は columns にも出ない', async () => {
    const { db } = makeDb();
    const res = await req(db, 'GET', '/api/furim/admin/tables');
    const body = (await res.json()) as {
      data: Array<{ name: string; listColumns: string[]; columns: Array<{ name: string; label: string; searchable: boolean }>; virtualColumns: Array<{ name: string; label: string }> }>;
    };
    const t = body.data.find((x) => x.name === 'furim_customers')!;
    expect(t.listColumns).toEqual(SHEET_ORDER);
    for (const name of HIDDEN) {
      expect(t.columns.map((c) => c.name), name).not.toContain(name);
      expect(t.listColumns, name).not.toContain(name);
    }
    const label = (n: string) => t.columns.find((c) => c.name === n)?.label ?? t.virtualColumns.find((v) => v.name === n)?.label;
    expect(['shops_url', 'rakuma_url', 'yahoo_flea_url', 'subscription_price', '_last_paid_amount', '_payment_count', '_payment_total'].map(label)).toEqual([
      'ShopsURL',
      'ラクマURL',
      'ヤフフリURL',
      'サブスク価格',
      '支払い金額',
      '通算支払い回数',
      '通算支払い総額',
    ]);
    expect(t.columns.find((c) => c.name === 'subscription_source')).toBeUndefined();
  });

  it('全件の一覧はサブスク 4 列の集計を furim_payments の GROUP BY 1 回で付け（顧客数に比例しない）、外した列は応答から消す', async () => {
    const customers = Array.from({ length: 250 }, (_, i) => ({ ...FULL, line_user_id: `U${i}` }));
    const { db, statements } = makeDb({
      firstRows: [{ n: 250 }],
      allRows: [
        customers,
        [],
        [],
        [],
        [
          { k: 'U0', n: 3, total: 26934, last_paid: 8228, last_paid_at: '2026-09-14T15:14:04.793+09:00' },
          { k: 'U1', n: 1, total: 5456, last_paid: 5456, last_paid_at: '2026-09-14T13:40:56.572+09:00' },
        ],
      ],
    });
    const res = await req(db, 'GET', '/api/furim/admin/furim_customers');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    const paymentStmts = statements.filter((s) => s.sql.includes('FROM furim_payments'));
    expect(paymentStmts).toHaveLength(1);
    expect(paymentStmts[0].sql).toBe(
      'SELECT line_user_id AS k, COUNT(*) AS n, SUM(actual_paid_amount) AS total, actual_paid_amount AS last_paid, MAX(paid_at) AS last_paid_at FROM furim_payments WHERE line_user_id IS NOT NULL GROUP BY line_user_id',
    );
    expect(paymentStmts[0].args).toEqual([]);
    expect(body.data[0]).toMatchObject({ _last_paid_amount: 8228, _payment_count: 3, _payment_total: 26934, subscription_price: 8980, shops_url: 'https://mercari-shops.com/shops/s1' });
    expect(body.data[1]).toMatchObject({ _last_paid_amount: 5456, _payment_count: 1, _payment_total: 5456 });
    expect(body.data[2]).toMatchObject({ _last_paid_amount: null, _payment_count: 0, _payment_total: 0 });
    for (const name of HIDDEN) expect(Object.keys(body.data[0]), name).not.toContain(name);
  });

  it('1 行取得は本人分だけ IN で集計する', async () => {
    const { db, statements } = makeDb({
      firstRows: [{ ...FULL }, { created_at: '2023-05-25T19:53:19.000+09:00' }],
      allRows: [[], [{ k: 'U1', n: 2, total: 19756, last_paid: 9878, last_paid_at: '2026-09-13T23:10:26.765+09:00' }]],
    });
    const res = await req(db, 'GET', '/api/furim/admin/furim_customers/U1');
    const body = (await res.json()) as { data: Record<string, unknown> };
    const paymentStmts = statements.filter((s) => s.sql.includes('FROM furim_payments'));
    expect(paymentStmts).toHaveLength(1);
    expect(paymentStmts[0].sql).toContain('WHERE line_user_id IN (?) GROUP BY line_user_id');
    expect(paymentStmts[0].args).toEqual(['U1']);
    expect(body.data).toMatchObject({ _last_paid_amount: 9878, _payment_count: 2, _payment_total: 19756 });
    expect(body.data.subscription_source).toBeUndefined();
  });

  it('CSV も一覧と同じ並びで、外した列は出ず、サブスク 4 列が出る', async () => {
    const { db } = makeDb({
      allRows: [
        [{ ...FULL, _friend_created_at: '2023-05-25T19:53:19.000+09:00' }],
        [{ id: 'f1', line_user_id: 'U1', display_name: 'たろう' }],
        [{ k: 'U1', n: 2, total: 19756, last_paid: 9878, last_paid_at: '2026-09-13T23:10:26.765+09:00' }],
        [],
        [],
      ],
    });
    const res = await req(db, 'GET', '/api/furim/admin/furim_customers/export.csv');
    const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
    const [head, first] = text.replace(/^﻿/, '').trim().split('\r\n').map((l) => l.split(','));
    expect(head.slice(0, 16)).toEqual([
      'LINE表示名',
      '友だち登録日時',
      'LINEユーザーID',
      'Stripe顧客ID',
      'メルカリURL',
      'ShopsURL',
      'ラクマURL',
      'ヤフフリURL',
      'プラン名',
      'サブスクID',
      'サブスク開始日時',
      'サブスク終了日時',
      'サブスク価格',
      '支払い金額',
      '通算支払い回数',
      '通算支払い総額',
    ]);
    for (const l of ['メールアドレス', '最終請求書ID', 'サブスク状態', '契約経路', '多チャネル出品先', '機能', 'パッケージ', '旧プラン名', '端末判定済み']) {
      expect(head, l).not.toContain(l);
    }
    expect(first.slice(12, 16)).toEqual(['8980', '9878', '2', '19756']);
    expect(first).not.toContain('plan-builder');
  });

  it('外した列は PATCH / POST できない（D1 の列は残るが管理画面からは触らない）', async () => {
    const { db, statements } = makeDb({ firstRows: [{ ...FULL }] });
    const res = await req(db, 'PATCH', '/api/furim/admin/furim_customers/U1', { changes: { subscription_source: 'legacy' } });
    expect(res.status).toBe(400);
    expect(statements.some((s) => s.sql.startsWith('UPDATE'))).toBe(false);
    const post = makeDb();
    const created = await req(post.db, 'POST', '/api/furim/admin/furim_customers', { values: { line_user_id: 'U9', subscription_source: 'legacy' } });
    expect(created.status).toBe(400);
  });
});
