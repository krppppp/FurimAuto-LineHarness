import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import { ADMIN_TABLES, getAdminTable, type AdminColumn, type AdminTable } from '../furim/admin-schema.js';
import type { Env } from '../index.js';

/**
 * 管理画面「データ」区画の汎用 CRUD（Capsec #251・段階4-A の最小）。
 * furim/admin-schema.ts のホワイトリストにあるテーブル・列だけを扱う。
 * 認証は authMiddleware（スタッフ）。PATCH は owner/admin のみで、変更列ごとに
 * furim_admin_audit に前後の値を残す。追加・削除・CSV は親 #246 で。
 */

const furimAdmin = new Hono<Env>();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type Row = Record<string, unknown>;

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

// GET /api/furim/admin/:table/:id — 1 行
furimAdmin.get('/api/furim/admin/:table/:id', async (c) => {
  const table = requireTable(c.req.param('table'));
  if (!table) return c.json({ success: false, error: 'このテーブルは扱えません' }, 404);
  const row = await fetchRow(c.env.DB, table, c.req.param('id'));
  if (!row) return c.json({ success: false, error: '行が見つかりません' }, 404);
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
