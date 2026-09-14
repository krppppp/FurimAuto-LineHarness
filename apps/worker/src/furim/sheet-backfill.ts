// スプレッドシートの過去分を D1 に取り込む（段階4-B・Capsec #252・2026-09-14）。
//
// - シートは GAS claudeApi getData で全行読む（シートは凍結・書き込まない）
// - 1 シート = 1 対応テーブル。一意キー（インボイスID・重複防止キー・インストールID…）があればそれ、
//   無ければ行の SHA-256 を id にして INSERT OR IGNORE → 何度実行しても増えない
// - line_user_id はシートに無いので、Stripe顧客ID / キーコード / 各サイトURL / LINE表示名（一意な時だけ）で
//   furim_customers・friends から解決する。解決できなくても行は捨てない（NOT NULL の表だけ skip して件数に出す）
// - 型注記行（値が String / Number / Boolean だけの行）と空行はシート側の飾りなので除外し、理由付きで数える
import { toJstString } from '@line-crm/db';
import { gasGet, getGasErrorFromResponse } from './gas-client.js';
import { isSameConsume } from './ticket-ledger.js';

export type SheetRow = Record<string, unknown>;

export type SheetSpec = {
  name: string;
  sheet: string;
  headerRow: number;
  table: string;
};

export const SHEET_BACKFILL_SPECS: SheetSpec[] = [
  { name: 'subscription-transactions', sheet: 'サブスクトランザクション', headerRow: 1, table: 'furim_payments' },
  { name: 'ticket-transactions', sheet: 'チケットトランザクション', headerRow: 1, table: 'furim_ticket_ledger' },
  { name: 'execution-logs', sheet: '自動化処理履歴', headerRow: 1, table: 'furim_execution_logs' },
  { name: 'auto-copy-logs', sheet: '自動コピー出品履歴', headerRow: 1, table: 'furim_auto_copy_logs' },
  { name: 'errors', sheet: 'Error', headerRow: 1, table: 'furim_ext_errors' },
  { name: 'manual-copy-logs', sheet: '手動コピー出品履歴', headerRow: 1, table: 'furim_manual_copy_logs' },
  { name: 'shop-research-logs', sheet: 'ショップ調査履歴', headerRow: 1, table: 'furim_shop_research_logs' },
  { name: 'free-accounts', sheet: '無料アカウント台帳', headerRow: 1, table: 'furim_free_accounts' },
  { name: 'survey-answers', sheet: 'アンケート結果', headerRow: 1, table: 'furim_survey_answers' },
  { name: 'coupon-applications', sheet: 'クーポン適用履歴', headerRow: 1, table: 'furim_coupon_applications' },
  { name: 'cancellations', sheet: 'キャンセル一覧', headerRow: 1, table: 'furim_cancellations' },
  { name: 'referral-cashbacks', sheet: '紹介キャッシュバック履歴', headerRow: 2, table: 'furim_referral_cashbacks' },
];

export function getSheetSpec(name: string): SheetSpec | undefined {
  return SHEET_BACKFILL_SPECS.find((s) => s.name === name);
}

const GAS_TIMEOUT_MS = 180_000;
const MAX_BINDS_PER_STATEMENT = 90;
const STATEMENTS_PER_BATCH = 100;
const TYPE_WORDS = new Set(['String', 'Number', 'Boolean', 'Date']);
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/;

// ── 値の正規化 ──

export function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

export function int(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** シートの日時（Date セルは ISO Z 文字列で届く。GAS 由来の 'YYYY/MM/DD HH:mm:ss' は JST）→ jstNow と同じ '+09:00' 形式 */
export function jst(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)) - 9 * 60 * 60_000;
    return toJstString(new Date(ms));
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? s : toJstString(new Date(t));
}

