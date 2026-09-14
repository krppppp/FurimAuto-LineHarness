import { describe, it, expect, vi, beforeEach } from 'vitest';

let clock = Date.parse('2026-09-14T12:00:00.000+09:00');
const toJst = (d: Date) => new Date(d.getTime() + 9 * 60 * 60_000).toISOString().slice(0, -1) + '+09:00';
vi.mock('@line-crm/db', () => ({
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getStaffByApiKey: vi.fn().mockResolvedValue(null),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
  jstNow: () => toJst(new Date((clock += 1000))),
  toJstString: toJst,
}));

const worker = (await import('../index.js')).default;
const { applyTicketDelta, applyTicketConsume, moveConsumeRowsToAutoCopyLogs, isSameConsume } = await import('./ticket-ledger.js');

type Row = Record<string, unknown>;
const U1 = 'U' + '1'.repeat(32);
const U2 = 'U' + '2'.repeat(32);

/** 消費・付与・移動で使う文だけを意味どおりに実行する簡易 D1（PK / UNIQUE / EXISTS / MAX を模す） */
function makeDb(init: { customers?: Row[]; ledger?: Row[]; autoCopy?: Row[] } = {}) {
  const customers = new Map<string, Row>((init.customers ?? []).map((c) => [String(c.line_user_id), { ...c }]));
  const ledger: Row[] = (init.ledger ?? []).map((r) => ({ ...r }));
  const autoCopy: Row[] = (init.autoCopy ?? []).map((r) => ({ ...r }));
  const sqls: string[] = [];
  const exec = (sql: string, a: unknown[]): { changes: number; first?: unknown; all?: unknown[] } => {
    sqls.push(sql);
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT \* FROM furim_customers WHERE key_code = \?/.test(s) || /^SELECT line_user_id, key_code FROM furim_customers WHERE key_code = \?/.test(s)) {
      return { changes: 0, first: [...customers.values()].find((c) => c.key_code === a[0]) ?? null };
    }
    if (/^SELECT copy_tickets FROM furim_customers WHERE line_user_id = \?/.test(s)) {
      const c = customers.get(String(a[0]));
      return { changes: 0, first: c ? { copy_tickets: c.copy_tickets } : null };
    }
    if (/^INSERT OR IGNORE INTO furim_auto_copy_logs .* SELECT/.test(s)) {
      const [id, uid, src, tgt, delta, uid2, processed, imported, delta2, key, key2] = a;
      if (ledger.some((l) => l.idempotency_key === key2)) return { changes: 0 };
      if (autoCopy.some((r) => r.id === id || r.idempotency_key === key)) return { changes: 0 };
      const c = customers.get(String(uid2));
      const remaining = c ? Math.max(0, Number(c.copy_tickets ?? 0) + Number(delta)) : null;
      autoCopy.push({ id, line_user_id: uid, source_url: src, target_url: tgt, remaining_tickets: remaining, processed_at: processed, imported_at: imported, delta: delta2, idempotency_key: key });
      return { changes: 1 };
    }
    if (/^INSERT OR IGNORE INTO furim_auto_copy_logs .* VALUES/.test(s)) {
      const [id, uid, src, tgt, processed, imported, delta, key] = a;
      if (autoCopy.some((r) => r.id === id || r.idempotency_key === key)) return { changes: 0 };
      autoCopy.push({ id, line_user_id: uid, source_url: src, target_url: tgt, remaining_tickets: null, processed_at: processed, imported_at: imported, delta, idempotency_key: key });
      return { changes: 1 };
    }
    if (/^INSERT OR IGNORE INTO furim_ticket_ledger/.test(s)) {
      const [id, uid, delta, reason, key, pi, inv, src, tgt, created] = a;
      if (ledger.some((l) => l.id === id || l.idempotency_key === key)) return { changes: 0 };
      ledger.push({ id, line_user_id: uid, delta, reason, idempotency_key: key, payment_intent_id: pi, invoice_id: inv, source_url: src, target_url: tgt, created_at: created });
      return { changes: 1 };
    }
    const upd = s.match(/^UPDATE furim_customers SET copy_tickets = MAX\(0, COALESCE\(copy_tickets, 0\) \+ \?\), updated_at = \? WHERE line_user_id = \? AND EXISTS \(SELECT 1 FROM (furim_auto_copy_logs|furim_ticket_ledger) WHERE id = \?\)/);
    if (upd) {
      const [delta, now, uid, id] = a;
      const table = upd[1] === 'furim_auto_copy_logs' ? autoCopy : ledger;
      const c = customers.get(String(uid));
      if (!c || !table.some((r) => r.id === id)) return { changes: 0 };
      c.copy_tickets = Math.max(0, Number(c.copy_tickets ?? 0) + Number(delta));
      c.updated_at = now;
      return { changes: 1 };
    }
    if (/^SELECT id, line_user_id, delta, idempotency_key, source_url, target_url, created_at FROM furim_ticket_ledger WHERE reason = 'consume'/.test(s)) {
      return { changes: 0, all: ledger.filter((l) => l.reason === 'consume').sort((x, y) => String(x.created_at).localeCompare(String(y.created_at))) };
    }
    if (/^SELECT COUNT\(\*\) AS n FROM furim_auto_copy_logs$/.test(s)) return { changes: 0, first: { n: autoCopy.length } };
    if (/^SELECT COUNT\(\*\) AS n FROM furim_ticket_ledger WHERE reason = 'consume'$/.test(s)) return { changes: 0, first: { n: ledger.filter((l) => l.reason === 'consume').length } };
    if (/^SELECT id, line_user_id, source_url, target_url, processed_at, idempotency_key FROM furim_auto_copy_logs WHERE \(processed_at >= \? AND processed_at <= \?\) OR idempotency_key IN/.test(s)) {
      const [from, to, ...keys] = a.map(String);
      return { changes: 0, all: autoCopy.filter((r) => (String(r.processed_at) >= from && String(r.processed_at) <= to) || keys.includes(String(r.idempotency_key))) };
    }
    if (/^UPDATE furim_auto_copy_logs SET idempotency_key = \?, delta = \?, line_user_id = COALESCE\(line_user_id, \?\) WHERE id = \? AND idempotency_key IS NULL$/.test(s)) {
      const [key, delta, uid, id] = a;
      const r = autoCopy.find((x) => x.id === id && x.idempotency_key == null);
      if (!r) return { changes: 0 };
      if (autoCopy.some((x) => x.idempotency_key === key)) throw new Error('UNIQUE constraint failed: furim_auto_copy_logs.idempotency_key');
      Object.assign(r, { idempotency_key: key, delta, line_user_id: r.line_user_id ?? uid });
      return { changes: 1 };
    }
    if (/^DELETE FROM furim_ticket_ledger WHERE id = \? AND reason = 'consume' AND EXISTS \(SELECT 1 FROM furim_auto_copy_logs WHERE idempotency_key = \?\)$/.test(s)) {
      const [id, key] = a;
      const i = ledger.findIndex((l) => l.id === id && l.reason === 'consume');
      if (i < 0 || !autoCopy.some((r) => r.idempotency_key === key)) return { changes: 0 };
      ledger.splice(i, 1);
      return { changes: 1 };
    }
    return { changes: 0 };
  };
  const stmt = (sql: string, args: unknown[]) => ({
    sql,
    args,
    run: async () => ({ meta: { changes: exec(sql, args).changes } }),
    first: async () => exec(sql, args).first ?? null,
    all: async () => ({ results: exec(sql, args).all ?? [] }),
  });
  const db = {
    prepare: (sql: string) => ({ ...stmt(sql, []), bind: (...args: unknown[]) => stmt(sql, args) }),
    batch: async (stmts: Array<{ sql: string; args: unknown[] }>) => stmts.map((x) => ({ meta: { changes: exec(x.sql, x.args).changes } })),
  } as unknown as D1Database;
  return { db, customers, ledger, autoCopy, sqls };
}

