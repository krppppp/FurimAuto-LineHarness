import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import {
  ADMIN_TABLES,
  DISPLAY_NAME_COLUMN,
  FEATURE_FLAG_LOCK_PREFIX,
  FEATURE_FLAG_ORDER,
  FEATURE_FLAG_PREFIX,
  FEATURE_SITE_NAMES,
  FRIEND_CREATED_AT_COLUMN,
  columnLabel,
  csvColumnNames,
  datetimeStorageOf,
  getAdminTable,
  listColumnNames,
  toDisplayDateTime,
  virtualColumnOf,
  isDeletable,
  isInsertable,
  parseRowId,
  pkColumns,
  pkLabel,
  rowIdOf,
  type AdminColumn,
  type AdminKeyKind,
  type AdminTable,
  type AdminVirtualColumn,
} from '../furim/admin-schema.js';
import { invalidateExtCache } from '../furim/ext-auth.js';
import type { Env } from '../index.js';

/**
 * 管理画面「データ」区画の汎用 CRUD（Capsec #251・段階4-A の最小）。
 * furim/admin-schema.ts のホワイトリストにあるテーブル・列だけを扱う。
 * 認証は authMiddleware（スタッフ）。PATCH は owner/admin のみで、変更列ごとに
 * furim_admin_audit に前後の値を残す。
 * #246: 追加（POST・監査 column=(insert)）・削除（DELETE・監査 column=(delete) に行 JSON）・CSV 書き出し
 * （GET :table/export.csv）・複合主キー（行 id は admin-schema の rowIdOf。全行に _id を付ける）。
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
const ALL_ROWS_LIMIT = 10000;
const EXPORT_LIMIT = 50000;
const IN_CHUNK = 100;
const AUDIT_INSERT = '(insert)';
const AUDIT_DELETE = '(delete)';

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

type AggregateRow = { k: string; n: number; rewarded: number | null; applied: number | null; total: number | null };

export async function attachVirtualColumns(db: D1Database, groups: Array<{ table: AdminTable; rows: Row[] }>): Promise<void> {
  const affiliates = groups.filter((g) => g.table.name === 'affiliates').flatMap((g) => g.rows);
  const referrals = groups.filter((g) => g.table.name === 'furim_referrals').flatMap((g) => g.rows);
  if (affiliates.length === 0 && referrals.length === 0) return;

  const friendIds = [
    ...new Set(
      [
        ...affiliates.map((r) => keyText(r.friend_id)),
        ...referrals.flatMap((r) => [keyText(r.ambassador_friend_id), keyText(r.introduced_friend_id)]),
      ].filter((v): v is string => v !== null),
    ),
  ];
  const friends = new Map<string, FriendKeyRow>();
  if (friendIds.length) {
    const rows = await selectIn<FriendKeyRow>(db, (ph) => `SELECT id, line_user_id, display_name FROM friends WHERE id IN (${ph})`, friendIds);
    for (const r of rows) friends.set(r.id, r);
  }
  const friendOf = (v: unknown) => {
    const id = keyText(v);
    return id ? friends.get(id) : undefined;
  };

  for (const row of referrals) {
    const amb = friendOf(row.ambassador_friend_id);
    row._ambassador_display_name = amb?.display_name ?? null;
    row._ambassador_line_user_id = amb?.line_user_id ?? null;
    row._introduced_line_user_id = friendOf(row.introduced_friend_id)?.line_user_id ?? null;
  }

  if (affiliates.length === 0) return;
  for (const row of affiliates) row._line_user_id = friendOf(row.friend_id)?.line_user_id ?? null;
  const affiliateIds = [...new Set(affiliates.map((r) => keyText(r.id)).filter((v): v is string => v !== null))];
  const lineIds = [...new Set(affiliates.map((r) => keyText(r._line_user_id)).filter((v): v is string => v !== null))];
  const [referralCounts, cashbacks] = await Promise.all([
    affiliateIds.length
      ? selectIn<AggregateRow>(
          db,
          (ph) =>
            `SELECT affiliate_id AS k, COUNT(*) AS n, SUM(reward_coupon_name IS NOT NULL) AS rewarded, SUM(reward_applied_at IS NOT NULL) AS applied FROM furim_referrals WHERE affiliate_id IN (${ph}) GROUP BY affiliate_id`,
          affiliateIds,
        )
      : Promise.resolve([] as AggregateRow[]),
    lineIds.length
      ? selectIn<AggregateRow>(
          db,
          (ph) =>
            `SELECT ambassador_line_user_id AS k, COUNT(*) AS n, COALESCE(SUM(cashback_amount), 0) AS total FROM furim_referral_cashbacks WHERE ambassador_line_user_id IN (${ph}) GROUP BY ambassador_line_user_id`,
          lineIds,
        )
      : Promise.resolve([] as AggregateRow[]),
  ]);
  const byAffiliate = new Map(referralCounts.map((r) => [r.k, r]));
  const byLine = new Map(cashbacks.map((r) => [r.k, r]));
  for (const row of affiliates) {
    const rc = byAffiliate.get(keyText(row.id) ?? '');
    const cb = byLine.get(keyText(row._line_user_id) ?? '');
    row._referral_count = Number(rc?.n ?? 0);
    row._reward_coupon_count = Number(rc?.rewarded ?? 0);
    row._applied_coupon_count = Number(rc?.applied ?? 0);
    row._cashback_count = Number(cb?.n ?? 0);
    row._cashback_total = Number(cb?.total ?? 0);
  }
}

type MasterFeatureRow = { key: string; display_name: string | null; payload: string | null };

/** 機能マスタ（active）→ 一覧の機能列。並びは FEATURE_FLAG_ORDER（シートの順）、そこに無い機能はマスタの順で後ろ */
export async function loadFeatureColumns(db: D1Database): Promise<AdminVirtualColumn[]> {
  const rows = await db
    .prepare("SELECT key, display_name, payload FROM furim_master WHERE kind = 'feature' AND active = 1 ORDER BY rowid")
    .bind()
    .all<MasterFeatureRow>();
  const columns: AdminVirtualColumn[] = (rows.results ?? []).map((r) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(r.payload || '{}') as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const valueType = payload.value_type;
    const flag: 'bool' | 'text' = valueType === 'bool' || (valueType === undefined && r.key !== 'AutoMultiChannel') ? 'bool' : 'text';
    const site = FEATURE_SITE_NAMES[String(payload.site ?? '')] ?? '';
    return { name: `${FEATURE_FLAG_PREFIX}${r.key}`, label: `${site}${r.display_name ?? r.key}`, type: 'text', featureKey: r.key, flag };
  });
  const rank = (key: string) => {
    const i = FEATURE_FLAG_ORDER.indexOf(key);
    return i === -1 ? FEATURE_FLAG_ORDER.length : i;
  };
  return columns.sort((a, b) => rank(a.featureKey!) - rank(b.featureKey!));
}

