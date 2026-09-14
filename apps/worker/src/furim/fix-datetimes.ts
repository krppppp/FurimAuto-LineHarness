import { toJstString } from '@line-crm/db';
import { parseJstDateTime } from './customer-store.js';
import { MASTER_SHEET, sheetRowLineUserId } from './customer-sync.js';
import { fetchSheetRows, str, type SheetRow } from './sheet-backfill.js';

export const FIX_TARGETS = ['customers', 'affiliates', 'friend-sub', 'chats', 'friend-tags'] as const;
export type FixTarget = (typeof FIX_TARGETS)[number];

export const FIX_STAFF_NAME = 'system:fix-datetimes';
export const SUB_LINE_USER_ID = 'U16f359b3620c61ba076132988934a48a';
export const SAME_INSTANT_TOLERANCE_MS = 2000;
export const SAMPLE_LIMIT = 5;
const CANDIDATES_PER_BATCH = 50;
const DAY_MS = 24 * 60 * 60_000;

const AMBASSADOR_SHEET = 'アンバサダー';

export function isFixTarget(v: unknown): v is FixTarget {
  return typeof v === 'string' && (FIX_TARGETS as readonly string[]).includes(v);
}

export type FixRow = {
  table: string;
  column: string;
  rowId: string;
  pk: Record<string, string>;
  oldValue: string;
  source: string | null;
  stuck: boolean;
};

export type FixCandidate = {
  table: string;
  column: string;
  rowId: string;
  pk: Record<string, string>;
  oldValue: string;
  newValue: string;
};

export type Classified = {
  candidates: FixCandidate[];
  skippedNoSource: number;
  skippedAlreadyFixed: number;
};

export function classifyFixRows(rows: FixRow[]): Classified {
  const out: Classified = { candidates: [], skippedNoSource: 0, skippedAlreadyFixed: 0 };
  for (const r of rows) {
    const srcMs = r.source ? parseJstDateTime(r.source) : null;
    if (srcMs == null) {
      if (r.stuck) out.skippedNoSource++;
      continue;
    }
    const oldMs = parseJstDateTime(r.oldValue);
    if (oldMs != null && Math.abs(oldMs - srcMs) < SAME_INSTANT_TOLERANCE_MS) {
      out.skippedAlreadyFixed++;
      continue;
    }
    if (!r.stuck) continue;
    out.candidates.push({ table: r.table, column: r.column, rowId: r.rowId, pk: r.pk, oldValue: r.oldValue, newValue: toJstString(new Date(srcMs)) });
  }
  return out;
}

export type SheetCache = Map<string, SheetRow[]>;

async function sheetRows(gasDeployId: string | undefined, sheet: string, headerRow: number, cache: SheetCache): Promise<SheetRow[]> {
  const cached = cache.get(sheet);
  if (cached) return cached;
  if (!gasDeployId) throw new Error('GAS_DEPLOY_ID not configured');
  const rows = await fetchSheetRows(gasDeployId, { name: 'fix-datetimes', sheet, headerRow, table: '' });
  cache.set(sheet, rows);
  return rows;
}

function uniqueSourceMap(pairs: Array<[string, string | null]>): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const dup = new Set<string>();
  for (const [k, v] of pairs) {
    if (dup.has(k)) continue;
    if (map.has(k) && map.get(k) !== v) {
      map.set(k, null);
      dup.add(k);
      continue;
    }
    map.set(k, v);
  }
  return map;
}

export function friendRegisteredAtByLineUserId(rows: SheetRow[]): Map<string, string | null> {
  const pairs: Array<[string, string | null]> = [];
  for (const r of rows) {
    const id = sheetRowLineUserId(r);
    if (id) pairs.push([id, str(r['友達登録日時'])]);
  }
  return uniqueSourceMap(pairs);
}

export function ambassadorRegisteredAtByCode(rows: SheetRow[]): Map<string, string | null> {
  const pairs: Array<[string, string | null]> = [];
  for (const r of rows) {
    const code = str(r['アンバサダーコード']);
    const at = str(r['登録日時']);
    if (!code || code === 'String' || at === 'String') continue;
    pairs.push([code, at]);
  }
  return uniqueSourceMap(pairs);
}