/** 型注記行: 空でない値が String / Number / Boolean / Date だけ */
export function isTypeRow(row: SheetRow): boolean {
  const vals = Object.values(row).filter((v) => v != null && String(v).trim() !== '');
  return vals.length > 0 && vals.every((v) => TYPE_WORDS.has(String(v).trim()));
}

export function isEmptyRow(row: SheetRow): boolean {
  return Object.values(row).every((v) => v == null || String(v).trim() === '');
}

/** 行の決定的な id（シート名＋値の SHA-256 の先頭 32 桁） */
export async function rowHash(sheet: string, values: unknown[]): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([sheet, ...values.map((v) => (v == null ? '' : String(v)))]));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function headerStartingWith(row: SheetRow, prefix: string): string | undefined {
  return Object.keys(row).find((h) => h.startsWith(prefix));
}

// ── line_user_id の解決 ──

export type ResolveContext = {
  byStripe: Map<string, string>;
  byKeyCode: Map<string, string>;
  byUrl: Map<string, string>;
  byDisplayName: Map<string, string>;
  importedAt: string;
};

function uniqueMap(pairs: Array<[string | null | undefined, string]>): Map<string, string> {
  const map = new Map<string, string>();
  const dup = new Set<string>();
  for (const [k, v] of pairs) {
    const key = str(k);
    if (!key) continue;
    if (dup.has(key)) continue;
    const cur = map.get(key);
    if (cur && cur !== v) { map.delete(key); dup.add(key); continue; }
    map.set(key, v);
  }
  return map;
}

export async function loadResolveContext(db: D1Database, importedAt: string): Promise<ResolveContext> {
  const customers = await db
    .prepare('SELECT line_user_id, stripe_customer_id, key_code, mercari_url, shops_url, rakuma_url, yahoo_flea_url FROM furim_customers ORDER BY updated_at DESC')
    .all<{ line_user_id: string; stripe_customer_id: string | null; key_code: string | null; mercari_url: string | null; shops_url: string | null; rakuma_url: string | null; yahoo_flea_url: string | null }>();
  const friends = await db
    .prepare("SELECT line_user_id, display_name FROM friends WHERE line_user_id IS NOT NULL AND display_name IS NOT NULL AND display_name != ''")
    .all<{ line_user_id: string; display_name: string }>();
  const rows = customers.results ?? [];
  const byStripe = new Map<string, string>();
  const byKeyCode = new Map<string, string>();
  for (const r of rows) {
    const s = str(r.stripe_customer_id);
    if (s && !byStripe.has(s)) byStripe.set(s, r.line_user_id);
    const k = str(r.key_code);
    if (k && !byKeyCode.has(k)) byKeyCode.set(k, r.line_user_id);
  }
  const urlPairs: Array<[string | null, string]> = [];
  for (const r of rows) for (const u of [r.mercari_url, r.shops_url, r.rakuma_url, r.yahoo_flea_url]) urlPairs.push([u, r.line_user_id]);
  return {
    byStripe,
    byKeyCode,
    byUrl: uniqueMap(urlPairs),
    byDisplayName: uniqueMap((friends.results ?? []).map((f) => [f.display_name, f.line_user_id])),
    importedAt,
  };
}

// ── シート行 → 挿入行 ──

export type MappedRow = {
  table: string;
  columns: string[];
  values: unknown[];
  key: string;
  conflict?: { target: string; update: string[] };
};

export type SkipReason = 'type_row' | 'empty_row' | 'missing_key' | 'duplicate_in_sheet' | 'unresolved_line_user_id' | 'matched_consume';

export type MapResult = {
  rows: MappedRow[];
  skipped: Record<SkipReason, number>;
  unresolved: number;
};

type Mapper = (row: SheetRow, ctx: ResolveContext) => Promise<MappedRow | SkipReason>;