function withFeatureColumns(table: AdminTable, columns: AdminVirtualColumn[]): AdminTable {
  return columns.length ? { ...table, virtualColumns: [...(table.virtualColumns ?? []), ...columns] } : table;
}

const FLAG_KV_SEP = '';
const FLAG_ROW_SEP = '';
type FlagGroupRow = { line_user_id: string; f: string | null };

/** 行に _flag_<feature_key> を付ける。flags は line_user_id ごとに GROUP_CONCAT した 1 クエリ（顧客が IN_CHUNK を超えたら全件 1 クエリ） */
export async function attachFeatureFlags(db: D1Database, columns: AdminVirtualColumn[], rows: Row[]): Promise<void> {
  if (columns.length === 0 || rows.length === 0) return;
  const ids = [...new Set(rows.map((r) => keyText(r.line_user_id)).filter((v): v is string => v !== null))];
  const select = `SELECT line_user_id, GROUP_CONCAT(feature_key || char(31) || value || char(31) || locked, char(30)) AS f FROM furim_feature_flags`;
  const groups =
    ids.length === 0
      ? []
      : ids.length > IN_CHUNK
        ? ((await db.prepare(`${select} GROUP BY line_user_id`).bind().all<FlagGroupRow>()).results ?? [])
        : await selectIn<FlagGroupRow>(db, (ph) => `${select} WHERE line_user_id IN (${ph}) GROUP BY line_user_id`, ids);
  const byUser = new Map<string, Map<string, string>>();
  const lockedByUser = new Map<string, Set<string>>();
  for (const g of groups) {
    const values = new Map<string, string>();
    const locked = new Set<string>();
    for (const part of (g.f ?? '').split(FLAG_ROW_SEP)) {
      const i = part.indexOf(FLAG_KV_SEP);
      const j = part.lastIndexOf(FLAG_KV_SEP);
      if (i <= 0 || j <= i) continue;
      values.set(part.slice(0, i), part.slice(i + 1, j));
      if (part.slice(j + 1) === '1') locked.add(part.slice(0, i));
    }
    byUser.set(g.line_user_id, values);
    lockedByUser.set(g.line_user_id, locked);
  }
  for (const row of rows) {
    const uid = keyText(row.line_user_id) ?? '';
    const values = byUser.get(uid);
    const locked = lockedByUser.get(uid);
    for (const col of columns) {
      row[col.name] = values?.get(col.featureKey!) ?? null;
      if (locked?.has(col.featureKey!)) row[`${FEATURE_FLAG_LOCK_PREFIX}${col.featureKey}`] = 1;
    }
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
    pk: pkLabel(table),
    pkColumns: pkColumns(table),
    insertable: isInsertable(table),
    deletable: isDeletable(table),
    columns: table.columns.map((c) => ({
      name: c.name,
      type: c.type,
      editable: c.editable,
      searchable: Boolean(c.searchable),
      label: columnLabel(table, c.name),
      internal: (table.internal ?? []).includes(c.name),
      datetime: datetimeStorageOf(c.name),
    })),
    keys: table.keys,
    virtualColumns: table.virtualColumns ?? [],
    displayNameLabel: columnLabel(table, DISPLAY_NAME_COLUMN),
    joinFriends: Boolean(table.joinFriends),
    allRows: Boolean(table.allRows),
    timeColumn: table.timeColumn ?? null,
    timeColumnLabel: table.timeColumn ? columnLabel(table, table.timeColumn) : null,
    listColumns: listColumnNames(table),
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

/** 主キー条件（複合主キー対応）。id が形式不正なら null */
function pkWhere(table: AdminTable, id: string, prefix = ''): { where: string; binds: string[] } | null {
  const parsed = parseRowId(table, id);
  if (!parsed) return null;
  const cols = pkColumns(table);
  return { where: cols.map((c) => `${prefix}${c} = ?`).join(' AND '), binds: cols.map((c) => parsed[c]) };
}

function attachRowIds(table: AdminTable, rows: Row[]): void {
  for (const row of rows) row._id = rowIdOf(table, row);
}

export async function fetchRow(db: D1Database, table: AdminTable, id: string): Promise<Row | null> {
  const pk = pkWhere(table, id);
  if (!pk) return null;
  const row = await db.prepare(`SELECT * FROM ${table.name} WHERE ${pk.where}`).bind(...pk.binds).first<Row>();
  if (row) attachRowIds(table, [row]);
  return row;
}

/** 一覧・CSV 共通の検索条件 */
function buildListQuery(table: AdminTable, q: string): { from: string; select: string; where: string; binds: unknown[]; orderBy: string } {
  const join = Boolean(table.joinFriends);
  const col = (name: string) => (join ? `t.${name}` : name);
  const searchable = table.columns.filter((c) => c.searchable).map((c) => c.name);
  let where = '';
  const binds: unknown[] = [];
  if (q && searchable.length > 0) {
    where = ` WHERE ${searchable.map((name) => `${col(name)} LIKE ?`).join(' OR ')}`;
    for (let i = 0; i < searchable.length; i++) binds.push(`%${q}%`);
  }
  const pkFirst = pkColumns(table)[0];
  const from = join ? `${table.name} t LEFT JOIN friends f ON f.line_user_id = t.${pkFirst}` : table.name;
  const select = join ? 't.*, f.created_at AS _friend_created_at' : '*';
  const pkOrder = pkColumns(table).map((c) => (join ? `t.${c}` : c)).join(', ');
  const orderBy = join ? `f.created_at DESC, ${pkOrder}` : `${table.orderBy}, ${pkOrder}`;
  return { from, select, where, binds, orderBy };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET /api/furim/admin/tables — 扱えるテーブルとスキーマ
furimAdmin.get('/api/furim/admin/tables', async (c) => {
  return c.json({ success: true, data: ADMIN_TABLES.map(serializeTable) });
});

// GET /api/furim/admin/:table?q=&limit=&cursor= — 一覧・検索（cursor はオフセット）
// joinFriends のテーブルは friends を LEFT JOIN して _friend_created_at を付け、友だち登録の新しい順。
// allRows のテーブルは limit/cursor を無視して全件（上限 ALL_ROWS_LIMIT）。
furimAdmin.get('/api/furim/admin/:table', async (c) => {
  const table = requireTable(c.req.param('table'));
  if (!table) return c.json({ success: false, error: 'このテーブルは扱えません' }, 404);

  const q = (c.req.query('q') ?? '').trim();
  const limitRaw = Number(c.req.query('limit') ?? DEFAULT_LIMIT);
  const limit = table.allRows
    ? ALL_ROWS_LIMIT
    : Number.isInteger(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, MAX_LIMIT)
      : DEFAULT_LIMIT;
  const offsetRaw = Number(c.req.query('cursor') ?? 0);
  const offset = table.allRows ? 0 : Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  const { from, select, where, binds, orderBy } = buildListQuery(table, q);

  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${from}${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  const total = countRow?.n ?? 0;

  const rows = await c.env.DB.prepare(`SELECT ${select} FROM ${from}${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .bind(...binds, limit + 1, offset)
    .all<Row>();
  const results = rows.results ?? [];
  const hasMore = results.length > limit;
  const data = hasMore ? results.slice(0, limit) : results;
  attachRowIds(table, data);
  await attachDisplayNames(c.env.DB, [{ table, rows: data }]);
  await attachVirtualColumns(c.env.DB, [{ table, rows: data }]);
  const featureColumns = table.featureFlags ? await loadFeatureColumns(c.env.DB) : [];
  await attachFeatureFlags(c.env.DB, featureColumns, data);

  return c.json({
    success: true,
    data,
    meta: {
      table: serializeTable(withFeatureColumns(table, featureColumns)),
      total,
      limit,
      cursor: String(offset),
      nextCursor: hasMore ? String(offset + limit) : null,
    },
  });
});

// GET /api/furim/admin/:table/export.csv?q= — 一覧と同じ条件で CSV（BOM 付き・Excel でそのまま開ける・上限 EXPORT_LIMIT）
furimAdmin.get('/api/furim/admin/:table/export.csv', async (c) => {
  const table = requireTable(c.req.param('table'));
  if (!table) return c.json({ success: false, error: 'このテーブルは扱えません' }, 404);
  const q = (c.req.query('q') ?? '').trim();
  const { from, select, where, binds, orderBy } = buildListQuery(table, q);
  const rows = await c.env.DB.prepare(`SELECT ${select} FROM ${from}${where} ORDER BY ${orderBy} LIMIT ?`)
    .bind(...binds, EXPORT_LIMIT)
    .all<Row>();
  const data = rows.results ?? [];
  await attachDisplayNames(c.env.DB, [{ table, rows: data }]);
  await attachVirtualColumns(c.env.DB, [{ table, rows: data }]);
  const featureColumns = table.featureFlags ? await loadFeatureColumns(c.env.DB) : [];
  await attachFeatureFlags(c.env.DB, featureColumns, data);
  const csvTable = withFeatureColumns(table, featureColumns);
  const columns = csvColumnNames(csvTable);
  const lines = [columns.map((name) => csvCell(columnLabel(csvTable, name))).join(',')];
  for (const row of data) {
    const cells = columns.map((name) => (datetimeStorageOf(name) ? toDisplayDateTime(row[name]) : row[name]));
    lines.push(cells.map(csvCell).join(','));
  }
  const stamp = jstNow().slice(0, 19).replace(/[-:T]/g, '').replace(/\.\d+$/, '');
  const staff = c.get('staff');
  console.log(`[furim-admin] ${staff.name}(${staff.id}) が ${table.name} を CSV 書き出し（${data.length} 行・q=${q}）`);
  return new Response('\ufeff' + lines.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${table.name}-${stamp}.csv"`,
      'Cache-Control': 'no-store',
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

  const targets: Array<{ table: AdminTable; where: string; joinedWhere: string; binds: string[]; q: string }> = [];
  for (const t of ADMIN_TABLES) {
    const conds: string[] = [];
    const binds: string[] = [];
    let q = '';
    for (const key of t.keys) {
      const v = identity[key.kind];
      if (!v) continue;
      conds.push(key.column);
      binds.push(v);
      if (!q) q = v;
    }
    if (conds.length === 0) continue;
    let where = `(${conds.map((col) => `${col} = ?`).join(' OR ')})`;
    let joinedWhere = `(${conds.map((col) => `t.${col} = ?`).join(' OR ')})`;
    if (t.name === table.name) {
      const self = pkWhere(t, rowId);
      const selfJoined = pkWhere(t, rowId, 't.');
      if (self && selfJoined) {
        where += ` AND NOT (${self.where})`;
        joinedWhere += ` AND NOT (${selfJoined.where})`;
        binds.push(...self.binds);
      }
    }
    targets.push({ table: t, where, joinedWhere, binds, q });
  }

  // joinFriends のテーブル（顧客）は基準日時の友だち登録日時を付ける
  const statements = targets.flatMap((tg) => [
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${tg.table.name} WHERE ${tg.where}`).bind(...tg.binds),
    tg.table.joinFriends
      ? c.env.DB.prepare(
          `SELECT t.*, f.created_at AS ${FRIEND_CREATED_AT_COLUMN} FROM ${tg.table.name} t LEFT JOIN friends f ON f.line_user_id = t.${pkColumns(tg.table)[0]} WHERE ${tg.joinedWhere} ORDER BY t.${tg.table.orderBy}, ${pkColumns(tg.table).map((col) => `t.${col}`).join(', ')} LIMIT ?`,
        ).bind(...tg.binds, RELATED_LIMIT)
      : c.env.DB.prepare(`SELECT * FROM ${tg.table.name} WHERE ${tg.where} ORDER BY ${tg.table.orderBy}, ${pkColumns(tg.table).join(', ')} LIMIT ?`).bind(...tg.binds, RELATED_LIMIT),
  ]);
  const results = statements.length ? await c.env.DB.batch<Row>(statements) : [];

  const related = targets.map((tg, i) => {
    const countRow = (results[i * 2]?.results ?? [])[0] as { n?: number } | undefined;
    const rows = results[i * 2 + 1]?.results ?? [];
    attachRowIds(tg.table, rows);
    return { table: serializeTable(tg.table), total: Number(countRow?.n ?? 0), rows, q: tg.q };
  });
  await attachDisplayNames(c.env.DB, related.map((r, i) => ({ table: targets[i].table, rows: r.rows })));
  await attachVirtualColumns(c.env.DB, related.map((r, i) => ({ table: targets[i].table, rows: r.rows })));

  return c.json({ success: true, data: { identity, related } });
});

// GET /api/furim/admin/:table/:id — 1 行
furimAdmin.get('/api/furim/admin/:table/:id', async (c) => {
  const table = requireTable(c.req.param('table'));
  if (!table) return c.json({ success: false, error: 'このテーブルは扱えません' }, 404);
  const row = await fetchRow(c.env.DB, table, c.req.param('id'));
  if (!row) return c.json({ success: false, error: '行が見つかりません' }, 404);
  if (table.joinFriends) {
    const f = await c.env.DB.prepare('SELECT created_at FROM friends WHERE line_user_id = ?')
      .bind(row[pkColumns(table)[0]])
      .first<{ created_at: string | null }>();
    row[FRIEND_CREATED_AT_COLUMN] = f?.created_at ?? null;
  }
  await attachDisplayNames(c.env.DB, [{ table, rows: [row] }]);
  await attachVirtualColumns(c.env.DB, [{ table, rows: [row] }]);
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
    if (!col && virtualColumnOf(table, name)) return c.json({ success: false, error: `${name} は集計・表示用の列で編集できません` }, 400);
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

  const pk = pkWhere(table, id)!;
  const statements = [
    c.env.DB.prepare(`UPDATE ${table.name} SET ${setClauses.join(', ')} WHERE ${pk.where}`).bind(...setBinds, ...pk.binds),
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

// PATCH /api/furim/admin/furim_customers/:id/feature-flags {feature_key, value: 0|1} — 顧客一覧のチェックボックス（Capsec #261）。
// 保存は手動なので固定（locked）でも書く（source=worker）。値が変わった時だけ監査ログ（table_name=furim_feature_flags・
// row_id は機能フラグ表の行 id）を残し、拡張の KV キャッシュ（kc:<key_code>）を消す
furimAdmin.patch('/api/furim/admin/furim_customers/:id/feature-flags', requireRole('owner', 'admin'), async (c) => {
  const lineUserId = c.req.param('id')!;
  let body: { feature_key?: unknown; value?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'JSON が不正です' }, 400);
  }
  const raw = body?.value;
  const value = raw === 1 || raw === '1' ? '1' : raw === 0 || raw === '0' ? '0' : null;
  if (value === null) return c.json({ success: false, error: 'value は 0 か 1 で指定してください' }, 400);
  const featureKey = typeof body?.feature_key === 'string' ? body.feature_key : '';

  const column = (await loadFeatureColumns(c.env.DB)).find((col) => col.featureKey === featureKey);
  if (!column) return c.json({ success: false, error: `${featureKey || '(空)'} は機能マスタにありません` }, 400);
  if (column.flag !== 'bool') return c.json({ success: false, error: `${featureKey} は 0/1 の機能ではありません（機能フラグ表の行から編集してください）` }, 400);

  const customer = await c.env.DB.prepare('SELECT line_user_id, key_code FROM furim_customers WHERE line_user_id = ?')
    .bind(lineUserId)
    .first<{ line_user_id: string; key_code: string | null }>();
  if (!customer) return c.json({ success: false, error: '顧客が見つかりません' }, 404);

  const before = await c.env.DB.prepare('SELECT value FROM furim_feature_flags WHERE line_user_id = ? AND feature_key = ?')
    .bind(lineUserId, featureKey)
    .first<{ value: string }>();
  const data = { line_user_id: lineUserId, feature_key: featureKey, value };
  if (before && before.value === value) return c.json({ success: true, data, meta: { changed: false } });

  const staff = c.get('staff');
  const flagsTable = getAdminTable('furim_feature_flags')!;
  try {
    await c.env.DB.prepare(
      `INSERT INTO furim_feature_flags (line_user_id, feature_key, value, source, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(line_user_id, feature_key) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at`,
    )
      .bind(lineUserId, featureKey, value, 'worker', jstNow())
      .run();
    await c.env.DB.prepare(
      `INSERT INTO furim_admin_audit (id, staff_id, staff_name, table_name, row_id, column_name, old_value, new_value, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), staff.id, staff.name, flagsTable.name, rowIdOf(flagsTable, data), 'value', before?.value ?? null, value, jstNow())
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[furim-admin] PATCH feature-flags ${lineUserId}/${featureKey} failed: ${msg}`);
    return c.json({ success: false, error: `保存に失敗しました: ${msg}` }, 400);
  }
  await invalidateExtCache(c.env.FURIM_EXT_CACHE, customer.key_code);
  console.log(`[furim-admin] ${staff.name}(${staff.id}) が ${lineUserId} の機能フラグ ${featureKey} を ${before?.value ?? '(なし)'} → ${value}`);
  return c.json({ success: true, data, meta: { changed: true } });
});

// PATCH /api/furim/admin/furim_customers/:id/feature-flags/lock {feature_key, locked: 0|1} — 機能セルの固定（Capsec #261 案 A）。
// 固定した機能は自動の書き込みで上書きしない。外しても値は残る。状態が変わった時だけ監査ログ（column=locked）と KV 無効化
furimAdmin.patch('/api/furim/admin/furim_customers/:id/feature-flags/lock', requireRole('owner', 'admin'), async (c) => {
  const lineUserId = c.req.param('id')!;
  let body: { feature_key?: unknown; locked?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'JSON が不正です' }, 400);
  }
  const raw = body?.locked;
  const locked = raw === 1 || raw === '1' ? 1 : raw === 0 || raw === '0' ? 0 : null;
  if (locked === null) return c.json({ success: false, error: 'locked は 0 か 1 で指定してください' }, 400);
  const featureKey = typeof body?.feature_key === 'string' ? body.feature_key : '';

  const column = (await loadFeatureColumns(c.env.DB)).find((col) => col.featureKey === featureKey);
  if (!column) return c.json({ success: false, error: `${featureKey || '(空)'} は機能マスタにありません` }, 400);

  const customer = await c.env.DB.prepare('SELECT line_user_id, key_code FROM furim_customers WHERE line_user_id = ?')
    .bind(lineUserId)
    .first<{ line_user_id: string; key_code: string | null }>();
  if (!customer) return c.json({ success: false, error: '顧客が見つかりません' }, 404);

  const before = await c.env.DB.prepare('SELECT value, locked FROM furim_feature_flags WHERE line_user_id = ? AND feature_key = ?')
    .bind(lineUserId, featureKey)
    .first<{ value: string; locked: number | null }>();
  const beforeLocked = before?.locked ? 1 : 0;
  const data = { line_user_id: lineUserId, feature_key: featureKey, locked };
  if (beforeLocked === locked) return c.json({ success: true, data, meta: { changed: false } });

  const staff = c.get('staff');
  const flagsTable = getAdminTable('furim_feature_flags')!;
  const now = jstNow();
  try {
    if (before) {
      await c.env.DB.prepare('UPDATE furim_feature_flags SET locked = ? WHERE line_user_id = ? AND feature_key = ?').bind(locked, lineUserId, featureKey).run();
    } else {
      await c.env.DB.prepare('INSERT INTO furim_feature_flags (line_user_id, feature_key, value, source, updated_at, locked) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(lineUserId, featureKey, column.flag === 'bool' ? '0' : '', 'worker', now, locked)
        .run();
    }
    await c.env.DB.prepare(
      `INSERT INTO furim_admin_audit (id, staff_id, staff_name, table_name, row_id, column_name, old_value, new_value, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), staff.id, staff.name, flagsTable.name, rowIdOf(flagsTable, data), 'locked', String(beforeLocked), String(locked), now)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[furim-admin] PATCH feature-flags/lock ${lineUserId}/${featureKey} failed: ${msg}`);
    return c.json({ success: false, error: `保存に失敗しました: ${msg}` }, 400);
  }
  await invalidateExtCache(c.env.FURIM_EXT_CACHE, customer.key_code);
  console.log(`[furim-admin] ${staff.name}(${staff.id}) が ${lineUserId} の機能フラグ ${featureKey} の固定を ${beforeLocked} → ${locked}`);
  return c.json({ success: true, data, meta: { changed: true } });
});

// POST /api/furim/admin/:table {values:{列:値}} — 1 行追加（owner/admin）。主キーが 'id' 1 列なら UUID を採番。
// created_at / updated_at / imported_at が列にあって未指定なら現在時刻。監査ログは column=(insert) に行 JSON
furimAdmin.post('/api/furim/admin/:table', requireRole('owner', 'admin'), async (c) => {
  const table = requireTable(c.req.param('table')!);
  if (!table) return c.json({ success: false, error: 'このテーブルは扱えません' }, 404);
  if (!isInsertable(table)) return c.json({ success: false, error: 'このテーブルには追加できません' }, 400);

  let body: { values?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'JSON が不正です' }, 400);
  }
  const values = body?.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return c.json({ success: false, error: 'values を {列: 値} で指定してください' }, 400);
  }

  const now = jstNow();
  const record: Record<string, string | number | null> = {};
  for (const [name, raw] of Object.entries(values as Record<string, unknown>)) {
    const col = table.columns.find((x) => x.name === name);
    if (!col && virtualColumnOf(table, name)) return c.json({ success: false, error: `${name} は集計・表示用の列で編集できません` }, 400);
    if (!col) return c.json({ success: false, error: `${name} は存在しない列です` }, 400);
    const coerced = coerceValue(col, raw);
    if (!coerced.ok) return c.json({ success: false, error: coerced.error }, 400);
    record[name] = coerced.value;
  }
  const cols = pkColumns(table);
  if (cols.length === 1 && cols[0] === 'id' && (record.id === undefined || record.id === null)) record.id = crypto.randomUUID();
  for (const name of cols) {
    if (record[name] === undefined || record[name] === null || record[name] === '') {
      return c.json({ success: false, error: `主キー ${name} を指定してください` }, 400);
    }
  }
  for (const name of ['created_at', 'updated_at', 'imported_at']) {
    if (table.columns.some((x) => x.name === name) && (record[name] === undefined || record[name] === null)) record[name] = now;
  }

  const names = Object.keys(record);
  const staff = c.get('staff');
  const id = rowIdOf(table, record);
  const statements = [
    c.env.DB.prepare(`INSERT INTO ${table.name} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).bind(...names.map((n) => record[n])),
    c.env.DB.prepare(
      `INSERT INTO furim_admin_audit (id, staff_id, staff_name, table_name, row_id, column_name, old_value, new_value, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), staff.id, staff.name, table.name, id, AUDIT_INSERT, null, JSON.stringify(record), now),
  ];
  try {
    await c.env.DB.batch(statements);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[furim-admin] POST ${table.name} failed: ${msg}`);
    return c.json({ success: false, error: `追加に失敗しました: ${msg}` }, 400);
  }
  const after = await fetchRow(c.env.DB, table, id);
  if (after) {
    await attachDisplayNames(c.env.DB, [{ table, rows: [after] }]);
    await attachVirtualColumns(c.env.DB, [{ table, rows: [after] }]);
  }
  console.log(`[furim-admin] ${staff.name}(${staff.id}) が ${table.name}/${id} を追加`);
  return c.json({ success: true, data: after ?? { ...record, _id: id }, meta: { id } }, 201);
});

// DELETE /api/furim/admin/:table/:id — 1 行削除（owner/admin）。監査ログは column=(delete) に消した行の JSON
furimAdmin.delete('/api/furim/admin/:table/:id', requireRole('owner', 'admin'), async (c) => {
  const table = requireTable(c.req.param('table')!);
  if (!table) return c.json({ success: false, error: 'このテーブルは扱えません' }, 404);
  if (!isDeletable(table)) return c.json({ success: false, error: 'このテーブルの行は削除できません' }, 400);
  const id = c.req.param('id')!;
  const pk = pkWhere(table, id);
  if (!pk) return c.json({ success: false, error: '行 id の形式が不正です' }, 400);
  const before = await fetchRow(c.env.DB, table, id);
  if (!before) return c.json({ success: false, error: '行が見つかりません' }, 404);
  const { _id: _ignored, ...snapshot } = before;
  void _ignored;

  const staff = c.get('staff');
  const now = jstNow();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM ${table.name} WHERE ${pk.where}`).bind(...pk.binds),
      c.env.DB.prepare(
        `INSERT INTO furim_admin_audit (id, staff_id, staff_name, table_name, row_id, column_name, old_value, new_value, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), staff.id, staff.name, table.name, id, AUDIT_DELETE, JSON.stringify(snapshot), null, now),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[furim-admin] DELETE ${table.name}/${id} failed: ${msg}`);
    return c.json({ success: false, error: `削除に失敗しました: ${msg}` }, 400);
  }
  console.log(`[furim-admin] ${staff.name}(${staff.id}) が ${table.name}/${id} を削除`);
  return c.json({ success: true, data: snapshot, meta: { id } });
});

export { furimAdmin };
