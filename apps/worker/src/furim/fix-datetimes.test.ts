import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMocks = {
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
  jstNow: () => '2026-09-14T12:00:00.000+09:00',
  toJstString: (d: Date) => new Date(d.getTime() + 9 * 60 * 60_000).toISOString().slice(0, -1) + '+09:00',
};
vi.mock('@line-crm/db', () => dbMocks);

const gasGet = vi.fn();
vi.mock('./gas-client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gasGet,
}));

const worker = (await import('../index.js')).default;
const { fixDatetimes, classifyFixRows, judgeSevenDay, tagSourceKind, isMigratedTagAssignedAt, FIX_STAFF_NAME, SUB_LINE_USER_ID } = await import('./fix-datetimes.js');

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

const NOW_MS = Date.parse('2026-09-14T12:00:00.000+09:00');
const NOW = '2026-09-14T12:00:00.000+09:00';
const uid = (n: string) => 'U' + n.padStart(32, '0');

function makeDb(tables: Tables) {
  let lastChanges = 0;
  const writes: string[] = [];
  const t = (name: string) => (tables[name] ??= []);
  const groupMin = (rows: Row[], key: string, col: string, fn: 'min' | 'max', map: (v: string) => string = (v) => v) => {
    const out = new Map<string, string>();
    for (const r of rows) {
      const k = r[key] as string | null;
      if (k == null) continue;
      const v = map(String(r[col]));
      const cur = out.get(k);
      if (cur === undefined || (fn === 'min' ? v < cur : v > cur)) out.set(k, v);
    }
    return [...out].map(([k, at]) => ({ k, at }));
  };
  const select = (sql: string, args: unknown[]): Row[] => {
    switch (sql) {
      case 'SELECT line_user_id, created_at FROM furim_customers':
        return t('furim_customers').map((r) => ({ line_user_id: r.line_user_id, created_at: r.created_at }));
      case 'SELECT id, code, created_at FROM affiliates':
        return t('affiliates').map((r) => ({ id: r.id, code: r.code, created_at: r.created_at }));
      case 'SELECT id, line_user_id, created_at FROM friends WHERE line_user_id = ?':
      case 'SELECT created_at FROM friends WHERE line_user_id = ?':
        return t('friends').filter((r) => r.line_user_id === args[0]);
      case 'SELECT id, friend_id, created_at FROM chats':
        return t('chats');
      case "SELECT friend_id, MIN(replace(created_at, ' ', 'T')) AS at FROM messages_log GROUP BY friend_id":
        return groupMin(t('messages_log'), 'friend_id', 'created_at', 'min', (v) => v.replace(' ', 'T')).map((r) => ({ friend_id: r.k, at: r.at }));
      case 'SELECT line_user_id AS k, MIN(paid_at) AS at FROM furim_payments WHERE line_user_id IS NOT NULL GROUP BY line_user_id':
        return groupMin(t('furim_payments'), 'line_user_id', 'paid_at', 'min');
      case 'SELECT introduced_friend_id AS k, MIN(created_at) AS at FROM furim_referrals GROUP BY introduced_friend_id':
        return groupMin(t('furim_referrals'), 'introduced_friend_id', 'created_at', 'min');
      case "SELECT line_user_id AS k, MIN(created_at) AS at FROM furim_coupon_applications WHERE route = 'Furiman経由' GROUP BY line_user_id":
        return groupMin(t('furim_coupon_applications').filter((r) => r.route === 'Furiman経由'), 'line_user_id', 'created_at', 'min');
      case 'SELECT line_user_id AS k, MAX(canceled_at) AS at FROM furim_cancellations WHERE line_user_id IS NOT NULL GROUP BY line_user_id':
        return groupMin(t('furim_cancellations'), 'line_user_id', 'canceled_at', 'max');
    }
    if (sql.startsWith('SELECT ft.friend_id, ft.tag_id, ft.assigned_at, t.name, f.line_user_id FROM friend_tags ft')) {
      return t('friend_tags').flatMap((ft) => {
        const tag = t('tags').find((x) => x.id === ft.tag_id);
        const friend = t('friends').find((x) => x.id === ft.friend_id);
        if (!tag || !friend) return [];
        const name = String(tag.name);
        if (!['月額会員', '紹介経由', 'Furimanです', 'キャンセル済み'].includes(name) && !/^月額[0-9]/.test(name)) return [];
        return [{ friend_id: ft.friend_id, tag_id: ft.tag_id, assigned_at: ft.assigned_at, name, line_user_id: friend.line_user_id }];
      });
    }
    throw new Error(`unexpected select: ${sql}`);
  };
  const apply = (sql: string, args: unknown[]): number => {
    writes.push(sql);
    const up = sql.match(/^UPDATE (\w+) SET (\w+) = \? WHERE (.+) AND (\w+) = \?$/);
    if (up) {
      const [, table, col, where] = up;
      const pkCols = [...where.matchAll(/(\w+) = \?/g)].map((m) => m[1]);
      const [newValue, ...rest] = args;
      const oldValue = rest[rest.length - 1];
      const hits = t(table).filter((r) => pkCols.every((c, i) => r[c] === rest[i]) && r[col] === oldValue);
      for (const r of hits) r[col] = newValue;
      lastChanges = hits.length;
      return hits.length;
    }
    if (sql.startsWith('INSERT INTO furim_admin_audit') && sql.endsWith('WHERE changes() = 1')) {
      if (lastChanges !== 1) { lastChanges = 0; return 0; }
      const [id, staff_id, staff_name, table_name, row_id, column_name, old_value, new_value, created_at] = args;
      t('furim_admin_audit').push({ id, staff_id, staff_name, table_name, row_id, column_name, old_value, new_value, created_at });
      lastChanges = 1;
      return 1;
    }
    throw new Error(`unexpected write: ${sql}`);
  };
  const stmt = (sql: string, args: unknown[]) => ({
    sql,
    args,
    bind: (...a: unknown[]) => stmt(sql, a),
    all: async () => ({ results: select(sql, args) }),
    first: async () => select(sql, args)[0] ?? null,
    run: async () => ({ meta: { changes: apply(sql, args) } }),
  });
  const db = {
    prepare: (sql: string) => stmt(sql, []),
    batch: async (stmts: Array<{ sql: string; args: unknown[] }>) => stmts.map((s) => ({ meta: { changes: apply(s.sql, s.args) } })),
  } as unknown as D1Database;
  return { db, tables, writes };
}