function mapper(spec: SheetSpec): Mapper {
  switch (spec.name) {
    case 'subscription-transactions':
      return async (r, ctx) => {
        const invoiceId = str(r['インボイスID']);
        if (!invoiceId) return 'missing_key';
        const stripeId = str(r['Stripe顧客ID']);
        const paidAt = jst(r['処理日時']);
        return {
          table: spec.table,
          columns: ['invoice_id', 'line_user_id', 'stripe_customer_id', 'plan_name', 'subscription_price', 'discount_amount', 'price_excl_tax', 'tax_amount', 'actual_paid_amount', 'paid_at', 'created_at'],
          values: [invoiceId, (stripeId && ctx.byStripe.get(stripeId)) ?? null, stripeId, str(r['プラン名']), int(r['サブスク価格']), int(r['クーポン値引き額']), int(r['税抜価格']), int(r['消費税額']), int(r['支払い総額（税込）']), paidAt, paidAt ?? ctx.importedAt],
          key: invoiceId,
        };
      };
    case 'ticket-transactions':
      return async (r, ctx) => {
        const paymentId = str(r['請求書ID']);
        if (!paymentId) return 'missing_key';
        const stripeId = str(r['Stripe顧客ID']);
        const lineUserId = stripeId ? ctx.byStripe.get(stripeId) : undefined;
        if (!lineUserId) return 'unresolved_line_user_id';
        const key = `purchase:${paymentId}`;
        return {
          table: spec.table,
          columns: ['id', 'line_user_id', 'delta', 'reason', 'idempotency_key', 'payment_intent_id', 'amount', 'currency', 'created_at'],
          values: [await rowHash(spec.sheet, [paymentId]), lineUserId, int(r['購入チケット数']) ?? 0, 'purchase', key, paymentId, int(r['支払い総額（税込）']), 'jpy', jst(r['処理日時']) ?? ctx.importedAt],
          key,
        };
      };
    case 'execution-logs':
      return async (r, ctx) => {
        const values = Object.values(r);
        const hash = await rowHash(spec.sheet, values);
        const dedupeKey = str(r['重複防止キー']) ?? `sheet:${hash}`;
        const accountUrl = str(r['URL']);
        return {
          table: spec.table,
          columns: ['id', 'line_user_id', 'key_code', 'service', 'account_url', 'mypage_info_updated_date', 'count_rating', 'sales_amount', 'total_target_count', 'options', 'dedupe_key', 'client', 'payload', 'created_at'],
          values: [hash, (accountUrl && ctx.byUrl.get(accountUrl)) ?? null, null, str(r['サービス']), accountUrl, str(r['マイページ更新日時']), str(r['評価数']), str(r['売上金']), str(r['商品数']), str(r['自動化内容']), dedupeKey, 'sheet', JSON.stringify(r), jst(r['処理日時']) ?? ctx.importedAt],
          key: dedupeKey,
        };
      };
    case 'auto-copy-logs':
      return async (r, ctx) => {
        const values = Object.values(r);
        const hash = await rowHash(spec.sheet, values);
        const name = str(r['LINE表示名']);
        const remainingHeader = headerStartingWith(r, '　残チケット数') ?? headerStartingWith(r, '残チケット数') ?? '残チケット数';
        const dedupeKey = str(r['重複防止キー']);
        return {
          table: spec.table,
          columns: ['id', 'line_user_id', 'display_name', 'source_url', 'target_url', 'remaining_tickets', 'processed_at', 'imported_at', 'idempotency_key'],
          values: [hash, (name && ctx.byDisplayName.get(name)) ?? null, name, str(r['コピー元URL']), str(r['コピー出品先URL']), int(r[remainingHeader]), jst(r['処理日時']) ?? ctx.importedAt, ctx.importedAt, dedupeKey ? `consume:${dedupeKey}` : null],
          key: hash,
        };
      };
    case 'errors':
      return async (r, ctx) => {
        const values = Object.values(r);
        const hash = await rowHash(spec.sheet, values);
        const keyCode = str(r['キーコード']);
        return {
          table: spec.table,
          columns: ['id', 'line_user_id', 'key_code', 'method', 'error', 'mercari_url', 'discrimination_code', 'client', 'created_at'],
          values: [hash, (keyCode && ctx.byKeyCode.get(keyCode)) ?? null, keyCode, 'sheet', str(r['エラー内容']) ?? '', str(r['URL']), str(r['端末判定文字列']), 'sheet', jst(r['日時']) ?? ctx.importedAt],
          key: hash,
        };
      };
    case 'manual-copy-logs':
      return async (r, ctx) => {
        const dedupeKey = str(r['重複防止キー']);
        if (!dedupeKey) return 'missing_key';
        const keyCode = str(r['キーコード']);
        const startedAt = jst(r['開始日時']) ?? ctx.importedAt;
        return {
          table: spec.table,
          columns: ['id', 'dedupe_key', 'install_id', 'key_code', 'line_user_id', 'item_id', 'item_name', 'target', 'status', 'target_url', 'source_url', 'started_at', 'completed_at', 'created_at'],
          values: [await rowHash(spec.sheet, [dedupeKey]), dedupeKey, str(r['インストールID']), keyCode, (keyCode && ctx.byKeyCode.get(keyCode)) ?? null, str(r['コピー元商品ID']), str(r['コピー元商品名']), str(r['コピー先']), str(r['ステータス']) ?? '開始', str(r['出品先URL']), str(r['コピー元URL']), startedAt, jst(r['完了日時']), startedAt],
          key: dedupeKey,
        };
      };
    case 'shop-research-logs':
      return async (r, ctx) => {
        const dedupeKey = str(r['重複防止キー']);
        if (!dedupeKey) return 'missing_key';
        const keyCode = str(r['キーコード']);
        return {
          table: spec.table,
          columns: ['id', 'dedupe_key', 'install_id', 'key_code', 'line_user_id', 'my_mercari_url', 'target_url', 'is_free', 'created_at'],
          values: [await rowHash(spec.sheet, [dedupeKey]), dedupeKey, str(r['インストールID']), keyCode, (keyCode && ctx.byKeyCode.get(keyCode)) ?? null, str(r['自分のメルカリURL']), str(r['調査対象URL']) ?? '', str(r['区分']) === '無料枠' ? 1 : 0, jst(r['発火日時']) ?? ctx.importedAt],
          key: dedupeKey,
        };
      };
    case 'free-accounts':
      return async (r, ctx) => {
        const installId = str(r['インストールID']);
        if (!installId) return 'missing_key';
        const createdAt = jst(r['初回登録日時']) ?? ctx.importedAt;
        return {
          table: spec.table,
          columns: ['install_id', 'mercari_url', 'rakuma_url', 'yahoo_flea_url', 'yahoo_auction_url', 'shops_url', 'key_code', 'created_at', 'updated_at'],
          values: [installId, str(r['メルカリURL']), str(r['ラクマURL']), str(r['ヤフフリURL']), str(r['ヤフオクURL']), str(r['ShopsURL']), str(r['キーコード']), createdAt, jst(r['最終更新日時']) ?? createdAt],
          key: installId,
        };
      };
    case 'survey-answers':
      return async (r, ctx) => {
        const lineUserId = str(r['LINE_ID']) ?? '';
        if (!LINE_USER_ID_RE.test(lineUserId)) return 'missing_key';
        const answer = str(r['アンケート回答']) ?? '';
        const hash = await rowHash(spec.sheet, [lineUserId, answer]);
        return {
          table: spec.table,
          columns: ['id', 'line_user_id', 'display_name', 'answer', 'created_at'],
          values: [hash, lineUserId, str(r['LINE表示名']), answer, ctx.importedAt],
          key: hash,
        };
      };
    case 'coupon-applications':
      return async (r, ctx) => {
        const values = Object.values(r);
        const stripeId = str(r['Stripe顧客ID']);
        const lineUserId = stripeId ? ctx.byStripe.get(stripeId) : undefined;
        if (!lineUserId) return 'unresolved_line_user_id';
        const hash = await rowHash(spec.sheet, values);
        return {
          table: spec.table,
          columns: ['id', 'line_user_id', 'stripe_customer_id', 'coupon_name', 'coupon_id', 'route', 'created_at'],
          values: [hash, lineUserId, stripeId, str(r['クーポン名']) ?? '', str(r['クーポンID']), str(r['経路']) ?? '', jst(r['適用日時']) ?? ctx.importedAt],
          key: hash,
        };
      };
    case 'cancellations':
      return async (r, ctx) => {
        const values = Object.values(r);
        const hash = await rowHash(spec.sheet, values);
        const mercariUrl = str(r['メルカリURL']);
        const judgmentHeader = headerStartingWith(r, '副業継続判定');
        return {
          table: spec.table,
          columns: ['id', 'line_user_id', 'stripe_event_id', 'subscription_id', 'plan_name', 'mercari_url', 'canceled_at', 'display_name', 'side_job_judgment'],
          values: [hash, (mercariUrl && ctx.byUrl.get(mercariUrl)) ?? null, null, null, str(r['プラン名']), mercariUrl, jst(r['キャンセル日時']) ?? ctx.importedAt, str(r['LINE表示名']), judgmentHeader ? str(r[judgmentHeader]) : null],
          key: hash,
        };
      };
    case 'referral-cashbacks':
      return async (r, ctx) => {
        const values = Object.values(r);
        const hash = await rowHash(spec.sheet, values);
        const stripeId = str(r['Stripe顧客ID']);
        return {
          table: spec.table,
          columns: ['id', 'occurred_at', 'introduced_display_name', 'introduced_line_user_id', 'stripe_customer_id', 'price', 'ambassador_display_name', 'ambassador_line_user_id', 'cashback_amount', 'imported_at'],
          values: [hash, jst(r['日時']) ?? ctx.importedAt, str(r['LINE表示名(友)']), (stripeId && ctx.byStripe.get(stripeId)) ?? null, stripeId, int(r['価格']), str(r['LINE表示名(ア)']), str(r['LINE_ID']), int(r['キャッシュバック金額']), ctx.importedAt],
          key: hash,
        };
      };
    default:
      throw new Error(`unknown sheet spec: ${spec.name}`);
  }
}

