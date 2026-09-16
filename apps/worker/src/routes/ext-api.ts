import { Hono, type Context } from 'hono';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';
import { upsertFurimCustomer, type FurimCustomer, type FurimCustomerPatch } from '../furim/customer-store.js';
import {
  KEY_CODE_ERROR,
  evaluateKeyCodeSet,
  findLineUserIdByMercariUrl,
  invalidateExtCache,
  keyCodeErrorMessage,
  loadCustomerByKeyCode,
  recordExtError,
} from '../furim/ext-auth.js';

/**
 * Chrome 拡張 → Worker の認証・ログ API（Capsec #245・段階3）。
 * 契約: .claude-company/projects/furim-auto/specs/2026-09-14-ext-worker-api-contract.md
 * - POST JSON（GET クエリも可）・X-FurimAuto-Client 必須（無ければ 401）・常に JSON
 * - 業務結果は 200＋{success:false, error, errorMessage}（GAS と同じ文字列）。400 は必須欠落/JSON 壊れだけ。500 は内部エラー
 * - authMiddleware の対象外（middleware/auth.ts）。IP 120 req/分は middleware/rate-limit.ts
 */

export const EXT_API_PREFIX = '/api/ext/v1';
export const CLIENT_HEADER = 'X-FurimAuto-Client';

const extApi = new Hono<Env>();

type Ctx = Context<Env>;
type Params = Record<string, unknown>;

function str(v: unknown): string {
  if (v == null) return '';
  return String(v).trim();
}

function strOrNull(v: unknown): string | null {
  const s = str(v);
  return s === '' ? null : s;
}

function bad(c: Ctx, message: string): Response {
  return c.json({ success: false, error: 'bad_request', errorMessage: message }, 400);
}

// ── 共通: ヘッダ検査 ──
extApi.use(`${EXT_API_PREFIX}/*`, async (c, next) => {
  const client = c.req.header(CLIENT_HEADER);
  if (!client) {
    return c.json({ success: false, error: 'unauthorized', errorMessage: 'X-FurimAuto-Client ヘッダが必要です' }, 401);
  }
  await next();
});

async function readParams(c: Ctx): Promise<Params | null> {
  if (c.req.method === 'GET') return { ...c.req.query() };
  try {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as Params;
  } catch {
    return null;
  }
}

type Handler = (c: Ctx, p: Params, client: string) => Promise<Response>;

function mount(path: string, handler: Handler): void {
  // 内部エラーも必ず JSON（500・internal）にする。app.onError（HTML/テキスト）に落とさない
  const wrapped = async (c: Ctx) => {
    const client = c.req.header(CLIENT_HEADER) ?? '';
    try {
      const p = await readParams(c);
      if (!p) return bad(c, 'リクエスト本文が JSON として読めません');
      return await handler(c, p, client);
    } catch (err) {
      console.error(`[ext-api] internal error path=${path} client=${client}:`, err);
      return c.json({ success: false, error: 'internal', errorMessage: 'エラーが発生しました。しばらく時間をおいて再度お試しください。' }, 500);
    }
  };
  extApi.post(`${EXT_API_PREFIX}/${path}`, wrapped);
  extApi.get(`${EXT_API_PREFIX}/${path}`, wrapped);
}

async function findCustomerByKeyCode(db: D1Database, keyCode: string): Promise<FurimCustomer | null> {
  return db.prepare('SELECT * FROM furim_customers WHERE key_code = ? ORDER BY updated_at DESC LIMIT 1').bind(keyCode).first<FurimCustomer>();
}

async function findLineUserIdByKeyCode(db: D1Database, keyCode: string): Promise<string | null> {
  if (!keyCode) return null;
  const row = await db.prepare('SELECT line_user_id FROM furim_customers WHERE key_code = ? ORDER BY updated_at DESC LIMIT 1').bind(keyCode).first<{ line_user_id: string }>();
  return row?.line_user_id ?? null;
}