function env(db: D1Database) {
  return { DB: db, FURIM_EXT_CACHE: undefined, LINE_LOGIN_CHANNEL_ID: '2000000000', API_KEY: 'owner-key', WORKER_URL: 'https://worker.example.com' } as unknown as import('../index.js').Env['Bindings'];
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function copyCredit(db: D1Database, body: Row) {
  const res = await worker.fetch(new Request('https://worker.example.com/api/ext/v1/copy-credit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FurimAuto-Client': 'ext/4.3.2', 'cf-connecting-ip': '203.0.113.20' },
    body: JSON.stringify(body),
  }), env(db), ctx);
  return { status: res.status, json: await res.json() };
}

async function ticketConsumed(db: D1Database, body: Row) {
  const res = await worker.fetch(new Request('https://worker.example.com/api/furim/ticket-consumed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner-key' },
    body: JSON.stringify(body),
  }), env(db), ctx);
  return { status: res.status, json: await res.json() };
}

const customer = () => ({ line_user_id: U1, key_code: 'pb_abc', key_code_issued: 1, device_activated: 0, device_code: null, subscription_end_at: '2099-01-01 00:00:00', plan_label: 'PBプラン:メルカリ 基本プラン', copy_tickets: 12, mercari_url: null, ext_last_seen_at: null, updated_at: '2026-09-13 00:00:00' });
const consume = { keyCode: 'pb_abc', delta: -1, dedupeKey: 'k1', sourceUrl: 'https://jp.mercari.com/item/m1', targetUrl: 'https://item.fril.jp/x' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('チケット消費は自動コピー出品履歴に 1 行（新旧 2 経路・同じ冪等キー）', () => {
  it('copy-credit → ticket-consumed: 残数は 1 回だけ減り、自動コピー出品履歴は 1 行、台帳は増えない', async () => {
    const d = makeDb({ customers: [customer()] });
    const a = await copyCredit(d.db, consume);
    expect(a).toEqual({ status: 200, json: { success: true, keyCode: 'pb_abc', copyCredit: 11, message: 'コピー出品チケットを更新しました' } });
    const b = await ticketConsumed(d.db, consume);
    expect(b).toEqual({ status: 200, json: { success: true, applied: false, copyTickets: 11 } });
    expect(d.customers.get(U1)?.copy_tickets).toBe(11);
    expect(d.autoCopy).toHaveLength(1);
    expect(d.autoCopy[0]).toMatchObject({ line_user_id: U1, source_url: consume.sourceUrl, target_url: consume.targetUrl, remaining_tickets: 11, delta: -1, idempotency_key: 'consume:k1' });
    expect(d.ledger).toHaveLength(0);
  });

  it('ticket-consumed → copy-credit（逆順）も 1 回・1 行。拡張への再送応答は従来の形', async () => {
    const d = makeDb({ customers: [customer()] });
    expect((await ticketConsumed(d.db, consume)).json).toEqual({ success: true, applied: true, copyTickets: 11 });
    expect((await copyCredit(d.db, consume)).json).toEqual({ success: true, keyCode: 'pb_abc', copyCredit: 11, message: '再送のためスキップしました' });
    expect(d.customers.get(U1)?.copy_tickets).toBe(11);
    expect(d.autoCopy).toHaveLength(1);
    expect(d.ledger).toHaveLength(0);
  });

  it('同一経路の再送（copy-credit 2 回・ticket-consumed 2 回）も 1 回・1 行', async () => {
    const d = makeDb({ customers: [customer()] });
    await copyCredit(d.db, consume);
    expect((await copyCredit(d.db, consume)).json).toEqual({ success: true, keyCode: 'pb_abc', copyCredit: 11, message: '再送のためスキップしました' });
    await ticketConsumed(d.db, { ...consume, dedupeKey: 'k2' });
    expect((await ticketConsumed(d.db, { ...consume, dedupeKey: 'k2' })).json).toEqual({ success: true, applied: false, copyTickets: 10 });
    expect(d.customers.get(U1)?.copy_tickets).toBe(10);
    expect(d.autoCopy.map((r) => r.idempotency_key)).toEqual(['consume:k1', 'consume:k2']);
    expect(d.ledger).toHaveLength(0);
    expect(d.sqls.some((s) => /INTO furim_ticket_ledger/.test(s))).toBe(false);
  });

  it('残数 0 で消費しても 0 のまま・記録の残チケット数も 0', async () => {
    const d = makeDb({ customers: [{ ...customer(), copy_tickets: 0 }] });
    const r = await applyTicketConsume(d.db, undefined, { line_user_id: U1, key_code: 'pb_abc' }, { delta: -1, dedupeKey: 'z' });
    expect(r).toEqual({ applied: true, copyTickets: 0 });
    expect(d.autoCopy[0]).toMatchObject({ remaining_tickets: 0 });
  });

  it('移行前に台帳へ入った同じキーの再送は減らさない（デプロイ〜移動の間）', async () => {
    const d = makeDb({ customers: [{ ...customer(), copy_tickets: 11 }], ledger: [{ id: 'l1', line_user_id: U1, delta: -1, reason: 'consume', idempotency_key: 'consume:k1', created_at: '2026-09-14T11:59:00.000+09:00' }] });
    expect((await copyCredit(d.db, consume)).json).toEqual({ success: true, keyCode: 'pb_abc', copyCredit: 11, message: '再送のためスキップしました' });
    expect(d.autoCopy).toHaveLength(0);
  });

  it('付与（Free30 など）は今までどおり台帳に入り、自動コピー出品履歴には書かない', async () => {
    const d = makeDb({ customers: [customer()] });
    const r = await applyTicketDelta(d.db, undefined, { line_user_id: U1, key_code: 'pb_abc' }, { delta: 30, reason: 'free30', idempotencyKey: `free30:${U1}` });
    expect(r).toEqual({ applied: true, copyTickets: 42 });
    expect(d.ledger).toEqual([expect.objectContaining({ reason: 'free30', delta: 30, idempotency_key: `free30:${U1}` })]);
    expect(d.autoCopy).toHaveLength(0);
  });
});

describe('既存の consume 行を自動コピー出品履歴へ移す', () => {
  const t = (hms: string) => `2026-09-14T${hms}.000+09:00`;
  const fixtures = () => ({
    customers: [{ ...customer(), copy_tickets: 372 }, { line_user_id: U2, key_code: 'm398_x', copy_tickets: 63 }],
    ledger: [
      { id: 'p1', line_user_id: U1, delta: 100, reason: 'purchase', idempotency_key: 'purchase:in_1', created_at: t('07:00:00') },
      { id: 'c1', line_user_id: U1, delta: -1, reason: 'consume', idempotency_key: 'consume:a', source_url: 'https://jp.mercari.com/item/m1', target_url: 'https://item.fril.jp/1', created_at: '2026-09-14T08:06:09.680+09:00' },
      { id: 'c2', line_user_id: U1, delta: 1, reason: 'consume', idempotency_key: 'consume:b', source_url: null, target_url: null, created_at: '2026-09-14T08:06:12.867+09:00' },
      { id: 'c3', line_user_id: U2, delta: -1, reason: 'consume', idempotency_key: 'consume:c', source_url: 'https://jp.mercari.com/item/m3', target_url: 'https://paypayfleamarket.yahoo.co.jp/item/z3', created_at: '2026-09-14T08:28:55.111+09:00' },
      { id: 'c4', line_user_id: U2, delta: -1, reason: 'consume', idempotency_key: 'consume:d', source_url: 'https://jp.mercari.com/item/m4', target_url: 'https://paypayfleamarket.yahoo.co.jp/item/z4', created_at: '2026-09-14T10:03:27.222+09:00' },
    ],
    autoCopy: [
      { id: 's1', line_user_id: U1, source_url: 'https://jp.mercari.com/item/m1', target_url: 'https://item.fril.jp/1', remaining_tickets: 297, processed_at: t('08:06:10'), idempotency_key: null },
      { id: 's2', line_user_id: U1, source_url: null, target_url: null, remaining_tickets: 372, processed_at: t('08:06:13'), idempotency_key: null },
      { id: 's3', line_user_id: null, source_url: 'https://jp.mercari.com/item/m3', target_url: 'https://paypayfleamarket.yahoo.co.jp/item/z3', remaining_tickets: 66, processed_at: t('08:28:56'), idempotency_key: null },
      { id: 's9', line_user_id: null, source_url: 'https://jp.mercari.com/item/m9', target_url: 'https://item.fril.jp/9', remaining_tickets: 5, processed_at: t('08:07:00'), idempotency_key: null },
    ],
  });

  it('シート取り込み済みの同じ消費には冪等キーを付けて 1 行に寄せ、無ければ入れ、台帳から消す。残数は変えない。2 回目は何もしない', async () => {
    const d = makeDb(fixtures());
    const first = await moveConsumeRowsToAutoCopyLogs(d.db, { dryRun: false, now: t('12:00:00') });
    expect(first).toMatchObject({ ledgerConsumeBefore: 4, ledgerConsumeAfter: 0, autoCopyBefore: 4, autoCopyAfter: 5, merged: 3, inserted: 1, alreadyMoved: 0, deleted: 4 });
    expect(first.copyTicketsAfter).toEqual(first.copyTicketsBefore);
    expect(first.rows.map((r) => [r.ledgerId, r.action, r.autoCopyId])).toEqual([['c1', 'merge', 's1'], ['c2', 'merge', 's2'], ['c3', 'merge', 's3'], ['c4', 'insert', 'c4']]);
    expect(d.autoCopy.find((r) => r.id === 's3')).toMatchObject({ idempotency_key: 'consume:c', delta: -1, line_user_id: U2, remaining_tickets: 66 });
    expect(d.autoCopy.find((r) => r.id === 'c4')).toMatchObject({ idempotency_key: 'consume:d', line_user_id: U2, processed_at: '2026-09-14T10:03:27.222+09:00', remaining_tickets: null });
    expect(d.autoCopy.find((r) => r.id === 's9')).toMatchObject({ idempotency_key: null });
    expect(d.ledger.map((l) => l.id)).toEqual(['p1']);
    expect(d.customers.get(U1)?.copy_tickets).toBe(372);
    expect(d.customers.get(U2)?.copy_tickets).toBe(63);

    const second = await moveConsumeRowsToAutoCopyLogs(d.db, { dryRun: false, now: t('12:05:00') });
    expect(second).toMatchObject({ ledgerConsumeBefore: 0, ledgerConsumeAfter: 0, autoCopyBefore: 5, autoCopyAfter: 5, merged: 0, inserted: 0, deleted: 0 });
    expect(d.autoCopy).toHaveLength(5);
  });

  it('移動済みのキーが台帳に残っていたら台帳から消すだけ・dryRun は書かない', async () => {
    const f = fixtures();
    const d = makeDb({ ...f, autoCopy: [...f.autoCopy, { id: 'x', line_user_id: U2, source_url: null, target_url: null, processed_at: t('10:03:28'), idempotency_key: 'consume:d' }] });
    const dry = await moveConsumeRowsToAutoCopyLogs(d.db, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, merged: 3, inserted: 0, alreadyMoved: 1, deleted: 0, ledgerConsumeAfter: 4 });
    expect(d.ledger).toHaveLength(5);
    const real = await moveConsumeRowsToAutoCopyLogs(d.db, { dryRun: false });
    expect(real).toMatchObject({ alreadyMoved: 1, deleted: 4, autoCopyAfter: 5 });
  });

  it('同じ消費の判定: URL が同じ・2 分以内・line_user_id が食い違わない', () => {
    const base = { line_user_id: U1, source_url: 'a', target_url: 'b', at: t('08:00:00') };
    expect(isSameConsume(base, { ...base, line_user_id: null, at: t('08:01:59') })).toBe(true);
    expect(isSameConsume(base, { ...base, at: t('08:02:01') })).toBe(false);
    expect(isSameConsume(base, { ...base, target_url: 'c' })).toBe(false);
    expect(isSameConsume(base, { ...base, line_user_id: U2 })).toBe(false);
  });
});
