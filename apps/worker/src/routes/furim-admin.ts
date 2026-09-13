import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import { ADMIN_TABLES, getAdminTable, type AdminColumn, type AdminKeyKind, type AdminTable } from '../furim/admin-schema.js';
import type { Env } from '../index.js';

/**
 * 管理画面「データ」区画の汎用 CRUD（Capsec #251・段階4-A の最小）。
 * furim/admin-schema.ts のホワイトリストにあるテーブル・列だけを扱う。
 * 認証は authMiddleware（スタッフ）。PATCH は owner/admin のみで、変更列ごとに
 * furim_admin_audit に前後の値を残す。追加・削除・CSV は親 #246 で。
 *
 * #253: 一覧・1 行のレスポンスに付加列 _display_name（friends.display_name）を付ける。
 * テーブルの keys（line_user_id / friend_id / stripe_customer_id / key_code）の順で最初に値がある列から
 * 解決し、stripe_customer_id・key_code は furim_customers 経由で line_user_id にしてから friends を引く。
 * GET :table/:id/related は同じ keys で紐づく別テーブルの件数と最新 20 件を返す。
 */

const furimAdmin = new Hono<Env>();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const RELATED_LIMIT = 20;
const IN_CHUNK = 100;

type Row = Record<string, unknown>;

function keyText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'string' ? v : String(v);
  return s === '' ? null : s;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function selectIn<T extends Row>(db: D1Database, sql: (placeholders: string) => string, values: string[]): Promise<T[]> {
  const results = await Promise.all(
    chunk(values, IN_CHUNK).map((part) =>
      db
        .prepare(sql(part.map(() => '?').join(',')))
        .bind(...part)
        .all<T>(),
    ),
  );
  return results.flatMap((r) => r.results ?? []);
}

type CustomerKeyRow = { line_user_id: string; stripe_customer_id: string | null; key_code: string | null };
type FriendKeyRow = { id: string; line_user_id: string; display_name: string | null };

/** stripe_customer_id / key_code → line_user_id（furim_customers） */
async function resolveLineUserIds(db: D1Database, stripeIds: string[], keyCodes: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (stripeIds.length) {
    const rows = await selectIn<CustomerKeyRow>(
      db,
      (ph) => `SELECT line_user_id, stripe_customer_id, key_code FROM furim_customers WHERE stripe_customer_id IN (${ph})`,
      stripeIds,
    );
    for (const r of rows) if (r.stripe_customer_id) map.set(`stripe_customer_id:${r.stripe_customer_id}`, r.line_user_id);
  }
  if (keyCodes.length) {
    const rows = await selectIn<CustomerKeyRow>(
      db,
      (ph) => `SELECT line_user_id, stripe_customer_id, key_code FROM furim_customers WHERE key_code IN (${ph})`,
      keyCodes,
    );
    for (const r of rows) if (r.key_code) map.set(`key_code:${r.key_code}`, r.line_user_id);
  }
  return map;
}

/** 各行に _display_name を付ける。複数テーブル分をまとめて、種別ごとの IN クエリ（100 件ずつ）で引く */
export async function attachDisplayNames(db: D1Database, groups: Array<{ table: AdminTable; rows: Row[] }>): Promise<void> {
  const subjects: Array<{ row: Row; kind: AdminKeyKind; value: string }> = [];
  for (const g of groups) {
    for (const row of g.rows) {
      row._display_name = null;
      for (const key of g.table.keys) {
        const value = keyText(row[key.column]);
        if (value) {
          subjects.push({ row, kind: key.kind, value });
          break;
        }
      }
    }
  }
  if (subjects.length === 0) return;

  const uniq = (kind: AdminKeyKind) => [...new Set(subjects.filter((s) => s.kind === kind).map((s) => s.value))];
  const viaCustomer = await resolveLineUserIds(db, uniq('stripe_customer_id'), uniq('key_code'));

  const lineIds = new Set<string>(uniq('line_user_id'));
  for (const v of viaCustomer.values()) lineIds.add(v);
  const friendIds = uniq('friend_id');

  const byLine = new Map<string, string | null>();
  const byFriend = new Map<string, string | null>();
  if (lineIds.size) {
    const rows = await selectIn<FriendKeyRow>(db, (ph) => `SELECT id, line_user_id, display_name FROM friends WHERE line_user_id IN (${ph})`, [...lineIds]);
    for (const r of rows) byLine.set(r.line_user_id, r.display_name);
  }
  if (friendIds.length) {
    const rows = await selectIn<FriendKeyRow>(db, (ph) => `SELECT id, line_user_id, display_name FROM friends WHERE id IN (${ph})`, friendIds);
    for (const r of rows) byFriend.set(r.id, r.display_name);
  }

  for (const s of subjects) {
    let name: string | null | undefined;
    if (s.kind === 'line_user_id') name = byLine.get(s.value);
    else if (s.kind === 'friend_id') name = byFriend.get(s.value);
    else {
      const line = viaCustomer.get(`${s.kind}:${s.value}`);
      name = line ? byLine.get(line) : undefined;
    }
    s.row._display_name = name ?? null;
  }
}

