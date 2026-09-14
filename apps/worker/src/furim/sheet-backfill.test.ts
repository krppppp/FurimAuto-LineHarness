import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@line-crm/db', () => ({
  jstNow: () => '2026-09-14T12:00:00.000+09:00',
  toJstString: (d: Date) => new Date(d.getTime() + 9 * 60 * 60_000).toISOString().slice(0, -1) + '+09:00',
}));

const gasGet = vi.fn();
vi.mock('./gas-client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gasGet,
}));

const {
  SHEET_BACKFILL_SPECS,
  getSheetSpec,
  isTypeRow,
  jst,
  rowHash,
  mapSheetRows,
  buildInsertStatements,
  loadResolveContext,
  backfillSheet,
} = await import('./sheet-backfill.js');

const uid = (n: string) => 'U' + n.padStart(32, '0');
const NOW = '2026-09-14T12:00:00.000+09:00';

// 表ごとの一意キー（PK / UNIQUE）。INSERT OR IGNORE の挙動をここで模す
const UNIQUE_COLS: Record<string, string[]> = {
  furim_payments: ['invoice_id'],
  furim_ticket_ledger: ['id', 'idempotency_key'],
  furim_execution_logs: ['id', 'dedupe_key'],
  furim_auto_copy_logs: ['id', 'idempotency_key'],
  furim_ext_errors: ['id'],
  furim_manual_copy_logs: ['id', 'dedupe_key'],
  furim_shop_research_logs: ['id', 'dedupe_key'],
  furim_free_accounts: ['install_id'],
  furim_survey_answers: ['id'],
  furim_coupon_applications: ['id'],
  furim_cancellations: ['id'],
  furim_referral_cashbacks: ['id'],
  furim_master: ['kind|key'],
};

type Stored = Record<string, unknown>;

/**
 * INSERT 文を解釈して表ごとの行を保持する簡易 D1。
 * PK/UNIQUE の衝突は INSERT OR IGNORE なら捨て、ON CONFLICT DO UPDATE なら置き換える
 */
function makeDb(fixtures: { customers?: Stored[]; friends?: Stored[] } = {}) {
  const tables = new Map<string, Map<string, Stored>>();
  const tableOf = (name: string) => {
    let t = tables.get(name);
    if (!t) { t = new Map(); tables.set(name, t); }
    return t;
  };
  const uniqueKeys = (table: string, row: Stored) =>
    (UNIQUE_COLS[table] ?? ['id'])
      .map((u) => u.split('|').map((c) => row[c]))
      .filter((vals) => vals.every((v) => v != null))
      .map((vals) => vals.map(String).join('|'));
  const apply = (sql: string, args: unknown[]): number => {
    const fill = sql.match(/^UPDATE furim_auto_copy_logs SET remaining_tickets = \? WHERE id = \? AND remaining_tickets IS NULL$/);
    if (fill) {
      const r = tableOf('furim_auto_copy_logs').get(String(args[1]));
      if (!r || r.remaining_tickets != null) return 0;
      r.remaining_tickets = args[0];
      return 1;
    }
    const m = sql.match(/^INSERT(?: OR IGNORE)? INTO (\w+) \(([^)]+)\) VALUES/);
    if (!m) throw new Error(`unexpected sql: ${sql}`);
    const table = m[1];
    const cols = m[2].split(',').map((s) => s.trim());
    const upsert = /ON CONFLICT/.test(sql);
    const t = tableOf(table);
    let changes = 0;
    for (let i = 0; i < args.length; i += cols.length) {
      const row: Stored = {};
      cols.forEach((c, j) => { row[c] = args[i + j]; });
      const keys = uniqueKeys(table, row);
      const existing = [...t.values()].find((r) => uniqueKeys(table, r).some((k) => keys.includes(k)));
      if (existing && !upsert) continue;
      if (existing) t.delete(keys[0]);
      t.set(keys[0], row);
      changes++;
    }
    return changes;
  };
  const stmtFor = (sql: string, args: unknown[]) => ({
    sql,
    args,
    run: async () => ({ meta: { changes: apply(sql, args) } }),
    first: async () => {
      const m = sql.match(/SELECT COUNT\(\*\) AS n FROM (\w+)(?: WHERE kind = \?)?/);
      if (!m) return null;
      const rows = [...tableOf(m[1]).values()];
      return { n: args.length ? rows.filter((r) => r.kind === args[0]).length : rows.length };
    },
    all: async () => {
      if (/FROM furim_customers/.test(sql)) return { results: fixtures.customers ?? [] };
      if (/FROM friends/.test(sql)) return { results: fixtures.friends ?? [] };
      if (/FROM furim_auto_copy_logs WHERE idempotency_key IS NOT NULL/.test(sql)) return { results: [...tableOf('furim_auto_copy_logs').values()].filter((r) => r.idempotency_key != null) };
      return { results: [] };
    },
  });
  const db = {
    prepare(sql: string) {
      const base = stmtFor(sql, []);
      return { ...base, bind: (...args: unknown[]) => stmtFor(sql, args) };
    },
    batch: async (stmts: Array<{ sql: string; args: unknown[] }>) => stmts.map((s) => ({ meta: { changes: apply(s.sql, s.args) } })),
  } as unknown as D1Database;
  return { db, tables, rowsOf: (name: string) => [...tableOf(name).values()] };
}

