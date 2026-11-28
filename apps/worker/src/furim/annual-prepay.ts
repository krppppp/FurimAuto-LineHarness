// 年払いプラン（TB-3929・手順は TB-3925 の runbook）。
// 今の月払いの定期契約はそのまま残し、年払い額（常設は月額 × 11・決算セールは月額 × 10）を Checkout（mode=payment・既存の Stripe 顧客）で一括でもらう。
// 入金を確かめたら、その定期契約に年払いクーポン（100%・repeating・12 か月）を 1 枚足す。各月の請求は
// 「月払いで払う」か「クーポンで 0 円」のどちらか 1 つだけになるので、仕組みとして二重請求が起きない。
// 請求書（invoice）は使わない: invoice.payment_succeeded が定期契約なしで流れ、月額継続課金フローが動くため（runbook 2 章 C）。
import { jstNow } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { formatJstIso } from './customer-store.js';
import { notifyStaff } from './staff-notify.js';
import type { PushEnv } from '../services/push-notify.js';

export const DEFAULT_ANNUAL_COUPON_ID = 'annual-prepay-12m';
// 決算セール（TB-3951・TB-3956）: 「年払い」の返信が 11/27（金）19:00 JST より前なら月額 × 10。お支払いも同じ 11/27 19:00 まで（Checkout の期限はこれを超えない）
export const DEFAULT_SALE_REPLY_DEADLINE = '2026-11-27T19:00:00+09:00';
export const DEFAULT_ANNUAL_DEADLINE = '2026-11-27T19:00:00+09:00';
export const ANNUAL_MONTHS = 12;
export const SALE_PRICE_MONTHS = 10;
export const STANDARD_PRICE_MONTHS = 11;
const ANNUAL_REPLY_KEYWORD = '年払い';
const CHECKOUT_TTL_SEC = 24 * 3600; // Stripe の expires_at の上限（常設も 24 時間。切れたら同じ API で出し直す）
const CHECKOUT_MIN_TTL_SEC = 30 * 60; // Stripe の expires_at の下限
const STACK_VERSION = '2026-05-27.dahlia';

export type AnnualPrepayEnv = PushEnv & {
  STRIPE_SECRET_KEY?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  WORKER_PUBLIC_URL?: string;
  FURIM_ANNUAL_PREPAY_COUPON_ID?: string;
  FURIM_ANNUAL_PREPAY_DEADLINE?: string;
  FURIM_ANNUAL_SALE_REPLY_DEADLINE?: string;
  FURIM_ANNUAL_TAX_RATE_ID?: string;
};

export function annualCouponId(env: { FURIM_ANNUAL_PREPAY_COUPON_ID?: string }): string {
  return env.FURIM_ANNUAL_PREPAY_COUPON_ID || DEFAULT_ANNUAL_COUPON_ID;
}

// ── 計算（Stripe を呼ばない） ──────────────────────────

type Tier = { up_to: number | null; flat_amount?: number | null; unit_amount?: number | null };
export type SubItem = {
  quantity?: number;
  current_period_end?: number;
  price: { id?: string; unit_amount?: number | null; billing_scheme?: string; tiers?: Tier[] };
};
export type SubDiscount = {
  id: string;
  end?: number | null;
  coupon?: { id: string; amount_off?: number | null; percent_off?: number | null; duration?: string } | null;
};
export type AnnualSub = {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end?: boolean;
  cancel_at?: number | null;
  current_period_end?: number;
  metadata?: Record<string, string>;
  default_payment_method?: string | { id: string } | null;
  default_source?: string | { id: string } | null;
  items: { data: SubItem[] };
  discounts?: Array<SubDiscount | string>;
};

// 段階料金（graduated）込みの品目の金額。annual_quote.py の item_amount と同じ決まり
export function itemAmount(it: SubItem): number {
  const qty = it.quantity ?? 1;
  const p = it.price;
  if (p.billing_scheme !== 'tiered') return (p.unit_amount ?? 0) * qty;
  if (!p.tiers) throw new Error(`price tiers not expanded: ${p.id ?? '?'}`);
  let total = 0;
  let prev = 0;
  for (const t of p.tiers) {
    const n = (t.up_to ? Math.min(qty, t.up_to) : qty) - prev;
    if (n <= 0) break;
    total += (t.flat_amount ?? 0) + (t.unit_amount ?? 0) * n;
    prev += n;
    if (t.up_to == null || qty <= t.up_to) break;
  }
  return total;
}

export function expandedDiscounts(sub: AnnualSub): SubDiscount[] {
  return (sub.discounts ?? []).map((d) => {
    if (typeof d === 'string') throw new Error(`discounts not expanded: ${sub.id}`);
    return d;
  });
}

// 月額 = 全品目の合計 − forever の割引。once・repeating は入れない（価格表 2026-11-20 と同じ）。年払い = 月額 × priceMonths
export function quoteSubscription(sub: AnnualSub, priceMonths: number): { gross: number; foreverOff: number; monthly: number; annual: number; otherDiscounts: string[] } {
  const gross = sub.items.data.reduce((t, it) => t + itemAmount(it), 0);
  let foreverOff = 0;
  const otherDiscounts: string[] = [];
  for (const d of expandedDiscounts(sub)) {
    const c = d.coupon;
    if (!c) continue;
    if (c.duration === 'forever') foreverOff += c.amount_off || Math.round((gross * (c.percent_off ?? 0)) / 100);
    else otherDiscounts.push(c.id);
  }
  const monthly = gross - foreverOff;
  return { gross, foreverOff, monthly, annual: monthly * priceMonths, otherDiscounts };
}

export function periodEnd(sub: AnnualSub): number {
  return sub.current_period_end ?? Math.max(0, ...sub.items.data.map((it) => it.current_period_end ?? 0));
}

export function hasAnnualCoupon(sub: AnnualSub, couponId: string): boolean {
  return (sub.discounts ?? []).some((d) => typeof d !== 'string' && d.coupon?.id === couponId);
}

export type BlockReason = 'not_active' | 'cancel_scheduled' | 'open_invoice' | 'already_annual' | 'too_small' | 'deadline_passed';

// 年払いの Checkout を出してはいけない人（runbook 9 章）。null なら出してよい
export function checkoutBlock(sub: AnnualSub, opts: { couponId: string; openInvoiceCount: number; monthly: number }): { reason: BlockReason; message: string } | null {
  if (sub.status !== 'active') return { reason: 'not_active', message: `定期契約が active ではありません（${sub.status}）。支払い遅れは支払いが戻るまで案内しない` };
  if (sub.cancel_at_period_end || sub.cancel_at) return { reason: 'cancel_scheduled', message: '解約予約が入っています。本人に確かめてから' };
  if (opts.openInvoiceCount > 0) return { reason: 'open_invoice', message: `未払いの請求書が ${opts.openInvoiceCount} 件あります` };
  if (hasAnnualCoupon(sub, opts.couponId)) return { reason: 'already_annual', message: 'すでに年払いのクーポンが付いています' };
  if (opts.monthly <= 1) return { reason: 'too_small', message: `月額が ${opts.monthly} 円のため対象外` };
  return null;
}

// Checkout の期限: 発行から 24 時間。締切（決算セールは 11/27 19:00 JST）があればそれを超えない。残り 30 分を切ったら出さない
export function checkoutExpiresAt(nowMs: number, deadlineIso?: string): number | null {
  const now = Math.floor(nowMs / 1000);
  let exp = now + CHECKOUT_TTL_SEC;
  if (deadlineIso) {
    const deadline = Math.floor(Date.parse(deadlineIso) / 1000);
    if (!Number.isFinite(deadline)) throw new Error(`bad deadline: ${deadlineIso}`);
    exp = Math.min(exp, deadline);
  }
  return exp - now < CHECKOUT_MIN_TTL_SEC ? null : exp;
}

export type AnnualPricing = { kind: 'sale' | 'standard'; priceMonths: number; expiresAt: number; replyAt: string | null };

