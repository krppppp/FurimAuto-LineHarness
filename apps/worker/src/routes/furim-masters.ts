import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import { getAdminTable, rowIdOf } from '../furim/admin-schema.js';
import { MASTER_KINDS, buildMasterRecord, getMasterKind, masterValuesOf, type MasterKindDef } from '../furim/master-schema.js';
import type { Env } from '../index.js';

const furimMasters = new Hono<Env>();

type MasterRow = {
  kind: string;
  key: string;
  display_name: string | null;
  stripe_price_id: string | null;
  monthly_price: number | null;
  active: number;
  payload: string;
  fetched_at: string | null;
};

type Payload = Record<string, unknown>;

function parsePayload(s: string | null | undefined): Payload {
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Payload) : {};
  } catch {
    return {};
  }
}

function auditText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function masterRowId(kind: string, key: string): string {
  return rowIdOf(getAdminTable('furim_master')!, { kind, key });
}

function toItem(def: MasterKindDef, row: MasterRow) {
  return {
    key: row.key,
    id: masterRowId(row.kind, row.key),
    active: row.active,
    updated_at: row.fetched_at,
    values: masterValuesOf(def, parsePayload(row.payload)),
  };
}

async function loadFeatureKeys(db: D1Database): Promise<Set<string>> {
  const rows = await db.prepare("SELECT key FROM furim_master WHERE kind = 'feature'").bind().all<{ key: string }>();
  return new Set((rows.results ?? []).map((r) => r.key));
}

async function fetchMasterRow(db: D1Database, kind: string, key: string): Promise<MasterRow | null> {
  return db.prepare('SELECT * FROM furim_master WHERE kind = ? AND key = ?').bind(kind, key).first<MasterRow>();
}

async function readValues(c: { req: { json: () => Promise<unknown> } }): Promise<Payload | null> {
  try {
    const body = (await c.req.json()) as { values?: unknown };
    const values = body?.values;
    return values && typeof values === 'object' && !Array.isArray(values) ? (values as Payload) : null;
  } catch {
    return null;
  }
}

const auditSql = `INSERT INTO furim_admin_audit (id, staff_id, staff_name, table_name, row_id, column_name, old_value, new_value, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

furimMasters.get('/api/furim/admin/masters', async (c) => {
  const rows = await c.env.DB.prepare('SELECT kind, COUNT(*) AS n FROM furim_master GROUP BY kind').bind().all<{ kind: string; n: number }>();
  const counts = new Map((rows.results ?? []).map((r) => [r.kind, Number(r.n)]));
  return c.json({ success: true, data: MASTER_KINDS.map((def) => ({ ...def, count: counts.get(def.kind) ?? 0 })) });
});

furimMasters.get('/api/furim/admin/masters/:kind', async (c) => {
  const def = getMasterKind(c.req.param('kind'));
  if (!def) return c.json({ success: false, error: 'このマスタは扱えません' }, 404);
  const rows = await c.env.DB.prepare('SELECT * FROM furim_master WHERE kind = ? ORDER BY rowid').bind(def.kind).all<MasterRow>();
  return c.json({ success: true, data: (rows.results ?? []).map((r) => toItem(def, r)), meta: { kind: def } });
});

furimMasters.post('/api/furim/admin/masters/:kind', requireRole('owner', 'admin'), async (c) => {
  const def = getMasterKind(c.req.param('kind')!);
  if (!def) return c.json({ success: false, error: 'このマスタは扱えません' }, 404);
  const values = await readValues(c);
  if (!values) return c.json({ success: false, error: 'values を {項目: 値} で指定してください' }, 400);

  const { record, errors } = buildMasterRecord(def, values, { featureKeys: await loadFeatureKeys(c.env.DB) });
  if (!record) return c.json({ success: false, error: errors.join('・'), errors }, 400);
  if (await fetchMasterRow(c.env.DB, def.kind, record.key)) {
    return c.json({ success: false, error: `${record.key} は既にあります` }, 400);
  }

  const staff = c.get('staff');
  const now = jstNow();
  const payloadText = JSON.stringify(record.payload);
  const id = masterRowId(def.kind, record.key);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO furim_master (kind, key, display_name, stripe_price_id, monthly_price, active, payload, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(def.kind, record.key, record.display_name, record.stripe_price_id, record.monthly_price, record.active, payloadText, now),
      c.env.DB.prepare(auditSql).bind(crypto.randomUUID(), staff.id, staff.name, 'furim_master', id, '(insert)', null, payloadText, now),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[furim-masters] POST ${def.kind}/${record.key} failed: ${msg}`);
    return c.json({ success: false, error: `追加に失敗しました: ${msg}` }, 400);
  }
  console.log(`[furim-masters] ${staff.name}(${staff.id}) が ${def.kind}/${record.key} を追加`);
  const after = await fetchMasterRow(c.env.DB, def.kind, record.key);
  return c.json({ success: true, data: after ? toItem(def, after) : null }, 201);
});

