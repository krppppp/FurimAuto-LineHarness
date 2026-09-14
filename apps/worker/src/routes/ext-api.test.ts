import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMocks = {
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getStaffByApiKey: vi.fn().mockResolvedValue(null),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
  jstNow: () => '2026-09-14T03:00:00.000+09:00',
};
vi.mock('@line-crm/db', () => dbMocks);

const worker = (await import('../index.js')).default;

type Stmt = { sql: string; args: unknown[] };
type Reply = { first?: unknown; all?: unknown[]; changes?: number };
type Router = (sql: string, args: unknown[]) => Reply | undefined;

/** SQL 文字列でルーティングする簡易 D1。発行した文と batch を記録する */
function makeDb(router: Router = () => undefined) {
  const statements: Stmt[] = [];
  const batches: Stmt[][] = [];
  const stmtFor = (sql: string, args: unknown[]) => {
    const reply = () => router(sql, args) ?? {};
    return {
      sql,
      args,
      first: async () => reply().first ?? null,
      all: async () => ({ results: reply().all ?? [] }),
      run: async () => ({ meta: { changes: reply().changes ?? 1 } }),
    };
  };
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const s = stmtFor(sql, args);
          statements.push({ sql, args });
          return s;
        },
      };
    },
    batch: async (stmts: Stmt[]) => {
      batches.push(stmts);
      return stmts.map((s) => ({ meta: { changes: (router(s.sql, s.args) ?? {}).changes ?? 1 } }));
    },
  } as unknown as D1Database;
  return { db, statements, batches };
}

function makeKv() {
  const store = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      const v = store.get(key);
      if (v == null) return null;
      return type === 'json' ? JSON.parse(v) : v;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  return { kv, store };
}

const CLIENT = 'ext/4.3.2';

function envWith(db: D1Database, kv?: unknown) {
  return {
    DB: db,
    FURIM_EXT_CACHE: kv,
    LINE_LOGIN_CHANNEL_ID: '2000000000',
    API_KEY: 'owner-key',
    WORKER_URL: 'https://worker.example.com',
  } as unknown as import('../index.js').Env['Bindings'];
}