type Identity = {
  line_user_id: string | null;
  friend_id: string | null;
  display_name: string | null;
  stripe_customer_id: string | null;
  key_code: string | null;
};

/** 行の keys から本人を特定し、friends と furim_customers で残りのキーを補完する */
export async function resolveIdentity(db: D1Database, table: AdminTable, row: Row): Promise<Identity> {
  const id: Identity = { line_user_id: null, friend_id: null, display_name: null, stripe_customer_id: null, key_code: null };
  for (const key of table.keys) {
    const value = keyText(row[key.column]);
    if (value && id[key.kind] === null) id[key.kind] = value;
  }

  if (!id.line_user_id && id.friend_id) {
    const f = await db.prepare('SELECT id, line_user_id, display_name FROM friends WHERE id = ?').bind(id.friend_id).first<FriendKeyRow>();
    if (f) {
      id.line_user_id = f.line_user_id;
      id.display_name = f.display_name;
    }
  }
  if (!id.line_user_id && (id.stripe_customer_id || id.key_code)) {
    const c = await db
      .prepare('SELECT line_user_id, stripe_customer_id, key_code FROM furim_customers WHERE stripe_customer_id = ? OR key_code = ? LIMIT 1')
      .bind(id.stripe_customer_id ?? '', id.key_code ?? '')
      .first<CustomerKeyRow>();
    if (c) id.line_user_id = c.line_user_id;
  }
  if (id.line_user_id) {
    const [f, c] = await Promise.all([
      id.friend_id && id.display_name !== null
        ? Promise.resolve(null)
        : db.prepare('SELECT id, line_user_id, display_name FROM friends WHERE line_user_id = ?').bind(id.line_user_id).first<FriendKeyRow>(),
      table.name === 'furim_customers'
        ? Promise.resolve(null)
        : db.prepare('SELECT line_user_id, stripe_customer_id, key_code FROM furim_customers WHERE line_user_id = ?').bind(id.line_user_id).first<CustomerKeyRow>(),
    ]);
    if (f) {
      id.friend_id = id.friend_id ?? f.id;
      id.display_name = f.display_name;
    }
    if (c) {
      id.stripe_customer_id = id.stripe_customer_id ?? c.stripe_customer_id;
      id.key_code = id.key_code ?? c.key_code;
    }
  }
  return id;
}

function serializeTable(table: AdminTable) {
  return {
    name: table.name,
    label: table.label,
    pk: table.pk,
    columns: table.columns.map((c) => ({
      name: c.name,
      type: c.type,
      editable: c.editable,
      searchable: Boolean(c.searchable),
    })),
    keys: table.keys,
  };
}

function requireTable(name: string): AdminTable | null {
  return getAdminTable(name) ?? null;
}

function coerceValue(col: AdminColumn, raw: unknown): { ok: true; value: string | number | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  if (col.type === 'text') {
    if (typeof raw === 'string') return { ok: true, value: raw };
    if (typeof raw === 'number') return { ok: true, value: String(raw) };
    return { ok: false, error: `${col.name} は文字列で指定してください` };
  }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return { ok: false, error: `${col.name} は数値で指定してください` };
  if (col.type === 'integer' && !Number.isInteger(n)) return { ok: false, error: `${col.name} は整数で指定してください` };
  return { ok: true, value: n };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return String(a) === String(b);
}

function toAuditText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : String(v);
}

