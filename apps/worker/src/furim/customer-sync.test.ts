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
function makeDb(opts: { customers?: unknown[]; openDiffs?: unknown[]; dueDiffs?: unknown[]; names?: unknown[]; flags?: unknown[] } = {}) {
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
      subscription_end_at: '2026-09-20 12:00:00', copy_tickets: 30, mercari_url: null,
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