// ── 2-1. key-code-set ← getKeyCodeSet ──
mount('key-code-set', async (c, p, client) => {
  const keyCode = str(p.keyCode);
  if (!keyCode) return bad(c, 'keyCode が必要です');
  const input = { keyCode, discriminationCode: strOrNull(p.discriminationCode), mercariAccountUrl: strOrNull(p.mercariAccountUrl) };
  const db = c.env.DB;
  const kv = c.env.FURIM_EXT_CACHE;

  const fail = async (error: string, currentMercariUrl: string | null, lineUserId: string | null) => {
    await recordExtError(db, { method: 'getKeyCodeSet', error, lineUserId, keyCode, mercariUrl: input.mercariAccountUrl ?? 'URLなし', discriminationCode: input.discriminationCode, client });
    console.log(`[ext-api] key-code-set NG error=${error} keyCode=${keyCode} client=${client}`);
    return c.json({ success: false, error, errorMessage: keyCodeErrorMessage(error, { currentMercariUrl, mercariAccountUrl: input.mercariAccountUrl }), keyCode: null, expiredDate: null });
  };

  let { bundle, fromCache } = await loadCustomerByKeyCode(db, kv, keyCode);
  if (!bundle) {
    // 旧キーコードのまま（プラン変更で刷新済み）か、単なる無効かをメルカリURLで見分ける
    const owner = input.mercariAccountUrl ? await findLineUserIdByMercariUrl(db, input.mercariAccountUrl) : null;
    if (owner) return fail(KEY_CODE_ERROR.KEY_CODE_RENEWED, null, owner);
    return fail(KEY_CODE_ERROR.NOT_FOUND, null, null);
  }

  const evaluate = async (b: NonNullable<typeof bundle>) => {
    const other = input.mercariAccountUrl ? await findLineUserIdByMercariUrl(db, input.mercariAccountUrl, b.customer.line_user_id) : null;
    return evaluateKeyCodeSet(b, input, { nowMs: Date.now(), mercariUrlOwnedByOther: !!other });
  };
  let outcome = await evaluate(bundle);
  if (!outcome.ok && fromCache) {
    // キャッシュ由来の業務エラーは D1 を読み直してから確定（リセット直後・URL 登録直後の誤判定を防ぐ）
    const fresh = await loadCustomerByKeyCode(db, kv, keyCode, { fresh: true });
    bundle = fresh.bundle;
    fromCache = false;
    if (!bundle) return fail(KEY_CODE_ERROR.NOT_FOUND, null, null);
    outcome = await evaluate(bundle);
  }
  if (!outcome.ok) return fail(outcome.error, outcome.currentMercariUrl, bundle.customer.line_user_id);

  await upsertFurimCustomer(db, bundle.customer.line_user_id, outcome.patch);
  if (outcome.cacheDirty) await invalidateExtCache(kv, keyCode);
  console.log(`[ext-api] key-code-set OK keyCode=${keyCode} client=${client} cache=${fromCache ? 'hit' : 'miss'} issued=${outcome.patch.device_code ? 1 : 0}`);
  return c.json(outcome.response);
});

// ── 2-2. copy-credit ← updateCopyCredit（差分方式のみ・dedupeKey で冪等） ──
mount('copy-credit', async (c, p, client) => {
  const keyCode = str(p.keyCode);
  if (!keyCode) return bad(c, 'keyCode が必要です');
  const hasDelta = p.delta !== undefined && p.delta !== null && p.delta !== '';
  const delta = hasDelta ? Number(p.delta) : NaN;
  if (!hasDelta || !Number.isFinite(delta)) return bad(c, 'delta（使った枚数）が必要です。絶対値 copyCredit は受け付けません');
  const dedupeKey = str(p.dedupeKey);
  if (!dedupeKey) return bad(c, 'dedupeKey が必要です');
  const db = c.env.DB;

  const customer = await findCustomerByKeyCode(db, keyCode);
  if (!customer) {
    await recordExtError(db, { method: 'updateCopyCredit', error: KEY_CODE_ERROR.NOT_FOUND, keyCode, client });
    return c.json({ success: false, error: KEY_CODE_ERROR.NOT_FOUND, errorMessage: '入力されたキーコードは登録されていません。', keyCode, copyCredit: null });
  }

  // 自動コピー出品履歴＋残数は ticket-ledger.ts（旧拡張の GAS updateCopyCredit → /api/furim/ticket-consumed も同じ関数・同じ冪等キー）
  const { applyTicketConsume } = await import('../furim/ticket-ledger.js');
  const r = await applyTicketConsume(db, c.env.FURIM_EXT_CACHE, customer, {
    delta,
    dedupeKey,
    sourceUrl: strOrNull(p.sourceUrl),
    targetUrl: strOrNull(p.targetUrl),
  });
  console.log(`[ext-api] copy-credit ${r.applied ? 'applied' : 'dup'} keyCode=${keyCode} delta=${delta} left=${r.copyTickets} client=${client}`);
  return c.json({ success: true, keyCode, copyCredit: r.copyTickets, message: r.applied ? 'コピー出品チケットを更新しました' : '再送のためスキップしました' });
});

