import { describe, it, expect, vi, beforeEach } from 'vitest';
import { masterFixture as fixture, sheetMasterRows as sheetRows, type MasterRow } from '../furim/__fixtures__/master-fixture.js';

const dbMocks = {
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
  jstNow: () => '2026-09-14T21:00:00.000+09:00',
};
vi.mock('@line-crm/db', () => dbMocks);

const worker = (await import('../index.js')).default;

type Stmt = { sql: string; args: unknown[] };

function makeDb(rows: MasterRow[] = sheetRows()) {
  const statements: Stmt[] = [];
  const batches: Stmt[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          statements.push({ sql, args });
          return {
            sql,
            args,
            first: async () => {
              if (/FROM furim_master WHERE kind = \? AND key = \?/.test(sql)) return rows.find((r) => r.kind === args[0] && r.key === args[1]) ?? null;
              return null;
            },
            all: async () => {
              if (/GROUP BY kind/.test(sql)) {
                const m = new Map<string, number>();
                for (const r of rows) m.set(r.kind, (m.get(r.kind) ?? 0) + 1);
                return { results: [...m].map(([kind, n]) => ({ kind, n })) };
              }
              if (/SELECT key FROM furim_master WHERE kind = 'feature'/.test(sql)) return { results: rows.filter((r) => r.kind === 'feature').map((r) => ({ key: r.key })) };
              if (/kind IN \('feature', 'package'\)/.test(sql)) return { results: rows.filter((r) => r.kind === 'feature' || r.kind === 'package') };
              if (/FROM furim_master WHERE kind = \? ORDER BY rowid/.test(sql)) return { results: rows.filter((r) => r.kind === args[0]) };
              return { results: [] };
            },
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      };
    },
    batch: async (stmts: Stmt[]) => {
      batches.push(stmts);
      return stmts.map(() => ({ results: [] }));
    },
  } as unknown as D1Database;
  return { db, statements, batches };
}

const OWNER_KEY = 'owner-key';
const STAFF_KEY = 'staff-key';