async function loadCustomers(db: D1Database, gasDeployId: string | undefined, cache: SheetCache): Promise<FixRow[]> {
  const sources = friendRegisteredAtByLineUserId(await sheetRows(gasDeployId, MASTER_SHEET, 3, cache));
  const rows = (await db.prepare('SELECT line_user_id, created_at FROM furim_customers').all<{ line_user_id: string; created_at: string }>()).results ?? [];
  return rows.map((r) => ({
    table: 'furim_customers',
    column: 'created_at',
    rowId: r.line_user_id,
    pk: { line_user_id: r.line_user_id },
    oldValue: r.created_at,
    source: sources.get(r.line_user_id) ?? null,
    stuck: String(r.created_at).startsWith('2026-09-13T19:54'),
  }));
}

async function loadAffiliates(db: D1Database, gasDeployId: string | undefined, cache: SheetCache): Promise<FixRow[]> {
  const sources = ambassadorRegisteredAtByCode(await sheetRows(gasDeployId, AMBASSADOR_SHEET, 2, cache));
  const rows = (await db.prepare('SELECT id, code, created_at FROM affiliates').all<{ id: string; code: string; created_at: string }>()).results ?? [];
  return rows.map((r) => ({
    table: 'affiliates',
    column: 'created_at',
    rowId: r.id,
    pk: { id: r.id },
    oldValue: r.created_at,
    source: sources.get(r.code) ?? null,
    stuck: true,
  }));
}

async function loadFriendSub(db: D1Database, gasDeployId: string | undefined, cache: SheetCache): Promise<FixRow[]> {
  const sources = friendRegisteredAtByLineUserId(await sheetRows(gasDeployId, MASTER_SHEET, 3, cache));
  const row = await db.prepare('SELECT id, line_user_id, created_at FROM friends WHERE line_user_id = ?').bind(SUB_LINE_USER_ID).first<{ id: string; line_user_id: string; created_at: string }>();
  if (!row) return [];
  return [{ table: 'friends', column: 'created_at', rowId: row.id, pk: { id: row.id }, oldValue: row.created_at, source: sources.get(SUB_LINE_USER_ID) ?? null, stuck: true }];
}

async function loadChats(db: D1Database): Promise<FixRow[]> {
  const chats = (await db.prepare('SELECT id, friend_id, created_at FROM chats').all<{ id: string; friend_id: string; created_at: string }>()).results ?? [];
  const firsts = (await db.prepare("SELECT friend_id, MIN(replace(created_at, ' ', 'T')) AS at FROM messages_log GROUP BY friend_id").all<{ friend_id: string; at: string | null }>()).results ?? [];
  const firstByFriend = new Map(firsts.map((f) => [f.friend_id, f.at]));
  return chats.map((r) => ({
    table: 'chats',
    column: 'created_at',
    rowId: r.id,
    pk: { id: r.id },
    oldValue: r.created_at,
    source: firstByFriend.get(r.friend_id) ?? null,
    stuck: String(r.created_at).startsWith('2026-07-14T15:20'),
  }));
}

export type TagSourceKind = 'first_payment' | 'referral' | 'furiman_coupon' | 'cancellation';

export function tagSourceKind(name: string): TagSourceKind | null {
  if (name === '月額会員' || /^月額\d+$/.test(name)) return 'first_payment';
  if (name === '紹介経由') return 'referral';
  if (name === 'Furimanです') return 'furiman_coupon';
  if (name === 'キャンセル済み') return 'cancellation';
  return null;
}

export function isMigratedTagAssignedAt(assignedAt: string): boolean {
  const s = String(assignedAt);
  if (!s.startsWith('2026-06-11T17:')) return false;
  const hm = s.slice(11, 16);
  return hm >= '17:38' && hm <= '17:50';
}