// ── 2-3. execution-log ← stackExecutionData ──
const SERVICE_URL_COLUMN: Record<string, keyof FurimCustomerPatch> = {
  'メルカリ': 'mercari_url',
  'メルカリShops': 'shops_url',
  'ラクマ': 'rakuma_url',
  'ヤフフリ': 'yahoo_flea_url',
};

mount('execution-log', async (c, p, client) => {
  const keyCode = str(p.keyCode);
  if (!keyCode) return bad(c, 'keyCode が必要です');
  const db = c.env.DB;
  const accountUrl = strOrNull(p.accountUrl);
  const service = strOrNull(p.service);

  const customer = await findCustomerByKeyCode(db, keyCode);
  if (!customer) {
    // 旧キーコードが拡張に残っている顧客の記録が落ちた時に誰か分かるよう、accountUrl から逆引きして残す
    const lineUserId = await findLineUserIdByMercariUrl(db, accountUrl);
    await recordExtError(db, { method: 'stackExecutionData', error: KEY_CODE_ERROR.NOT_FOUND, lineUserId, keyCode, mercariUrl: accountUrl ?? 'URLなし', client });
    return c.json({ success: false, error: KEY_CODE_ERROR.NOT_FOUND, errorMessage: '入力されたキーコードは登録されていません。' });
  }

  // service ごとのアカウント URL を保存（渡された時だけ。空で上書きしない）
  if (accountUrl && service && SERVICE_URL_COLUMN[service]) {
    const col = SERVICE_URL_COLUMN[service];
    if ((customer[col as keyof FurimCustomer] ?? null) !== accountUrl) {
      await upsertFurimCustomer(db, customer.line_user_id, { [col]: accountUrl } as FurimCustomerPatch);
      await invalidateExtCache(c.env.FURIM_EXT_CACHE, keyCode);
    }
  }

  const dedupeKey = str(p.dedupeKey) || crypto.randomUUID();
  const hasMypage = !!strOrNull(p.mypageInfoUpdatedDate);
  const options = p.options == null ? null : typeof p.options === 'string' ? p.options : JSON.stringify(p.options);
  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO furim_execution_logs
         (id, line_user_id, key_code, service, account_url, mypage_info_updated_date, count_rating, sales_amount, total_target_count, options, dedupe_key, client, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      customer.line_user_id,
      keyCode,
      service,
      accountUrl,
      hasMypage ? strOrNull(p.mypageInfoUpdatedDate) : null,
      hasMypage ? strOrNull(p.countRating) : null,
      hasMypage ? strOrNull(p.salesAmount) : null,
      strOrNull(p.totalTargetCount),
      options,
      dedupeKey,
      client,
      JSON.stringify(p),
      jstNow(),
    )
    .run();
  if ((ins.meta?.changes ?? 0) === 0) {
    return c.json({ success: true, message: '再送のためスキップ' });
  }
  console.log(`[ext-api] execution-log keyCode=${keyCode} service=${service ?? ''} client=${client}`);
  return c.json({ success: true });
});

