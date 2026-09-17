import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@line-crm/db', () => ({ jstNow: () => '2026-09-13T12:00:00.000+09:00' }));

const gasGet = vi.fn();
vi.mock('./gas-client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gasGet,
}));

const sendPushToAll = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/push-notify.js', () => ({ sendPushToAll }));

const uid = (n: string) => 'U' + n.padStart(32, '0');
const { sheetRowToPatch, diffCustomerRow, isReconcileTick, reconcileFurimCustomers, backfillFurimCustomers } = await import('./customer-sync.js');

type Write = { sql: string; args: unknown[] };

/**
 * SQL 文字列でルーティングする簡易 D1。
 * - SELECT * FROM furim_customers → opts.customers
 * - SELECT * FROM furim_sync_diffs WHERE resolved_at IS NULL → opts.openDiffs
 * - notified_at IS NULL AND first_seen_at <= ? → opts.dueDiffs
 * - friends の display_name → opts.names
 * - batch / run は記録
 */
function makeDb(opts: { customers?: unknown[]; openDiffs?: unknown[]; dueDiffs?: unknown[]; names?: unknown[]; flags?: unknown[]; accepted?: unknown[] } = {}) {
  const writes: Write[] = [];
  const stmtFor = (sql: string, args: unknown[]) => ({
    sql,
    args,
    run: async () => { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
    first: async () => null,
    all: async () => {
      if (/FROM furim_feature_flags/.test(sql)) return { results: opts.flags ?? [] };
      if (/FROM furim_customers/.test(sql)) return { results: opts.customers ?? [] };
      if (/notified_at IS NULL AND first_seen_at/.test(sql)) return { results: opts.dueDiffs ?? [] };
      if (/notified_at LIKE 'accepted:%'/.test(sql)) return { results: opts.accepted ?? [] };
      if (/FROM furim_sync_diffs WHERE resolved_at IS NULL/.test(sql)) return { results: opts.openDiffs ?? [] };
      if (/FROM friends/.test(sql)) return { results: opts.names ?? [] };
      return { results: [] };
    },
  });
  const db = {
    prepare(sql: string) {
      const base = stmtFor(sql, []);
      return { ...base, bind: (...args: unknown[]) => stmtFor(sql, args) };
    },
    batch: async (stmts: Array<{ sql: string; args: unknown[] }>) => {
      for (const s of stmts) writes.push({ sql: s.sql, args: s.args });
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  } as unknown as D1Database;
  return { db, writes };
}

function customer(overrides: Record<string, unknown> = {}) {
  return {
    line_user_id: uid('1'), stripe_customer_id: 'cus_1', key_code: 'pb_abc', key_code_issued: 1, device_activated: 0,
    survey_answer: '紹介', free30_ticket: 0, youtube_coupon: null, extend_keyword: null, sheet_synced_at: null,
    created_at: '', updated_at: '', ...overrides,
  } as unknown as import('./customer-store.js').FurimCustomer;
}

function sheetRow(overrides: Record<string, unknown> = {}) {
  return {
    'LINE_ID': uid('1'), 'Stripe顧客ID': 'cus_1', 'キーコード': 'pb_abc', '初回発行': true, '端末判定文字列': '',
    'アンケート回答': '紹介', 'Free30チケット': false, 'Youtubeクーポン': '', '延長キーワード': '', ...overrides,
  };
}

const lineClient = { pushMessage: vi.fn().mockResolvedValue({}) };
const env = { GAS_DEPLOY_ID: 'dep-1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sheetRowToPatch', () => {
  it('シート列を furim_customers の列に写す（真偽は TRUE/true、空は null）', () => {
    expect(sheetRowToPatch(sheetRow({ '初回発行': 'TRUE', '端末判定文字列': '0.abc', 'Free30チケット': true, 'Youtubeクーポン': ' ', 'サブスク終了日時': '2026-09-20T03:00:00.000Z', 'コピー出品チケット': 30 }))).toMatchObject({
      stripe_customer_id: 'cus_1', key_code: 'pb_abc', key_code_issued: 1, device_activated: 1,
      survey_answer: '紹介', free30_ticket: 1, youtube_coupon: null, extend_keyword: null,
      subscription_end_at: '2026-09-20T12:00:00.000+09:00', copy_tickets: 30, mercari_url: null,
    });
  });
});

describe('diffCustomerRow', () => {
  it('D1 が正の列だけ比べ、null と空文字は同値', () => {
    const d = diffCustomerRow(uid('1'), sheetRowToPatch(sheetRow({ 'キーコード': 'pb_other', 'Youtubeクーポン': '' })), customer({ youtube_coupon: null }));
    expect(d).toEqual([{ lineUserId: uid('1'), field: 'key_code', d1Value: 'pb_abc', sheetValue: 'pb_other' }]);
  });

  it('device_activated（シート正）は diff にしない', () => {
    expect(diffCustomerRow(uid('1'), sheetRowToPatch(sheetRow({ '端末判定文字列': 'x' })), customer({ device_activated: 0 }))).toEqual([]);
  });
});

describe('isReconcileTick', () => {
  it('JST :15 と :45 だけ true', () => {
    const at = (h: number, m: number) => Date.UTC(2026, 8, 13, h - 9, m); // JST h:m
    expect(isReconcileTick(at(10, 15))).toBe(true);
    expect(isReconcileTick(at(10, 45))).toBe(true);
    expect(isReconcileTick(at(10, 0))).toBe(false);
    expect(isReconcileTick(at(10, 30))).toBe(false);
  });

  it('発火が秒単位で遅れても :15〜:19 と :45〜:49 は通し、その外は通さない', () => {
    const at = (h: number, m: number, s = 0, ms = 0) => Date.UTC(2026, 8, 13, h - 9, m, s, ms);
    expect(isReconcileTick(at(13, 15, 0))).toBe(true);
    expect(isReconcileTick(at(13, 16, 0, 300))).toBe(true);
    expect(isReconcileTick(at(13, 19, 59))).toBe(true);
    expect(isReconcileTick(at(13, 14, 59))).toBe(false);
    expect(isReconcileTick(at(13, 20, 0))).toBe(false);
    expect(isReconcileTick(at(13, 45, 0))).toBe(true);
    expect(isReconcileTick(at(13, 46, 0, 300))).toBe(true);
    expect(isReconcileTick(at(13, 49, 59))).toBe(true);
    expect(isReconcileTick(at(13, 44, 59))).toBe(false);
    expect(isReconcileTick(at(13, 50, 0))).toBe(false);
  });

  it('5 分 cron は発火の秒ずれがどこでも 30 分に 1 回だけ通る', () => {
    const base = Date.UTC(2026, 8, 13, 13 - 9, 0);
    for (let offset = 0; offset < 300_000; offset += 7_000) {
      const hits = Array.from({ length: 12 }, (_, i) => base + offset + i * 300_000).filter((t) => isReconcileTick(t));
      expect(hits).toHaveLength(2);
      expect(hits[1] - hits[0]).toBe(30 * 60_000);
    }
  });
});

const { checkReconcileStall, recordReconcileCompleted, RECONCILE_LAST_COMPLETED_KEY, RECONCILE_STALL_NOTIFIED_KEY } = await import('./customer-sync.js');

function makeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

describe('差分検知の停止通知', () => {
  const jst = (h: number, m: number, s = 0) => Date.UTC(2026, 8, 14, h - 9, m, s);

  it('完走したら完走時刻を書き、通知済みの印を消す', async () => {
    const kv = makeKv({ [RECONCILE_STALL_NOTIFIED_KEY]: 'x' });
    await recordReconcileCompleted(kv, jst(13, 15, 49));
    expect(kv.store.get(RECONCILE_LAST_COMPLETED_KEY)).toBe('2026-09-14T13:15:49.000+09:00');
    expect(kv.store.has(RECONCILE_STALL_NOTIFIED_KEY)).toBe(false);
  });

  it('完走時刻が 45 分未満なら通知しない', async () => {
    const kv = makeKv({ [RECONCILE_LAST_COMPLETED_KEY]: '2026-09-14T13:15:49.000+09:00' });
    const { db } = makeDb();
    expect(await checkReconcileStall(kv, db, lineClient as never, env, jst(14, 0, 48))).toBe('ok');
    expect(lineClient.pushMessage).not.toHaveBeenCalled();
  });

  it('45 分以上進まなければ LINE＋Web Push で 1 回だけ通知し、続く tick では送らない。完走で印が消えると次の停止でまた通知する', async () => {
    const kv = makeKv({ [RECONCILE_LAST_COMPLETED_KEY]: '2026-09-14T12:45:59.057+09:00' });
    const { db } = makeDb();
    expect(await checkReconcileStall(kv, db, lineClient as never, env, jst(13, 31))).toBe('notified');
    expect(lineClient.pushMessage).toHaveBeenCalledTimes(1);
    const text = (lineClient.pushMessage.mock.calls[0][1] as Array<{ text: string }>)[0].text;
    expect(text).toContain('45 分完走していません');
    expect(text).toContain('2026-09-14T12:45:59.057+09:00');
    expect(sendPushToAll).toHaveBeenCalledTimes(1);
    expect(await checkReconcileStall(kv, db, lineClient as never, env, jst(13, 36))).toBe('already-notified');
    expect(await checkReconcileStall(kv, db, lineClient as never, env, jst(14, 41))).toBe('already-notified');
    expect(lineClient.pushMessage).toHaveBeenCalledTimes(1);

    await recordReconcileCompleted(kv, jst(15, 15, 49));
    expect(await checkReconcileStall(kv, db, lineClient as never, env, jst(15, 20))).toBe('ok');
    expect(await checkReconcileStall(kv, db, lineClient as never, env, jst(16, 1))).toBe('notified');
    expect(lineClient.pushMessage).toHaveBeenCalledTimes(2);
  });

  it('完走時刻がまだ無ければ今を起点として書き、通知しない。GAS_DEPLOY_ID が無ければ何もしない', async () => {
    const kv = makeKv();
    const { db } = makeDb();
    expect(await checkReconcileStall(kv, db, lineClient as never, {}, jst(16, 0))).toBe('skipped');
    expect(kv.store.size).toBe(0);
    expect(await checkReconcileStall(kv, db, lineClient as never, env, jst(16, 0))).toBe('baseline');
    expect(kv.store.get(RECONCILE_LAST_COMPLETED_KEY)).toBe('2026-09-14T16:00:00.000+09:00');
    expect(lineClient.pushMessage).not.toHaveBeenCalled();
  });
});

describe('reconcileFurimCustomers', () => {
  it('ゲート外の tick は何もしない', async () => {
    const { db, writes } = makeDb();
    const r = await reconcileFurimCustomers(db, lineClient as never, env, { now: Date.UTC(2026, 8, 13, 1, 0) });
    expect(r.skipped).toBe('gate');
    expect(gasGet).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('端末判定文字列は取り込み、D1 正の列のズレは diff として記録、通知は猶予前ならしない', async () => {
    gasGet.mockResolvedValueOnce({ success: true, rows: [sheetRow({ '端末判定文字列': '0.dev', 'キーコード': 'pb_sheet' }), sheetRow({ 'LINE_ID': uid('9') })] });
    const { db, writes } = makeDb({ customers: [customer({ device_activated: 0 }), customer({ line_user_id: uid('2') })] });

    const r = await reconcileFurimCustomers(db, lineClient as never, env, { force: true });

    expect(r).toMatchObject({ sheetRows: 2, d1Rows: 2, pulled: 1, observedDiffs: 3, newDiffs: 3, resolvedDiffs: 0, notified: 0 });
    const pull = writes.find((w) => /INSERT INTO furim_customers/.test(w.sql));
    expect(pull?.args.slice(0, 2)).toEqual([uid('1'), 1]);
    const inserts = writes.filter((w) => /INSERT INTO furim_sync_diffs/.test(w.sql));
    expect(inserts.map((w) => [w.args[1], w.args[2]])).toEqual([
      [uid('1'), 'key_code'],
      [uid('9'), 'row_missing_in_d1'],
      [uid('2'), 'row_missing_in_sheet'],
    ]);
    expect(lineClient.pushMessage).not.toHaveBeenCalled();
    expect(sendPushToAll).not.toHaveBeenCalled();
  });

  it('検証用アカウント（あじゃぱー）はシートと D1 の突き合わせから外す（Capsec #301）', async () => {
    const test = 'Ue4941a030cb2ec8758095fb0fffff344';
    gasGet.mockResolvedValueOnce({ success: true, rows: [sheetRow({ 'LINE_ID': test, 'キーコード': '2weektrial_old' })] });
    const { db, writes } = makeDb({ customers: [customer({ line_user_id: test, key_code: '2weektrial_new' }), customer({ line_user_id: uid('7') })] });

    const r = await reconcileFurimCustomers(db, lineClient as never, env, { force: true });

    const inserts = writes.filter((w) => /INSERT INTO furim_sync_diffs/.test(w.sql));
    expect(inserts.some((w) => w.args[1] === test)).toBe(false);
    // 検証用以外（シートに無い uid(7)）は今までどおり出る
    expect(inserts.map((w) => [w.args[1], w.args[2]])).toEqual([[uid('7'), 'row_missing_in_sheet']]);
    expect(r.newDiffs).toBe(1);
  });

  it('人がシート側の誤りとして受け入れた差分は、シートの値が同じなら数え直さない（Capsec #289）', async () => {
    gasGet.mockResolvedValueOnce({ success: true, rows: [sheetRow({ 'LINE_ID': uid('9'), 'キーコード': '2weektrial_x' }), sheetRow({ 'Stripe顧客ID': 'cus_other' })] });
    const { db, writes } = makeDb({
      customers: [customer({ stripe_customer_id: null })],
      accepted: [
        { line_user_id: uid('9'), field: 'row_missing_in_d1', sheet_value: '2weektrial_x' },
        { line_user_id: uid('1'), field: 'stripe_customer_id', sheet_value: 'cus_old' },
      ],
    });

    const r = await reconcileFurimCustomers(db, lineClient as never, env, { force: true });

    const inserts = writes.filter((w) => /INSERT INTO furim_sync_diffs/.test(w.sql));
    // uid(9) の行なしは受け入れ済みで消える。uid(1) の Stripe 顧客 ID はシートの値が変わっている（cus_other）ので出る
    expect(inserts.map((w) => [w.args[1], w.args[2], w.args[4]])).toEqual([[uid('1'), 'stripe_customer_id', 'cus_other']]);
    expect(r.newDiffs).toBe(1);
  });

  it('継続中の diff は last_seen を更新し、消えた diff は resolved にする', async () => {
    gasGet.mockResolvedValueOnce({ success: true, rows: [sheetRow({ 'キーコード': 'pb_sheet' })] });
    const { db, writes } = makeDb({
      customers: [customer()],
      openDiffs: [
        { id: 'd-keep', line_user_id: uid('1'), field: 'key_code', first_seen_at: 'x', last_seen_at: 'x', notified_at: null, resolved_at: null },
        { id: 'd-gone', line_user_id: uid('1'), field: 'survey_answer', first_seen_at: 'x', last_seen_at: 'x', notified_at: null, resolved_at: null },
      ],
    });

    const r = await reconcileFurimCustomers(db, lineClient as never, env, { force: true });

    expect(r).toMatchObject({ newDiffs: 0, resolvedDiffs: 1 });
    expect(writes.some((w) => /SET d1_value = \?, sheet_value = \?, last_seen_at/.test(w.sql) && w.args[3] === 'd-keep')).toBe(true);
    expect(writes.some((w) => /SET resolved_at = \?/.test(w.sql) && w.args[1] === 'd-gone')).toBe(true);
  });

  it('猶予を超えた未通知の diff をスタッフ LINE＋Web Push で 1 回だけ通知し notified_at を立てる', async () => {
    gasGet.mockResolvedValueOnce({ success: true, rows: [sheetRow({ 'キーコード': 'pb_sheet' })] });
    const { db, writes } = makeDb({
      customers: [customer()],
      openDiffs: [{ id: 'd-1', line_user_id: uid('1'), field: 'key_code', d1_value: 'pb_abc', sheet_value: 'pb_sheet', first_seen_at: 'x', last_seen_at: 'x', notified_at: null, resolved_at: null }],
      dueDiffs: [{ id: 'd-1', line_user_id: uid('1'), field: 'key_code', d1_value: 'pb_abc', sheet_value: 'pb_sheet', first_seen_at: 'x', last_seen_at: 'x', notified_at: null, resolved_at: null }],
      names: [{ line_user_id: uid('1'), display_name: 'テスト太郎' }],
    });

    const r = await reconcileFurimCustomers(db, lineClient as never, env, { force: true });

    expect(r.notified).toBe(1);
    expect(lineClient.pushMessage).toHaveBeenCalledTimes(1);
    const text = (lineClient.pushMessage.mock.calls[0][1] as Array<{ text: string }>)[0].text;
    expect(text).toContain('差分 1 件');
    expect(text).toContain('テスト太郎 / key_code: D1=pb_abc / シート=pb_sheet');
    expect(sendPushToAll).toHaveBeenCalledTimes(1);
    expect(writes.some((w) => /SET notified_at = \?/.test(w.sql) && w.args[1] === 'd-1')).toBe(true);
  });

  it('GAS が落ちたら throw（cron 側で握る）', async () => {
    gasGet.mockRejectedValueOnce(new Error('GAS GET 500'));
    const { db } = makeDb();
    await expect(reconcileFurimCustomers(db, lineClient as never, env, { force: true })).rejects.toThrow('GAS GET 500');
  });
});

describe('backfillFurimCustomers', () => {
  it('dryRun は書かずに件数とサンプルを返す。実行時は全列 upsert', async () => {
    gasGet.mockResolvedValue({ success: true, rows: [sheetRow(), sheetRow({ 'LINE_ID': '' }), sheetRow({ 'LINE_ID': uid('2'), 'キーコード': '' })] });
    const { db, writes } = makeDb();

    const dry = await backfillFurimCustomers(db, 'dep-1', { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, totalRows: 3, targetCount: 2, upserted: 0 });
    expect(writes).toHaveLength(0);

    const real = await backfillFurimCustomers(db, 'dep-1', { dryRun: false });
    expect(real).toMatchObject({ dryRun: false, targetCount: 2, upserted: 2 });
    expect(writes).toHaveLength(2);
    expect(writes[0].sql).toContain('sheet_synced_at = excluded.sheet_synced_at');
    expect(writes[1].args[0]).toBe(uid('2'));
  });
});

// ── 段階3（Capsec #245）: 機能フラグの取り込み・Worker 認証済み顧客のシート取り込み停止・初期投入 ──
const { sheetRowToFeatureFlags, backfillFurimExtColumns } = await import('./customer-sync.js');

describe('sheetRowToFeatureFlags', () => {
  it('(mChangePrice) の列から右を機能列とみなし、bool は 1/0・文字列列はそのまま', () => {
    const row = sheetRow({
      'サブスク価格': 2980,
      'メルカリ値下げ機能\n(mChangePrice)': true,
      'メルカリ底値\n(mSetBottomPrice)': 'FALSE',
      '自動併売\n(AutoMultiChannel)': 'メルカリ/ラクマ',
      '在庫管理\n(InventorySheet)': '',
    });
    expect(sheetRowToFeatureFlags(row)).toEqual({ mChangePrice: '1', mSetBottomPrice: '0', AutoMultiChannel: 'メルカリ/ラクマ', InventorySheet: '' });
  });

  it('括弧付き見出しでも mChangePrice より左は機能列にしない', () => {
    expect(sheetRowToFeatureFlags(sheetRow({ '備考\n(memo)': 'x' }))).toEqual({});
  });
});

describe('reconcileFurimCustomers（段階3）', () => {
  it('Worker 経由で認証済み（ext_last_seen_at あり）の顧客はシートから端末判定/チケット/URL を取り込まない', async () => {
    gasGet.mockResolvedValueOnce({ success: true, rows: [sheetRow({ '端末判定文字列': '0.sheet', 'コピー出品チケット': 99 })] });
    const { db, writes } = makeDb({ customers: [customer({ device_activated: 1, device_code: 'worker-issued', copy_tickets: 3, ext_last_seen_at: '2026-09-14 03:00:00' })] });
    const r = await reconcileFurimCustomers(db, lineClient as never, env, { force: true });
    expect(r.pulled).toBe(0);
    expect(writes.some((w) => /INSERT INTO furim_customers/.test(w.sql))).toBe(false);
  });

  it('旧拡張の顧客は端末判定文字列（device_code）も取り込む', async () => {
    gasGet.mockResolvedValueOnce({ success: true, rows: [sheetRow({ '端末判定文字列': '0.sheet' })] });
    const { db, writes } = makeDb({ customers: [customer({ device_activated: 0, device_code: null, ext_last_seen_at: null })] });
    const r = await reconcileFurimCustomers(db, lineClient as never, env, { force: true });
    expect(r.pulled).toBe(1);
    const pull = writes.find((w) => /INSERT INTO furim_customers/.test(w.sql));
    expect(pull?.sql).toMatch(/device_code/);
    expect(pull?.args).toContain('0.sheet');
  });

  it('#262 旧拡張の顧客は ShopsURL・ラクマURL・ヤフフリURL もシートから取り込み、同じ値や空は書かない', async () => {
    gasGet.mockResolvedValueOnce({
      success: true,
      rows: [sheetRow({ 'ShopsURL': 'https://mercari-shops.com/shops/s1', 'ラクマURL': 'https://fril.jp/shop/r1', 'ヤフフリURL': '' })],
    });
    const { db, writes } = makeDb({
      customers: [customer({ ext_last_seen_at: null, shops_url: null, rakuma_url: 'https://fril.jp/shop/r1', yahoo_flea_url: null })],
    });
    const r = await reconcileFurimCustomers(db, lineClient as never, env, { force: true });
    expect(r.pulled).toBe(1);
    const pull = writes.find((w) => /INSERT INTO furim_customers/.test(w.sql));
    expect(pull?.sql).toMatch(/shops_url/);
    expect(pull?.sql).not.toMatch(/rakuma_url|yahoo_flea_url/);
    expect(pull?.args).toContain('https://mercari-shops.com/shops/s1');
  });

  it('#262 Worker 経由で認証済みの顧客は他 PF の URL もシートから取り込まない', async () => {
    gasGet.mockResolvedValueOnce({ success: true, rows: [sheetRow({ 'ShopsURL': 'https://mercari-shops.com/shops/s1' })] });
    const { db, writes } = makeDb({ customers: [customer({ ext_last_seen_at: '2026-09-14T03:00:00.000+09:00', shops_url: null })] });
    const r = await reconcileFurimCustomers(db, lineClient as never, env, { force: true });
    expect(r.pulled).toBe(0);
    expect(writes.some((w) => /INSERT INTO furim_customers/.test(w.sql))).toBe(false);
  });

  it('機能フラグは D1 と違う分だけ upsert する', async () => {
    gasGet.mockResolvedValueOnce({
      success: true,
      rows: [sheetRow({ 'メルカリ値下げ機能\n(mChangePrice)': true, '自動併売\n(AutoMultiChannel)': 'メルカリ' })],
    });
    const { db, writes } = makeDb({ customers: [customer()], flags: [{ line_user_id: uid('1'), feature_key: 'mChangePrice', value: '1' }] });
    const r = await reconcileFurimCustomers(db, lineClient as never, env, { force: true });
    expect(r.flagsPulled).toBe(1);
    const flagWrites = writes.filter((w) => /INSERT INTO furim_feature_flags/.test(w.sql));
    expect(flagWrites).toHaveLength(1);
    expect(flagWrites[0].args.slice(0, 3)).toEqual([uid('1'), 'AutoMultiChannel', 'メルカリ']);
  });

  it('#261 案 A: 固定した機能はシートと違っても取り込まず（UPSERT も出さない）、固定していない機能は従来どおり取り込む', async () => {
    gasGet.mockResolvedValueOnce({
      success: true,
      rows: [sheetRow({ 'メルカリ値下げ機能\n(mChangePrice)': false, 'メルカリバックアップ\n(mBackup)': true })],
    });
    const { db, writes } = makeDb({
      customers: [customer()],
      flags: [
        { line_user_id: uid('1'), feature_key: 'mChangePrice', value: '1', locked: 1 },
        { line_user_id: uid('1'), feature_key: 'mBackup', value: '0', locked: 0 },
      ],
    });
    const r = await reconcileFurimCustomers(db, lineClient as never, env, { force: true });
    expect(r.flagsPulled).toBe(1);
    const flagWrites = writes.filter((w) => /INSERT INTO furim_feature_flags/.test(w.sql));
    expect(flagWrites.map((w) => w.args.slice(1, 3))).toEqual([['mBackup', '1']]);
  });

  it('#261 案 A: 固定だけが違う顧客は取り込み件数に数えない', async () => {
    gasGet.mockResolvedValueOnce({ success: true, rows: [sheetRow({ 'メルカリ値下げ機能\n(mChangePrice)': false })] });
    const { db, writes } = makeDb({ customers: [customer()], flags: [{ line_user_id: uid('1'), feature_key: 'mChangePrice', value: '1', locked: 1 }] });
    const r = await reconcileFurimCustomers(db, lineClient as never, env, { force: true });
    expect(r.flagsPulled).toBe(0);
    expect(writes.some((w) => /INSERT INTO furim_feature_flags/.test(w.sql))).toBe(false);
  });
});

describe('backfillFurimExtColumns', () => {
  it('端末判定文字列・各サイト URL・在庫シート・機能フラグだけを写し、D1 が正の列は触らない', async () => {
    gasGet.mockResolvedValueOnce({
      success: true,
      rows: [
        sheetRow({ '端末判定文字列': '0.sheet', 'ShopsURL': 'https://mercari-shops.com/shops/1', '在庫管理シート': 'https://docs.google.com/x', 'メルカリ値下げ機能\n(mChangePrice)': true }),
        sheetRow({ 'LINE_ID': uid('2'), '端末判定文字列': '0.other' }),
        sheetRow({ 'LINE_ID': uid('3') }),
      ],
    });
    const { db, writes } = makeDb({ customers: [customer(), customer({ line_user_id: uid('2'), ext_last_seen_at: '2026-09-14 03:00:00' })] });
    const r = await backfillFurimExtColumns(db, 'dep-1', { dryRun: false });
    expect(r).toMatchObject({ dryRun: false, totalRows: 3, targetCount: 2 });
    const c1 = writes.find((w) => /INSERT INTO furim_customers/.test(w.sql) && w.args[0] === uid('1'));
    expect(c1?.sql).toMatch(/device_code/);
    expect(c1?.sql).toMatch(/shops_url/);
    expect(c1?.sql).toMatch(/inventory_sheet_url/);
    expect(c1?.sql).not.toMatch(/key_code/);
    expect(c1?.sql).not.toMatch(/subscription_end_at/);
    const c2 = writes.find((w) => /INSERT INTO furim_customers/.test(w.sql) && w.args[0] === uid('2'));
    expect(c2?.sql).not.toMatch(/device_code/);
    const flags = writes.filter((w) => /INSERT INTO furim_feature_flags/.test(w.sql));
    expect(flags.map((w) => [w.args[0], w.args[1], w.args[2]])).toEqual([[uid('1'), 'mChangePrice', '1']]);
  });

  it('dryRun は書かない', async () => {
    gasGet.mockResolvedValueOnce({ success: true, rows: [sheetRow({ '端末判定文字列': '0.sheet' })] });
    const { db, writes } = makeDb({ customers: [customer()] });
    const r = await backfillFurimExtColumns(db, 'dep-1', { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(writes).toHaveLength(0);
  });
});

const { pullFeatureFlagsFromSheet, upsertFeatureFlags } = await import('./customer-sync.js');

describe('pullFeatureFlagsFromSheet', () => {

  it('LINE_ID で 1 行だけ getData し、機能フラグを upsert する', async () => {
    gasGet.mockResolvedValueOnce({ success: true, rows: [sheetRow({ 'メルカリ値下げ機能\n(mChangePrice)': true, '自動併売\n(AutoMultiChannel)': '' })] });
    const { db, writes } = makeDb();
    expect(await pullFeatureFlagsFromSheet(db, 'dep-1', uid('1'))).toBe(true);
    expect(gasGet).toHaveBeenCalledWith('dep-1', expect.objectContaining({ method: 'getData', filterCol: 'LINE_ID', filterVal: uid('1') }), expect.anything());
    const flags = writes.filter((w) => /INSERT INTO furim_feature_flags/.test(w.sql));
    expect(flags.map((w) => [w.args[1], w.args[2]])).toEqual([['mChangePrice', '1'], ['AutoMultiChannel', '']]);
  });

  it('#261 案 A: 機能フラグの UPSERT は固定（locked=1）の行を更新しない（全自動経路が通る 1 か所）', async () => {
    gasGet.mockResolvedValueOnce({ success: true, rows: [sheetRow({ 'メルカリ値下げ機能\n(mChangePrice)': true })] });
    const { db, writes } = makeDb();
    await pullFeatureFlagsFromSheet(db, 'dep-1', uid('1'));
    const upsert = writes.find((w) => /INSERT INTO furim_feature_flags/.test(w.sql));
    expect(upsert?.sql.replace(/\s+/g, ' ')).toMatch(/ON CONFLICT\(line_user_id, feature_key\) DO UPDATE SET value = excluded\.value, source = excluded\.source, updated_at = excluded\.updated_at WHERE furim_feature_flags\.locked = 0$/);
  });

  it('GAS が落ちても投げず false（cron が取り込む）。deploy ID / lineUserId が無ければ何もしない', async () => {
    gasGet.mockRejectedValueOnce(new Error('GAS down'));
    const { db, writes } = makeDb();
    expect(await pullFeatureFlagsFromSheet(db, 'dep-1', uid('1'))).toBe(false);
    expect(writes).toHaveLength(0);
    expect(await pullFeatureFlagsFromSheet(db, undefined, uid('1'))).toBe(false);
    expect(await pullFeatureFlagsFromSheet(db, 'dep-1', null)).toBe(false);
  });
});

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