async function loadFriendTags(db: D1Database): Promise<FixRow[]> {
  const tags = (
    await db
      .prepare(
        "SELECT ft.friend_id, ft.tag_id, ft.assigned_at, t.name, f.line_user_id FROM friend_tags ft JOIN tags t ON t.id = ft.tag_id JOIN friends f ON f.id = ft.friend_id WHERE t.name IN ('月額会員', '紹介経由', 'Furimanです', 'キャンセル済み') OR t.name GLOB '月額[0-9]*'",
      )
      .all<{ friend_id: string; tag_id: string; assigned_at: string; name: string; line_user_id: string }>()
  ).results ?? [];
  const byKey = async (sql: string) => new Map(((await db.prepare(sql).all<{ k: string; at: string | null }>()).results ?? []).map((r) => [r.k, r.at]));
  const firstPayment = await byKey('SELECT line_user_id AS k, MIN(paid_at) AS at FROM furim_payments WHERE line_user_id IS NOT NULL GROUP BY line_user_id');
  const referral = await byKey('SELECT introduced_friend_id AS k, MIN(created_at) AS at FROM furim_referrals GROUP BY introduced_friend_id');
  const furiman = await byKey("SELECT line_user_id AS k, MIN(created_at) AS at FROM furim_coupon_applications WHERE route = 'Furiman経由' GROUP BY line_user_id");
  const cancellation = await byKey('SELECT line_user_id AS k, MAX(canceled_at) AS at FROM furim_cancellations WHERE line_user_id IS NOT NULL GROUP BY line_user_id');
  const out: FixRow[] = [];
  for (const t of tags) {
    const kind = tagSourceKind(t.name);
    if (!kind) continue;
    let source =
      kind === 'first_payment' ? firstPayment.get(t.line_user_id)
      : kind === 'referral' ? referral.get(t.friend_id)
      : kind === 'furiman_coupon' ? furiman.get(t.line_user_id)
      : cancellation.get(t.line_user_id);
    const stuck = isMigratedTagAssignedAt(t.assigned_at);
    const srcMs = parseJstDateTime(source ?? null);
    const oldMs = parseJstDateTime(t.assigned_at);
    if (stuck && srcMs != null && oldMs != null && srcMs > oldMs) source = null;
    out.push({
      table: 'friend_tags',
      column: 'assigned_at',
      rowId: `${encodeURIComponent(t.friend_id)}|${encodeURIComponent(t.tag_id)}`,
      pk: { friend_id: t.friend_id, tag_id: t.tag_id },
      oldValue: t.assigned_at,
      source: source ?? null,
      stuck,
    });
  }
  return out;
}

export async function loadFixRows(db: D1Database, gasDeployId: string | undefined, target: FixTarget, cache: SheetCache): Promise<FixRow[]> {
  switch (target) {
    case 'customers':
      return loadCustomers(db, gasDeployId, cache);
    case 'affiliates':
      return loadAffiliates(db, gasDeployId, cache);
    case 'friend-sub':
      return loadFriendSub(db, gasDeployId, cache);
    case 'chats':
      return loadChats(db);
    case 'friend-tags':
      return loadFriendTags(db);
  }
}

export function buildFixStatements(db: D1Database, c: FixCandidate, staffId: string, now: string): D1PreparedStatement[] {
  const cols = Object.keys(c.pk);
  const where = cols.map((k) => `${k} = ?`).join(' AND ');
  return [
    db.prepare(`UPDATE ${c.table} SET ${c.column} = ? WHERE ${where} AND ${c.column} = ?`).bind(c.newValue, ...cols.map((k) => c.pk[k]), c.oldValue),
    db
      .prepare(
        'INSERT INTO furim_admin_audit (id, staff_id, staff_name, table_name, row_id, column_name, old_value, new_value, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1',
      )
      .bind(crypto.randomUUID(), staffId, FIX_STAFF_NAME, c.table, c.rowId, c.column, c.oldValue, c.newValue, now),
  ];
}