// ── 2-4. inventory-sheet-created ← setInventorySheetCreated（同期時にも呼ばれる・冪等） ──
mount('inventory-sheet-created', async (c, p, client) => {
  const keyCode = str(p.keyCode);
  if (!keyCode) return bad(c, 'keyCode が必要です');
  const db = c.env.DB;
  const customer = await findCustomerByKeyCode(db, keyCode);
  if (!customer) return c.json({ success: false, error: KEY_CODE_ERROR.NOT_FOUND });
  const spreadsheetUrl = str(p.spreadsheetUrl);
  if (!spreadsheetUrl) return c.json({ success: false, error: 'spreadsheetUrlなし' });
  const current = customer.inventory_sheet_url ?? '';
  if (current === spreadsheetUrl) {
    return c.json({ success: true, alreadySet: true, spreadsheetUrl });
  }
  await upsertFurimCustomer(db, customer.line_user_id, { inventory_sheet_url: spreadsheetUrl, inventory_sheet_created_at: jstNow() });
  await invalidateExtCache(c.env.FURIM_EXT_CACHE, keyCode);
  console.log(`[ext-api] inventory-sheet-created keyCode=${keyCode} replaced=${!!current} client=${client}`);
  return c.json({ success: true, spreadsheetUrl, replaced: !!current });
});

// ── 2-5. line-display-name ← getLineDisplayName ──
mount('line-display-name', async (c, p) => {
  const keyCode = str(p.keyCode);
  if (!keyCode) return bad(c, 'keyCode が必要です');
  const db = c.env.DB;
  const lineUserId = await findLineUserIdByKeyCode(db, keyCode);
  if (!lineUserId) return c.json({ success: false, errorMessage: KEY_CODE_ERROR.NOT_FOUND });
  const friend = await db.prepare('SELECT display_name FROM friends WHERE line_user_id = ?').bind(lineUserId).first<{ display_name: string | null }>();
  return c.json({ success: true, lineDisplayName: friend?.display_name ?? '' });
});