function req(db: D1Database, method: string, path: string, body?: unknown, key = OWNER_KEY) {
  const headers = new Headers({ Authorization: `Bearer ${key}` });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return worker.fetch(
    new Request(`https://worker.example.com${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }),
    { DB: db, LINE_LOGIN_CHANNEL_ID: '2000000000', API_KEY: OWNER_KEY, WORKER_URL: 'https://worker.example.com' } as unknown as import('../index.js').Env['Bindings'],
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getLineAccounts.mockResolvedValue([]);
  dbMocks.getStaffByApiKey.mockImplementation(async (_db: unknown, key: string) => (key === STAFF_KEY ? { id: 's1', name: 'スタッフ', role: 'staff' } : null));
});

const updateOf = (batches: Stmt[][]) => batches.flat().find((s) => s.sql.startsWith('UPDATE furim_master'));
const auditsOf = (batches: Stmt[][]) => batches.flat().filter((s) => s.sql.includes('INSERT INTO furim_admin_audit'));

describe('#264 マスタ編集 API', () => {
  it('種類の一覧は 4 種類と項目の定義・件数を返す', async () => {
    const { db } = makeDb();
    const res = await req(db, 'GET', '/api/furim/admin/masters');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ kind: string; count: number; fields: Array<{ name: string; label: string; type: string }> }> };
    expect(body.data.map((k) => [k.kind, k.count])).toEqual([['feature', 51], ['package', 11], ['plan', 2], ['ticket_price', 4]]);
    const feature = body.data[0].fields.find((f) => f.name === 'monthly_price')!;
    expect(feature).toMatchObject({ label: '月額（税抜・円）', type: 'money' });
  });

  it('一覧は payload を項目ごとの値にして返す（数値・真偽・機能キーの配列）', async () => {
    const { db } = makeDb();
    const res = await req(db, 'GET', '/api/furim/admin/masters/package');
    const body = (await res.json()) as { data: Array<{ key: string; id: string; values: Record<string, unknown> }> };
    const m = body.data.find((x) => x.key === 'm_basic')!;
    expect(m.id).toBe('package|m_basic');
    expect(m.values).toMatchObject({ package_key: 'm_basic', monthly_price: 3980, combo_discount: 0, sort_order: 30, active: true });
    expect(m.values.features).toEqual(['mChangePrice', 'mComment', 'mDeleteComment', 'mCopyMShopsListing', 'mCopyRakumaListing', 'mCopyYahooAuctionListing', 'mCopyYahooFleamarketListing']);
  });

  it('知らない種類は 404', async () => {
    const { db } = makeDb();
    expect((await req(db, 'GET', '/api/furim/admin/masters/coupon')).status).toBe(404);
    expect((await req(db, 'PATCH', '/api/furim/admin/masters/coupon/x', { values: {} })).status).toBe(404);
  });

  it('更新: 変えた項目だけ型を揃え、変えていない項目は元の値（文字列の数値・TRUE）のまま。列も payload から作り、監査は項目ごとに前後を残す', async () => {
    const { db, batches } = makeDb();
    const res = await req(db, 'PATCH', `/api/furim/admin/masters/package/m_full`, { values: { monthly_price: '9980', display_name: 'メルカリ 全自動化プラン（新）' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { changed: string[] } };
    expect(body.meta.changed.sort()).toEqual(['display_name', 'monthly_price']);
    const up = updateOf(batches)!;
    const payload = JSON.parse(String(up.args[4]));
    const before = fixture.packages.find((p) => p.package_key === 'm_full')!;
    expect(Object.keys(payload)).toEqual(Object.keys(before));
    expect(payload).toEqual({ ...before, monthly_price: 9980, display_name: 'メルカリ 全自動化プラン（新）' });
    expect(up.args.slice(0, 4)).toEqual(['メルカリ 全自動化プラン（新）', before.stripe_price_id, 9980, 1]);
    expect(up.args.slice(5)).toEqual(['2026-09-14T21:00:00.000+09:00', 'package', 'm_full']);
    const audits = auditsOf(batches);
    expect(audits.map((a) => [a.args[3], a.args[4], a.args[5], a.args[6], a.args[7]])).toEqual([
      ['furim_master', 'package|m_full', 'display_name', 'メルカリ 全自動化プラン', 'メルカリ 全自動化プラン（新）'],
      ['furim_master', 'package|m_full', 'monthly_price', '8980', '9980'],
    ]);
  });

  it('更新: 同じ値を送っても書かない（監査ログも無し）', async () => {
    const { db, batches } = makeDb();
    const res = await req(db, 'PATCH', `/api/furim/admin/masters/feature/mChangePrice`, { values: { monthly_price: '1980', active: true, requires: [] } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { meta: { changed: string[] } }).meta.changed).toEqual([]);
    expect(batches).toHaveLength(0);
  });

  it('更新: 無効にすると active 列が 0・payload は FALSE', async () => {
    const { db, batches } = makeDb();
    await req(db, 'PATCH', `/api/furim/admin/masters/feature/mAuction`, { values: { active: false } });
    const up = updateOf(batches)!;
    expect(up.args[3]).toBe(0);
    expect(JSON.parse(String(up.args[4])).active).toBe('FALSE');
  });

  it.each([
    ['feature', 'mChangePrice', { monthly_price: 'abc' }, '整数'],
    ['feature', 'mChangePrice', { monthly_price: '1980.5' }, '整数'],
    ['feature', 'mChangePrice', { monthly_price: '-1' }, '0 以上'],
    ['feature', 'mChangePrice', { monthly_price: '' }, '月額'],
    ['feature', 'mChangePrice', { display_name: '' }, '必須'],
    ['feature', 'mChangePrice', { site: 'amazon' }, 'のどれか'],
    ['feature', 'mChangePrice', { active: 'yes' }, 'true / false'],
    ['feature', 'mChangePrice', { requires: ['noSuchFeature'] }, '機能マスタに無い'],
    ['feature', 'mChangePrice', { feature_key: 'mChangePrice2' }, '変えられません'],
    ['package', 'm_full', { features: ['mChangePrice', 'nope'] }, '機能マスタに無い'],
    ['package', 'm_full', { sort_order: '' }, '必須'],
    ['plan', '友達登録2週間トライアルプラン', { トライアル期間: 'x' }, '整数'],
    ['plan', '友達登録2週間トライアルプラン', { features: { mChangePrice: 'yes' } }, 'true / false'],
    ['plan', '友達登録2週間トライアルプラン', { features: { zzz: true } }, '機能マスタに無い'],
    ['ticket_price', '15', { PriceID: '' }, '必須'],
  ])('不正な値は 400 で保存しない: %s/%s %j', async (kind, key, values, message) => {
    const { db, batches } = makeDb();
    const res = await req(db, 'PATCH', `/api/furim/admin/masters/${kind}/${encodeURIComponent(key)}`, { values });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(message);
    expect(batches).toHaveLength(0);
  });

  it('追加: 新しいチケット単価を INSERT し、監査に (insert) と行 JSON。既にあるキーは 400', async () => {
    const { db, batches } = makeDb();
    const res = await req(db, 'POST', '/api/furim/admin/masters/ticket_price', { values: { 単価: '12', PriceID: 'price_12' } });
    expect(res.status).toBe(201);
    const ins = batches.flat().find((s) => s.sql.startsWith('INSERT INTO furim_master'))!;
    expect(ins.args).toEqual(['ticket_price', '12', '12', 'price_12', null, 1, JSON.stringify({ 単価: 12, PriceID: 'price_12' }), '2026-09-14T21:00:00.000+09:00']);
    expect(auditsOf(batches).map((a) => [a.args[4], a.args[5], a.args[7]])).toEqual([['ticket_price|12', '(insert)', JSON.stringify({ 単価: 12, PriceID: 'price_12' })]]);

    const dup = makeDb();
    const again = await req(dup.db, 'POST', '/api/furim/admin/masters/ticket_price', { values: { 単価: 15, PriceID: 'price_x' } });
    expect(again.status).toBe(400);
    expect(dup.batches).toHaveLength(0);
  });

  it('削除: パッケージが使っている機能は 400。使われていなければ DELETE と監査 (delete)', async () => {
    const used = makeDb();
    const res = await req(used.db, 'DELETE', '/api/furim/admin/masters/feature/mChangePrice');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('パッケージ m_full');
    expect(used.batches).toHaveLength(0);

    const { db, batches } = makeDb();
    const ok = await req(db, 'DELETE', '/api/furim/admin/masters/ticket_price/10');
    expect(ok.status).toBe(200);
    expect(batches.flat()[0].sql).toBe('DELETE FROM furim_master WHERE kind = ? AND key = ?');
    const audit = auditsOf(batches)[0];
    expect([audit.args[4], audit.args[5], JSON.parse(String(audit.args[6])).payload]).toEqual(['ticket_price|10', '(delete)', { 単価: 10, PriceID: fixture.ticketPrices.find((t) => t['単価'] === 10)!.PriceID }]);
  });

  it('staff ロールは追加・更新・削除が 403（読むのは可）', async () => {
    const { db, batches } = makeDb();
    expect((await req(db, 'GET', '/api/furim/admin/masters/feature', undefined, STAFF_KEY)).status).toBe(200);
    expect((await req(db, 'POST', '/api/furim/admin/masters/ticket_price', { values: { 単価: 12, PriceID: 'p' } }, STAFF_KEY)).status).toBe(403);
    expect((await req(db, 'PATCH', '/api/furim/admin/masters/feature/mChangePrice', { values: { monthly_price: 1 } }, STAFF_KEY)).status).toBe(403);
    expect((await req(db, 'DELETE', '/api/furim/admin/masters/ticket_price/10', undefined, STAFF_KEY)).status).toBe(403);
    expect(batches).toHaveLength(0);
  });

  it('汎用のデータ表の furim_master は読み取り専用（行編集・追加・削除できない）', async () => {
    const { db, batches } = makeDb();
    expect((await req(db, 'POST', '/api/furim/admin/furim_master', { values: { kind: 'plan', key: 'x', payload: '{}' } })).status).toBe(400);
    expect((await req(db, 'DELETE', '/api/furim/admin/furim_master/plan%7Cx')).status).toBe(400);
    expect(batches).toHaveLength(0);
  });
});