const customers = [
  { line_user_id: uid('1'), stripe_customer_id: 'cus_1', key_code: 'pb_aaa', mercari_url: 'https://jp.mercari.com/user/profile/1', shops_url: null, rakuma_url: null, yahoo_flea_url: null },
  { line_user_id: uid('2'), stripe_customer_id: 'cus_2', key_code: 'm398_bbb', mercari_url: 'https://jp.mercari.com/user/profile/2', shops_url: null, rakuma_url: null, yahoo_flea_url: 'https://paypayfleamarket.yahoo.co.jp/user/p2' },
  // 同じメルカリURL を 2 人が持つ → URL では解決しない
  { line_user_id: uid('3'), stripe_customer_id: 'cus_3', key_code: 'pb_ccc', mercari_url: 'https://jp.mercari.com/user/profile/2', shops_url: null, rakuma_url: null, yahoo_flea_url: null },
];
const friends = [
  { line_user_id: uid('1'), display_name: 'いわ' },
  { line_user_id: uid('2'), display_name: 'yoko' },
  { line_user_id: uid('3'), display_name: 'yoko' },
];

async function ctxWith() {
  const { db } = makeDb({ customers, friends });
  return loadResolveContext(db, NOW);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('値の正規化', () => {
  it('型注記行を見分ける', () => {
    expect(isTypeRow({ 処理日時: 'String', LINE表示名: 'String', 残: 'Number', 空: '' })).toBe(true);
    expect(isTypeRow({ 処理日時: '2026-07-31T20:12:50.000Z', LINE表示名: 'String' })).toBe(false);
    expect(isTypeRow({ a: '', b: '' })).toBe(false);
  });

  it('日時は ISO Z も GAS の YYYY/MM/DD も +09:00 に揃え、解釈できない文字列はそのまま', () => {
    expect(jst('2026-07-31T20:12:50.000Z')).toBe('2026-08-01T05:12:50.000+09:00');
    expect(jst('2026/08/01 05:12:50')).toBe('2026-08-01T05:12:50.000+09:00');
    expect(jst('URLなし')).toBe('URLなし');
    expect(jst('')).toBeNull();
  });

  it('行ハッシュは同じ入力で同じ id、シートが違えば別 id', async () => {
    const a = await rowHash('Error', ['2026-01-01T01:52:33.000Z', 'x', 1]);
    const b = await rowHash('Error', ['2026-01-01T01:52:33.000Z', 'x', '1']);
    const c = await rowHash('自動化処理履歴', ['2026-01-01T01:52:33.000Z', 'x', 1]);
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
    expect(a).not.toBe(c);
  });
});

describe('列マッピング', () => {
  it('サブスクトランザクション → furim_payments（インボイスID が主キー・Stripe顧客ID で line_user_id を解決）', async () => {
    const spec = getSheetSpec('subscription-transactions')!;
    const res = await mapSheetRows(spec, [
      { 処理日時: '2023-06-19T13:15:40.000Z', LINE表示名: 'いわ', Stripe顧客ID: 'cus_1', プラン名: 'メルカリ3980円プラン', インボイスID: 'in_1', サブスク価格: 3980, クーポン値引き額: 0, 税抜価格: 3980, 消費税額: 0, '支払い総額（税込）': 3980 },
      { 処理日時: '2023-06-20T13:15:40.000Z', LINE表示名: '誰か', Stripe顧客ID: 'cus_x', プラン名: 'p', インボイスID: 'in_2', サブスク価格: 1, クーポン値引き額: 0, 税抜価格: 1, 消費税額: 0, '支払い総額（税込）': 1 },
      { 処理日時: '2023-06-20T13:15:40.000Z', LINE表示名: '誰か', Stripe顧客ID: 'cus_x', プラン名: 'p', インボイスID: 'in_2', サブスク価格: 1, クーポン値引き額: 0, 税抜価格: 1, 消費税額: 0, '支払い総額（税込）': 1 },
      { 処理日時: '', LINE表示名: '', Stripe顧客ID: '', プラン名: '', インボイスID: '', サブスク価格: '', クーポン値引き額: '', 税抜価格: '', 消費税額: '', '支払い総額（税込）': '' },
    ], await ctxWith());
    expect(res.rows).toHaveLength(2);
    expect(res.skipped).toMatchObject({ duplicate_in_sheet: 1, empty_row: 1 });
    expect(res.unresolved).toBe(1);
    const first = Object.fromEntries(res.rows[0].columns.map((c, i) => [c, res.rows[0].values[i]]));
    expect(first).toMatchObject({ invoice_id: 'in_1', line_user_id: uid('1'), stripe_customer_id: 'cus_1', plan_name: 'メルカリ3980円プラン', subscription_price: 3980, actual_paid_amount: 3980, paid_at: '2023-06-19T22:15:40.000+09:00', created_at: '2023-06-19T22:15:40.000+09:00' });
  });

  it('チケットトランザクション → furim_ticket_ledger（Stripe 経路と同じ purchase:<id>・未解決は skip）', async () => {
    const spec = getSheetSpec('ticket-transactions')!;
    const res = await mapSheetRows(spec, [
      { 処理日時: '2025-10-10T22:11:37.000Z', LINE表示名: 'いわ', Stripe顧客ID: 'cus_1', 購入チケット数: 200, 請求書ID: 'pi_1', 税抜価格: 2800, 消費税額: 280, '支払い総額（税込）': 3080 },
      { 処理日時: '2025-10-10T22:11:37.000Z', LINE表示名: 'x', Stripe顧客ID: 'cus_none', 購入チケット数: 200, 請求書ID: 'pi_2', 税抜価格: 2800, 消費税額: 280, '支払い総額（税込）': 3080 },
    ], await ctxWith());
    expect(res.rows).toHaveLength(1);
    expect(res.skipped.unresolved_line_user_id).toBe(1);
    const row = Object.fromEntries(res.rows[0].columns.map((c, i) => [c, res.rows[0].values[i]]));
    expect(row).toMatchObject({ line_user_id: uid('1'), delta: 200, reason: 'purchase', idempotency_key: 'purchase:pi_1', payment_intent_id: 'pi_1', amount: 3080, currency: 'jpy' });
  });

  it('自動化処理履歴 → furim_execution_logs（重複防止キーが無い旧行は行ハッシュ・URL で line_user_id・payload にシート行）', async () => {
    const spec = getSheetSpec('execution-logs')!;
    const res = await mapSheetRows(spec, [
      { 処理日時: 'String', LINE表示名: 'String', サービス: 'String', URL: 'String', マイページ更新日時: 'String', 評価数: 'String', 売上金: 'String', 商品数: 'String', 自動化内容: 'String', 重複防止キー: '' },
      { 処理日時: '2026-07-31T20:12:50.000Z', LINE表示名: 'yoko', サービス: 'ヤフフリ', URL: 'https://paypayfleamarket.yahoo.co.jp/user/p2', マイページ更新日時: '', 評価数: '', 売上金: '', 商品数: 31, 自動化内容: '"{"yf_changePrice":["-100","円"]}"', 重複防止キー: '' },
      { 処理日時: '2026-08-01T20:12:50.000Z', LINE表示名: 'いわ', サービス: 'メルカリ', URL: 'https://jp.mercari.com/user/profile/1', マイページ更新日時: '2026/08/01', 評価数: 12, 売上金: '1,000', 商品数: 3, 自動化内容: '{}', 重複防止キー: 'msep3kb3-1zgbci9t' },
    ], await ctxWith());
    expect(res.skipped.type_row).toBe(1);
    expect(res.rows).toHaveLength(2);
    const rows = res.rows.map((r) => Object.fromEntries(r.columns.map((c, i) => [c, r.values[i]])));
    expect(rows[0]).toMatchObject({ line_user_id: uid('2'), key_code: null, service: 'ヤフフリ', total_target_count: '31', client: 'sheet', created_at: '2026-08-01T05:12:50.000+09:00' });
    expect(String(rows[0].dedupe_key)).toMatch(/^sheet:[0-9a-f]{32}$/);
    expect(JSON.parse(String(rows[0].payload))).toMatchObject({ LINE表示名: 'yoko' });
    expect(rows[1]).toMatchObject({ line_user_id: uid('1'), dedupe_key: 'msep3kb3-1zgbci9t', count_rating: '12', sales_amount: '1,000' });
  });

  it('自動コピー出品履歴 → furim_auto_copy_logs（LINE表示名が一意な時だけ line_user_id・全角スペース付き見出しの残数）', async () => {
    const spec = getSheetSpec('auto-copy-logs')!;
    const res = await mapSheetRows(spec, [
      { 処理日時: '2025-10-16T23:58:50.000Z', LINE表示名: 'いわ', コピー元URL: 'https://a', コピー出品先URL: 'https://b', '　残チケット数': 9 },
      { 処理日時: '2025-10-16T23:58:51.000Z', LINE表示名: 'yoko', コピー元URL: '', コピー出品先URL: '', '　残チケット数': 8 },
      { 処理日時: '2025-10-16T23:58:51.000Z', LINE表示名: 'yoko', コピー元URL: '', コピー出品先URL: '', '　残チケット数': 8 },
    ], await ctxWith());
    expect(res.rows).toHaveLength(2);
    expect(res.skipped.duplicate_in_sheet).toBe(1);
    const rows = res.rows.map((r) => Object.fromEntries(r.columns.map((c, i) => [c, r.values[i]])));
    expect(rows[0]).toMatchObject({ line_user_id: uid('1'), display_name: 'いわ', source_url: 'https://a', target_url: 'https://b', remaining_tickets: 9, processed_at: '2025-10-17T08:58:50.000+09:00', imported_at: NOW });
    expect(rows[1]).toMatchObject({ line_user_id: null, display_name: 'yoko', source_url: null, remaining_tickets: 8 });
  });

  it('自動コピー出品履歴の 重複防止キー は consume:<キー> として持つ（無ければ NULL）', async () => {
    const res = await mapSheetRows(getSheetSpec('auto-copy-logs')!, [
      { 処理日時: '2026-09-14T00:02:51.000Z', LINE表示名: 'いわ', コピー元URL: 'https://a', コピー出品先URL: 'https://b', '　残チケット数': 9, 重複防止キー: 'mu0f-1' },
      { 処理日時: '2026-09-14T00:02:52.000Z', LINE表示名: 'いわ', コピー元URL: 'https://a', コピー出品先URL: 'https://c', '　残チケット数': 8, 重複防止キー: '' },
    ], await ctxWith());
    const rows = res.rows.map((r) => Object.fromEntries(r.columns.map((c, i) => [c, r.values[i]])));
    expect(rows.map((r) => r.idempotency_key)).toEqual(['consume:mu0f-1', null]);
  });

  it('Error → furim_ext_errors（キーコードで line_user_id・数値のキーコードも文字列に）', async () => {
    const spec = getSheetSpec('errors')!;
    const res = await mapSheetRows(spec, [
      { 日時: '2026-01-01T01:52:33.000Z', LINE表示名: 'x', キーコード: 'm398_bbb', 端末判定文字列: '0.w7go1c0p3i', エラー内容: '該当レコードなし', URL: 'https://jp.mercari.com/user/profile/2' },
      { 日時: '2026-01-01T06:44:17.000Z', LINE表示名: '', キーコード: 12345, 端末判定文字列: 678, エラー内容: '無料期間終了', URL: 'URLなし' },
    ], await ctxWith());
    const rows = res.rows.map((r) => Object.fromEntries(r.columns.map((c, i) => [c, r.values[i]])));
    expect(rows[0]).toMatchObject({ line_user_id: uid('2'), key_code: 'm398_bbb', method: 'sheet', error: '該当レコードなし', mercari_url: 'https://jp.mercari.com/user/profile/2', discrimination_code: '0.w7go1c0p3i', client: 'sheet', created_at: '2026-01-01T10:52:33.000+09:00' });
    expect(rows[1]).toMatchObject({ line_user_id: null, key_code: '12345', discrimination_code: '678', error: '無料期間終了' });
  });

  it('手動コピー / ショップ調査 / 無料台帳は重複防止キー・インストールID が主キー', async () => {
    const ctx = await ctxWith();
    const manual = await mapSheetRows(getSheetSpec('manual-copy-logs')!, [
      { 開始日時: '2026-08-21T00:48:09.000Z', LINE表示名: 'いわ', インストールID: 'inst-1', キーコード: 'pb_aaa', コピー元商品ID: 'm1', コピー元商品名: 'カメラ', コピー先: 'ヤフフリ', ステータス: '出品完了', 出品先URL: 'https://y/1', 完了日時: '2026-08-21T00:48:57.000Z', 重複防止キー: 'mc_1', コピー元URL: '' },
      { 開始日時: '2026-08-21T00:48:09.000Z', LINE表示名: '', インストールID: 'inst-2', キーコード: '', コピー元商品ID: 'm2', コピー元商品名: 'x', コピー先: 'ラクマ', ステータス: '開始', 出品先URL: '', 完了日時: '', 重複防止キー: '', コピー元URL: '' },
    ], ctx);
    expect(manual.rows).toHaveLength(1);
    expect(manual.skipped.missing_key).toBe(1);
    const m = Object.fromEntries(manual.rows[0].columns.map((c, i) => [c, manual.rows[0].values[i]]));
    expect(m).toMatchObject({ dedupe_key: 'mc_1', install_id: 'inst-1', key_code: 'pb_aaa', line_user_id: uid('1'), item_id: 'm1', target: 'ヤフフリ', status: '出品完了', target_url: 'https://y/1', started_at: '2026-08-21T09:48:09.000+09:00', completed_at: '2026-08-21T09:48:57.000+09:00', created_at: '2026-08-21T09:48:09.000+09:00' });

    const shop = await mapSheetRows(getSheetSpec('shop-research-logs')!, [
      { 発火日時: '2026-08-21T00:44:35.000Z', LINE表示名: '', 自分のメルカリURL: 'https://m/1', 調査対象URL: 'https://m/2', 区分: '無料枠', インストールID: 'inst-1', キーコード: '', 重複防止キー: 'sr_1' },
      { 発火日時: '2026-08-21T00:45:35.000Z', LINE表示名: 'いわ', 自分のメルカリURL: 'https://m/1', 調査対象URL: 'https://m/3', 区分: 'プラン', インストールID: 'inst-1', キーコード: 'pb_aaa', 重複防止キー: 'sr_2' },
    ], ctx);
    const s = shop.rows.map((r) => Object.fromEntries(r.columns.map((c, i) => [c, r.values[i]])));
    expect(s[0]).toMatchObject({ dedupe_key: 'sr_1', is_free: 1, line_user_id: null, target_url: 'https://m/2' });
    expect(s[1]).toMatchObject({ dedupe_key: 'sr_2', is_free: 0, line_user_id: uid('1') });

    const free = await mapSheetRows(getSheetSpec('free-accounts')!, [
      { インストールID: 'e629', メルカリURL: 'https://m/1', ラクマURL: '', ヤフフリURL: '', ヤフオクURL: 'https://a/1', ShopsURL: '', キーコード: 'nushi_1', 初回登録日時: '2026-08-18T12:50:28.034Z', 最終更新日時: '2026-08-25T02:51:54.176Z', 照合ステータス: '月額会員', LINE表示名: 'x', プラン名: '主プラン', 照合日時: '2026-09-13T21:14:59.330Z' },
    ], ctx);
    const f = Object.fromEntries(free.rows[0].columns.map((c, i) => [c, free.rows[0].values[i]]));
    expect(f).toEqual({ install_id: 'e629', mercari_url: 'https://m/1', rakuma_url: null, yahoo_flea_url: null, yahoo_auction_url: 'https://a/1', shops_url: null, key_code: 'nushi_1', created_at: '2026-08-18T21:50:28.034+09:00', updated_at: '2026-08-25T11:51:54.176+09:00' });
  });

  it('アンケート / クーポン適用 / キャンセル / 紹介キャッシュバック', async () => {
    const ctx = await ctxWith();
    const survey = await mapSheetRows(getSheetSpec('survey-answers')!, [
      { LINE表示名: 'String', LINE_ID: 'String', アンケート回答: 'String' },
      { LINE表示名: 'だいすけ', LINE_ID: uid('1'), アンケート回答: '紹介' },
      { LINE表示名: 'だいすけ2', LINE_ID: uid('1'), アンケート回答: '紹介' },
      { LINE表示名: 'x', LINE_ID: 'not-a-line-id', アンケート回答: 'X' },
    ], ctx);
    expect(survey.rows).toHaveLength(1);
    expect(survey.skipped).toMatchObject({ type_row: 1, duplicate_in_sheet: 1, missing_key: 1 });
    expect(Object.fromEntries(survey.rows[0].columns.map((c, i) => [c, survey.rows[0].values[i]]))).toMatchObject({ line_user_id: uid('1'), display_name: 'だいすけ', answer: '紹介', created_at: NOW });

    const coupon = await mapSheetRows(getSheetSpec('coupon-applications')!, [
      { 適用日時: '2025-07-30T07:10:30.371Z', LINE表示名: 'いわ', Stripe顧客ID: 'cus_1', クーポン名: 'Youtubeご視聴感謝20%OFFクーポン', クーポンID: 'MxrPwCf8', 経路: 'Furiman経由' },
      { 適用日時: '2025-07-30T07:10:30.371Z', LINE表示名: 'x', Stripe顧客ID: 'cus_none', クーポン名: 'c', クーポンID: 'i', 経路: 'Furiman経由' },
    ], ctx);
    expect(coupon.rows).toHaveLength(1);
    expect(coupon.skipped.unresolved_line_user_id).toBe(1);
    expect(Object.fromEntries(coupon.rows[0].columns.map((c, i) => [c, coupon.rows[0].values[i]]))).toMatchObject({ line_user_id: uid('1'), stripe_customer_id: 'cus_1', coupon_name: 'Youtubeご視聴感謝20%OFFクーポン', coupon_id: 'MxrPwCf8', route: 'Furiman経由', created_at: '2025-07-30T16:10:30.371+09:00' });

    const cancel = await mapSheetRows(getSheetSpec('cancellations')!, [
      { キャンセル日時: '2023-10-25T05:07:55.000Z', LINE表示名: 'まえだ', プラン名: 'メルカリ8980円プラン', メルカリURL: 'https://jp.mercari.com/user/profile/1', '副業継続判定(基準:出品最新30件が1ヶ月以内=◯ / 2026-08-12自動判定)': '×停止(出品0件)' },
      { キャンセル日時: '2023-10-26T05:07:55.000Z', LINE表示名: '八木', プラン名: '', メルカリURL: 'https://jp.mercari.com/user/profile/2', '副業継続判定(基準:出品最新30件が1ヶ月以内=◯ / 2026-08-12自動判定)': '' },
    ], ctx);
    const c = cancel.rows.map((r) => Object.fromEntries(r.columns.map((x, i) => [x, r.values[i]])));
    expect(c[0]).toMatchObject({ line_user_id: uid('1'), stripe_event_id: null, plan_name: 'メルカリ8980円プラン', mercari_url: 'https://jp.mercari.com/user/profile/1', canceled_at: '2023-10-25T14:07:55.000+09:00', display_name: 'まえだ', side_job_judgment: '×停止(出品0件)' });
    expect(c[1]).toMatchObject({ line_user_id: null, plan_name: null, display_name: '八木', side_job_judgment: null });

    const cb = await mapSheetRows(getSheetSpec('referral-cashbacks')!, [
      { 日時: '2024-05-04T20:35:16.000Z', 'LINE表示名(友)': '佐々木', Stripe顧客ID: 'cus_2', 価格: 3980, 'LINE表示名(ア)': '貴一朗', LINE_ID: uid('9'), キャッシュバック金額: 0 },
    ], ctx);
    expect(Object.fromEntries(cb.rows[0].columns.map((x, i) => [x, cb.rows[0].values[i]]))).toMatchObject({ occurred_at: '2024-05-05T05:35:16.000+09:00', introduced_display_name: '佐々木', introduced_line_user_id: uid('2'), stripe_customer_id: 'cus_2', price: 3980, ambassador_display_name: '貴一朗', ambassador_line_user_id: uid('9'), cashback_amount: 0, imported_at: NOW });
  });

  it('プラン一覧 / チケット単価一覧 → furim_master（kind=plan / ticket_price・機能列は payload.features に）', async () => {
    const ctx = await ctxWith();
    const plans = await mapSheetRows(getSheetSpec('plans')!, [
      { プラン名: 'String', 価格: 'Number', PriceID: 'String', トライアル期間: 'Number', キーコード接頭語: 'String', 'メルカリ値下げ機能\n(mChangePrice)': 'Boolean' },
      { プラン名: '友達登録1週間トライアルプラン', 価格: 0, PriceID: 'なし', トライアル期間: 7, キーコード接頭語: '1weektrial_', 'メルカリ値下げ機能\n(mChangePrice)': true, '自動併売在庫管理機能\n(AutoMultiChannel)': '' },
    ], ctx);
    expect(plans.rows).toHaveLength(1);
    const p = plans.rows[0];
    expect(p.conflict).toEqual({ target: 'kind, key', update: ['display_name', 'stripe_price_id', 'monthly_price', 'active', 'payload', 'fetched_at'] });
    const row = Object.fromEntries(p.columns.map((c, i) => [c, p.values[i]]));
    expect(row).toMatchObject({ kind: 'plan', key: '友達登録1週間トライアルプラン', display_name: '友達登録1週間トライアルプラン', stripe_price_id: 'なし', monthly_price: 0, active: 1, fetched_at: NOW });
    expect(JSON.parse(String(row.payload))).toEqual({ プラン名: '友達登録1週間トライアルプラン', 価格: 0, PriceID: 'なし', トライアル期間: 7, キーコード接頭語: '1weektrial_', features: { mChangePrice: true, AutoMultiChannel: '' } });

    const prices = await mapSheetRows(getSheetSpec('ticket-prices')!, [{ 単価: 15, PriceID: 'price_15' }], ctx);
    expect(Object.fromEntries(prices.rows[0].columns.map((c, i) => [c, prices.rows[0].values[i]]))).toMatchObject({ kind: 'ticket_price', key: '15', stripe_price_id: 'price_15', monthly_price: null });
  });

  it('全シート定義が一意な name を持ち、mapper が実装されている', async () => {
    const ctx = await ctxWith();
    expect(new Set(SHEET_BACKFILL_SPECS.map((s) => s.name)).size).toBe(SHEET_BACKFILL_SPECS.length);
    for (const spec of SHEET_BACKFILL_SPECS) {
      const res = await mapSheetRows(spec, [{}], ctx);
      expect(res.skipped.empty_row).toBe(1);
    }
  });
});

describe('D1 文の組み立て', () => {
  it('同じ表の行は 1 文 90 bind 以内の複数行 INSERT OR IGNORE にまとめ、upsert 行は 1 行 1 文', () => {
    const { db } = makeDb();
    const rows = Array.from({ length: 25 }, (_, i) => ({ table: 'furim_ext_errors', columns: ['id', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], values: [String(i), 1, 2, 3, 4, 5, 6, 7, 8], key: String(i) }));
    const master = { table: 'furim_master', columns: ['kind', 'key', 'payload'], values: ['plan', 'p', '{}'], key: 'p', conflict: { target: 'kind, key', update: ['payload'] } };
    const stmts = buildInsertStatements(db, [...rows, master]) as unknown as Array<{ sql: string; args: unknown[] }>;
    // 9 列 → 10 行/文 → 25 行は 3 文、＋ upsert 1 文
    expect(stmts).toHaveLength(4);
    expect(stmts[0].sql).toMatch(/^INSERT OR IGNORE INTO furim_ext_errors \(id, a, b, c, d, e, f, g, h\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?\)(, \(\?, \?, \?, \?, \?, \?, \?, \?, \?\)){9}$/);
    expect(stmts[0].args).toHaveLength(90);
    expect(stmts[2].args).toHaveLength(45);
    expect(stmts[3].sql).toBe('INSERT INTO furim_master (kind, key, payload) VALUES (?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET payload = excluded.payload');
  });
});

describe('backfillSheet（冪等性）', () => {
  const errorRows = [
    { 日時: '2026-01-01T01:52:33.000Z', LINE表示名: 'x', キーコード: 'm398_bbb', 端末判定文字列: '0.w7', エラー内容: '該当レコードなし', URL: 'https://jp.mercari.com/user/profile/2' },
    { 日時: '2026-01-01T06:44:17.000Z', LINE表示名: '', キーコード: 'rwad5rkf', 端末判定文字列: '', エラー内容: '該当レコードなし', URL: 'URLなし' },
    { 日時: '2026-01-01T06:44:17.000Z', LINE表示名: '', キーコード: 'rwad5rkf', 端末判定文字列: '', エラー内容: '該当レコードなし', URL: 'URLなし' },
  ];

  it('2 回実行しても件数が増えず、シート件数との差分が理由付きで返る', async () => {
    const { db, rowsOf } = makeDb({ customers, friends });
    gasGet.mockResolvedValue({ success: true, columns: [], rows: errorRows });
    const spec = getSheetSpec('errors')!;
    const first = await backfillSheet(db, 'dep-1', spec, { dryRun: false, now: NOW });
    expect(first).toMatchObject({ dryRun: false, sheet: 'Error', table: 'furim_ext_errors', sheetRows: 3, mapped: 2, inserted: 2, countBefore: 0, countAfter: 2, unresolvedLineUserId: 1 });
    expect(first.skipped.duplicate_in_sheet).toBe(1);
    expect(gasGet).toHaveBeenCalledWith('dep-1', { method: 'getData', sheet: 'Error', headerRow: '1' }, { timeoutMs: 180_000 });

    const second = await backfillSheet(db, 'dep-1', spec, { dryRun: false, now: NOW });
    expect(second).toMatchObject({ mapped: 2, inserted: 0, countBefore: 2, countAfter: 2 });
    expect(rowsOf('furim_ext_errors')).toHaveLength(2);
    expect(rowsOf('furim_ext_errors')[0]).toMatchObject({ line_user_id: uid('2'), key_code: 'm398_bbb', method: 'sheet', client: 'sheet' });
  });

  it('dryRun は書かずに件数だけ返す', async () => {
    const { db, rowsOf } = makeDb({ customers, friends });
    gasGet.mockResolvedValue({ success: true, columns: [], rows: errorRows });
    const res = await backfillSheet(db, 'dep-1', getSheetSpec('errors')!, { dryRun: true, now: NOW });
    expect(res).toMatchObject({ dryRun: true, mapped: 2, inserted: 0, statements: 1, countBefore: 0, countAfter: 0 });
    expect(res.sample).toHaveLength(2);
    expect(rowsOf('furim_ext_errors')).toHaveLength(0);
  });

  it('自動化処理履歴は既に Worker 経由で入った同じ重複防止キーの行を上書きしない', async () => {
    const { db, rowsOf } = makeDb({ customers, friends });
    await db.prepare('INSERT INTO furim_execution_logs (id, dedupe_key, client) VALUES (?, ?, ?)').bind('live-1', 'msep3kb3-1zgbci9t', 'ext/4.3.1').run();
    gasGet.mockResolvedValue({ success: true, columns: [], rows: [
      { 処理日時: '2026-08-01T20:12:50.000Z', LINE表示名: 'いわ', サービス: 'メルカリ', URL: 'https://jp.mercari.com/user/profile/1', マイページ更新日時: '', 評価数: '', 売上金: '', 商品数: 3, 自動化内容: '{}', 重複防止キー: 'msep3kb3-1zgbci9t' },
      { 処理日時: '2026-08-02T20:12:50.000Z', LINE表示名: 'いわ', サービス: 'メルカリ', URL: 'https://jp.mercari.com/user/profile/1', マイページ更新日時: '', 評価数: '', 売上金: '', 商品数: 3, 自動化内容: '{}', 重複防止キー: 'other' },
    ] });
    const res = await backfillSheet(db, 'dep-1', getSheetSpec('execution-logs')!, { dryRun: false, now: NOW });
    expect(res).toMatchObject({ mapped: 2, inserted: 1, countBefore: 1, countAfter: 2 });
    expect(rowsOf('furim_execution_logs').find((r) => r.dedupe_key === 'msep3kb3-1zgbci9t')).toMatchObject({ id: 'live-1', client: 'ext/4.3.1' });
  });

  it('自動コピー出品履歴は消費経路で入った同じ消費（同じキー / キー無しは URL＋2 分以内）を入れず、残チケット数だけ埋める。2 回目も増えない', async () => {
    const { db, rowsOf } = makeDb({ customers, friends });
    const ins = 'INSERT INTO furim_auto_copy_logs (id, line_user_id, display_name, source_url, target_url, remaining_tickets, processed_at, imported_at, delta, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    await db.prepare(ins).bind('live-1', uid('1'), null, 'https://jp.mercari.com/item/m1', 'https://item.fril.jp/1', null, '2026-09-14T09:02:00.148+09:00', NOW, -1, 'consume:k1').run();
    await db.prepare(ins).bind('live-2', uid('2'), null, 'https://jp.mercari.com/item/m2', 'https://item.fril.jp/2', 40, '2026-09-14T10:03:27.222+09:00', NOW, -1, 'consume:gas-generated').run();
    const oldRow = { 処理日時: '2026-09-13T23:00:00.000Z', LINE表示名: 'いわ', コピー元URL: 'https://jp.mercari.com/item/m0', コピー出品先URL: 'https://item.fril.jp/0', '　残チケット数': 9, 重複防止キー: '' };
    await db.prepare(ins).bind(await rowHash('自動コピー出品履歴', Object.values(oldRow)), null, 'いわ', 'https://jp.mercari.com/item/m0', 'https://item.fril.jp/0', 9, '2026-09-14T08:00:00.000+09:00', NOW, null, null).run();
    gasGet.mockResolvedValue({ success: true, columns: [], rows: [
      oldRow,
      { 処理日時: '2026-09-14T00:02:01.000Z', LINE表示名: 'いわ', コピー元URL: 'https://jp.mercari.com/item/m1', コピー出品先URL: 'https://item.fril.jp/1', '　残チケット数': 297, 重複防止キー: 'k1' },
      { 処理日時: '2026-09-14T01:03:28.000Z', LINE表示名: 'yoko', コピー元URL: 'https://jp.mercari.com/item/m2', コピー出品先URL: 'https://item.fril.jp/2', '　残チケット数': 41, 重複防止キー: '' },
      { 処理日時: '2026-09-14T01:10:00.000Z', LINE表示名: 'いわ', コピー元URL: 'https://jp.mercari.com/item/m5', コピー出品先URL: 'https://item.fril.jp/5', '　残チケット数': 296, 重複防止キー: 'k5' },
    ] });
    const spec = getSheetSpec('auto-copy-logs')!;
    const first = await backfillSheet(db, 'dep-1', spec, { dryRun: false, now: NOW });
    expect(first).toMatchObject({ mapped: 2, inserted: 1, remainingFilled: 1, countBefore: 3, countAfter: 4 });
    expect(first.skipped.matched_consume).toBe(2);
    expect(rowsOf('furim_auto_copy_logs').find((r) => r.id === 'live-1')).toMatchObject({ remaining_tickets: 297, idempotency_key: 'consume:k1' });
    expect(rowsOf('furim_auto_copy_logs').find((r) => r.id === 'live-2')).toMatchObject({ remaining_tickets: 40 });
    expect(rowsOf('furim_auto_copy_logs').find((r) => r.idempotency_key === 'consume:k5')).toMatchObject({ line_user_id: uid('1'), remaining_tickets: 296 });

    const second = await backfillSheet(db, 'dep-1', spec, { dryRun: false, now: NOW });
    expect(second).toMatchObject({ inserted: 0, remainingFilled: 0, countBefore: 4, countAfter: 4 });
    expect(second.skipped.matched_consume).toBe(2);
  });

  it('GAS が失敗を返したら投げる（業務エラーは再試行しない）', async () => {
    const { db } = makeDb();
    gasGet.mockResolvedValue({ success: false, error: 'シート "x" が見つかりません' });
    await expect(backfillSheet(db, 'dep-1', getSheetSpec('errors')!, { dryRun: true })).rejects.toThrow(/getData\(Error\) failed/);
    expect(gasGet).toHaveBeenCalledTimes(1);
  });

  it('Google の断続的な 404 HTML は読み直す（3 回まで）', async () => {
    vi.useFakeTimers();
    try {
      const { db } = makeDb({ customers, friends });
      gasGet
        .mockRejectedValueOnce(new Error('GAS GET 404: <!DOCTYPE html>...'))
        .mockResolvedValueOnce('<!DOCTYPE html><html>ページが見つかりません</html>')
        .mockResolvedValueOnce({ success: true, columns: [], rows: errorRows });
      const p = backfillSheet(db, 'dep-1', getSheetSpec('errors')!, { dryRun: true, now: NOW });
      await vi.runAllTimersAsync();
      const res = await p;
      expect(res.mapped).toBe(2);
      expect(gasGet).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