export async function fetchRow(db: D1Database, table: AdminTable, id: string): Promise<Row | null> {
  return db.prepare(`SELECT * FROM ${table.name} WHERE ${table.pk} = ?`).bind(id).first<Row>();
}

// GET /api/furim/admin/tables — 扱えるテーブルとスキーマ
furimAdmin.get('/api/furim/admin/tables', async (c) => {
  return c.json({ success: true, data: ADMIN_TABLES.map(serializeTable) });
});

// GET /api/furim/admin/:table?q=&limit=&cursor= — 一覧・検索（cursor はオフセット）
furimAdmin.get('/api/furim/admin/:table', async (c) => {
  const table = requireTable(c.req.param('table'));
  if (!table) return c.json({ success: false, error: 'このテーブルは扱えません' }, 404);

  const q = (c.req.query('q') ?? '').trim();
  const limitRaw = Number(c.req.query('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : DEFAULT_LIMIT;
  const offsetRaw = Number(c.req.query('cursor') ?? 0);
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  const searchable = table.columns.filter((col) => col.searchable).map((col) => col.name);
  let where = '';
  const binds: unknown[] = [];
  if (q && searchable.length > 0) {
    where = ` WHERE ${searchable.map((name) => `${name} LIKE ?`).join(' OR ')}`;
    for (let i = 0; i < searchable.length; i++) binds.push(`%${q}%`);
  }

  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table.name}${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  const total = countRow?.n ?? 0;

  const rows = await c.env.DB.prepare(
    `SELECT * FROM ${table.name}${where} ORDER BY ${table.orderBy}, ${table.pk} LIMIT ? OFFSET ?`,
  )
    .bind(...binds, limit + 1, offset)
    .all<Row>();
  const results = rows.results ?? [];
  const hasMore = results.length > limit;
  const data = hasMore ? results.slice(0, limit) : results;
  await attachDisplayNames(c.env.DB, [{ table, rows: data }]);

  return c.json({
    success: true,
    data,
    meta: {
      table: serializeTable(table),
      total,
      limit,
      cursor: String(offset),
      nextCursor: hasMore ? String(offset + limit) : null,
    },
  });
});

// GET /api/furim/admin/:table/:id/audit — その行の監査ログ
furimAdmin.get('/api/furim/admin/:table/:id/audit', async (c) => {
  const table = requireTable(c.req.param('table'));
  if (!table) return c.json({ success: false, error: 'このテーブルは扱えません' }, 404);
  const rows = await c.env.DB.prepare(
    `SELECT * FROM furim_admin_audit WHERE table_name = ? AND row_id = ? ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(table.name, c.req.param('id'))
    .all<Row>();
  return c.json({ success: true, data: rows.results ?? [] });
});

// GET /api/furim/admin/:table/:id/related — その行の本人に紐づく別テーブルの件数と最新 20 件
furimAdmin.get('/api/furim/admin/:table/:id/related', async (c) => {
  const table = requireTable(c.req.param('table'));
  if (!table) return c.json({ success: false, error: 'このテーブルは扱えません' }, 404);
  const rowId = c.req.param('id');
  const row = await fetchRow(c.env.DB, table, rowId);
  if (!row) return c.json({ success: false, error: '行が見つかりません' }, 404);

  const identity = await resolveIdentity(c.env.DB, table, row);

  const targets: Array<{ table: AdminTable; where: string; binds: string[]; q: string }> = [];
  for (const t of ADMIN_TABLES) {
    const conds: string[] = [];
    const binds: string[] = [];
    let q = '';
    for (const key of t.keys) {
      const v = identity[key.kind];
      if (!v) continue;
      conds.push(`${key.column} = ?`);
      binds.push(v);
      if (!q) q = v;
    }
    if (conds.length === 0) continue;
    let where = `(${conds.join(' OR ')})`;
    if (t.name === table.name) {
      where += ` AND ${t.pk} != ?`;
      binds.push(rowId);
    }
    targets.push({ table: t, where, binds, q });
  }

  const statements = targets.flatMap((tg) => [
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${tg.table.name} WHERE ${tg.where}`).bind(...tg.binds),
    c.env.DB.prepare(`SELECT * FROM ${tg.table.name} WHERE ${tg.where} ORDER BY ${tg.table.orderBy}, ${tg.table.pk} LIMIT ?`).bind(...tg.binds, RELATED_LIMIT),
  ]);
  const results = statements.length ? await c.env.DB.batch<Row>(statements) : [];

  const related = targets.map((tg, i) => {
    const countRow = (results[i * 2]?.results ?? [])[0] as { n?: number } | undefined;
    const rows = results[i * 2 + 1]?.results ?? [];
    return { table: serializeTable(tg.table), total: Number(countRow?.n ?? 0), rows, q: tg.q };
  });
  await attachDisplayNames(c.env.DB, related.map((r, i) => ({ table: targets[i].table, rows: r.rows })));

  return c.json({ success: true, data: { identity, related } });
});