function call(env: ReturnType<typeof envWith>, path: string, body: unknown, opts: { header?: string | null; ip?: string; method?: string; raw?: string } = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json', 'cf-connecting-ip': opts.ip ?? '203.0.113.10' });
  if (opts.header !== null) headers.set('X-FurimAuto-Client', opts.header ?? CLIENT);
  const method = opts.method ?? 'POST';
  return worker.fetch(
    new Request(`https://worker.example.com/api/ext/v1/${path}`, {
      method,
      headers,
      body: method === 'GET' ? undefined : (opts.raw ?? JSON.stringify(body)),
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
}

const U1 = 'U' + '1'.repeat(32);
const U2 = 'U' + '2'.repeat(32);

function customer(overrides: Record<string, unknown> = {}) {
  return {
    line_user_id: U1,
    key_code: 'pb_abc',
    key_code_issued: 1,
    device_activated: 0,
    device_code: null,
    subscription_end_at: '2099-01-01 00:00:00',
    plan_label: 'PBプラン:メルカリ 基本プラン',
    copy_tickets: 12,
    mercari_url: null,
    inventory_sheet_url: null,
    ext_last_seen_at: null,
    created_at: '2026-09-13 00:00:00',
    updated_at: '2026-09-13 00:00:00',
    ...overrides,
  };
}

const FLAGS = [
  { feature_key: 'mChangePrice', value: '1' },
  { feature_key: 'mSetBottomPrice', value: '0' },
  { feature_key: 'AutoMultiChannel', value: 'メルカリ/ラクマ' },
  { feature_key: 'InventorySheet', value: '1' },
];

/** furim_customers の 1 行と機能フラグを返す標準ルータ */
function customerRouter(row: Record<string, unknown> | null, extra: Router = () => undefined): Router {
  return (sql, args) => {
    const e = extra(sql, args);
    if (e) return e;
    if (/SELECT \* FROM furim_customers WHERE key_code = \?/.test(sql)) return { first: row };
    if (/SELECT line_user_id FROM furim_customers WHERE key_code = \?/.test(sql)) return { first: row ? { line_user_id: row.line_user_id } : null };
    if (/FROM furim_feature_flags WHERE line_user_id/.test(sql)) return { all: row ? FLAGS : [] };
    if (/mercari_url = \?/.test(sql)) return { first: null };
    return undefined;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('共通（ヘッダ・入力・JSON）', () => {
  it('X-FurimAuto-Client が無ければ 401 JSON', async () => {
    const { db } = makeDb();
    const res = await call(envWith(db), 'key-code-set', { keyCode: 'x' }, { header: null });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toMatchObject({ success: false, error: 'unauthorized' });
  });

  it('必須パラメータ欠落は 400 bad_request、JSON 壊れも 400', async () => {
    const { db, statements } = makeDb();
    const res = await call(envWith(db), 'key-code-set', {});
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: 'bad_request' });
    const broken = await call(envWith(db), 'key-code-set', null, { raw: '{keyCode:' });
    expect(broken.status).toBe(400);
    expect(statements).toHaveLength(0);
  });

  it('GET クエリでも同じパラメータで受ける', async () => {
    const { db } = makeDb(customerRouter(customer({ device_code: 'dev-1' })));
    const res = await worker.fetch(
      new Request('https://worker.example.com/api/ext/v1/key-code-set?keyCode=pb_abc&discriminationCode=dev-1', { headers: { 'X-FurimAuto-Client': CLIENT } }),
      envWith(db),
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, keyCode: 'pb_abc', discriminationCode: 'dev-1' });
  });

  it('スタッフ認証（authMiddleware）の対象外', async () => {
    const { db } = makeDb();
    const res = await call(envWith(db), 'line-display-name', { keyCode: 'nope' });
    expect(res.status).toBe(200);
    expect(dbMocks.getStaffByApiKey).not.toHaveBeenCalled();
  });
});

describe('POST /api/ext/v1/key-code-set', () => {
  it('初回認証: 端末判定文字列を発行して保存し、GAS と同じ形で返す', async () => {
    const { db, statements } = makeDb(customerRouter(customer()));
    const res = await call(envWith(db), 'key-code-set', { keyCode: 'pb_abc', mercariAccountUrl: 'https://jp.mercari.com/user/profile/1', version: '4.3.2' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      success: true,
      keyCode: 'pb_abc',
      expiredDate: '2099-01-01T00:00:00.000+09:00',
      copyCredit: 12,
      funcObject: { mChangePrice: true, mSetBottomPrice: false, AutoMultiChannel: 'メルカリ/ラクマ', InventorySheet: true },
    });
    expect(String(body.discriminationCode)).toMatch(/^[0-9a-z]{16}$/);
    const upsert = statements.find((s) => /INSERT INTO furim_customers/.test(s.sql));
    expect(upsert?.sql).toMatch(/device_code/);
    expect(upsert?.sql).toMatch(/device_activated/);
    expect(upsert?.sql).toMatch(/mercari_url/);
    expect(upsert?.sql).toMatch(/ext_last_seen_at/);
    expect(upsert?.args).toContain('https://jp.mercari.com/user/profile/1');
    expect(statements.some((s) => /INSERT INTO furim_ext_errors/.test(s.sql))).toBe(false);
  });

  it('無効キーコードは 200 + success:false（該当レコードなし）で Error 台帳に残す', async () => {
    const { db, statements } = makeDb(customerRouter(null));
    const res = await call(envWith(db), 'key-code-set', { keyCode: 'zzz' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: false,
      error: '該当レコードなし',
      errorMessage: '入力されたキーコードは登録されていません。公式LINEを確認した上で正しいキーコードをご確認ください。',
      keyCode: null,
      expiredDate: null,
    });
    const err = statements.find((s) => /INSERT INTO furim_ext_errors/.test(s.sql));
    expect(err?.args).toContain('getKeyCodeSet');
    expect(err?.args).toContain('該当レコードなし');
    expect(err?.args).toContain(CLIENT);
  });

  it('見つからないがメルカリURLが他の行に登録済み → キーコードが更新されました', async () => {
    const { db } = makeDb(customerRouter(null, (sql) => (/mercari_url = \?/.test(sql) ? { first: { line_user_id: U2 } } : undefined)));
    const res = await call(envWith(db), 'key-code-set', { keyCode: 'old', mercariAccountUrl: 'https://jp.mercari.com/user/profile/9' });
    expect(await res.json()).toMatchObject({ success: false, error: 'キーコードが更新されました' });
  });

  it('期限切れはプラン名で文言を出し分ける', async () => {
    const cases: Array<[string | null, string]> = [
      ['キャンセル済み(PBプラン)', 'プランキャンセル済み'],
      ['PBプラン:メルカリ 基本プラン', '有効期限切れ'],
      ['友達登録2週間トライアル', '無料期間終了'],
      [null, '無料期間終了'],
    ];
    for (const [plan, error] of cases) {
      const { db } = makeDb(customerRouter(customer({ subscription_end_at: '2020-01-01 00:00:00', plan_label: plan, device_code: 'dev-1' })));
      const res = await call(envWith(db), 'key-code-set', { keyCode: 'pb_abc', discriminationCode: 'dev-1' });
      expect(await res.json()).toMatchObject({ success: false, error });
    }
  });

  it('期限が空の行は GAS と同じく通す', async () => {
    const { db } = makeDb(customerRouter(customer({ subscription_end_at: null, device_code: 'dev-1' })));
    const res = await call(envWith(db), 'key-code-set', { keyCode: 'pb_abc', discriminationCode: 'dev-1' });
    expect(await res.json()).toMatchObject({ success: true, expiredDate: '' });
  });

  it('端末判定文字列の不一致は不正利用。クライアント未保持＋メルカリURL一致なら再発行で救済', async () => {
    const { db } = makeDb(customerRouter(customer({ device_code: 'dev-1', mercari_url: 'https://jp.mercari.com/user/profile/1' })));
    const ng = await call(envWith(db), 'key-code-set', { keyCode: 'pb_abc', discriminationCode: 'other', mercariAccountUrl: 'https://jp.mercari.com/user/profile/1' });
    expect(await ng.json()).toMatchObject({ success: false, error: '端末判定文字列が一致しないので不正利用' });

    const rescued = await call(envWith(db), 'key-code-set', { keyCode: 'pb_abc', mercariAccountUrl: 'https://jp.mercari.com/user/profile/1' });
    const body = (await rescued.json()) as { success: boolean; discriminationCode: string };
    expect(body.success).toBe(true);
    expect(body.discriminationCode).not.toBe('dev-1');
    expect(body.discriminationCode).toMatch(/^[0-9a-z]{16}$/);

    const noUrl = await call(envWith(db), 'key-code-set', { keyCode: 'pb_abc' });
    expect(await noUrl.json()).toMatchObject({ success: false, error: '端末判定文字列が一致しないので不正利用' });
  });

  it('メルカリURL不一致・重複', async () => {
    const mismatch = makeDb(customerRouter(customer({ device_code: 'dev-1', mercari_url: 'https://jp.mercari.com/user/profile/1' })));
    const r1 = await call(envWith(mismatch.db), 'key-code-set', { keyCode: 'pb_abc', discriminationCode: 'dev-1', mercariAccountUrl: 'https://jp.mercari.com/user/profile/2' });
    expect(await r1.json()).toMatchObject({
      success: false,
      error: 'メルカリURL不一致',
      errorMessage: '登録されているメルカリアカウントと異なるアカウントからのアクセスです。このキーコードは「https://jp.mercari.com/user/profile/1」に紐づけられています。',
    });

    const dup = makeDb(customerRouter(customer({ device_code: 'dev-1' }), (sql) => (/mercari_url = \?/.test(sql) ? { first: { line_user_id: U2 } } : undefined)));
    const r2 = await call(envWith(dup.db), 'key-code-set', { keyCode: 'pb_abc', discriminationCode: 'dev-1', mercariAccountUrl: 'https://jp.mercari.com/user/profile/2' });
    const b2 = (await r2.json()) as { success: boolean; error: string; errorMessage: string };
    expect(b2).toMatchObject({ success: false, error: 'メルカリURL重複' });
    expect(b2.errorMessage).toContain('まだメルカリアカウントが紐づけられていません');
  });

  it('KV キャッシュ: 2 回目は D1 の顧客行を読まず、キャッシュ由来の業務エラーは D1 を読み直してから確定する', async () => {
    const { kv } = makeKv();
    let row = customer({ device_code: 'dev-1', mercari_url: 'https://jp.mercari.com/user/profile/1' });
    const { db, statements } = makeDb(customerRouter(row, (sql) => (/SELECT \* FROM furim_customers WHERE key_code/.test(sql) ? { first: row } : undefined)));
    const env = envWith(db, kv);

    const first = await call(env, 'key-code-set', { keyCode: 'pb_abc', discriminationCode: 'dev-1' });
    expect(await first.json()).toMatchObject({ success: true });
    expect(kv.put).toHaveBeenCalledTimes(1);
    const selectsAfterFirst = statements.filter((s) => /SELECT \* FROM furim_customers WHERE key_code/.test(s.sql)).length;
    expect(selectsAfterFirst).toBe(1);

    const second = await call(env, 'key-code-set', { keyCode: 'pb_abc', discriminationCode: 'dev-1' });
    expect(await second.json()).toMatchObject({ success: true });
    expect(statements.filter((s) => /SELECT \* FROM furim_customers WHERE key_code/.test(s.sql)).length).toBe(1);
    expect(kv.get).toHaveBeenCalledTimes(2);

    // LINE でキーコードリセット → D1 の device_code は空。KV はまだ旧値
    row = customer({ device_code: null, mercari_url: 'https://jp.mercari.com/user/profile/1' });
    const third = await call(env, 'key-code-set', { keyCode: 'pb_abc', discriminationCode: 'stale-client' });
    const body = (await third.json()) as { success: boolean; discriminationCode: string };
    expect(body.success).toBe(true);
    expect(body.discriminationCode).toMatch(/^[0-9a-z]{16}$/);
    expect(statements.filter((s) => /SELECT \* FROM furim_customers WHERE key_code/.test(s.sql)).length).toBe(2);
    expect(kv.delete).toHaveBeenCalledWith('kc:pb_abc');
  });

  it('KV が壊れていても D1 だけで動く', async () => {
    const kv = { get: vi.fn().mockRejectedValue(new Error('kv down')), put: vi.fn().mockRejectedValue(new Error('kv down')), delete: vi.fn().mockRejectedValue(new Error('kv down')) };
    const { db } = makeDb(customerRouter(customer({ device_code: 'dev-1' })));
    const res = await call(envWith(db, kv), 'key-code-set', { keyCode: 'pb_abc', discriminationCode: 'dev-1' });
    expect(await res.json()).toMatchObject({ success: true });
  });

  it('D1 が落ちたら 500 JSON（internal）', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1 down'); } }) }) } as unknown as D1Database;
    const res = await call(envWith(db), 'key-code-set', { keyCode: 'pb_abc' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false, error: 'internal' });
  });
});

describe('POST /api/ext/v1/copy-credit', () => {
  it('delta が無い（絶対値のみ）・dedupeKey が無いは 400', async () => {
    const { db } = makeDb();
    const abs = await call(envWith(db), 'copy-credit', { keyCode: 'pb_abc', copyCredit: 5, dedupeKey: 'k1' });
    expect(abs.status).toBe(400);
    const noKey = await call(envWith(db), 'copy-credit', { keyCode: 'pb_abc', delta: -1 });
    expect(noKey.status).toBe(400);
  });

  it('自動コピー出品履歴に consume:<dedupeKey> を積み、残数を減らして返す（1 batch・台帳には書かない）', async () => {
    const { db, batches, statements } = makeDb(customerRouter(customer({ copy_tickets: 12 }), (sql) => (/SELECT copy_tickets FROM furim_customers/.test(sql) ? { first: { copy_tickets: 11 } } : undefined)));
    const res = await call(envWith(db), 'copy-credit', { keyCode: 'pb_abc', delta: -1, dedupeKey: 'k1', sourceUrl: 'https://jp.mercari.com/item/m1', targetUrl: 'https://fril.jp/x' });
    expect(await res.json()).toEqual({ success: true, keyCode: 'pb_abc', copyCredit: 11, message: 'コピー出品チケットを更新しました' });
    expect(batches).toHaveLength(1);
    expect(batches[0][0].sql).toMatch(/INSERT OR IGNORE INTO furim_auto_copy_logs/);
    expect(batches[0][0].args).toContain('consume:k1');
    expect(batches[0][0].args).toContain(-1);
    expect(batches[0][0].args).toEqual(expect.arrayContaining(['https://jp.mercari.com/item/m1', 'https://fril.jp/x']));
    expect(batches[0][1].sql).toMatch(/MAX\(0, COALESCE\(copy_tickets, 0\) \+ \?\)/);
    expect(batches[0][1].sql).toMatch(/EXISTS \(SELECT 1 FROM furim_auto_copy_logs WHERE id = \?\)/);
    expect(statements.some((s) => /INSERT (OR IGNORE )?INTO furim_ticket_ledger/.test(s.sql))).toBe(false);
    expect(statements.some((s) => /INSERT INTO furim_ext_errors/.test(s.sql))).toBe(false);
  });

  it('同じ dedupeKey の再送は残数を変えず現在値を返す', async () => {
    const { db } = makeDb(customerRouter(customer({ copy_tickets: 11 }), (sql) => {
      if (/INSERT OR IGNORE INTO furim_auto_copy_logs/.test(sql)) return { changes: 0 };
      if (/SELECT copy_tickets FROM furim_customers/.test(sql)) return { first: { copy_tickets: 11 } };
      return undefined;
    }));
    const res = await call(envWith(db), 'copy-credit', { keyCode: 'pb_abc', delta: -1, dedupeKey: 'k1' });
    expect(await res.json()).toEqual({ success: true, keyCode: 'pb_abc', copyCredit: 11, message: '再送のためスキップしました' });
  });

  it('キーコード不明は 200 + success:false', async () => {
    const { db } = makeDb(customerRouter(null));
    const res = await call(envWith(db), 'copy-credit', { keyCode: 'zzz', delta: -1, dedupeKey: 'k1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: false, error: '該当レコードなし', keyCode: 'zzz', copyCredit: null });
  });
});

describe('POST /api/ext/v1/execution-log', () => {
  const params = {
    keyCode: 'pb_abc',
    dedupeKey: 'd1',
    service: 'メルカリ',
    accountUrl: 'https://jp.mercari.com/user/profile/1',
    mypageInfoUpdatedDate: '2026/09/14 03:00:00',
    countRating: 600,
    salesAmount: 22222,
    totalTargetCount: 12,
    options: JSON.stringify({ m_changePrice: ['-100', '円'] }),
  };

  it('payload 丸ごとと主要列を保存し、service のアカウント URL を顧客に保存する', async () => {
    const { db, statements } = makeDb(customerRouter(customer()));
    const res = await call(envWith(db), 'execution-log', params);
    expect(await res.json()).toEqual({ success: true });
    const ins = statements.find((s) => /INSERT OR IGNORE INTO furim_execution_logs/.test(s.sql));
    expect(ins?.args).toContain(U1);
    expect(ins?.args).toContain('メルカリ');
    expect(ins?.args).toContain('d1');
    expect(ins?.args).toContain(CLIENT);
    expect(ins?.args).toContain('600');
    expect(JSON.parse(String(ins?.args[12]))).toMatchObject({ keyCode: 'pb_abc', service: 'メルカリ' });
    const url = statements.find((s) => /INSERT INTO furim_customers/.test(s.sql));
    expect(url?.sql).toMatch(/mercari_url/);
    expect(url?.args).toContain('https://jp.mercari.com/user/profile/1');
  });

  it('同じ dedupeKey は再送スキップ、キーコード不明は 200 + success:false', async () => {
    const dup = makeDb(customerRouter(customer({ mercari_url: params.accountUrl }), (sql) => (/INSERT OR IGNORE INTO furim_execution_logs/.test(sql) ? { changes: 0 } : undefined)));
    const r1 = await call(envWith(dup.db), 'execution-log', params);
    expect(await r1.json()).toEqual({ success: true, message: '再送のためスキップ' });
    expect(dup.statements.some((s) => /INSERT INTO furim_customers/.test(s.sql))).toBe(false);

    const missing = makeDb(customerRouter(null));
    const r2 = await call(envWith(missing.db), 'execution-log', params);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ success: false, error: '該当レコードなし' });
    expect(missing.statements.some((s) => /INSERT INTO furim_ext_errors/.test(s.sql))).toBe(true);
  });
});

describe('POST /api/ext/v1/inventory-sheet-created', () => {
  const url = 'https://docs.google.com/spreadsheets/d/abc/edit';
  it('同じ URL なら alreadySet、違えば置き換え、無ければ spreadsheetUrlなし', async () => {
    const same = makeDb(customerRouter(customer({ inventory_sheet_url: url })));
    expect(await (await call(envWith(same.db), 'inventory-sheet-created', { keyCode: 'pb_abc', spreadsheetUrl: url })).json()).toEqual({ success: true, alreadySet: true, spreadsheetUrl: url });
    expect(same.statements.some((s) => /INSERT INTO furim_customers/.test(s.sql))).toBe(false);

    const replace = makeDb(customerRouter(customer({ inventory_sheet_url: 'https://docs.google.com/spreadsheets/d/old/edit' })));
    expect(await (await call(envWith(replace.db), 'inventory-sheet-created', { keyCode: 'pb_abc', spreadsheetUrl: url })).json()).toEqual({ success: true, spreadsheetUrl: url, replaced: true });
    const up = replace.statements.find((s) => /INSERT INTO furim_customers/.test(s.sql));
    expect(up?.sql).toMatch(/inventory_sheet_url/);
    expect(up?.sql).toMatch(/inventory_sheet_created_at/);

    const fresh = makeDb(customerRouter(customer()));
    expect(await (await call(envWith(fresh.db), 'inventory-sheet-created', { keyCode: 'pb_abc', spreadsheetUrl: url })).json()).toEqual({ success: true, spreadsheetUrl: url, replaced: false });

    expect(await (await call(envWith(fresh.db), 'inventory-sheet-created', { keyCode: 'pb_abc' })).json()).toEqual({ success: false, error: 'spreadsheetUrlなし' });
    const missing = makeDb(customerRouter(null));
    expect(await (await call(envWith(missing.db), 'inventory-sheet-created', { keyCode: 'zzz', spreadsheetUrl: url })).json()).toEqual({ success: false, error: '該当レコードなし' });
  });
});

describe('POST /api/ext/v1/line-display-name', () => {
  it('friends.display_name を返す。無ければ success:false', async () => {
    const { db } = makeDb(customerRouter(customer(), (sql) => (/FROM friends WHERE line_user_id/.test(sql) ? { first: { display_name: 'くろ' } } : undefined)));
    expect(await (await call(envWith(db), 'line-display-name', { keyCode: 'pb_abc' })).json()).toEqual({ success: true, lineDisplayName: 'くろ' });
    const missing = makeDb(customerRouter(null));
    expect(await (await call(envWith(missing.db), 'line-display-name', { keyCode: 'zzz' })).json()).toEqual({ success: false, errorMessage: '該当レコードなし' });
  });
});

describe('POST /api/ext/v1/free-account', () => {
  const installId = '0123456789abcdef-0123';
  it('installId 不正・URL 不正・更新内容なし', async () => {
    const { db } = makeDb();
    expect(await (await call(envWith(db), 'free-account', { installId: 'short', mercariUrl: 'https://jp.mercari.com/user/profile/1' })).json()).toEqual({ success: false, error: 'installId不正' });
    expect(await (await call(envWith(db), 'free-account', { installId, mercariUrl: 'https://evil.example/' })).json()).toEqual({ success: false, error: 'mercariUrl不正' });
    expect(await (await call(envWith(db), 'free-account', { installId })).json()).toEqual({ success: false, error: '更新内容なし' });
  });

  it('新規は created、既存は URL を改行区切りで追記しキーコードは上書き', async () => {
    const created = makeDb((sql) => (/FROM furim_free_accounts/.test(sql) ? { first: null } : undefined));
    expect(await (await call(envWith(created.db), 'free-account', { installId, mercariUrl: 'https://jp.mercari.com/user/profile/1', keyCode: 'pb_abc' })).json()).toEqual({ success: true, created: true });
    const ins = created.statements.find((s) => /INSERT INTO furim_free_accounts/.test(s.sql));
    expect(ins?.args.slice(0, 2)).toEqual([installId, 'https://jp.mercari.com/user/profile/1']);

    const existing = { install_id: installId, mercari_url: 'https://jp.mercari.com/user/profile/1', rakuma_url: null, yahoo_flea_url: null, yahoo_auction_url: null, shops_url: null, key_code: 'old' };
    const updated = makeDb((sql) => (/FROM furim_free_accounts/.test(sql) ? { first: existing } : undefined));
    expect(await (await call(envWith(updated.db), 'free-account', { installId, mercariUrl: 'https://jp.mercari.com/user/profile/2', keyCode: 'pb_abc' })).json()).toEqual({ success: true, updated: true });
    const up = updated.statements.find((s) => /UPDATE furim_free_accounts/.test(s.sql));
    expect(up?.args).toContain('https://jp.mercari.com/user/profile/1\nhttps://jp.mercari.com/user/profile/2');
    expect(up?.args).toContain('pb_abc');

    const noop = makeDb((sql) => (/FROM furim_free_accounts/.test(sql) ? { first: existing } : undefined));
    expect(await (await call(envWith(noop.db), 'free-account', { installId, mercariUrl: 'https://jp.mercari.com/user/profile/1', keyCode: 'old' })).json()).toEqual({ success: true, updated: false });
    expect(noop.statements.some((s) => /UPDATE furim_free_accounts/.test(s.sql))).toBe(false);
  });
});

describe('POST /api/ext/v1/manual-copy-log', () => {
  const base = { installId: '0123456789abcdef-0123', keyCode: 'pb_abc', itemId: 'm1', itemName: '商品', target: 'rakuma', dedupeKey: 'mc1', sourceUrl: 'https://jp.mercari.com/item/m1' };
  it('stage 不正・dedupeKey なし', async () => {
    const { db } = makeDb();
    expect(await (await call(envWith(db), 'manual-copy-log', { ...base, stage: 'x' })).json()).toEqual({ success: false, error: 'stage不正' });
    expect(await (await call(envWith(db), 'manual-copy-log', { ...base, stage: 'started', dedupeKey: '' })).json()).toEqual({ success: false, error: 'dedupeKeyなし' });
  });

  it('started は行を積んで usedCount、再送はスキップ、submitted は完了に更新、abandoned は対象行なし', async () => {
    const none = makeDb(customerRouter(customer(), (sql) => {
      if (/FROM furim_manual_copy_logs WHERE dedupe_key/.test(sql)) return { first: null };
      if (/COUNT\(\*\) AS n FROM furim_manual_copy_logs/.test(sql)) return { first: { n: 3 } };
      return undefined;
    }));
    expect(await (await call(envWith(none.db), 'manual-copy-log', { ...base, stage: 'started' })).json()).toEqual({ success: true, created: true, usedCount: 3 });
    const ins = none.statements.find((s) => /INSERT OR IGNORE INTO furim_manual_copy_logs/.test(s.sql));
    expect(ins?.sql).toMatch(/'開始'/);
    expect(ins?.args).toContain(U1);

    const exists = makeDb(customerRouter(customer(), (sql) => {
      if (/FROM furim_manual_copy_logs WHERE dedupe_key/.test(sql)) return { first: { id: 'row1', status: '開始' } };
      if (/COUNT\(\*\) AS n FROM furim_manual_copy_logs/.test(sql)) return { first: { n: 3 } };
      return undefined;
    }));
    expect(await (await call(envWith(exists.db), 'manual-copy-log', { ...base, stage: 'started' })).json()).toEqual({ success: true, message: '再送のためスキップ', usedCount: 3 });
    expect(await (await call(envWith(exists.db), 'manual-copy-log', { ...base, stage: 'submitted', targetUrl: 'https://fril.jp/x' })).json()).toEqual({ success: true, updated: true });
    const up = exists.statements.find((s) => /SET status = '出品完了'/.test(s.sql));
    expect(up?.args).toEqual(['https://fril.jp/x', '2026-09-14T03:00:00.000+09:00', 'row1']);

    expect(await (await call(envWith(none.db), 'manual-copy-log', { ...base, stage: 'abandoned' })).json()).toEqual({ success: true, message: '対象行なし' });
    expect(await (await call(envWith(exists.db), 'manual-copy-log', { ...base, stage: 'abandoned' })).json()).toEqual({ success: true, updated: true });
  });
});

describe('POST /api/ext/v1/shop-research-log', () => {
  const base = { installId: '0123456789abcdef-0123', keyCode: '', myMercariUrl: 'https://jp.mercari.com/user/profile/1', targetUrl: 'https://jp.mercari.com/user/profile/9', isFree: '1', dedupeKey: 'sr_1' };
  it('targetUrl 不正・dedupeKey なし', async () => {
    const { db } = makeDb();
    expect(await (await call(envWith(db), 'shop-research-log', { ...base, targetUrl: 'https://fril.jp/x' })).json()).toEqual({ success: false, error: 'targetUrl不正' });
    expect(await (await call(envWith(db), 'shop-research-log', { ...base, dedupeKey: '' })).json()).toEqual({ success: false, error: 'dedupeKeyなし' });
  });

  it('記録して無料枠の usedCount を返す。再送はスキップ。表示名の逆引きは自分のメルカリURL でも行う', async () => {
    const { db, statements } = makeDb((sql) => {
      if (/mercari_url = \?/.test(sql)) return { first: { line_user_id: U1 } };
      if (/COUNT\(\*\) AS n FROM furim_shop_research_logs/.test(sql)) return { first: { n: 2 } };
      return undefined;
    });
    expect(await (await call(envWith(db), 'shop-research-log', base)).json()).toEqual({ success: true, created: true, usedCount: 2 });
    const ins = statements.find((s) => /INSERT OR IGNORE INTO furim_shop_research_logs/.test(s.sql));
    expect(ins?.args).toContain(U1);
    expect(ins?.args).toContain(1);

    const dup = makeDb((sql) => {
      if (/INSERT OR IGNORE INTO furim_shop_research_logs/.test(sql)) return { changes: 0 };
      if (/COUNT\(\*\) AS n FROM furim_shop_research_logs/.test(sql)) return { first: { n: 2 } };
      return undefined;
    });
    expect(await (await call(envWith(dup.db), 'shop-research-log', base)).json()).toEqual({ success: true, message: '再送のためスキップ', usedCount: 2 });
  });
});

describe('流量制限', () => {
  it('IP 単位 120 req/分を超えると 429 rate_limited（JSON）', async () => {
    const { db } = makeDb(customerRouter(customer({ device_code: 'dev-1' })));
    const env = envWith(db);
    let last: Response | null = null;
    for (let i = 0; i < 121; i++) {
      last = await call(env, 'line-display-name', { keyCode: 'pb_abc' }, { ip: '198.51.100.77' });
    }
    expect(last?.status).toBe(429);
    expect(await last?.json()).toMatchObject({ success: false, error: 'rate_limited' });
  });
});

describe('CORS（Chrome 拡張の origin）', () => {
  const EXT_ORIGIN = 'chrome-extension://ijadldonnopnaalnlmoomdnjhbogjjhf';

  function preflight(path: string, origin: string, requestHeaders = 'x-furimauto-client,content-type') {
    const { db } = makeDb();
    return worker.fetch(
      new Request(`https://worker.example.com${path}`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': requestHeaders,
          'cf-connecting-ip': '203.0.113.10',
        },
      }),
      envWith(db),
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
  }

  it('プリフライトは 204 で拡張の origin を反射し、X-FurimAuto-Client を許可する（auth / ヘッダ検査に届かない）', async () => {
    const res = await preflight('/api/ext/v1/key-code-set', EXT_ORIGIN);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(EXT_ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('x-furimauto-client');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET,POST,OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(res.headers.get('Access-Control-Max-Age')).toBe('600');
  });

  it('本番・dev など別の拡張 ID も反射する。chrome-extension 以外は反射しない', async () => {
    for (const id of ['ieogmhpajeapjjikkdbkkkapgjfkhign', 'abcdefghijklmnopabcdefghijklmnop']) {
      const res = await preflight('/api/ext/v1/execution-log', `chrome-extension://${id}`);
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(`chrome-extension://${id}`);
    }
    const res = await preflight('/api/ext/v1/execution-log', 'https://evil.example.com');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('実リクエストのレスポンスにも拡張の origin が付く（不正キーでも 200 JSON）', async () => {
    const { db } = makeDb();
    const res = await worker.fetch(
      new Request('https://worker.example.com/api/ext/v1/key-code-set', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-FurimAuto-Client': CLIENT,
          Origin: EXT_ORIGIN,
          'cf-connecting-ip': '203.0.113.10',
        },
        body: JSON.stringify({ keyCode: 'nope' }),
      }),
      envWith(db),
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(EXT_ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });

  it('管理 API の CORS は従来のまま（同一 origin を反射・credentials あり・拡張の origin は反射しない）', async () => {
    const same = await preflight('/api/friends', 'https://worker.example.com', 'content-type,x-csrf-token');
    expect(same.status).toBe(204);
    expect(same.headers.get('Access-Control-Allow-Origin')).toBe('https://worker.example.com');
    expect(same.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(same.headers.get('Access-Control-Allow-Headers')).toContain('X-CSRF-Token');
    expect(same.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).not.toContain('x-furimauto-client');

    const ext = await preflight('/api/friends', EXT_ORIGIN);
    expect(ext.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