export async function mapSheetRows(spec: SheetSpec, rows: SheetRow[], ctx: ResolveContext): Promise<MapResult> {
  const map = mapper(spec);
  const out: MappedRow[] = [];
  const skipped: Record<SkipReason, number> = { type_row: 0, empty_row: 0, missing_key: 0, duplicate_in_sheet: 0, unresolved_line_user_id: 0, matched_consume: 0 };
  const seen = new Set<string>();
  let unresolved = 0;
  for (const row of rows) {
    if (isEmptyRow(row)) { skipped.empty_row++; continue; }
    if (isTypeRow(row)) { skipped.type_row++; continue; }
    const mapped = await map(row, ctx);
    if (typeof mapped === 'string') { skipped[mapped]++; continue; }
    if (seen.has(mapped.key)) { skipped.duplicate_in_sheet++; continue; }
    seen.add(mapped.key);
    const lineIdx = mapped.columns.indexOf('line_user_id');
    if (lineIdx >= 0 && mapped.values[lineIdx] == null) unresolved++;
    out.push(mapped);
  }
  return { rows: out, skipped, unresolved };
}

// ── D1 文 ──

/** 同じ表・同じ列の行をまとめ、1 文 90 bind 以内の複数行 INSERT OR IGNORE にする（upsert 指定の行は 1 行 1 文） */
export function buildInsertStatements(db: D1Database, rows: MappedRow[]): D1PreparedStatement[] {
  const groups = new Map<string, MappedRow[]>();
  for (const r of rows) {
    const g = `${r.table}|${r.columns.join(',')}|${r.conflict ? r.conflict.target : ''}`;
    let list = groups.get(g);
    if (!list) { list = []; groups.set(g, list); }
    list.push(r);
  }
  const stmts: D1PreparedStatement[] = [];
  for (const list of groups.values()) {
    const first = list[0];
    const cols = first.columns;
    const placeholders = `(${cols.map(() => '?').join(', ')})`;
    if (first.conflict) {
      const set = first.conflict.update.map((c) => `${c} = excluded.${c}`).join(', ');
      for (const r of list) {
        stmts.push(db.prepare(`INSERT INTO ${r.table} (${cols.join(', ')}) VALUES ${placeholders} ON CONFLICT(${first.conflict.target}) DO UPDATE SET ${set}`).bind(...r.values));
      }
      continue;
    }
    const perStmt = Math.max(1, Math.floor(MAX_BINDS_PER_STATEMENT / cols.length));
    for (let i = 0; i < list.length; i += perStmt) {
      const chunk = list.slice(i, i + perStmt);
      const sql = `INSERT OR IGNORE INTO ${first.table} (${cols.join(', ')}) VALUES ${chunk.map(() => placeholders).join(', ')}`;
      stmts.push(db.prepare(sql).bind(...chunk.flatMap((r) => r.values)));
    }
  }
  return stmts;
}