// ── 2-6. free-account ← registFreeAccount（installId 主キー・URL 列は改行区切りで追記） ──
const INSTALL_ID_RE = /^[0-9a-fA-F-]{16,64}$/;
const FREE_ACCOUNT_URL_PARAMS: Array<{ param: string; col: string; pattern: RegExp }> = [
  { param: 'mercariUrl', col: 'mercari_url', pattern: /^https:\/\/jp\.mercari\.com\// },
  { param: 'rakumaUrl', col: 'rakuma_url', pattern: /^https:\/\/(fril\.jp|item\.fril\.jp)\// },
  { param: 'yahooFleaUrl', col: 'yahoo_flea_url', pattern: /^https:\/\/paypayfleamarket\.yahoo\.co\.jp\// },
  { param: 'yahooAuctionUrl', col: 'yahoo_auction_url', pattern: /^https:\/\/auctions\.yahoo\.co\.jp\// },
  { param: 'shopsUrl', col: 'shops_url', pattern: /^https:\/\/mercari-shops\.com\// },
];
const MAX_URLS_PER_CELL = 20;

type FreeAccountRow = { install_id: string; mercari_url: string | null; rakuma_url: string | null; yahoo_flea_url: string | null; yahoo_auction_url: string | null; shops_url: string | null; key_code: string | null };

mount('free-account', async (c, p, client) => {
  const installId = str(p.installId);
  const keyCode = str(p.keyCode);
  if (!INSTALL_ID_RE.test(installId)) return c.json({ success: false, error: 'installId不正' });
  const urls: Record<string, string> = {};
  for (const def of FREE_ACCOUNT_URL_PARAMS) {
    const v = str(p[def.param]);
    if (!v) continue;
    if (v.length > 300 || !def.pattern.test(v)) return c.json({ success: false, error: def.param + '不正' });
    urls[def.col] = v;
  }
  if (!Object.keys(urls).length && !keyCode) return c.json({ success: false, error: '更新内容なし' });
  const db = c.env.DB;
  const now = jstNow();

  const existing = await db.prepare('SELECT * FROM furim_free_accounts WHERE install_id = ?').bind(installId).first<FreeAccountRow>();
  if (!existing) {
    await db
      .prepare(
        `INSERT INTO furim_free_accounts (install_id, mercari_url, rakuma_url, yahoo_flea_url, yahoo_auction_url, shops_url, key_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(installId, urls.mercari_url ?? null, urls.rakuma_url ?? null, urls.yahoo_flea_url ?? null, urls.yahoo_auction_url ?? null, urls.shops_url ?? null, keyCode || null, now, now)
      .run();
    console.log(`[ext-api] free-account created installId=${installId} urls=${Object.keys(urls).length} client=${client}`);
    return c.json({ success: true, created: true });
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [col, url] of Object.entries(urls)) {
    const cur = String((existing as Record<string, unknown>)[col] ?? '');
    const lines = cur ? cur.split('\n').filter((s) => s) : [];
    if (lines.includes(url)) continue;
    if (lines.length >= MAX_URLS_PER_CELL) continue;
    lines.push(url);
    sets.push(`${col} = ?`);
    binds.push(lines.join('\n'));
  }
  if (keyCode && (existing.key_code ?? '') !== keyCode) {
    sets.push('key_code = ?');
    binds.push(keyCode);
  }
  const changed = sets.length > 0;
  if (changed) {
    sets.push('updated_at = ?');
    binds.push(now);
    await db.prepare(`UPDATE furim_free_accounts SET ${sets.join(', ')} WHERE install_id = ?`).bind(...binds, installId).run();
  }
  console.log(`[ext-api] free-account updated installId=${installId} changed=${changed} client=${client}`);
  return c.json({ success: true, updated: changed });
});

// ── 2-7. manual-copy-log ← registManualCopyLog ──
type ManualCopyRow = { id: string; status: string };

async function countManualCopies(db: D1Database, installId: string, target: string): Promise<number> {
  if (!installId || !target) return 0;
  const row = await db.prepare('SELECT COUNT(*) AS n FROM furim_manual_copy_logs WHERE install_id = ? AND target = ?').bind(installId, target).first<{ n: number }>();
  return row?.n ?? 0;
}

mount('manual-copy-log', async (c, p, client) => {
  const stage = str(p.stage);
  const dedupeKey = str(p.dedupeKey);
  const installId = str(p.installId);
  const keyCode = str(p.keyCode);
  const itemId = str(p.itemId);
  const itemName = str(p.itemName).slice(0, 100);
  const target = str(p.target);
  const targetUrl = str(p.targetUrl).slice(0, 300);
  const sourceUrl = str(p.sourceUrl).slice(0, 300);
  if (stage !== 'started' && stage !== 'submitted' && stage !== 'abandoned') return c.json({ success: false, error: 'stage不正' });
  if (!dedupeKey) return c.json({ success: false, error: 'dedupeKeyなし' });
  const db = c.env.DB;
  const now = jstNow();
  const lineUserId = await findLineUserIdByKeyCode(db, keyCode);
  const existing = await db.prepare('SELECT id, status FROM furim_manual_copy_logs WHERE dedupe_key = ?').bind(dedupeKey).first<ManualCopyRow>();

  if (stage === 'started') {
    if (existing) return c.json({ success: true, message: '再送のためスキップ', usedCount: await countManualCopies(db, installId, target) });
    await db
      .prepare(
        `INSERT OR IGNORE INTO furim_manual_copy_logs
           (id, dedupe_key, install_id, key_code, line_user_id, item_id, item_name, target, status, target_url, source_url, started_at, completed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '開始', '', ?, ?, NULL, ?)`,
      )
      .bind(crypto.randomUUID(), dedupeKey, installId, keyCode, lineUserId, itemId, itemName, target, sourceUrl, now, now)
      .run();
    console.log(`[ext-api] manual-copy-log started target=${target} installId=${installId} client=${client}`);
    return c.json({ success: true, created: true, usedCount: await countManualCopies(db, installId, target) });
  }

  if (stage === 'abandoned') {
    if (!existing) return c.json({ success: true, message: '対象行なし' });
    if (existing.status !== '開始') return c.json({ success: true, message: '更新不要', status: existing.status });
    await db.prepare(`UPDATE furim_manual_copy_logs SET status = '未完了(期限切れ)', target_url = '', completed_at = ? WHERE id = ?`).bind(now, existing.id).run();
    return c.json({ success: true, updated: true });
  }

  // submitted
  if (existing) {
    await db.prepare(`UPDATE furim_manual_copy_logs SET status = '出品完了', target_url = ?, completed_at = ? WHERE id = ?`).bind(targetUrl, now, existing.id).run();
    return c.json({ success: true, updated: true });
  }
  await db
    .prepare(
      `INSERT OR IGNORE INTO furim_manual_copy_logs
         (id, dedupe_key, install_id, key_code, line_user_id, item_id, item_name, target, status, target_url, source_url, started_at, completed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '出品完了', ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), dedupeKey, installId, keyCode, lineUserId, itemId, itemName, target, targetUrl, sourceUrl, now, now, now)
    .run();
  return c.json({ success: true, created: true });
});

// ── 2-8. shop-research-log ← registShopResearchLog ──
async function countFreeShopResearch(db: D1Database, installId: string): Promise<number> {
  if (!installId) return 0;
  const row = await db.prepare('SELECT COUNT(*) AS n FROM furim_shop_research_logs WHERE install_id = ? AND is_free = 1').bind(installId).first<{ n: number }>();
  return row?.n ?? 0;
}

mount('shop-research-log', async (c, p, client) => {
  const installId = str(p.installId);
  const keyCode = str(p.keyCode);
  const myMercariUrl = str(p.myMercariUrl).slice(0, 300);
  const targetUrl = str(p.targetUrl).slice(0, 300);
  const isFree = str(p.isFree) === '1';
  const dedupeKey = str(p.dedupeKey);
  if (!targetUrl || !/^https:\/\/jp\.mercari\.com\//.test(targetUrl)) return c.json({ success: false, error: 'targetUrl不正' });
  if (!dedupeKey) return c.json({ success: false, error: 'dedupeKeyなし' });
  const db = c.env.DB;

  let lineUserId = await findLineUserIdByKeyCode(db, keyCode);
  if (!lineUserId && myMercariUrl) lineUserId = await findLineUserIdByMercariUrl(db, myMercariUrl);

  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO furim_shop_research_logs (id, dedupe_key, install_id, key_code, line_user_id, my_mercari_url, target_url, is_free, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), dedupeKey, installId, keyCode, lineUserId, myMercariUrl, targetUrl, isFree ? 1 : 0, jstNow())
    .run();
  const usedCount = await countFreeShopResearch(db, installId);
  if ((ins.meta?.changes ?? 0) === 0) return c.json({ success: true, message: '再送のためスキップ', usedCount });
  console.log(`[ext-api] shop-research-log installId=${installId} free=${isFree} client=${client}`);
  return c.json({ success: true, created: true, usedCount });
});

// ── 2-9. collect-skip ← 巡回キューの取りこぼし（Capsec #294） ──
// 在庫巡回のキューは chrome.storage.local の 1 キーで、タブ側の shift と background の
// タイムアウト側の slice が、どちらも「自分が読んだ配列 −1」を書き戻していた。持ち主を
// 確かめないため、進んだ先の 1 件が一度も処理されずに消える（ログ上は完了に見える）。
// 拡張側で持ち主を確かめる修正を入れるが、飛ばしたときは必ずここに 1 件送ってもらう。
// console.log だけだと「何件飛んだか」を後から数えられない。
mount('collect-skip', async (c, p, client) => {
  const keyCode = str(p.keyCode);
  const queue = str(p.queue) === 'delete' ? 'delete' : 'collect'; // 収集キュー / 削除キュー
  const reason = str(p.reason).slice(0, 40) || 'unknown'; // timeout / owner_mismatch など
  const service = str(p.service).slice(0, 40); // 販路（メルカリ・ラクマ…）
  const target = str(p.target).slice(0, 300); // 対象の URL か商品名
  const detail = str(p.detail).slice(0, 200);
  const db = c.env.DB;

  const lineUserId = await findLineUserIdByKeyCode(db, keyCode);
  // 巡回は D1 に実行記録が無いので、拡張エラーの表に残す（巡回もダッシュボードもここを読む）
  await recordExtError(db, {
    method: 'collectSkip',
    error: [queue, reason, service || '(販路不明)', detail].filter(Boolean).join(' / ').slice(0, 300),
    lineUserId,
    keyCode,
    mercariUrl: target || null,
    discriminationCode: null,
    client,
  });
  console.warn(`[ext-api] collect-skip queue=${queue} reason=${reason} service=${service} keyCode=${keyCode} client=${client}`);
  return c.json({ success: true, recorded: true });
});

export { extApi };