function sheets(opts: { customers?: Row[]; ambassadors?: Row[] }) {
  gasGet.mockImplementation(async (_id: string, params: Record<string, string>) => {
    if (params.sheet === '顧客情報-サブスク情報-キーコード') return { success: true, rows: [{ LINE_ID: 'String', 友達登録日時: 'Date' }, ...(opts.customers ?? [])] };
    if (params.sheet === 'アンバサダー') return { success: true, rows: [{ 登録日時: 'String', アンバサダーコード: 'String' }, ...(opts.ambassadors ?? [])] };
    throw new Error(`unexpected sheet ${params.sheet}`);
  });
}

const run = (db: D1Database, target: Parameters<typeof fixDatetimes>[2], dryRun: boolean) =>
  fixDatetimes(db, 'gas', target, { dryRun, staffId: 'staff-1', now: NOW, nowMs: NOW_MS });

beforeEach(() => {
  gasGet.mockReset();
  dbMocks.getStaffByApiKey.mockReset();
});

describe('classifyFixRows', () => {
  const base = { table: 'x', column: 'created_at', rowId: 'r', pk: { id: 'r' } };
  it('固まっている行だけを候補にし、取り元なしと一致済み（2 秒未満）を数える', () => {
    const r = classifyFixRows([
      { ...base, rowId: 'a', oldValue: '2026-09-13T22:54:22.413', source: '2024-04-07T11:21:08.000Z', stuck: true },
      { ...base, rowId: 'b', oldValue: '2026-09-13T22:54:22.413', source: null, stuck: true },
      { ...base, rowId: 'c', oldValue: '2026-08-07T11:13:35.957+09:00', source: '2026-08-07T02:13:34.000Z', stuck: true },
      { ...base, rowId: 'd', oldValue: '2026-01-01T00:00:00.000+09:00', source: '2025-01-01T00:00:00.000Z', stuck: false },
      { ...base, rowId: 'e', oldValue: '2026-01-01T00:00:00.000+09:00', source: null, stuck: false },
    ]);
    expect(r.candidates.map((c) => [c.rowId, c.newValue])).toEqual([['a', '2024-04-07T20:21:08.000+09:00']]);
    expect(r.skippedNoSource).toBe(1);
    expect(r.skippedAlreadyFixed).toBe(1);
  });

  it('messages_log のミリ秒と space 形式を +09:00・ミリ秒 3 桁にそろえる', () => {
    const r = classifyFixRows([
      { ...base, oldValue: '2026-07-14T15:20:33.200', source: '2026-07-10T19:40:47.690+09:00', stuck: true },
      { ...base, oldValue: '2026-07-14T15:20:33.200', source: '2026-07-09T00:50:27', stuck: true },
      { ...base, oldValue: '2026-06-11T17:40:00.199+09:00', source: '2024-04-13 15:16:04', stuck: true },
    ]);
    expect(r.candidates.map((c) => c.newValue)).toEqual(['2026-07-10T19:40:47.690+09:00', '2026-07-09T00:50:27.000+09:00', '2024-04-13T15:16:04.000+09:00']);
    for (const c of r.candidates) expect(c.newValue).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+09:00$/);
  });
});