export async function applyFixCandidates(db: D1Database, candidates: FixCandidate[], staffId: string, now: string): Promise<{ updated: number; auditRows: number }> {
  let updated = 0;
  let auditRows = 0;
  for (let i = 0; i < candidates.length; i += CANDIDATES_PER_BATCH) {
    const chunk = candidates.slice(i, i + CANDIDATES_PER_BATCH);
    const results = await db.batch(chunk.flatMap((c) => buildFixStatements(db, c, staffId, now)));
    results.forEach((r, idx) => {
      const n = r.meta?.changes ?? 0;
      if (idx % 2 === 0) updated += n;
      else auditRows += n;
    });
  }
  return { updated, auditRows };
}

export type SevenDayJudge = {
  friendCreatedAt: string | null;
  daysSinceRegistration: number | null;
  furimanCoupon: '7日未満（半額）' | '経過済み（20%OFF）';
  extendTrial: '1週間以内（+7日）' | '経過済み（+3日）';
};

export function judgeSevenDay(friendCreatedAt: string | null, nowMs: number): SevenDayJudge {
  const registeredAt = friendCreatedAt ? Date.parse(friendCreatedAt) : NaN;
  const days = Number.isNaN(registeredAt) ? NaN : Math.floor((nowMs - registeredAt) / DAY_MS);
  const withinOneWeek = !Number.isNaN(registeredAt) && nowMs - registeredAt <= 7 * DAY_MS;
  return {
    friendCreatedAt,
    daysSinceRegistration: Number.isNaN(days) ? null : days,
    furimanCoupon: days < 7 ? '7日未満（半額）' : '経過済み（20%OFF）',
    extendTrial: withinOneWeek ? '1週間以内（+7日）' : '経過済み（+3日）',
  };
}

async function readSubJudge(db: D1Database, nowMs: number): Promise<SevenDayJudge> {
  const friend = await db.prepare('SELECT created_at FROM friends WHERE line_user_id = ?').bind(SUB_LINE_USER_ID).first<{ created_at: string }>();
  return judgeSevenDay(friend?.created_at ?? null, nowMs);
}

export type FixSample = { table: string; column: string; rowId: string; oldValue: string; newValue: string };

export type FixResult = {
  target: FixTarget;
  dryRun: boolean;
  candidates: number;
  updated: number;
  skippedNoSource: number;
  skippedAlreadyFixed: number;
  auditRows: number;
  samples: FixSample[];
  judgeBefore?: SevenDayJudge;
  judgeAfter?: SevenDayJudge;
};

export async function fixDatetimes(
  db: D1Database,
  gasDeployId: string | undefined,
  target: FixTarget,
  opts: { dryRun: boolean; staffId: string; now?: string; nowMs?: number; cache?: SheetCache },
): Promise<FixResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const now = opts.now ?? toJstString(new Date(nowMs));
  const rows = await loadFixRows(db, gasDeployId, target, opts.cache ?? new Map());
  const classified = classifyFixRows(rows);
  const result: FixResult = {
    target,
    dryRun: opts.dryRun,
    candidates: classified.candidates.length,
    updated: 0,
    skippedNoSource: classified.skippedNoSource,
    skippedAlreadyFixed: classified.skippedAlreadyFixed,
    auditRows: 0,
    samples: classified.candidates.slice(0, SAMPLE_LIMIT).map(({ table, column, rowId, oldValue, newValue }) => ({ table, column, rowId, oldValue, newValue })),
  };
  if (target === 'friend-sub') result.judgeBefore = await readSubJudge(db, nowMs);
  if (opts.dryRun) {
    if (target === 'friend-sub') {
      const next = classified.candidates[0]?.newValue ?? result.judgeBefore?.friendCreatedAt ?? null;
      result.judgeAfter = judgeSevenDay(next, nowMs);
    }
    return result;
  }
  const applied = await applyFixCandidates(db, classified.candidates, opts.staffId, now);
  result.updated = applied.updated;
  result.auditRows = applied.auditRows;
  if (target === 'friend-sub') result.judgeAfter = await readSubJudge(db, nowMs);
  console.log('[furim/fix-datetimes]', JSON.stringify({ target, candidates: result.candidates, updated: result.updated, auditRows: result.auditRows, skippedNoSource: result.skippedNoSource, skippedAlreadyFixed: result.skippedAlreadyFixed }));
  return result;
}
