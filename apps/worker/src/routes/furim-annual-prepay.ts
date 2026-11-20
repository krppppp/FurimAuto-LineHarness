import { Hono } from 'hono';
import { requireRole } from '../middleware/role-guard.js';
import { applyAnnualCoupon, createAnnualCheckout, ensureAnnualCoupon } from '../furim/annual-prepay.js';
import type { Env } from '../index.js';

/**
 * 年払いプランの管理 API（TB-3929・runbook TB-3925 の 7 章）。認証は authMiddleware（スタッフ）・書き込みは owner/admin。
 * - POST /api/furim/annual-prepay/checkout { lineUserId, subscriptionId? } … 年払いの Checkout を発行して URL を返す（請求は変えない）
 * - POST /api/furim/annual-prepay/apply { lineUserId, paymentIntentId }   … 入金を確かめて年払いクーポンを足す（会員の請求の変更・くろさんの確認カードの後）
 * - POST /api/furim/annual-prepay/setup-coupon { dryRun?: boolean = true } … 年払いクーポン 1 枚を作る（冪等）
 */
const furimAnnualPrepay = new Hono<Env>();

furimAnnualPrepay.post('/api/furim/annual-prepay/checkout', requireRole('owner', 'admin'), async (c) => {
  const body = await c.req.json<{ lineUserId?: string; subscriptionId?: string }>().catch(() => ({}) as { lineUserId?: string; subscriptionId?: string });
  if (!body.lineUserId) return c.json({ success: false, error: 'lineUserId required' }, 400);
  try {
    const r = await createAnnualCheckout(c.env.DB, c.env, { lineUserId: body.lineUserId, subscriptionId: body.subscriptionId, createdBy: c.get('staff')?.name });
    if (!r.ok) return c.json({ success: false, reason: r.reason, error: r.message }, 409);
    return c.json({ success: true, ...r });
  } catch (e) {
    console.error('[annual-prepay/checkout] error:', e);
    return c.json({ success: false, error: String(e) }, 500);
  }
});

furimAnnualPrepay.post('/api/furim/annual-prepay/apply', requireRole('owner', 'admin'), async (c) => {
  const body = await c.req.json<{ lineUserId?: string; paymentIntentId?: string }>().catch(() => ({}) as { lineUserId?: string; paymentIntentId?: string });
  if (!body.lineUserId || !body.paymentIntentId?.startsWith('pi_')) return c.json({ success: false, error: 'lineUserId and paymentIntentId required' }, 400);
  try {
    const r = await applyAnnualCoupon(c.env.DB, c.env, { lineUserId: body.lineUserId, paymentIntentId: body.paymentIntentId });
    if (!r.ok) return c.json({ success: false, reason: r.reason, error: r.message, problems: r.problems }, 409);
    return c.json({ success: true, ...r });
  } catch (e) {
    console.error('[annual-prepay/apply] error:', e);
    return c.json({ success: false, error: String(e) }, 500);
  }
});

furimAnnualPrepay.post('/api/furim/annual-prepay/setup-coupon', requireRole('owner', 'admin'), async (c) => {
  const body = await c.req.json<{ dryRun?: boolean }>().catch(() => ({}) as { dryRun?: boolean });
  try {
    const r = await ensureAnnualCoupon(c.env, body.dryRun !== false);
    return c.json({ success: true, dryRun: body.dryRun !== false, ...r });
  } catch (e) {
    console.error('[annual-prepay/setup-coupon] error:', e);
    return c.json({ success: false, error: String(e) }, 500);
  }
});

export { furimAnnualPrepay };