// 年払い額の月数を決める（TB-3951）。「年払い」の最初の返信（無ければ今）が返信の締切より前で、決算セールの Checkout がまだ出せるなら × 10。
// それ以外は常設の × 11（期限は発行から 24 時間）
export function annualPricing(input: { nowMs: number; replyAt: string | null; saleReplyDeadlineIso: string; saleCheckoutDeadlineIso: string }): AnnualPricing {
  const replyDeadline = Date.parse(input.saleReplyDeadlineIso);
  if (!Number.isFinite(replyDeadline)) throw new Error(`bad sale reply deadline: ${input.saleReplyDeadlineIso}`);
  const basis = input.replyAt ? Date.parse(input.replyAt) : input.nowMs;
  if (basis < replyDeadline) {
    const exp = checkoutExpiresAt(input.nowMs, input.saleCheckoutDeadlineIso);
    if (exp) return { kind: 'sale', priceMonths: SALE_PRICE_MONTHS, expiresAt: exp, replyAt: input.replyAt };
  }
  return { kind: 'standard', priceMonths: STANDARD_PRICE_MONTHS, expiresAt: checkoutExpiresAt(input.nowMs)!, replyAt: input.replyAt };
}

// 「年払い」を含む本人の最初の返信の日時（messages_log の created_at・JST）
export async function firstAnnualReplyAt(db: D1Database, lineUserId: string): Promise<string | null> {
  const r = await db
    .prepare(
      `SELECT m.created_at FROM messages_log m JOIN friends f ON f.id = m.friend_id
       WHERE f.line_user_id = ? AND m.direction = 'incoming' AND m.message_type = 'text' AND m.content LIKE ?
       ORDER BY m.created_at ASC LIMIT 1`,
    )
    .bind(lineUserId, `%${ANNUAL_REPLY_KEYWORD}%`)
    .first<{ created_at: string }>();
  return r?.created_at ?? null;
}

// 月の足し算（Stripe の月次の更新と同じく、日が無い月は月末に寄せる）
export function addMonths(unixSec: number, n: number): number {
  const d = new Date(unixSec * 1000);
  const day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return Math.floor(t.getTime() / 1000);
}

const jstDate = (unixSec: number) => formatJstIso(unixSec * 1000).slice(0, 10).replace(/-/g, '/');

export function buildCheckoutParams(input: {
  annualPrepayId: string;
  customerId: string;
  subscriptionId: string;
  lineUserId: string;
  monthly: number;
  annual: number;
  priceMonths: number;
  taxRateId: string;
  expiresAt: number;
  periodEndSec: number;
  workerPublicUrl?: string;
}): Record<string, string> {
  const start = input.periodEndSec;
  const lastDay = addMonths(start, ANNUAL_MONTHS) - 24 * 3600;
  const sale = input.priceMonths === SALE_PRICE_MONTHS;
  const name = sale ? 'FurimAuto 年払いプラン（12か月・決算セール 2か月分無料）' : 'FurimAuto 年払いプラン（12か月）';
  const meta: Record<string, string> = {
    purchaseType: 'annual_prepay',
    annualPrepayId: input.annualPrepayId,
    lineUserId: input.lineUserId,
    subscriptionId: input.subscriptionId,
    monthlyExclTax: String(input.monthly),
    annualExclTax: String(input.annual),
    priceMonths: String(input.priceMonths),
  };
  const params: Record<string, string> = {
    mode: 'payment',
    customer: input.customerId,
    locale: 'ja',
    'payment_method_types[0]': 'card',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'jpy',
    'line_items[0][price_data][unit_amount]': String(input.annual),
    'line_items[0][price_data][tax_behavior]': 'exclusive',
    'line_items[0][price_data][product_data][name]': name,
    'line_items[0][tax_rates][0]': input.taxRateId,
    expires_at: String(input.expiresAt),
    success_url: `${input.workerPublicUrl ?? ''}/plan-builder/thanks`,
    'payment_intent_data[description]': `${name} ${input.subscriptionId}`,
    'custom_text[submit][message]':
      `12か月分を${input.priceMonths}か月分のお支払い（${sale ? '決算セール・2か月分無料' : '1か月分無料'}）。` +
      `期間: 次回の更新日（${jstDate(start)}）から12か月（${jstDate(lastDay)}まで）。お支払いは今回の1回だけで、期間中の月々のお支払いはありません。` +
      '途中解約・返金は原則できません。',
  };
  for (const [k, v] of Object.entries(meta)) {
    params[`metadata[${k}]`] = v;
    params[`payment_intent_data[metadata][${k}]`] = v;
  }
  return params;
}

// 付与の前の確かめ（入金・金額・契約の一致）。null なら付けてよい
export function applyBlock(input: {
  pi: { status?: string; amount?: number; amount_received?: number; customer?: string | null; metadata?: Record<string, string> };
  row: { line_user_id: string; subscription_id: string; stripe_customer_id: string; annual_excl_tax: number; price_months: number | null; amount_total: number | null } | null;
  lineUserId: string;
  sub: AnnualSub;
  quote: { annual: number; otherDiscounts: string[] };
}): { reason: string; message: string } | null {
  const { pi, row, sub, quote } = input;
  const m = pi.metadata ?? {};
  if (pi.status !== 'succeeded') return { reason: 'not_paid', message: `入金が確認できません（${pi.status}）` };
  if (m.purchaseType !== 'annual_prepay') return { reason: 'not_annual', message: '年払いの決済ではありません' };
  if (m.lineUserId !== input.lineUserId) return { reason: 'line_mismatch', message: '決済の lineUserId が違います' };
  if (!row) return { reason: 'no_record', message: '年払いの台帳に発行の記録がありません' };
  if (row.line_user_id !== input.lineUserId || row.subscription_id !== m.subscriptionId) return { reason: 'record_mismatch', message: '台帳と決済の契約が一致しません' };
  if (sub.id !== m.subscriptionId) return { reason: 'sub_mismatch', message: '決済の定期契約と今の定期契約が違います' };
  if (sub.customer !== pi.customer || sub.customer !== row.stripe_customer_id) return { reason: 'customer_mismatch', message: '決済の顧客と定期契約の顧客が違います' };
  if (Number(m.annualExclTax) !== row.annual_excl_tax) return { reason: 'amount_mismatch', message: '決済の金額（税抜）が台帳と違います' };
  if (m.priceMonths && row.price_months != null && Number(m.priceMonths) !== row.price_months) return { reason: 'amount_mismatch', message: '決済の月数（×10／×11）が台帳と違います' };
  if (row.amount_total != null && (pi.amount_received ?? pi.amount) !== row.amount_total) return { reason: 'amount_mismatch', message: `入金額 ${pi.amount_received ?? pi.amount} 円が Checkout の合計 ${row.amount_total} 円と違います` };
  if (quote.annual !== row.annual_excl_tax) return { reason: 'plan_changed', message: `発行後に月額が変わっています（今の年払い額 ${quote.annual} 円・入金の基準 ${row.annual_excl_tax} 円）` };
  if (sub.status !== 'active') return { reason: 'not_active', message: `定期契約が active ではありません（${sub.status}）` };
  if (sub.cancel_at_period_end || sub.cancel_at) return { reason: 'cancel_scheduled', message: '解約予約が入っています' };
  if (quote.otherDiscounts.length > 0) {
    // once 等が残ったまま付けると次の 0 円の請求で消えて価値がなくなる。次回の更新が終わってから付ける（runbook 9 章）
    return { reason: 'once_pending', message: `forever 以外の割引が残っています（${quote.otherDiscounts.join(',')}）。次回の更新の後に付ける` };
  }
  return null;
}