describe('tagSourceKind / isMigratedTagAssignedAt', () => {
  it('月額N・月額会員・紹介経由・Furimanです・キャンセル済みだけに取り元がある', () => {
    expect(['月額会員', '月額3000', '月額19800', '紹介経由', 'Furimanです', 'キャンセル済み'].map(tagSourceKind)).toEqual(['first_payment', 'first_payment', 'first_payment', 'referral', 'furiman_coupon', 'cancellation']);
    expect(['未使用ユーザー', 'ブロック', 'セグメント1', '解説見た', 'サブ垢', 'アンバサダーLv.1', '月額会員ページ'].map(tagSourceKind)).toEqual([null, null, null, null, null, null, null]);
  });
  it('移行の時間帯は 2026-06-11 17:38〜17:50', () => {
    expect(['2026-06-11T17:38:53.756+09:00', '2026-06-11T17:40:00.199+09:00', '2026-06-11T17:50:00.145+09:00'].every(isMigratedTagAssignedAt)).toBe(true);
    expect(['2026-06-11T17:37:59.000+09:00', '2026-06-11T17:51:00.000+09:00', '2026-07-08T22:11:35.743+09:00', '2026-07-12 20:25:10'].some(isMigratedTagAssignedAt)).toBe(false);
  });
});

describe('judgeSevenDay', () => {
  it('actions.ts と同じ式: 7 日未満→半額、1 週間以内→+7 日', () => {
    expect(judgeSevenDay('2026-09-10T12:00:00.000+09:00', NOW_MS)).toMatchObject({ daysSinceRegistration: 4, furimanCoupon: '7日未満（半額）', extendTrial: '1週間以内（+7日）' });
    expect(judgeSevenDay('2025-10-19T07:13:48.000+09:00', NOW_MS)).toMatchObject({ furimanCoupon: '経過済み（20%OFF）', extendTrial: '経過済み（+3日）' });
    expect(judgeSevenDay(null, NOW_MS)).toMatchObject({ daysSinceRegistration: null, furimanCoupon: '経過済み（20%OFF）', extendTrial: '経過済み（+3日）' });
  });
});