// GET /api/furim/admin/:table/:id — 1 行
furimAdmin.get('/api/furim/admin/:table/:id', async (c) => {
  const table = requireTable(c.req.param('table'));
  if (!table) return c.json({ success: false, error: 'このテーブルは扱えません' }, 404);
  const row = await fetchRow(c.env.DB, table, c.req.param('id'));
  if (!row) return c.json({ success: false, error: '行が見つかりません' }, 404);
  await attachDisplayNames(c.env.DB, [{ table, rows: [row] }]);
  return c.json({ success: true, data: row, meta: { table: serializeTable(table) } });
});

// PATCH /api/furim/admin/:table/:id {changes:{列:値}} — 編集可能列だけ更新し監査ログを残す
furimAdmin.patch('/api/furim/admin/:table/:id', requireRole('owner', 'admin'), async (c) => {
  const table = requireTable(c.req.param('table')!);
  if (!table) return c.json({ success: false, error: 'このテーブルは扱えません' }, 404);
  const id = c.req.param('id')!;

  let body: { changes?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'JSON が不正です' }, 400);
  }
  const changes = body?.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return c.json({ success: false, error: 'changes を {列: 値} で指定してください' }, 400);
  }

  const before = await fetchRow(c.env.DB, table, id);
  if (!before) return c.json({ success: false, error: '行が見つかりません' }, 404);

  const updates: { col: AdminColumn; value: string | number | null }[] = [];
  for (const [name, raw] of Object.entries(changes as Record<string, unknown>)) {
    const col = table.columns.find((x) => x.name === name);
    if (!col) return c.json({ success: false, error: `${name} は存在しない列です` }, 400);
    if (!col.editable) return c.json({ success: false, error: `${name} は編集できません` }, 400);
    const coerced = coerceValue(col, raw);
    if (!coerced.ok) return c.json({ success: false, error: coerced.error }, 400);
    if (sameValue(before[name], coerced.value)) continue;
    updates.push({ col, value: coerced.value });
  }

  if (updates.length === 0) {
    return c.json({ success: true, data: before, meta: { changed: [] } });
  }

  const staff = c.get('staff');
  const now = jstNow();
  const setClauses = updates.map((u) => `${u.col.name} = ?`);
  const setBinds: unknown[] = updates.map((u) => u.value);
  if (table.touchUpdatedAt) {
    setClauses.push('updated_at = ?');
    setBinds.push(now);
  }

  const statements = [
    c.env.DB.prepare(`UPDATE ${table.name} SET ${setClauses.join(', ')} WHERE ${table.pk} = ?`).bind(...setBinds, id),
    ...updates.map((u) =>
      c.env.DB.prepare(
        `INSERT INTO furim_admin_audit (id, staff_id, staff_name, table_name, row_id, column_name, old_value, new_value, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        staff.id,
        staff.name,
        table.name,
        id,
        u.col.name,
        toAuditText(before[u.col.name]),
        toAuditText(u.value),
        now,
      ),
    ),
  ];

  try {
    await c.env.DB.batch(statements);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[furim-admin] PATCH ${table.name}/${id} failed: ${msg}`);
    return c.json({ success: false, error: `更新に失敗しました: ${msg}` }, 400);
  }

  const after = await fetchRow(c.env.DB, table, id);
  console.log(`[furim-admin] ${staff.name}(${staff.id}) が ${table.name}/${id} の ${updates.map((u) => u.col.name).join(',')} を更新`);
  return c.json({ success: true, data: after, meta: { changed: updates.map((u) => u.col.name) } });
});

export { furimAdmin };
