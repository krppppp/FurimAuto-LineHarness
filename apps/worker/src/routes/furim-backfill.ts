// スプレッドシートの過去分を D1 に取り込む初期投入（段階4-B・Capsec #252）。
// backfill-ext-columns と同じ作法: スタッフ認証（authMiddleware）・dryRun 既定・本番は confirmProd 必須。
import { Hono } from 'hono';
import type { Env } from '../index.js';
import { SHEET_BACKFILL_SPECS, backfillSheet, countTableRows, getSheetSpec } from '../furim/sheet-backfill.js';

const furimBackfill = new Hono<Env>();

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

export { furimBackfill };