async function expectIdempotent(db: D1Database, tables: Tables, target: Parameters<typeof fixDatetimes>[2], expected: { candidates: number; skippedNoSource: number; skippedAlreadyFixed: number }) {
  const snapshot = JSON.stringify(tables);
  const dry = await run(db, target, true);
  expect(dry).toMatchObject({ dryRun: true, updated: 0, auditRows: 0, ...expected });
  expect(JSON.stringify(tables)).toBe(snapshot);
  const first = await run(db, target, false);
  expect(first).toMatchObject({ dryRun: false, candidates: expected.candidates, updated: expected.candidates, auditRows: expected.candidates });
  const second = await run(db, target, false);
  expect(second).toMatchObject({ candidates: 0, updated: 0, auditRows: 0, skippedNoSource: expected.skippedNoSource, skippedAlreadyFixed: expected.skippedAlreadyFixed + expected.candidates });
  return first;
}

describe('fixDatetimes customers', () => {
  it('09-13 19:54 の行だけを友達登録日時に直し、監査ログを残し、2 回目は 0', async () => {
    const { db, tables } = makeDb({
      furim_customers: [
        { line_user_id: uid('1'), created_at: '2026-09-13T19:54:32.847' },
        { line_user_id: uid('2'), created_at: '2026-09-13T19:54:32.847' },
        { line_user_id: uid('3'), created_at: '2026-09-13T23:34:17.615+09:00' },
      ],
    });
    sheets({ customers: [{ LINE_ID: uid('1'), 友達登録日時: '2026-07-08T14:29:37.000Z' }, { LINE_ID: uid('3'), 友達登録日時: '2026-09-13T14:34:17.000Z' }] });
    const first = await expectIdempotent(db, tables, 'customers', { candidates: 1, skippedNoSource: 1, skippedAlreadyFixed: 1 });
    expect(first.samples).toEqual([{ table: 'furim_customers', column: 'created_at', rowId: uid('1'), oldValue: '2026-09-13T19:54:32.847', newValue: '2026-07-08T23:29:37.000+09:00' }]);
    expect(tables.furim_customers[0].created_at).toBe('2026-07-08T23:29:37.000+09:00');
    expect(tables.furim_customers[1].created_at).toBe('2026-09-13T19:54:32.847');
    expect(tables.furim_admin_audit).toEqual([
      { id: expect.any(String), staff_id: 'staff-1', staff_name: FIX_STAFF_NAME, table_name: 'furim_customers', row_id: uid('1'), column_name: 'created_at', old_value: '2026-09-13T19:54:32.847', new_value: '2026-07-08T23:29:37.000+09:00', created_at: NOW },
    ]);
  });
});

describe('fixDatetimes affiliates', () => {
  it('シートと 2 秒以上ずれた行を直し、1 秒差の行とシートに無い行は触らない', async () => {
    const { db, tables } = makeDb({
      affiliates: [
        { id: 'a1', code: '7BRXFZS7', created_at: '2026-09-13T22:54:22.413' },
        { id: 'a2', code: '975MEQXN', created_at: '2026-07-17T17:59:52.939+09:00' },
        { id: 'a3', code: '66JUDIU6', created_at: '2026-08-07T11:13:35.957+09:00' },
        { id: 'a4', code: 'NOSHEET1', created_at: '2026-09-13T22:54:22.413' },
      ],
    });
    sheets({
      ambassadors: [
        { 登録日時: '2024-04-07T11:21:08.000Z', アンバサダーコード: '7BRXFZS7' },
        { 登録日時: '2025-03-01T00:00:00.000Z', アンバサダーコード: '975MEQXN' },
        { 登録日時: '2026-08-07T02:13:34.000Z', アンバサダーコード: '66JUDIU6' },
      ],
    });
    await expectIdempotent(db, tables, 'affiliates', { candidates: 2, skippedNoSource: 1, skippedAlreadyFixed: 1 });
    expect(tables.affiliates.map((a) => a.created_at)).toEqual(['2024-04-07T20:21:08.000+09:00', '2025-03-01T09:00:00.000+09:00', '2026-08-07T11:13:35.957+09:00', '2026-09-13T22:54:22.413']);
    expect(tables.furim_admin_audit.map((a) => [a.table_name, a.row_id, a.old_value])).toEqual([['affiliates', 'a1', '2026-09-13T22:54:22.413'], ['affiliates', 'a2', '2026-07-17T17:59:52.939+09:00']]);
  });
});

