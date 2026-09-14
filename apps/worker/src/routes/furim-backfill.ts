// スプレッドシートの過去分を D1 に取り込む初期投入（段階4-B・Capsec #252）。
// backfill-ext-columns と同じ作法: スタッフ認証（authMiddleware）・dryRun 既定・本番は confirmProd 必須。
import { Hono } from 'hono';
import type { Env } from '../index.js';
import { SHEET_BACKFILL_SPECS, backfillSheet, countTableRows, getSheetSpec } from '../furim/sheet-backfill.js';
import { moveConsumeRowsToAutoCopyLogs } from '../furim/ticket-ledger.js';
import { FIX_TARGETS, fixDatetimes, isFixTarget, type SheetCache } from '../furim/fix-datetimes.js';
import { fillPaymentsFromStripe, makeStripeInvoiceFetcher } from '../furim/fill-payments-from-stripe.js';

const furimBackfill = new Hono<Env>();

furimBackfill.get('/api/furim/fix-datetimes', async (c) => {
  try {
    const only = c.req.query('target');
    if (only !== undefined && !isFixTarget(only)) {
      return c.json({ success: false, error: 'target が不正です', targets: FIX_TARGETS }, 400);
    }
    const cache: SheetCache = new Map();
    const targets = [];
    for (const target of only ? [only] : FIX_TARGETS) {
      const r = await fixDatetimes(c.env.DB, c.env.GAS_DEPLOY_ID, target, { dryRun: true, staffId: c.get('staff').id, cache });
      targets.push(r);
    }
    return c.json({ success: true, targets });
  } catch (err) {
    console.error('[furim/fix-datetimes] error:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

furimBackfill.post('/api/furim/fix-datetimes', async (c) => {
  const isDev = c.env.WORKER_NAME === 'line-harness';
  try {
    const body = await c.req.json<{ target?: string; dryRun?: boolean; confirmProd?: boolean }>().catch(() => ({}) as { target?: string; dryRun?: boolean; confirmProd?: boolean });
    if (!isFixTarget(body.target)) {
      return c.json({ success: false, error: 'target を指定してください', targets: FIX_TARGETS }, 400);
    }
    const dryRun = body.dryRun !== false;
    if (!dryRun && !isDev && body.confirmProd !== true) {
      return c.json({ success: false, error: '本番workerでの実行には confirmProd: true が必要です' }, 403);
    }
    const result = await fixDatetimes(c.env.DB, c.env.GAS_DEPLOY_ID, body.target, { dryRun, staffId: c.get('staff').id });
    return c.json({ success: true, ...result });
  } catch (err) {
    console.error('[furim/fix-datetimes] error:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

/** GET /api/furim/backfill-sheets — 取り込み対象シートと対応テーブル・D1 の現在件数 */
furimBackfill.get('/api/furim/backfill-sheets', async (c) => {
  try {
    const sheets = [];
    for (const spec of SHEET_BACKFILL_SPECS) {
      sheets.push({ name: spec.name, sheet: spec.sheet, table: spec.table, masterKind: spec.masterKind ?? null, d1Count: await countTableRows(c.env.DB, spec) });
    }
    return c.json({ success: true, sheets });
  } catch (err) {
    console.error('[furim/backfill-sheets] error:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

/**
 * POST /api/furim/backfill-sheets
 * Body: { sheet: string（SHEET_BACKFILL_SPECS の name）, dryRun?: boolean = true, confirmProd?: boolean }
 * 1 回の呼び出しで 1 シートを全行取り込む（冪等・再実行で増えない）
 */
furimBackfill.post('/api/furim/backfill-sheets', async (c) => {
  const isDev = c.env.WORKER_NAME === 'line-harness';
  try {
    const body = await c.req.json<{ sheet?: string; dryRun?: boolean; confirmProd?: boolean }>().catch(() => ({}) as { sheet?: string; dryRun?: boolean; confirmProd?: boolean });
    const spec = body.sheet ? getSheetSpec(body.sheet) : undefined;
    if (!spec) {
      return c.json({ success: false, error: 'sheet を指定してください', sheets: SHEET_BACKFILL_SPECS.map((s) => s.name) }, 400);
    }
    const dryRun = body.dryRun !== false;
    if (!dryRun && !isDev && body.confirmProd !== true) {
      return c.json({ success: false, error: '本番workerでの実行には confirmProd: true が必要です' }, 403);
    }
    if (!c.env.GAS_DEPLOY_ID) return c.json({ success: false, error: 'GAS_DEPLOY_ID not configured' }, 500);
    const result = await backfillSheet(c.env.DB, c.env.GAS_DEPLOY_ID, spec, { dryRun });
    return c.json({ success: true, ...result });
  } catch (err) {
    console.error('[furim/backfill-sheets] error:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

/**
 * POST /api/furim/move-consume-to-auto-copy-logs
 * 段階4-D（Capsec #258）: furim_ticket_ledger の consume 行を furim_auto_copy_logs へ移して台帳から消す（冪等・残数は触らない）
 * Body: { dryRun?: boolean = true, confirmProd?: boolean }
 */
furimBackfill.post('/api/furim/move-consume-to-auto-copy-logs', async (c) => {
  const isDev = c.env.WORKER_NAME === 'line-harness';
  try {
    const body = await c.req.json<{ dryRun?: boolean; confirmProd?: boolean }>().catch(() => ({}) as { dryRun?: boolean; confirmProd?: boolean });
    const dryRun = body.dryRun !== false;
    if (!dryRun && !isDev && body.confirmProd !== true) {
      return c.json({ success: false, error: '本番workerでの実行には confirmProd: true が必要です' }, 403);
    }
    const result = await moveConsumeRowsToAutoCopyLogs(c.env.DB, { dryRun });
    return c.json({ success: true, ...result });
  } catch (err) {
    console.error('[furim/move-consume] error:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

furimBackfill.post('/api/furim/fill-payments-from-stripe', async (c) => {
  const isDev = c.env.WORKER_NAME === 'line-harness';
  try {
    const body = await c.req
      .json<{ dryRun?: boolean; confirmProd?: boolean; cursor?: string; limit?: number }>()
      .catch(() => ({}) as { dryRun?: boolean; confirmProd?: boolean; cursor?: string; limit?: number });
    const dryRun = body.dryRun !== false;
    if (!dryRun && !isDev && body.confirmProd !== true) {
      return c.json({ success: false, error: '本番workerでの実行には confirmProd: true が必要です' }, 403);
    }
    if (!c.env.STRIPE_SECRET_KEY) return c.json({ success: false, error: 'STRIPE_SECRET_KEY not configured' }, 500);
    const result = await fillPaymentsFromStripe(c.env.DB, makeStripeInvoiceFetcher(c.env.STRIPE_SECRET_KEY), {
      dryRun,
      staffId: c.get('staff').id,
      cursor: body.cursor,
      limit: body.limit,
    });
    return c.json({ success: true, ...result });
  } catch (err) {
    console.error('[furim/fill-payments-from-stripe] error:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

export { furimBackfill };