// 付けた後の確かめ: 年払いの割引の end が 12 回目の更新日より後・13 回目より前／前からの割引が全部残っている／次回請求 0 円
export function verifyApplied(input: {
  before: SubDiscount[];
  after: AnnualSub;
  couponId: string;
  periodEndSec: number;
  upcomingAmountDue: number;
}): { ok: boolean; problems: string[]; discount: SubDiscount | null } {
  const problems: string[] = [];
  const after = expandedDiscounts(input.after);
  const annual = after.find((d) => d.coupon?.id === input.couponId) ?? null;
  if (!annual) problems.push('年払いの割引が付いていない');
  else {
    const end = annual.end ?? 0;
    const twelfth = addMonths(input.periodEndSec, ANNUAL_MONTHS - 1);
    const thirteenth = addMonths(input.periodEndSec, ANNUAL_MONTHS);
    if (!(end > twelfth && end < thirteenth)) problems.push(`割引の end（${end}）が 12 回目（${twelfth}）と 13 回目（${thirteenth}）の更新の間にない`);
  }
  const afterIds = new Set(after.map((d) => d.id));
  const lost = input.before.filter((d) => !afterIds.has(d.id)).map((d) => d.coupon?.id ?? d.id);
  if (lost.length) problems.push(`前からの割引が消えた: ${lost.join(',')}`);
  if (input.upcomingAmountDue !== 0) problems.push(`次回請求の見込みが ${input.upcomingAmountDue} 円（0 円でない）`);
  return { ok: problems.length === 0, problems, discount: annual };
}

// ── Stripe・D1 を使う処理 ──────────────────────────

async function stripe(
  secretKey: string,
  path: string,
  params?: Record<string, string>,
  method: 'GET' | 'POST' = 'GET',
  opts: { version?: string; idempotencyKey?: string } = {},
): Promise<Record<string, unknown>> {
  const url = new URL(`https://api.stripe.com/v1/${path}`);
  const body = params ? new URLSearchParams(params) : undefined;
  if (method === 'GET' && body) url.search = body.toString();
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(opts.version ? { 'Stripe-Version': opts.version } : {}),
      ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: method === 'POST' ? body : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error as { message?: string } | undefined)?.message ?? res.status;
    throw new Error(`Stripe ${path}: ${err}`);
  }
  return json;
}

// 読み取りはアカウント既定の版（discount に coupon が埋め込まれる形）。書き込みだけ割引のスタックが扱える版
async function readSub(secretKey: string, subId: string): Promise<AnnualSub> {
  return (await stripe(secretKey, `subscriptions/${subId}`, { 'expand[0]': 'discounts', 'expand[1]': 'items.data.price.tiers' })) as unknown as AnnualSub;
}

async function resolveTaxRate(env: AnnualPrepayEnv, secretKey: string): Promise<string> {
  if (env.FURIM_ANNUAL_TAX_RATE_ID) return env.FURIM_ANNUAL_TAX_RATE_ID;
  const list = (await stripe(secretKey, 'tax_rates', { limit: '100', active: 'true' })) as unknown as { data: Array<{ id: string; percentage: number; inclusive: boolean }> };
  const found = list.data.find((t) => t.percentage === 10 && !t.inclusive);
  if (!found) throw new Error('10% 外税の tax_rate がありません（FURIM_ANNUAL_TAX_RATE_ID を設定する）');
  return found.id;
}

type CustomerRow = { stripe_customer_id: string | null; subscription_id: string | null };

async function resolveSubscription(db: D1Database, secretKey: string, lineUserId: string, subscriptionId?: string): Promise<{ customerId: string; sub: AnnualSub }> {
  const cust = await db.prepare('SELECT stripe_customer_id, subscription_id FROM furim_customers WHERE line_user_id = ?').bind(lineUserId).first<CustomerRow>();
  const customerId = cust?.stripe_customer_id ?? '';
  if (!customerId.startsWith('cus_')) throw new AnnualPrepayError('no_customer', '顧客マスターに Stripe 顧客 ID がありません');
  let subId = subscriptionId || cust?.subscription_id || '';
  if (!subId) {
    const list = (await stripe(secretKey, 'subscriptions', { customer: customerId, status: 'active', limit: '3' })) as unknown as { data: Array<{ id: string }> };
    if (list.data.length !== 1) throw new AnnualPrepayError('ambiguous_subscription', `active の定期契約が ${list.data.length} 本あります。subscriptionId を指定する`);
    subId = list.data[0].id;
  }
  const sub = await readSub(secretKey, subId);
  if (sub.customer !== customerId) throw new AnnualPrepayError('customer_mismatch', `定期契約 ${subId} は顧客 ${customerId} のものではありません`);
  return { customerId, sub };
}

export class AnnualPrepayError extends Error {
  constructor(public reason: string, message: string) {
    super(message);
  }
}

type PrepayRow = {
  id: string;
  line_user_id: string;
  stripe_customer_id: string;
  subscription_id: string;
  monthly_excl_tax: number;
  annual_excl_tax: number;
  price_months: number | null;
  reply_at: string | null;
  amount_total: number | null;
  checkout_session_id: string | null;
  checkout_url: string | null;
  expires_at: string | null;
  payment_intent_id: string | null;
  paid_at: string | null;
  apply_started_at: string | null;
  applied_at: string | null;
  discount_end_at: string | null;
  first_free_renewal_at: string | null;
  created_at: string;
  amount_paid?: number | null;
  apply_error?: string | null;
  tax_amount?: number | null;
  pay_mode?: string | null;
  charge_key?: string | null;
  charge_status?: string | null;
};

export type CheckoutResult =
  | { ok: true; reused: boolean; url: string; annualPrepayId: string; kind: 'sale' | 'standard'; priceMonths: number; replyAt: string | null; monthly: number; annual: number; amountTotal: number | null; expiresAt: string; subscriptionId: string; periodStart: string }
  | { ok: true; dryRun: true; kind: 'sale' | 'standard'; priceMonths: number; replyAt: string | null; monthly: number; annual: number; expiresAt: string; subscriptionId: string; periodStart: string; openCheckoutId: string | null }
  | { ok: false; reason: string; message: string };