describe('fixDatetimes friend-sub', () => {
  it('「サブ」だけを 2025/10/19 に戻し、7 日系の判定の前後を返す', async () => {
    const { db, tables } = makeDb({
      friends: [
        { id: 'f-sub', line_user_id: SUB_LINE_USER_ID, created_at: '2026-09-10T16:54:44.210+09:00' },
        { id: 'f-other', line_user_id: uid('9'), created_at: '2026-09-13T00:00:00.000+09:00' },
      ],
    });
    sheets({ customers: [{ LINE_ID: SUB_LINE_USER_ID, 友達登録日時: '2025-10-18T22:13:48.000Z' }, { LINE_ID: uid('9'), 友達登録日時: '2020-01-01T00:00:00.000Z' }] });
    const dry = await run(db, 'friend-sub', true);
    expect(dry.judgeBefore).toMatchObject({ friendCreatedAt: '2026-09-10T16:54:44.210+09:00', furimanCoupon: '7日未満（半額）', extendTrial: '1週間以内（+7日）' });
    expect(dry.judgeAfter).toMatchObject({ friendCreatedAt: '2025-10-19T07:13:48.000+09:00', furimanCoupon: '経過済み（20%OFF）', extendTrial: '経過済み（+3日）' });
    const first = await expectIdempotent(db, tables, 'friend-sub', { candidates: 1, skippedNoSource: 0, skippedAlreadyFixed: 0 });
    expect(first.judgeAfter).toMatchObject({ friendCreatedAt: '2025-10-19T07:13:48.000+09:00', furimanCoupon: '経過済み（20%OFF）', extendTrial: '経過済み（+3日）' });
    expect(tables.friends[1].created_at).toBe('2026-09-13T00:00:00.000+09:00');
    expect(tables.furim_admin_audit).toHaveLength(1);
    expect(tables.furim_admin_audit[0]).toMatchObject({ table_name: 'friends', row_id: 'f-sub', column_name: 'created_at', new_value: '2025-10-19T07:13:48.000+09:00' });
  });
});

describe('fixDatetimes chats', () => {
  it('2026-07-14 15:20 の行だけを最初のメッセージの日時にし、メッセージの無い行は数える', async () => {
    const { db, tables } = makeDb({
      chats: [
        { id: 'c1', friend_id: 'f1', created_at: '2026-07-14T15:20:33.200' },
        { id: 'c2', friend_id: 'f2', created_at: '2026-07-14T15:20:33.200' },
        { id: 'c3', friend_id: 'f3', created_at: '2026-07-20T10:00:00.000+09:00' },
      ],
      messages_log: [
        { friend_id: 'f1', created_at: '2026-07-10T19:40:47.690+09:00' },
        { friend_id: 'f1', created_at: '2026-07-09 00:50:27' },
        { friend_id: 'f3', created_at: '2026-07-01T00:00:00.000+09:00' },
      ],
    });
    await expectIdempotent(db, tables, 'chats', { candidates: 1, skippedNoSource: 1, skippedAlreadyFixed: 0 });
    expect(tables.chats.map((c) => c.created_at)).toEqual(['2026-07-09T00:50:27.000+09:00', '2026-07-14T15:20:33.200', '2026-07-20T10:00:00.000+09:00']);
  });
});