furimMasters.patch('/api/furim/admin/masters/:kind/:key', requireRole('owner', 'admin'), async (c) => {
  const def = getMasterKind(c.req.param('kind')!);
  if (!def) return c.json({ success: false, error: 'このマスタは扱えません' }, 404);
  const key = c.req.param('key')!;
  const values = await readValues(c);
  if (!values) return c.json({ success: false, error: 'values を {項目: 値} で指定してください' }, 400);

  const beforeRow = await fetchMasterRow(c.env.DB, def.kind, key);
  if (!beforeRow) return c.json({ success: false, error: '行が見つかりません' }, 404);
  const before = parsePayload(beforeRow.payload);

  const merged = { ...masterValuesOf(def, before), ...values };
  const { record, errors } = buildMasterRecord(def, merged, { featureKeys: await loadFeatureKeys(c.env.DB) }, before);
  if (!record) return c.json({ success: false, error: errors.join('・'), errors }, 400);

  const changed = [...new Set([...Object.keys(before), ...Object.keys(record.payload)])].filter(
    (name) => JSON.stringify(before[name]) !== JSON.stringify(record.payload[name]),
  );
  if (changed.length === 0) return c.json({ success: true, data: toItem(def, beforeRow), meta: { changed: [] } });

  const staff = c.get('staff');
  const now = jstNow();
  const id = masterRowId(def.kind, key);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE furim_master SET display_name = ?, stripe_price_id = ?, monthly_price = ?, active = ?, payload = ?, fetched_at = ? WHERE kind = ? AND key = ?',
      ).bind(record.display_name, record.stripe_price_id, record.monthly_price, record.active, JSON.stringify(record.payload), now, def.kind, key),
      ...changed.map((name) =>
        c.env.DB.prepare(auditSql).bind(crypto.randomUUID(), staff.id, staff.name, 'furim_master', id, name, auditText(before[name]), auditText(record.payload[name]), now),
      ),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[furim-masters] PATCH ${def.kind}/${key} failed: ${msg}`);
    return c.json({ success: false, error: `保存に失敗しました: ${msg}` }, 400);
  }
  console.log(`[furim-masters] ${staff.name}(${staff.id}) が ${def.kind}/${key} の ${changed.join(',')} を更新`);
  const after = await fetchMasterRow(c.env.DB, def.kind, key);
  return c.json({ success: true, data: after ? toItem(def, after) : null, meta: { changed } });
});

furimMasters.delete('/api/furim/admin/masters/:kind/:key', requireRole('owner', 'admin'), async (c) => {
  const def = getMasterKind(c.req.param('kind')!);
  if (!def) return c.json({ success: false, error: 'このマスタは扱えません' }, 404);
  const key = c.req.param('key')!;
  const beforeRow = await fetchMasterRow(c.env.DB, def.kind, key);
  if (!beforeRow) return c.json({ success: false, error: '行が見つかりません' }, 404);

  if (def.kind === 'feature') {
    const rows = await c.env.DB.prepare("SELECT kind, key, payload FROM furim_master WHERE kind IN ('feature', 'package')").bind().all<MasterRow>();
    const users = (rows.results ?? [])
      .filter((r) => !(r.kind === 'feature' && r.key === key))
      .filter((r) => {
        const p = parsePayload(r.payload);
        const names = r.kind === 'package' ? ['features'] : ['requires', 'excludes'];
        return names.some((n) => String(p[n] ?? '').split(',').map((s) => s.trim().split('=')[0]).includes(key));
      })
      .map((r) => `${r.kind === 'package' ? 'パッケージ' : '機能'} ${r.key}`);
    if (users.length) return c.json({ success: false, error: `${key} は ${users.join('・')} が使っているので削除できません` }, 400);
  }

  const staff = c.get('staff');
  const now = jstNow();
  const snapshot = { ...beforeRow, payload: parsePayload(beforeRow.payload) };
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM furim_master WHERE kind = ? AND key = ?').bind(def.kind, key),
      c.env.DB.prepare(auditSql).bind(crypto.randomUUID(), staff.id, staff.name, 'furim_master', masterRowId(def.kind, key), '(delete)', JSON.stringify(snapshot), null, now),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[furim-masters] DELETE ${def.kind}/${key} failed: ${msg}`);
    return c.json({ success: false, error: `削除に失敗しました: ${msg}` }, 400);
  }
  console.log(`[furim-masters] ${staff.name}(${staff.id}) が ${def.kind}/${key} を削除`);
  return c.json({ success: true, data: { key } });
});

export { furimMasters };