// 1. 年払いの Checkout を発行する（runbook 7 章 1）
export async function createAnnualCheckout(
  db: D1Database,
  env: AnnualPrepayEnv,
  input: { lineUserId: string; subscriptionId?: string; createdBy?: string; nowMs?: number; dryRun?: boolean; quoted?: { kind: 'sale' | 'standard'; priceMonths: number; annual: number } },
): Promise<CheckoutResult> {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY not configured');
  const nowMs = input.nowMs ?? Date.now();
  const replyAt = await firstAnnualReplyAt(db, input.lineUserId);
  const saleCheckoutDeadlineIso = env.FURIM_ANNUAL_PREPAY_DEADLINE || DEFAULT_ANNUAL_DEADLINE;
  // ボタンの決済の代わり（TB-4346）: 案内した月数のまま出す。締切まで 30 分を切っていても ×10 は Stripe の下限の 31 分後まで払える
  const pricing: AnnualPricing = input.quoted
    ? {
        kind: input.quoted.kind, priceMonths: input.quoted.priceMonths, replyAt,
        expiresAt: input.quoted.kind === 'sale'
          ? checkoutExpiresAt(nowMs, saleCheckoutDeadlineIso) ?? Math.floor(nowMs / 1000) + CHECKOUT_MIN_TTL_SEC + 60
          : checkoutExpiresAt(nowMs)!,
      }
    : annualPricing({
        nowMs, replyAt, saleCheckoutDeadlineIso,
        saleReplyDeadlineIso: env.FURIM_ANNUAL_SALE_REPLY_DEADLINE || DEFAULT_SALE_REPLY_DEADLINE,
      });
  const { expiresAt, priceMonths } = pricing;

  let found: { customerId: string; sub: AnnualSub };
  try {
    found = await resolveSubscription(db, secretKey, input.lineUserId, input.subscriptionId);
  } catch (e) {
    if (e instanceof AnnualPrepayError) return { ok: false, reason: e.reason, message: e.message };
    throw e;
  }
  const { customerId, sub } = found;
  const couponId = annualCouponId(env);
  const quote = quoteSubscription(sub, priceMonths);
  if (input.quoted && input.quoted.annual !== quote.annual) {
    return { ok: false, reason: 'price_changed', message: `ご案内した金額（${input.quoted.annual.toLocaleString('ja-JP')}円）から変わっています` };
  }
  const invoices = (await stripe(secretKey, 'invoices', { subscription: sub.id, status: 'open', limit: '3' })) as unknown as { data: unknown[] };
  const block = checkoutBlock(sub, { couponId, openInvoiceCount: invoices.data.length, monthly: quote.monthly });
  if (block) return { ok: false, ...block };

  // 同じ定期契約で入金済みなら出さない。期限内の未払いのリンクがあればそれを返す（払えるリンクを 2 本にしない）
  const rows = (await db.prepare('SELECT * FROM furim_annual_prepay WHERE subscription_id = ? ORDER BY created_at DESC').bind(sub.id).all<PrepayRow>()).results ?? [];
  if (rows.some((r) => r.paid_at)) return { ok: false, reason: 'already_paid', message: 'この定期契約の年払いは入金済みです' };
  const open = rows.find((r) => r.expires_at && Date.parse(r.expires_at) - nowMs > CHECKOUT_MIN_TTL_SEC * 1000 && r.annual_excl_tax === quote.annual && r.checkout_url);
  // dryRun: 金額と期限だけ返す。Stripe にも D1 にも書かない（本番の読み取り確認用）
  if (input.dryRun) {
    return {
      ok: true, dryRun: true, kind: pricing.kind, priceMonths, replyAt: pricing.replyAt, monthly: quote.monthly, annual: quote.annual,
      expiresAt: formatJstIso(expiresAt * 1000), subscriptionId: sub.id, periodStart: formatJstIso(periodEnd(sub) * 1000), openCheckoutId: open?.id ?? null,
    };
  }
  // 金額の違う（× 10 → × 11 に変わった等）期限内の未払いリンクは先に失効させる。払えるリンクを 2 本にしない
  for (const r of rows.filter((r) => r !== open && r.checkout_session_id && r.expires_at && Date.parse(r.expires_at) > nowMs)) {
    try {
      await stripe(secretKey, `checkout/sessions/${r.checkout_session_id}/expire`, {}, 'POST');
    } catch (e) {
      const cur = (await stripe(secretKey, `checkout/sessions/${r.checkout_session_id}`)) as { status?: string };
      if (cur.status !== 'expired') {
        return { ok: false, reason: 'previous_checkout_open', message: `前に出した Checkout（${r.id}）を失効できません。入金済みでないか確かめる: ${String(e).slice(0, 200)}` };
      }
    }
    await db.prepare('UPDATE furim_annual_prepay SET expires_at = ? WHERE id = ?').bind(formatJstIso(nowMs), r.id).run();
  }

  const pe = periodEnd(sub);
  if (open) {
    return {
      ok: true, reused: true, url: open.checkout_url!, annualPrepayId: open.id, kind: pricing.kind, priceMonths, replyAt: pricing.replyAt, monthly: open.monthly_excl_tax, annual: open.annual_excl_tax,
      amountTotal: open.amount_total, expiresAt: open.expires_at!, subscriptionId: sub.id, periodStart: formatJstIso(pe * 1000),
    };
  }

  const annualPrepayId = `ap_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const taxRateId = await resolveTaxRate(env, secretKey);
  const params = buildCheckoutParams({
    annualPrepayId, customerId, subscriptionId: sub.id, lineUserId: input.lineUserId,
    monthly: quote.monthly, annual: quote.annual, priceMonths, taxRateId, expiresAt, periodEndSec: pe, workerPublicUrl: env.WORKER_PUBLIC_URL,
  });
  const session = (await stripe(secretKey, 'checkout/sessions', params, 'POST', { idempotencyKey: `annual-checkout-${annualPrepayId}` })) as unknown as { id: string; url: string; amount_total?: number };
  const expiresIso = formatJstIso(expiresAt * 1000);
  await db
    .prepare(
      `INSERT INTO furim_annual_prepay (id, line_user_id, stripe_customer_id, subscription_id, monthly_excl_tax, annual_excl_tax, price_months, reply_at, amount_total,
         checkout_session_id, checkout_url, expires_at, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(annualPrepayId, input.lineUserId, customerId, sub.id, quote.monthly, quote.annual, priceMonths, pricing.replyAt, session.amount_total ?? null, session.id, session.url, expiresIso, jstNow(), input.createdBy ?? null)
    .run();
  return {
    ok: true, reused: false, url: session.url, annualPrepayId, kind: pricing.kind, priceMonths, replyAt: pricing.replyAt, monthly: quote.monthly, annual: quote.annual,
    amountTotal: session.amount_total ?? null, expiresAt: expiresIso, subscriptionId: sub.id, periodStart: formatJstIso(pe * 1000),
  };
}

export type ApplyResult =
  | { ok: true; alreadyApplied: boolean; subscriptionId: string; discountId: string | null; discountEndAt: string | null; firstFreeRenewalAt: string | null; upcomingAmountDue?: number }
  | { ok: false; reason: string; message: string; problems?: string[] };

// 2. 入金を確かめてから年払いクーポンを足す（runbook 7 章 2）。同じ PaymentIntent で 2 回付けない
export async function applyAnnualCoupon(
  db: D1Database,
  env: AnnualPrepayEnv,
  input: { lineUserId: string; paymentIntentId: string },
): Promise<ApplyResult> {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY not configured');
  const couponId = annualCouponId(env);
  const pi = (await stripe(secretKey, `payment_intents/${input.paymentIntentId}`)) as unknown as {
    id: string; status?: string; amount?: number; amount_received?: number; customer?: string | null; metadata?: Record<string, string>;
  };
  const rowId = pi.metadata?.annualPrepayId ?? '';
  let row = rowId ? await db.prepare('SELECT * FROM furim_annual_prepay WHERE id = ?').bind(rowId).first<PrepayRow>() : null;
  if (row?.applied_at) {
    return { ok: true, alreadyApplied: true, subscriptionId: row.subscription_id, discountId: null, discountEndAt: row.discount_end_at, firstFreeRenewalAt: row.first_free_renewal_at };
  }
  if (row?.payment_intent_id && row.payment_intent_id !== pi.id) return { ok: false, reason: 'record_mismatch', message: `台帳の決済（${row.payment_intent_id}）と違います` };

  const sub = await readSub(secretKey, pi.metadata?.subscriptionId ?? '');
  // 台帳の月数で比べる（092 だけの行・metadata の無い古い Checkout は × 10）
  const quote = quoteSubscription(sub, row?.price_months ?? (Number(pi.metadata?.priceMonths) || SALE_PRICE_MONTHS));
  // 年払いのクーポンが付いていたら、付与の途中で落ちた（Stripe は付いた・台帳は未記録）とみなし、確かめ直しだけ行う
  const already = hasAnnualCoupon(sub, couponId);
  if (!already) {
    const block = applyBlock({ pi, row, lineUserId: input.lineUserId, sub, quote });
    if (block) return { ok: false, ...block };
  } else if (!row || pi.metadata?.lineUserId !== input.lineUserId) {
    return { ok: false, reason: 'record_mismatch', message: '年払いのクーポンは付いていますが、台帳か lineUserId が一致しません' };
  }
  row = row!;

  // 取り合いを止める（同じ入金で 2 本同時に走らせない）。webhook がまだなら入金の記録もここで埋める
  const claim = await db
    .prepare(
      `UPDATE furim_annual_prepay SET apply_started_at = ?, payment_intent_id = COALESCE(payment_intent_id, ?), amount_paid = COALESCE(amount_paid, ?), paid_at = COALESCE(paid_at, ?)
       WHERE id = ? AND applied_at IS NULL AND (apply_started_at IS NULL OR apply_started_at < ?)`,
    )
    .bind(jstNow(), pi.id, pi.amount_received ?? pi.amount ?? null, jstNow(), row.id, formatJstIso(Date.now() - 10 * 60_000))
    .run();
  if ((claim.meta?.changes ?? 0) === 0) return { ok: false, reason: 'in_progress', message: '同じ入金の付与が進行中です。10 分おいてやり直す' };

  const before = expandedDiscounts(sub);
  const pe = periodEnd(sub);
  try {
    if (!already) {
      const params: Record<string, string> = {};
      before.forEach((d, i) => {
        params[`discounts[${i}][discount]`] = d.id;
      });
      params[`discounts[${before.length}][coupon]`] = couponId;
      await stripe(secretKey, `subscriptions/${sub.id}`, params, 'POST', { version: STACK_VERSION, idempotencyKey: `annual-apply-${pi.id}` });
    }
    const after = await readSub(secretKey, sub.id);
    const upcoming = (await stripe(secretKey, 'invoices/upcoming', { customer: sub.customer, subscription: sub.id })) as unknown as { amount_due?: number };
    const v = verifyApplied({
      before: before.filter((d) => d.coupon?.id !== couponId),
      after, couponId, periodEndSec: pe, upcomingAmountDue: upcoming.amount_due ?? -1,
    });
    const endAt = v.discount?.end ? formatJstIso(v.discount.end * 1000) : null;
    const firstFree = formatJstIso(pe * 1000);
    if (!v.ok) {
      await db.prepare('UPDATE furim_annual_prepay SET apply_error = ?, discount_id = ?, discount_end_at = ? WHERE id = ?').bind(v.problems.join(' / ').slice(0, 500), v.discount?.id ?? null, endAt, row.id).run();
      return { ok: false, reason: 'verify_failed', message: '付与後の確かめで食い違いがありました（Stripe の定期契約を読み取りで確かめる）', problems: v.problems };
    }
    await db
      .prepare('UPDATE furim_annual_prepay SET applied_at = ?, discount_id = ?, discount_end_at = ?, first_free_renewal_at = ?, apply_error = NULL WHERE id = ?')
      .bind(jstNow(), v.discount?.id ?? null, endAt, firstFree, row.id)
      .run();
    return { ok: true, alreadyApplied: already, subscriptionId: sub.id, discountId: v.discount?.id ?? null, discountEndAt: endAt, firstFreeRenewalAt: firstFree, upcomingAmountDue: upcoming.amount_due };
  } catch (e) {
    await db.prepare('UPDATE furim_annual_prepay SET apply_started_at = NULL, apply_error = ? WHERE id = ?').bind(String(e).slice(0, 500), row.id).run();
    throw e;
  }
}

// 3. webhook: payment_intent.succeeded の年払いを台帳に記録し、スタッフに知らせる（付与はしない）
export async function recordAnnualPayment(
  db: D1Database,
  env: AnnualPrepayEnv,
  input: { eventId: string; paymentIntentId: string; amount: number; customer: string | null; metadata: Record<string, string> },
): Promise<{ recorded: boolean }> {
  const m = input.metadata;
  const id = m.annualPrepayId || `pi:${input.paymentIntentId}`;
  const now = jstNow();
  // 発行の記録がある行を入金済みにする。無ければ（API を通さず作った Checkout）metadata から 1 行起こす
  const upd = await db
    .prepare('UPDATE furim_annual_prepay SET payment_intent_id = ?, amount_paid = ?, paid_at = ?, stripe_event_id = ? WHERE id = ? AND paid_at IS NULL')
    .bind(input.paymentIntentId, input.amount, now, input.eventId, id)
    .run();
  let recorded = (upd.meta?.changes ?? 0) > 0;
  if (!recorded) {
    const ins = await db
      .prepare(
        `INSERT OR IGNORE INTO furim_annual_prepay (id, line_user_id, stripe_customer_id, subscription_id, monthly_excl_tax, annual_excl_tax, price_months, created_at,
           payment_intent_id, amount_paid, paid_at, stripe_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, m.lineUserId ?? '', input.customer ?? '', m.subscriptionId ?? '', Number(m.monthlyExclTax ?? 0), Number(m.annualExclTax ?? 0), m.priceMonths ? Number(m.priceMonths) : null, now, input.paymentIntentId, input.amount, now, input.eventId)
      .run();
    recorded = (ins.meta?.changes ?? 0) > 0;
  }
  // ボタンでの決済（TB-3963）は chargeAnnualPrepay が付与と知らせまで行う。ここでは記録だけ
  if (recorded && m.payMode !== 'one_click') {
    const friend = m.lineUserId
      ? await db.prepare('SELECT display_name FROM friends WHERE line_user_id = ?').bind(m.lineUserId).first<{ display_name: string | null }>()
      : null;
    const body = [
      `${friend?.display_name ?? '(名前不明)'}　${input.amount.toLocaleString('ja-JP')}円（税込）`,
      `月額 ${Number(m.monthlyExclTax ?? 0).toLocaleString('ja-JP')}円 → 年払い ${Number(m.annualExclTax ?? 0).toLocaleString('ja-JP')}円（税抜・月額×${m.priceMonths ?? SALE_PRICE_MONTHS}${m.priceMonths === String(STANDARD_PRICE_MONTHS) ? ' 常設' : ' 決算セール'}）`,
      `line: ${m.lineUserId ?? ''}`,
      `sub: ${m.subscriptionId ?? ''}`,
      `pi: ${input.paymentIntentId}`,
      'クーポンはまだ付けていません（くろさんの確認カードの後に apply）',
    ].join('\n');
    await notifyStaff(db, env.LINE_CHANNEL_ACCESS_TOKEN ? new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN) : null, env, {
      title: '年払いの入金がありました',
      body,
      lineText: `💴 年払いの入金がありました\n${body}`,
    }, 'annual-prepay');
  }
  return { recorded };
}

// 年払いクーポンを作る（全員共通の 1 枚・冪等）。既定は dryRun。live で作るのはくろさんの OK の後
export async function ensureAnnualCoupon(env: AnnualPrepayEnv, dryRun: boolean): Promise<{ status: 'existing' | 'would-create' | 'created'; coupon?: Record<string, unknown> }> {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY not configured');
  const id = annualCouponId(env);
  try {
    const existing = await stripe(secretKey, `coupons/${id}`);
    const ok = existing.percent_off === 100 && existing.duration === 'repeating' && existing.duration_in_months === ANNUAL_MONTHS;
    if (!ok) throw new Error(`coupon ${id} exists with unexpected shape: ${JSON.stringify({ percent_off: existing.percent_off, duration: existing.duration, months: existing.duration_in_months })}`);
    return { status: 'existing', coupon: existing };
  } catch (e) {
    if (!String(e).includes('No such coupon')) throw e;
  }
  if (dryRun) return { status: 'would-create' };
  const coupon = await stripe(secretKey, 'coupons', {
    id,
    percent_off: '100',
    duration: 'repeating',
    duration_in_months: String(ANNUAL_MONTHS),
    name: '年払い（12か月分お支払い済み）',
    'metadata[purpose]': 'annual_prepay',
  }, 'POST', { idempotencyKey: `annual-coupon-${id}` });
  return { status: 'created', coupon };
}

// ── ボタン 1 つで決済（TB-3963） ──────────────────────────
// 金額の案内 → 「この内容で申し込む」→ 定期契約の既定のカードで PaymentIntent（off_session・confirm）→ 成功したら applyAnnualCoupon まで続けて行う。
// 二重の決済は D1 の charge_key（定期契約＋期間の始まり）の UNIQUE で止める。3D セキュア・カード不可・既定のカードなしは決済せず Checkout のリンクを返す

export const TAX_PERCENT = 10;

export type CustomerAction = 'none' | 'open_checkout' | 'staff_contact';

export type AnnualQuote = {
  kind: 'sale' | 'standard';
  priceMonths: number;
  monthly: number;
  annual: number;
  tax: number;
  total: number;
  periodStart: string;
  periodLastDay: string;
  // LINE の返事（annual-prepay-line.ts・TB-3964）が読む形: 期間の始まりと最終日（JST の ISO）
  startAt: string;
  endAt: string;
  subscriptionId: string;
};

export type QuoteResult = ({ ok: true; payWith: 'card' | 'checkout' } & AnnualQuote) | { ok: false; reason: string; message: string; customerAction: CustomerAction };

export type ChargeResult =
  | ({ ok: true; status: 'succeeded' | 'paid_apply_pending'; charged: true; applied: boolean; alreadyCharged: false; annualPrepayId: string; paymentIntentId: string; message?: string } & AnnualQuote)
  | ({ ok: true; dryRun: true; payWith: 'card' | 'checkout' } & AnnualQuote)
  | { ok: false; reason: string; message: string; customerAction: CustomerAction; checkoutUrl?: string; quote?: AnnualQuote };

export function taxOf(annual: number): number {
  return Math.round((annual * TAX_PERCENT) / 100);
}

// 決済の月数: 「年払い」の最初の返信（無ければ今）が返信の締切より前で、今がお支払いの締切より前なら × 10。それ以外は × 11
export function chargePricing(input: { nowMs: number; replyAt: string | null; saleReplyDeadlineIso: string; saleDeadlineIso: string }): { kind: 'sale' | 'standard'; priceMonths: number } {
  const replyDeadline = Date.parse(input.saleReplyDeadlineIso);
  const saleDeadline = Date.parse(input.saleDeadlineIso);
  if (!Number.isFinite(replyDeadline) || !Number.isFinite(saleDeadline)) throw new Error('bad sale deadline');
  const basis = input.replyAt ? Date.parse(input.replyAt) : input.nowMs;
  return basis < replyDeadline && input.nowMs < saleDeadline
    ? { kind: 'sale', priceMonths: SALE_PRICE_MONTHS }
    : { kind: 'standard', priceMonths: STANDARD_PRICE_MONTHS };
}

const refId = (v: string | { id: string } | null | undefined) => (typeof v === 'string' ? v : v?.id) || null;

// 月々の請求と同じ順で既定のカードを選ぶ（定期契約の既定 → 顧客の請求書の既定 → 古い source）
export function pickPaymentMethod(sub: AnnualSub, customer: { invoice_settings?: { default_payment_method?: string | { id: string } | null }; default_source?: string | { id: string } | null }): string | null {
  return refId(sub.default_payment_method) ?? refId(customer.invoice_settings?.default_payment_method) ?? refId(sub.default_source) ?? refId(customer.default_source);
}

export function staffContactFor(reason: string): boolean {
  return ['not_active', 'cancel_scheduled', 'open_invoice', 'too_small', 'once_pending', 'no_customer', 'ambiguous_subscription', 'customer_mismatch', 'previous_checkout_open', 'charge_unknown'].includes(reason);
}

const fail = (reason: string, message: string, extra: { checkoutUrl?: string; quote?: AnnualQuote } = {}) => ({
  ok: false as const, reason, message, customerAction: (extra.checkoutUrl ? 'open_checkout' : staffContactFor(reason) ? 'staff_contact' : 'none') as CustomerAction, ...extra,
});

type ChargeContext = { customerId: string; sub: AnnualSub; quote: AnnualQuote; paymentMethod: string | null; rows: PrepayRow[]; periodEndSec: number };

async function prepareCharge(
  db: D1Database,
  env: AnnualPrepayEnv,
  secretKey: string,
  input: { lineUserId: string; subscriptionId?: string; nowMs: number },
): Promise<ChargeContext | { ok: false; reason: string; message: string; customerAction: CustomerAction }> {
  const pricing = chargePricing({
    nowMs: input.nowMs,
    replyAt: await firstAnnualReplyAt(db, input.lineUserId),
    saleReplyDeadlineIso: env.FURIM_ANNUAL_SALE_REPLY_DEADLINE || DEFAULT_SALE_REPLY_DEADLINE,
    saleDeadlineIso: env.FURIM_ANNUAL_PREPAY_DEADLINE || DEFAULT_ANNUAL_DEADLINE,
  });
  let found: { customerId: string; sub: AnnualSub };
  try {
    found = await resolveSubscription(db, secretKey, input.lineUserId, input.subscriptionId);
  } catch (e) {
    if (e instanceof AnnualPrepayError) return fail(e.reason, e.message);
    throw e;
  }
  const { customerId, sub } = found;
  const q = quoteSubscription(sub, pricing.priceMonths);
  const invoices = (await stripe(secretKey, 'invoices', { subscription: sub.id, status: 'open', limit: '3' })) as unknown as { data: unknown[] };
  const block = checkoutBlock(sub, { couponId: annualCouponId(env), openInvoiceCount: invoices.data.length, monthly: q.monthly });
  if (block) return fail(block.reason, block.message);
  // once・repeating の割引が残っていると、付けた年払いクーポンが次の 0 円の請求で消える（applyBlock の once_pending）。決済の前に止める
  if (q.otherDiscounts.length > 0) return fail('once_pending', `forever 以外の割引が残っています（${q.otherDiscounts.join(',')}）`);
  const rows = (await db.prepare('SELECT * FROM furim_annual_prepay WHERE subscription_id = ? ORDER BY created_at DESC').bind(sub.id).all<PrepayRow>()).results ?? [];
  if (rows.some((r) => r.paid_at)) return fail('already_paid', 'この定期契約の年払いはお支払い済みです');
  const customer = (await stripe(secretKey, `customers/${customerId}`)) as { invoice_settings?: { default_payment_method?: string | null }; default_source?: string | null };
  const pe = periodEnd(sub);
  const tax = taxOf(q.annual);
  return {
    customerId, sub, rows, periodEndSec: pe,
    paymentMethod: pickPaymentMethod(sub, customer),
    quote: {
      kind: pricing.kind, priceMonths: pricing.priceMonths, monthly: q.monthly, annual: q.annual, tax, total: q.annual + tax,
      periodStart: jstDate(pe), periodLastDay: jstDate(addMonths(pe, ANNUAL_MONTHS) - 24 * 3600),
      startAt: formatJstIso(pe * 1000), endAt: formatJstIso((addMonths(pe, ANNUAL_MONTHS) - 24 * 3600) * 1000), subscriptionId: sub.id,
    },
  };
}

// 金額の案内（Flex 用）。Stripe にも D1 にも書かない
export async function quoteAnnualCharge(db: D1Database, env: AnnualPrepayEnv, input: { lineUserId: string; subscriptionId?: string; nowMs?: number }): Promise<QuoteResult> {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY not configured');
  const ctx = await prepareCharge(db, env, secretKey, { ...input, nowMs: input.nowMs ?? Date.now() });
  if ('ok' in ctx) return ctx;
  return { ok: true, payWith: ctx.paymentMethod ? 'card' : 'checkout', ...ctx.quote };
}

async function stripeRaw(secretKey: string, path: string, params: Record<string, string>, idempotencyKey: string): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Idempotency-Key': idempotencyKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return { ok: res.ok, json: (await res.json()) as Record<string, unknown> };
}

export function buildChargeParams(input: { annualPrepayId: string; customerId: string; paymentMethod: string; lineUserId: string; quote: AnnualQuote }): Record<string, string> {
  const q = input.quote;
  const name = q.priceMonths === SALE_PRICE_MONTHS ? 'FurimAuto 年払いプラン（12か月・決算セール 2か月分無料）' : 'FurimAuto 年払いプラン（12か月）';
  const params: Record<string, string> = {
    amount: String(q.total),
    currency: 'jpy',
    customer: input.customerId,
    payment_method: input.paymentMethod,
    // 既定の支払い方法が Link の人もいる（TB-4346）
    'payment_method_types[0]': 'card',
    'payment_method_types[1]': 'link',
    off_session: 'true',
    confirm: 'true',
    description: `${name} ${q.periodStart}〜${q.periodLastDay} ${q.subscriptionId}`,
  };
  const meta: Record<string, string> = {
    purchaseType: 'annual_prepay',
    payMode: 'one_click',
    annualPrepayId: input.annualPrepayId,
    lineUserId: input.lineUserId,
    subscriptionId: q.subscriptionId,
    monthlyExclTax: String(q.monthly),
    annualExclTax: String(q.annual),
    taxAmount: String(q.tax),
    priceMonths: String(q.priceMonths),
    periodStart: q.periodStart,
    periodLastDay: q.periodLastDay,
  };
  for (const [k, v] of Object.entries(meta)) params[`metadata[${k}]`] = v;
  return params;
}

async function notifyCharge(db: D1Database, env: AnnualPrepayEnv, title: string, lines: string[]): Promise<void> {
  try {
    const body = lines.join('\n');
    await notifyStaff(db, env.LINE_CHANNEL_ACCESS_TOKEN ? new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN) : null, env, { title, body, lineText: `💴 ${title}\n${body}` }, 'annual-prepay');
  } catch (e) {
    console.error('[annual-prepay/charge] notify failed:', e);
  }
}

// 失敗のときの逃げ道: 今の Checkout のリンク（出せなければ担当から連絡）
async function fallbackCheckout(db: D1Database, env: AnnualPrepayEnv, input: { lineUserId: string; subscriptionId: string; nowMs: number }, reason: string, message: string, quote: AnnualQuote): Promise<ChargeResult> {
  const co = await createAnnualCheckout(db, env, { lineUserId: input.lineUserId, subscriptionId: input.subscriptionId, createdBy: 'one-click-fallback', nowMs: input.nowMs,
    quoted: { kind: quote.kind, priceMonths: quote.priceMonths, annual: quote.annual } });
  if (co.ok && 'url' in co) return fail(reason, message, { checkoutUrl: co.url, quote });
  return fail(co.ok ? reason : co.reason, co.ok ? message : `${message}／Checkout も出せません: ${co.message}`, { quote });
}

export async function chargeAnnualPrepay(
  db: D1Database,
  env: AnnualPrepayEnv,
  input: { lineUserId: string; expectedAnnual?: number; subscriptionId?: string; nowMs?: number; dryRun?: boolean },
): Promise<ChargeResult> {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY not configured');
  const nowMs = input.nowMs ?? Date.now();
  const ctx = await prepareCharge(db, env, secretKey, { lineUserId: input.lineUserId, subscriptionId: input.subscriptionId, nowMs });
  if ('ok' in ctx) return ctx;
  const { customerId, sub, quote, paymentMethod, rows } = ctx;
  if (input.dryRun) return { ok: true, dryRun: true, payWith: paymentMethod ? 'card' : 'checkout', ...quote };
  // 案内に出した額と違えば決済しない（× 10 の締切をまたいだ・プランが変わった）
  if (input.expectedAnnual != null && input.expectedAnnual !== quote.annual) {
    return fail('price_changed', `ご案内した金額（${input.expectedAnnual.toLocaleString('ja-JP')}円）から変わっています`, { quote });
  }
  const chargeKey = `${sub.id}:${ctx.periodEndSec}`;
  const holding = rows.find((r) => r.charge_key === chargeKey);
  if (holding) return fail('in_progress', 'お手続き中です');
  if (!paymentMethod) return fallbackCheckout(db, env, { lineUserId: input.lineUserId, subscriptionId: sub.id, nowMs }, 'no_payment_method', '登録済みのカードが見つかりません', quote);

  // 期限内の未払いの Checkout は先に失効させる（ボタンの決済のあとにリンクでも払えてしまうのを止める）
  for (const r of rows.filter((r) => r.checkout_session_id && r.expires_at && Date.parse(r.expires_at) > nowMs)) {
    try {
      await stripe(secretKey, `checkout/sessions/${r.checkout_session_id}/expire`, {}, 'POST');
    } catch (e) {
      const cur = (await stripe(secretKey, `checkout/sessions/${r.checkout_session_id}`)) as { status?: string };
      if (cur.status !== 'expired') return fail('previous_checkout_open', `前に出した Checkout（${r.id}）を失効できません: ${String(e).slice(0, 200)}`);
    }
    await db.prepare('UPDATE furim_annual_prepay SET expires_at = ? WHERE id = ?').bind(formatJstIso(nowMs), r.id).run();
  }

  const annualPrepayId = `ap_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  try {
    await db
      .prepare(
        `INSERT INTO furim_annual_prepay (id, line_user_id, stripe_customer_id, subscription_id, monthly_excl_tax, annual_excl_tax, price_months, reply_at, amount_total,
           tax_amount, pay_mode, charge_key, charge_status, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'one_click', ?, 'processing', ?, 'line-button')`,
      )
      .bind(annualPrepayId, input.lineUserId, customerId, sub.id, quote.monthly, quote.annual, quote.priceMonths, await firstAnnualReplyAt(db, input.lineUserId), quote.total, quote.tax, chargeKey, jstNow())
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return fail('in_progress', 'お手続き中です');
    throw e;
  }

  const params = buildChargeParams({ annualPrepayId, customerId, paymentMethod, lineUserId: input.lineUserId, quote });
  let res: { ok: boolean; json: Record<string, unknown> };
  try {
    res = await stripeRaw(secretKey, 'payment_intents', params, `annual-charge-${annualPrepayId}`);
  } catch (e) {
    // 届いたか分からない。charge_key は持ったまま（2 回目を弾く）にして担当が Stripe を読み取りで確かめる
    await db.prepare("UPDATE furim_annual_prepay SET charge_status = 'unknown', charge_error = ? WHERE id = ?").bind(String(e).slice(0, 500), annualPrepayId).run();
    await notifyCharge(db, env, '年払いのボタン決済の結果が分かりません', [`line: ${input.lineUserId}`, `sub: ${sub.id}`, `ap: ${annualPrepayId}`, String(e).slice(0, 200)]);
    return fail('charge_unknown', '決済の結果を確かめています');
  }
  const err = res.json.error as { code?: string; decline_code?: string; message?: string; payment_intent?: { id: string; status?: string } } | undefined;
  const pi = (res.ok ? res.json : err?.payment_intent) as { id: string; status?: string } | undefined;

  if (res.ok && pi?.status === 'succeeded') {
    await db.prepare("UPDATE furim_annual_prepay SET charge_status = 'succeeded', payment_intent_id = ? WHERE id = ?").bind(pi.id, annualPrepayId).run();
    let applied: ApplyResult;
    try {
      applied = await applyAnnualCoupon(db, env, { lineUserId: input.lineUserId, paymentIntentId: pi.id });
    } catch (e) {
      applied = { ok: false, reason: 'apply_error', message: String(e).slice(0, 300) };
    }
    const friend = await db.prepare('SELECT display_name FROM friends WHERE line_user_id = ?').bind(input.lineUserId).first<{ display_name: string | null }>();
    const head = [
      `${friend?.display_name ?? '(名前不明)'}　${quote.total.toLocaleString('ja-JP')}円（税込）`,
      `月額 ${quote.monthly.toLocaleString('ja-JP')}円 → 年払い ${quote.annual.toLocaleString('ja-JP')}円（税抜・月額×${quote.priceMonths}${quote.kind === 'sale' ? ' 決算セール' : ' 常設'}）`,
      `期間 ${quote.periodStart}〜${quote.periodLastDay}`,
      `line: ${input.lineUserId}`, `sub: ${sub.id}`, `pi: ${pi.id}`,
    ];
    if (applied.ok) {
      await notifyCharge(db, env, '年払いのボタン決済が完了しました', [...head, 'クーポン付与・次回 0 円の確認まで済み']);
      return { ok: true, status: 'succeeded', charged: true, applied: true, alreadyCharged: false, annualPrepayId, paymentIntentId: pi.id, ...quote };
    }
    await notifyCharge(db, env, '【要確認】年払いの入金はあり・クーポンの付与が済んでいません', [...head, `${applied.reason}: ${applied.message}`, ...(applied.problems ?? [])]);
    return { ok: true, status: 'paid_apply_pending', charged: true, applied: false, alreadyCharged: false, annualPrepayId, paymentIntentId: pi.id, message: applied.message, ...quote };
  }

  // 本人確認（3D セキュア）・カード不可: 決済を取り消して charge_key を外し、Checkout のリンクを返す
  if (pi?.id && pi.status !== 'canceled') {
    try {
      await stripe(secretKey, `payment_intents/${pi.id}/cancel`, {}, 'POST');
    } catch (e) {
      console.error('[annual-prepay/charge] cancel failed:', pi.id, e);
    }
  }
  const reason = pi?.status === 'requires_action' || err?.code === 'authentication_required' ? 'authentication_required' : 'card_failed';
  const detail = err ? `${err.code ?? ''} ${err.decline_code ?? ''} ${err.message ?? ''}`.trim() : `status=${pi?.status ?? '?'}`;
  await db
    .prepare("UPDATE furim_annual_prepay SET charge_status = ?, charge_key = NULL, charge_error = ?, payment_intent_id = ? WHERE id = ?")
    .bind(reason, detail.slice(0, 500), pi?.id ?? null, annualPrepayId)
    .run();
  return fallbackCheckout(db, env, { lineUserId: input.lineUserId, subscriptionId: sub.id, nowMs }, reason,
    reason === 'authentication_required' ? 'カード会社の本人確認が必要です' : '登録済みのカードで決済できませんでした', quote);
}

// その日（JST）の年払いの申込の一覧（21:00 の報告用）。ボタンの決済と Checkout の両方
export type DailyRow = { name: string; lineUserId: string; mode: string; monthly: number; annual: number; total: number | null; priceMonths: number | null; periodStart: string | null; result: string; createdAt: string };

export async function annualDailyReport(db: D1Database, dateJst: string): Promise<DailyRow[]> {
  const rows = (await db
    .prepare(
      `SELECT a.*, f.display_name FROM furim_annual_prepay a LEFT JOIN friends f ON f.line_user_id = a.line_user_id
       WHERE substr(a.created_at, 1, 10) = ? OR substr(a.paid_at, 1, 10) = ? ORDER BY a.created_at`,
    )
    .bind(dateJst, dateJst)
    .all<PrepayRow & { display_name: string | null }>()).results ?? [];
  return rows.map((r) => ({
    name: r.display_name ?? '(名前不明)',
    lineUserId: r.line_user_id,
    mode: r.pay_mode === 'one_click' ? 'ボタン' : 'Checkout',
    monthly: r.monthly_excl_tax,
    annual: r.annual_excl_tax,
    total: r.amount_paid ?? r.amount_total,
    priceMonths: r.price_months,
    periodStart: r.first_free_renewal_at,
    result: r.applied_at ? '完了（クーポン付与済み）' : r.paid_at ? `入金あり・付与まだ${r.apply_error ? `（${r.apply_error.slice(0, 80)}）` : ''}` : r.charge_status && r.charge_status !== 'processing' ? `決済できず（${r.charge_status}）` : r.pay_mode === 'one_click' ? '処理中' : 'リンク発行のみ',
    createdAt: r.created_at,
  }));
}

// 入金あり・付与まだ（日付を問わない）。21:00 の報告と突き合わせで毎回出す（TB-4045）
export type PendingRow = { id: string; name: string; lineUserId: string; subscriptionId: string; paymentIntentId: string | null; paidAt: string | null; applyError: string | null };

export async function annualPendingApply(db: D1Database): Promise<PendingRow[]> {
  const rows = (await db
    .prepare(
      `SELECT a.*, f.display_name FROM furim_annual_prepay a LEFT JOIN friends f ON f.line_user_id = a.line_user_id
       WHERE a.applied_at IS NULL AND (a.paid_at IS NOT NULL OR a.charge_status IN ('succeeded', 'unknown')) ORDER BY a.created_at`,
    )
    .all<PrepayRow & { display_name: string | null }>()).results ?? [];
  return rows.map((r) => ({
    id: r.id, name: r.display_name ?? '(名前不明)', lineUserId: r.line_user_id, subscriptionId: r.subscription_id,
    paymentIntentId: r.payment_intent_id, paidAt: r.paid_at, applyError: r.apply_error ?? (r.charge_status === 'unknown' ? 'charge_unknown' : null),
  }));
}

// Stripe の入金（PaymentIntent・purchaseType=annual_prepay・succeeded）と D1 の台帳を突き合わせる（TB-4045）。読み取りだけ
export type ReconcileResult = {
  ok: boolean;
  since: string;
  coupon: { status: string; error?: string };
  stripe: { succeeded: number; amount: number };
  d1: { paid: number; applied: number };
  pending: PendingRow[];
  missingInD1: Array<{ paymentIntentId: string; lineUserId: string; subscriptionId: string; amount: number; createdAt: string; d1: 'no_row' | 'not_paid' }>;
  notInStripe: Array<{ id: string; paymentIntentId: string | null; lineUserId: string }>;
};

type SearchPi = { id: string; amount_received?: number; amount?: number; created: number; status?: string; metadata?: Record<string, string> };

export async function reconcileAnnualPrepay(db: D1Database, env: AnnualPrepayEnv, input: { sinceIso: string }): Promise<ReconcileResult> {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY not configured');
  const sinceSec = Math.floor(Date.parse(input.sinceIso) / 1000);
  if (!Number.isFinite(sinceSec)) throw new Error(`bad since: ${input.sinceIso}`);

  let coupon: ReconcileResult['coupon'];
  try {
    coupon = { status: (await ensureAnnualCoupon(env, true)).status };
  } catch (e) {
    coupon = { status: 'error', error: String(e).slice(0, 300) };
  }

  const pis: SearchPi[] = [];
  let page: string | undefined;
  for (let i = 0; i < 20; i++) {
    const params: Record<string, string> = { query: `metadata['purchaseType']:'annual_prepay' AND status:'succeeded' AND created>=${sinceSec}`, limit: '100' };
    if (page) params.page = page;
    const res = (await stripe(secretKey, 'payment_intents/search', params)) as unknown as { data: SearchPi[]; has_more?: boolean; next_page?: string | null };
    pis.push(...res.data.filter((p) => p.status === 'succeeded'));
    if (!res.has_more || !res.next_page) break;
    page = res.next_page;
  }

  const rows = (await db.prepare('SELECT * FROM furim_annual_prepay WHERE paid_at IS NOT NULL OR payment_intent_id IS NOT NULL').all<PrepayRow>()).results ?? [];
  const byPi = new Map(rows.filter((r) => r.payment_intent_id).map((r) => [r.payment_intent_id!, r]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missingInD1: ReconcileResult['missingInD1'] = [];
  for (const p of pis) {
    const r = byPi.get(p.id) ?? (p.metadata?.annualPrepayId ? byId.get(p.metadata.annualPrepayId) : undefined);
    if (r?.paid_at || (r && r.charge_status === 'succeeded')) continue;
    missingInD1.push({
      paymentIntentId: p.id, lineUserId: p.metadata?.lineUserId ?? '', subscriptionId: p.metadata?.subscriptionId ?? '',
      amount: p.amount_received ?? p.amount ?? 0, createdAt: formatJstIso(p.created * 1000), d1: r ? 'not_paid' : 'no_row',
    });
  }
  const stripeIds = new Set(pis.map((p) => p.id));
  const sinceMs = sinceSec * 1000;
  const paidRows = rows.filter((r) => r.paid_at && Date.parse(r.paid_at) >= sinceMs);
  const notInStripe = paidRows.filter((r) => !r.payment_intent_id || !stripeIds.has(r.payment_intent_id)).map((r) => ({ id: r.id, paymentIntentId: r.payment_intent_id, lineUserId: r.line_user_id }));
  const pending = await annualPendingApply(db);

  return {
    ok: coupon.status === 'existing' && pending.length === 0 && missingInD1.length === 0 && notInStripe.length === 0,
    since: formatJstIso(sinceMs),
    coupon,
    stripe: { succeeded: pis.length, amount: pis.reduce((t, p) => t + (p.amount_received ?? p.amount ?? 0), 0) },
    d1: { paid: paidRows.length, applied: paidRows.filter((r) => r.applied_at).length },
    pending,
    missingInD1,
    notInStripe,
  };
}