describe('fixDatetimes friend-tags', () => {
  it('移行分のうち取り元がある行だけを規則どおりに直す', async () => {
    const MIG = '2026-06-11T17:40:00.199+09:00';
    const { db, tables } = makeDb({
      friends: [
        { id: 'f1', line_user_id: uid('1') },
        { id: 'f2', line_user_id: uid('2') },
      ],
      tags: [
        { id: 't-m', name: '月額5000' },
        { id: 't-r', name: '紹介経由' },
        { id: 't-y', name: 'Furimanです' },
        { id: 't-c', name: 'キャンセル済み' },
        { id: 't-u', name: '未使用ユーザー' },
        { id: 't-mk', name: '月額会員' },
      ],
      friend_tags: [
        { friend_id: 'f1', tag_id: 't-m', assigned_at: MIG },
        { friend_id: 'f1', tag_id: 't-r', assigned_at: MIG },
        { friend_id: 'f1', tag_id: 't-y', assigned_at: MIG },
        { friend_id: 'f1', tag_id: 't-c', assigned_at: MIG },
        { friend_id: 'f1', tag_id: 't-u', assigned_at: MIG },
        { friend_id: 'f2', tag_id: 't-mk', assigned_at: MIG },
        { friend_id: 'f2', tag_id: 't-c', assigned_at: '2026-07-12 20:25:10' },
      ],
      furim_payments: [
        { line_user_id: uid('1'), paid_at: '2024-02-01T10:00:00.000+09:00' },
        { line_user_id: uid('1'), paid_at: '2024-01-01T10:00:00.000+09:00' },
        { line_user_id: uid('2'), paid_at: '2026-07-01T10:00:00.000+09:00' },
      ],
      furim_referrals: [{ introduced_friend_id: 'f1', created_at: '2024-04-13 15:16:04' }],
      furim_coupon_applications: [
        { line_user_id: uid('1'), route: 'Furiman経由', created_at: '2025-07-30T16:10:30.371+09:00' },
        { line_user_id: uid('1'), route: '別経路', created_at: '2025-01-01T00:00:00.000+09:00' },
      ],
      furim_cancellations: [
        { line_user_id: uid('1'), canceled_at: '2024-03-01T00:00:00.000+09:00' },
        { line_user_id: uid('1'), canceled_at: '2025-03-01T00:00:00.000+09:00' },
        { line_user_id: uid('2'), canceled_at: '2025-05-01T00:00:00.000+09:00' },
      ],
    });
    await expectIdempotent(db, tables, 'friend-tags', { candidates: 4, skippedNoSource: 1, skippedAlreadyFixed: 0 });
    const at = (f: string, tg: string) => tables.friend_tags.find((x) => x.friend_id === f && x.tag_id === tg)!.assigned_at;
    expect(at('f1', 't-m')).toBe('2024-01-01T10:00:00.000+09:00');
    expect(at('f1', 't-r')).toBe('2024-04-13T15:16:04.000+09:00');
    expect(at('f1', 't-y')).toBe('2025-07-30T16:10:30.371+09:00');
    expect(at('f1', 't-c')).toBe('2025-03-01T00:00:00.000+09:00');
    expect(at('f1', 't-u')).toBe(MIG);
    expect(at('f2', 't-mk')).toBe(MIG);
    expect(at('f2', 't-c')).toBe('2026-07-12 20:25:10');
    expect(tables.furim_admin_audit.map((a) => a.row_id)).toEqual(['f1|t-m', 'f1|t-r', 'f1|t-y', 'f1|t-c']);
  });
});