async function runBatches(db: D1Database, stmts: D1PreparedStatement[]): Promise<number> {
  let changes = 0;
  for (let i = 0; i < stmts.length; i += STATEMENTS_PER_BATCH) {
    const results = await db.batch(stmts.slice(i, i + STATEMENTS_PER_BATCH));
    changes += results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
  }
  return changes;
}

const GAS_READ_ATTEMPTS = 3;

// Google は断続的に 404 の HTML ページを返す（gas-client.ts 参照）。getData は読むだけなので再試行しても副作用が無い
function isTransientGasFailure(e: unknown): boolean {
  const msg = String(e);
  return /GAS GET 404|HTML error page|fetch hang|aborted|TimeoutError/i.test(msg);
}

export async function fetchSheetRows(gasDeployId: string, spec: SheetSpec): Promise<SheetRow[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await gasGet(gasDeployId, { method: 'getData', sheet: spec.sheet, headerRow: String(spec.headerRow) }, { timeoutMs: GAS_TIMEOUT_MS });
      const failure = getGasErrorFromResponse(res);
      if (failure) throw new Error(`getData(${spec.sheet}) failed: ${failure}`);
      const data = res as { success?: boolean; rows?: SheetRow[] };
      if (data?.success !== true || !Array.isArray(data.rows)) throw new Error(`getData(${spec.sheet}) unexpected response`);
      return data.rows;
    } catch (e) {
      if (attempt >= GAS_READ_ATTEMPTS || !isTransientGasFailure(e)) throw e;
      console.warn(`[furim/backfill-sheets] getData(${spec.sheet}) transient failure (attempt ${attempt}):`, String(e).slice(0, 120));
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

export async function countTableRows(db: D1Database, spec: SheetSpec): Promise<number> {
  const stmt = db.prepare(`SELECT COUNT(*) AS n FROM ${spec.table}`);
  const row = await stmt.first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * 自動コピー出品履歴: 消費経路（copy-credit / ticket-consumed）で既に入った行と同じ消費のシート行は入れない（段階4-D・Capsec #258）。
 * 重複防止キーがあれば consume:<キー> で、無ければ URL＋2 分以内で突き合わせる。通知経由の行を正とし、残チケット数が空ならシートの値で埋める
 */
async function dropMatchedConsumes(db: D1Database, mapped: MapResult): Promise<D1PreparedStatement[]> {
  const keyed = (
    await db
      .prepare('SELECT id, line_user_id, source_url, target_url, processed_at, remaining_tickets, idempotency_key FROM furim_auto_copy_logs WHERE idempotency_key IS NOT NULL')
      .all<{ id: string; line_user_id: string | null; source_url: string | null; target_url: string | null; processed_at: string; remaining_tickets: number | null; idempotency_key: string }>()
  ).results ?? [];
  if (keyed.length === 0) return [];
  const byKey = new Map(keyed.map((k) => [k.idempotency_key, k]));
  const byTarget = new Map<string, typeof keyed>();
  for (const k of keyed) {
    const t = k.target_url ?? '';
    const list = byTarget.get(t) ?? [];
    list.push(k);
    byTarget.set(t, list);
  }
  const fills: D1PreparedStatement[] = [];
  const filled = new Set<string>();
  const kept: MappedRow[] = [];
  for (const row of mapped.rows) {
    const v = Object.fromEntries(row.columns.map((c, i) => [c, row.values[i]])) as Record<string, unknown>;
    const key = v.idempotency_key as string | null;
    const self = { line_user_id: v.line_user_id as string | null, source_url: v.source_url as string | null, target_url: v.target_url as string | null, at: String(v.processed_at) };
    const match = key
      ? byKey.get(key)
      : (byTarget.get(self.target_url ?? '') ?? []).find((k) => isSameConsume(self, { ...k, at: k.processed_at }));
    if (!match || match.id === v.id) { kept.push(row); continue; }
    mapped.skipped.matched_consume++;
    if (v.line_user_id == null) mapped.unresolved--;
    if (match.remaining_tickets == null && v.remaining_tickets != null && !filled.has(match.id)) {
      fills.push(db.prepare('UPDATE furim_auto_copy_logs SET remaining_tickets = ? WHERE id = ? AND remaining_tickets IS NULL').bind(v.remaining_tickets, match.id));
      filled.add(match.id);
    }
  }
  mapped.rows = kept;
  return fills;
}

export type SheetBackfillResult = {
  dryRun: boolean;
  sheet: string;
  table: string;
  sheetRows: number;
  mapped: number;
  skipped: Record<SkipReason, number>;
  unresolvedLineUserId: number;
  statements: number;
  inserted: number;
  remainingFilled: number;
  countBefore: number;
  countAfter: number;
  sample: MappedRow[];
};

export async function backfillSheet(db: D1Database, gasDeployId: string, spec: SheetSpec, opts: { dryRun: boolean; now?: string }): Promise<SheetBackfillResult> {
  const importedAt = opts.now ?? toJstString(new Date());
  const rows = await fetchSheetRows(gasDeployId, spec);
  const ctx = await loadResolveContext(db, importedAt);
  const mapped = await mapSheetRows(spec, rows, ctx);
  const fills = spec.name === 'auto-copy-logs' ? await dropMatchedConsumes(db, mapped) : [];
  const stmts = [...buildInsertStatements(db, mapped.rows), ...fills];
  const countBefore = await countTableRows(db, spec);
  const base = {
    sheet: spec.sheet,
    table: spec.table,
    sheetRows: rows.length,
    mapped: mapped.rows.length,
    skipped: mapped.skipped,
    unresolvedLineUserId: mapped.unresolved,
    statements: stmts.length,
    countBefore,
    sample: mapped.rows.slice(0, 3),
  };
  if (opts.dryRun) return { dryRun: true, inserted: 0, remainingFilled: 0, countAfter: countBefore, ...base };
  const inserted = await runBatches(db, stmts.slice(0, stmts.length - fills.length));
  const remainingFilled = fills.length ? await runBatches(db, fills) : 0;
  const countAfter = await countTableRows(db, spec);
  console.log('[furim/backfill-sheets]', JSON.stringify({ sheet: spec.sheet, table: spec.table, sheetRows: rows.length, mapped: mapped.rows.length, skipped: mapped.skipped, inserted, countBefore, countAfter }));
  return { dryRun: false, inserted, remainingFilled, countAfter, ...base };
}