describe('UPDATE は変更前の値を条件にする', () => {
  it('読んだ後に値が変わった行は更新されず、監査ログも残らない', async () => {
    const { db, tables } = makeDb({ affiliates: [{ id: 'a1', code: 'C1', created_at: '2026-09-13T22:54:22.413' }] });
    sheets({ ambassadors: [{ 登録日時: '2024-04-07T11:21:08.000Z', アンバサダーコード: 'C1' }] });
    const origBatch = db.batch.bind(db);
    (db as unknown as { batch: typeof db.batch }).batch = async (stmts) => {
      tables.affiliates[0].created_at = '2026-09-14T00:00:00.000+09:00';
      return origBatch(stmts);
    };
    const r = await run(db, 'affiliates', false);
    expect(r).toMatchObject({ candidates: 1, updated: 0, auditRows: 0 });
    expect(tables.furim_admin_audit ?? []).toHaveLength(0);
  });
});

describe('POST /api/furim/fix-datetimes', () => {
  function envWith(db: D1Database, workerName: string) {
    return { DB: db, API_KEY: 'owner-key', WORKER_NAME: workerName, GAS_DEPLOY_ID: 'gas', LINE_LOGIN_CHANNEL_ID: '2000000000', WORKER_URL: 'https://worker.example.com' } as unknown as import('../index.js').Env['Bindings'];
  }
  function call(db: D1Database, workerName: string, method: string, body?: unknown, query = '') {
    return worker.fetch(
      new Request(`https://worker.example.com/api/furim/fix-datetimes${query}`, {
        method,
        headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      envWith(db, workerName),
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
  }
  const fixture = () => makeDb({ affiliates: [{ id: 'a1', code: 'C1', created_at: '2026-09-13T22:54:22.413' }] });

  it('本番 worker で confirmProd なしの実行は 403 で何も書かない', async () => {
    const { db, tables, writes } = fixture();
    sheets({ ambassadors: [{ 登録日時: '2024-04-07T11:21:08.000Z', アンバサダーコード: 'C1' }] });
    const res = await call(db, 'line-harness-prod', 'POST', { target: 'affiliates', dryRun: false });
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
    expect(tables.affiliates[0].created_at).toBe('2026-09-13T22:54:22.413');
  });

  it('dryRun は既定で true・本番でも読むだけ', async () => {
    const { db, writes } = fixture();
    sheets({ ambassadors: [{ 登録日時: '2024-04-07T11:21:08.000Z', アンバサダーコード: 'C1' }] });
    const res = await call(db, 'line-harness-prod', 'POST', { target: 'affiliates' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ success: true, target: 'affiliates', dryRun: true, candidates: 1, updated: 0, auditRows: 0 });
    expect(writes).toHaveLength(0);
  });

  it('本番で confirmProd: true なら実行し、staff の id で監査ログを残す', async () => {
    const { db, tables } = fixture();
    sheets({ ambassadors: [{ 登録日時: '2024-04-07T11:21:08.000Z', アンバサダーコード: 'C1' }] });
    const res = await call(db, 'line-harness-prod', 'POST', { target: 'affiliates', dryRun: false, confirmProd: true });
    expect(await res.json()).toMatchObject({ success: true, dryRun: false, updated: 1, auditRows: 1 });
    expect(tables.furim_admin_audit[0]).toMatchObject({ staff_id: 'env-owner', staff_name: FIX_STAFF_NAME });
  });

  it('target が不正なら 400', async () => {
    const { db } = fixture();
    const res = await call(db, 'line-harness', 'POST', { target: 'survey-answers', dryRun: false });
    expect(res.status).toBe(400);
  });

  it('GET は target ごとの件数と例を返し、書き込まない', async () => {
    const { db, writes } = fixture();
    sheets({ ambassadors: [{ 登録日時: '2024-04-07T11:21:08.000Z', アンバサダーコード: 'C1' }] });
    const res = await call(db, 'line-harness-prod', 'GET', undefined, '?target=affiliates');
    const json = (await res.json()) as { targets: Array<Record<string, unknown>> };
    expect(json.targets).toHaveLength(1);
    expect(json.targets[0]).toMatchObject({ target: 'affiliates', dryRun: true, candidates: 1, samples: [{ rowId: 'a1', newValue: '2024-04-07T20:21:08.000+09:00' }] });
    expect(writes).toHaveLength(0);
  });
});
