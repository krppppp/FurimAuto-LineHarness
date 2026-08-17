import { Hono } from 'hono';
import type { Context } from 'hono';
import { gasGet } from '../furim/gas-client.js';
import type { Env } from '../index.js';

// 機能マスタ・パッケージマスタ（Google Sheets）を単一ソースとする
// プラン選択UI＋料金シミュレーター＋Checkout発行。
// LP(lp0)のシミュレーターと同じUX・デザイントーン（#f27d0c基調）で、
// lp0/ambassadorはiframe(?embed=1)、LINEはLIFF(?liff=1&liffId=...)で共通利用する。

type Feature = {
  feature_key: string;
  service: string;
  site: string;
  display_name: string;
  description: string;
  value_type: string;
  billing_type: string;
  monthly_price: number | string;
  stripe_price_id: string;
  requires: string;
  excludes: string;
  ui_group: string;
  sort_order: number;
  active: string | boolean;
};

type Pkg = {
  package_key: string;
  site: string;
  plan_type: 'full' | 'semi' | 'basic';
  display_name: string;
  monthly_price: number | string;
  combo_discount: number | string;
  stripe_price_id: string;
  features: string;
  sort_order: number;
  active: string | boolean;
};

type Master = { features: Feature[]; packages: Pkg[] };

// Stripe AutoMultiChannel price（tiers_mode=graduated）のtier2 unit_amountと一致させること。
// tier1（〜2サイト flat）は機能マスタのmonthly_priceが正。
const MULTI_CHANNEL_EXTRA_SITE_PRICE = 1980;
const MULTI_CHANNEL_SITES = ['メルカリ', 'ラクマ', 'Shops', 'ヤフオク', 'ヤフフリ'];
const TAX_RATE_PERCENT = 10;
const MASTER_CACHE_SECONDS = 300;

const SITE_NAMES: Record<string, string> = {
  mercari: 'メルカリ',
  mercariShops: 'メルカリShops',
  rakuma: 'ラクマ',
  yahooFlea: 'ヤフフリ',
};

const planBuilder = new Hono<Env>();

// webhook側（plan-apply）からも使うため、Contextに依存しないenvベース実装
export async function fetchMasterByEnv(gasDeployId: string | undefined): Promise<Master> {
  const cache = caches.default;
  const cacheKey = new Request('https://line-harness.internal/__cache/plan-builder-master');
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  if (!gasDeployId) throw new Error('GAS_DEPLOY_ID is not configured');
  const data = (await gasGet(gasDeployId, { method: 'getFeatureMaster' })) as {
    success: boolean;
    features: Feature[];
    packages: Pkg[];
  };
  if (!data?.success || !Array.isArray(data.features)) {
    throw new Error(`getFeatureMaster failed: ${JSON.stringify(data).slice(0, 200)}`);
  }
  const master: Master = { features: data.features, packages: data.packages ?? [] };

  await cache.put(
    cacheKey,
    new Response(JSON.stringify(master), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${MASTER_CACHE_SECONDS}` },
    }),
  );
  return master;
}

async function fetchMaster(c: Context<Env>): Promise<Master> {
  return fetchMasterByEnv(c.env.GAS_DEPLOY_ID);
}

// 複数discountスタック（併用割引+キャンペーンクーポン等）はこのバージョン以降でのみ操作可能。
// アカウント既定は旧版のまま・スタック操作の呼び出しだけ明示ピン留めする（7/9の教訓: 形が変わる）。
// 注意: 新版でサブスクを「作成」するとbilling_mode=flexibleになり旧版APIと非互換になるため、
// このバージョン指定は既存サブスクの読み取り・更新にのみ使うこと
export const STRIPE_STACK_VERSION = '2026-05-27.dahlia';

export async function stripeCall(
  secretKey: string,
  path: string,
  params?: Record<string, string>,
  method: 'GET' | 'POST' | 'DELETE' = 'POST',
  version?: string,
): Promise<Record<string, unknown>> {
  const url = new URL(`https://api.stripe.com/v1/${path}`);
  const body = params ? new URLSearchParams(params) : undefined;
  if (method === 'GET' && body) {
    url.search = body.toString();
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(version ? { 'Stripe-Version': version } : {}),
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

// 10%外税のtax_rateを取得（なければ作成）
async function ensureTaxRate(secretKey: string): Promise<string> {
  const list = (await stripeCall(secretKey, 'tax_rates', { limit: '100', active: 'true' }, 'GET')) as {
    data: Array<{ id: string; percentage: number; inclusive: boolean }>;
  };
  const found = list.data.find((t) => t.percentage === TAX_RATE_PERCENT && !t.inclusive);
  if (found) return found.id;
  const created = await stripeCall(secretKey, 'tax_rates', {
    display_name: '消費税',
    percentage: String(TAX_RATE_PERCENT),
    inclusive: 'false',
    country: 'JP',
  });
  return created.id as string;
}

// 併用割引クーポン（-1500×全自動数 -480×半自動数）。金額ごとに決定的なIDで再利用する
export async function ensureComboCoupon(secretKey: string, nFull: number, nSemi: number): Promise<string | null> {
  const amount = 1500 * nFull + 480 * nSemi;
  if (amount <= 0) return null;
  const id = `combo-f${nFull}-s${nSemi}`;
  try {
    const existing = await stripeCall(secretKey, `coupons/${id}`, undefined, 'GET');
    if (existing.valid) return id;
  } catch {
    // not found → create
  }
  await stripeCall(secretKey, 'coupons', {
    id,
    amount_off: String(amount),
    currency: 'jpy',
    duration: 'forever',
    name: `複数サイト併用割引（全自動×${nFull}・半自動×${nSemi}）`,
  });
  return id;
}

// 顧客レベルのクーポン（「Furimanです」キーワードで付与される旧来フロー）を確認する。
// クーポンの付与はキーワード（actionFurimanCoupon）だけが行う。plan-builder側は
// 「既に付いているか」を見るだけ（LIFFバナー表示と、checkoutでcombo割引に潰されない制御に使う）
async function getCustomerCoupon(
  secretKey: string,
  gasDeployId: string,
  lineUserId: string,
): Promise<{ exists: boolean; customerId?: string; couponName?: string; percent?: number | null }> {
  try {
    const r = (await gasGet(gasDeployId, { method: 'getStripeIDwithLINEID', lineUserId })) as {
      customer_stripe_id?: string | null;
    };
    if (!r?.customer_stripe_id) return { exists: false };
    const cust = (await stripeCall(secretKey, `customers/${r.customer_stripe_id}`, undefined, 'GET')) as {
      discount?: { coupon?: { name?: string; percent_off?: number | null } };
    };
    const cp = cust?.discount?.coupon;
    if (cp) return { exists: true, customerId: r.customer_stripe_id, couponName: cp.name ?? 'クーポン', percent: cp.percent_off ?? null };
    return { exists: false, customerId: r.customer_stripe_id };
  } catch (e) {
    console.log('plan-builder: customer coupon check skipped', e);
    return { exists: false };
  }
}

// LIFF/外部からのJSON取得用（/api/配下はauthMiddleware、拡張子付きパスはASSETSに
// 取られるため、拡張子なしの公開パスに置く）
planBuilder.get('/plan-builder/features', async (c) => {
  try {
    const master = await fetchMaster(c);
    return c.json({ success: true, ...master });
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 502);
  }
});

// 顧客に付与済みのクーポン確認（LIFF UIのバナー表示用。付与は「Furimanです」キーワードで）
planBuilder.get('/plan-builder/coupon-status', async (c) => {
  const lineUserId = c.req.query('lineUserId') ?? '';
  if (!lineUserId || !c.env.GAS_DEPLOY_ID || !c.env.STRIPE_SECRET_KEY) return c.json({ success: true, eligible: false });
  const s = await getCustomerCoupon(c.env.STRIPE_SECRET_KEY, c.env.GAS_DEPLOY_ID, lineUserId);
  return c.json({ success: true, eligible: s.exists, couponName: s.couponName ?? null, percent: s.percent ?? null });
});

export type PlanSelectionInput = {
  packages?: string[];
  features?: string[];
  multiChannelSites?: string[];
  lineUserId?: string;
  // Checkoutリンクの有効期限（秒）。Stripeの許容範囲1800〜86400にクランプ。省略時は12時間
  expiresInSeconds?: number;
};

export type PlanCheckoutEnv = {
  STRIPE_SECRET_KEY?: string;
  GAS_DEPLOY_ID?: string;
  WORKER_PUBLIC_URL?: string;
};

// 選択内容を検証して価格情報つきで展開する（checkout / intent 共用）
export async function resolvePlanSelection(gasDeployId: string | undefined, body: PlanSelectionInput) {
  const master = await fetchMasterByEnv(gasDeployId);
  const pkgByKey = Object.fromEntries(master.packages.map((p) => [p.package_key, p]));
  const featByKey = Object.fromEntries(master.features.map((f) => [f.feature_key, f]));

  const pkgs = (body.packages ?? []).map((k) => {
    if (!pkgByKey[k]) throw new Error(`unknown package: ${k}`);
    return pkgByKey[k];
  });
  const feats = (body.features ?? []).map((k) => {
    const f = featByKey[k];
    if (!f) throw new Error(`unknown feature: ${k}`);
    if (f.billing_type !== 'subscription') throw new Error(`not subscribable: ${k}`);
    return f;
  });
  if (pkgs.length === 0 && feats.length === 0) throw new Error('nothing selected');

  const mcSites = (body.multiChannelSites ?? []).filter((s) => MULTI_CHANNEL_SITES.includes(s));
  if (feats.some((f) => f.feature_key === 'AutoMultiChannel') && mcSites.length === 0) {
    throw new Error('multiChannelSites required for AutoMultiChannel');
  }

  const nFull = pkgs.filter((p) => p.plan_type === 'full').length;
  const nSemi = pkgs.filter((p) => p.plan_type === 'semi').length;
  const comboAmount = pkgs.length >= 2 ? 1500 * nFull + 480 * nSemi : 0;

  // 税抜小計（AutoMultiChannelはtier計算）
  let subtotal = 0;
  for (const p of pkgs) subtotal += Number(p.monthly_price);
  for (const f of feats) {
    if (f.feature_key === 'AutoMultiChannel') {
      subtotal += Number(f.monthly_price) + Math.max(0, mcSites.length - 2) * MULTI_CHANNEL_EXTRA_SITE_PRICE;
    } else {
      subtotal += Number(f.monthly_price);
    }
  }
  const total = subtotal - comboAmount;

  // トーク・Flexに載せる選択内容サマリ。
  // 機能のdisplay_nameはサイト名を含まない（値段変更 等）ため、複数サイト選択時に
  // 同名機能が重複して見える（2026-08-18 くろさん指摘）。【サイト名】見出しで
  // グルーピングして、どのサイトの機能かを一目で分かるようにする
  const grouped: Record<string, string[]> = {};
  const ungrouped: string[] = [];
  const pushLine = (site: string, line: string) => {
    if (SITE_NAMES[site]) (grouped[site] ??= []).push(line);
    else ungrouped.push(line); // premium/trial(site=all)・サイト横断機能は見出しなし
  };
  for (const p of pkgs) pushLine(p.site, `・${p.display_name}`);
  for (const f of feats) {
    if (f.feature_key === 'AutoMultiChannel') ungrouped.push(`・${f.display_name}（${mcSites.length}サイト巡回）`);
    else pushLine(f.site, `・${f.display_name}`);
  }
  const summaryLines: string[] = [];
  for (const siteId of Object.keys(SITE_NAMES)) {
    if (grouped[siteId]?.length) summaryLines.push(`【${SITE_NAMES[siteId]}】`, ...grouped[siteId]);
  }
  summaryLines.push(...ungrouped);
  if (comboAmount > 0) summaryLines.push(`・複数サイト併用割引 -${comboAmount.toLocaleString('ja-JP')}円`);

  return { pkgs, feats, mcSites, nFull, nSemi, comboAmount, subtotal, total, summaryLines };
}

// Stripe Checkout Session を発行する（ルート / webhook(plan-apply) 共用）。
// リンクは12時間で失効させる（LINEで案内する注意書きと揃える。2026-08-18に1時間→12時間へ変更）
export async function createPlanBuilderCheckout(env: PlanCheckoutEnv, body: PlanSelectionInput): Promise<{ url: string; total: number; summaryLines: string[] }> {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY not configured');
  const sel = await resolvePlanSelection(env.GAS_DEPLOY_ID, body);
  const { pkgs, feats, mcSites, nFull, nSemi } = sel;

  const params: Record<string, string> = {
    mode: 'subscription',
    success_url: `${env.WORKER_PUBLIC_URL}/plan-builder/thanks`,
    cancel_url: `${env.WORKER_PUBLIC_URL}/plan-builder`,
    expires_at: String(Math.floor(Date.now() / 1000) + Math.min(Math.max(Math.floor(body.expiresInSeconds ?? 43200), 1800), 86400)),
  };
  let i = 0;
  for (const p of pkgs) {
    params[`line_items[${i}][price]`] = p.stripe_price_id;
    params[`line_items[${i}][quantity]`] = '1';
    i++;
  }
  for (const f of feats) {
    params[`line_items[${i}][price]`] = f.stripe_price_id;
    params[`line_items[${i}][quantity]`] = f.feature_key === 'AutoMultiChannel' ? String(mcSites.length) : '1';
    i++;
  }

  const taxRate = await ensureTaxRate(secretKey);
  params['subscription_data[default_tax_rates][0]'] = taxRate;

  if (pkgs.length >= 2) {
    const coupon = await ensureComboCoupon(secretKey, nFull, nSemi);
    if (coupon) params['discounts[0][coupon]'] = coupon;
  }

  params['subscription_data[metadata][source]'] = 'plan-builder';
  params['subscription_data[metadata][packages]'] = pkgs.map((p) => p.package_key).join(',');
  params['subscription_data[metadata][features]'] = feats.map((f) => f.feature_key).join(',');
  if (mcSites.length > 0) params['subscription_data[metadata][multiChannelSites]'] = mcSites.join('/');
  if (body.lineUserId) {
    params['subscription_data[metadata][lineUserId]'] = body.lineUserId;
    // 既存Stripe顧客の紐付け + 顧客レベルクーポン（「Furimanです」で付与済み）の保護。
    // Checkoutにdiscountsを渡すとsubscription discountが顧客クーポンより優先され、
    // せっかくの50%/20%が一度も適用されなくなる。顧客クーポンと併用割引(combo)が両方ある場合は
    // 「初月=併用割引後価格の◯%OFF」となる合算onceクーポンを都度作成して渡し（旧システムと同額）、
    // comboはmetadataに退避して初回invoice後にwebhookがsubscriptionへ後付けする（2ヶ月目〜）。
    // 合算クーポンと顧客クーポンは初回invoice後にwebhookが削除する（一覧を汚さない・二重適用防止）
    if (env.GAS_DEPLOY_ID) {
      const cc = await getCustomerCoupon(secretKey, env.GAS_DEPLOY_ID, body.lineUserId);
      if (cc.customerId) params['customer'] = cc.customerId;
      const comboCouponId = params['discounts[0][coupon]'];
      if (cc.exists && comboCouponId) {
        params['subscription_data[metadata][pendingComboCoupon]'] = comboCouponId;
        delete params['discounts[0][coupon]'];
        if (cc.percent) {
          const amountOff = Math.round((sel.subtotal * cc.percent) / 100 + sel.comboAmount * (1 - cc.percent / 100));
          const mergedId = `fm${cc.percent}x${amountOff}-${crypto.randomUUID().slice(0, 6)}`;
          try {
            await stripeCall(secretKey, 'coupons', {
              id: mergedId,
              amount_off: String(amountOff),
              currency: 'jpy',
              duration: 'once',
              name: `初月適用: ${cc.percent}%OFF+併用割引`,
            });
            params['discounts[0][coupon]'] = mergedId;
            params['subscription_data[metadata][mergedCouponId]'] = mergedId;
            params['subscription_data[metadata][consumedCustomerCoupon]'] = '1';
          } catch (e) {
            // 作成失敗時は従来どおり: 初月=顧客クーポンのみ、comboは2ヶ月目〜
            console.error('plan-builder: merged coupon create failed, fallback to customer coupon only', e);
          }
        }
        // percentが無い（金額型の顧客クーポン）場合は合算せず: 初月=顧客クーポン、comboは2ヶ月目〜
      }
    }
  }

  const session = await stripeCall(secretKey, 'checkout/sessions', params);
  return { url: String(session.url), total: sel.total, summaryLines: sel.summaryLines };
}

// 選択内容からStripe Checkout Session URLを発行する（LP埋め込み等の直接利用・LIFFのフォールバック用）
planBuilder.post('/plan-builder/checkout', async (c) => {
  try {
    const body = (await c.req.json()) as PlanSelectionInput;
    const result = await createPlanBuilderCheckout(c.env, body);
    return c.json({ success: true, url: result.url });
  } catch (e) {
    console.error('plan-builder checkout error:', e);
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// lineUserIdからアクティブなStripeサブスクを引く（プラン変更フロー用）。
// スプシでStripe顧客IDを逆引き→activeサブスクの先頭を返す。無ければnull
export async function getActiveSubscriptionForLine(
  env: { GAS_DEPLOY_ID?: string; STRIPE_SECRET_KEY?: string },
  lineUserId: string,
): Promise<{ customerId: string; sub: Record<string, unknown> } | null> {
  if (!env.GAS_DEPLOY_ID || !env.STRIPE_SECRET_KEY) return null;
  try {
    const { gasGet } = await import('../furim/gas-client.js');
    const r = (await gasGet(env.GAS_DEPLOY_ID, { method: 'getStripeIDwithLINEID', lineUserId })) as { customer_stripe_id?: string };
    const customerId = r?.customer_stripe_id ?? '';
    if (!customerId || !customerId.startsWith('cus_')) return null;
    const list = (await stripeCall(env.STRIPE_SECRET_KEY, 'subscriptions', { customer: customerId, status: 'active', limit: '3' }, 'GET')) as unknown as { data: Array<Record<string, unknown>> };
    const sub = list.data?.[0];
    return sub ? { customerId, sub } : null;
  } catch (e) {
    console.error('[plan-builder] getActiveSubscriptionForLine failed:', e);
    return null;
  }
}

// サブスクの全discount（スタック対応）を読み取る。
// 旧版のsub.discount（単数）はスタック中undefinedになるため、割引の読み取りは必ずこちらを使う。
// ※読み取りは旧版（Discountにcouponが埋め込まれる形）。新版(dahlia)はsource.coupon=ID参照に
//   変わっておりcoupon詳細に追加フェッチが要るため使わない。新版を使うのは書き込みのみ
export async function getSubDiscounts(
  secretKey: string,
  subId: string,
): Promise<Array<{ discountId: string; couponId: string; name: string; amountOff: number; percentOff: number | null; duration: string }>> {
  const sub = (await stripeCall(secretKey, `subscriptions/${subId}`, { 'expand[]': 'discounts' }, 'GET')) as unknown as {
    discounts?: Array<{ id: string; coupon?: { id: string; name?: string; amount_off?: number; percent_off?: number; duration?: string } }>;
  };
  return (sub.discounts ?? []).map((d) => ({
    discountId: d.id,
    couponId: d.coupon?.id ?? '',
    name: d.coupon?.name ?? '',
    amountOff: d.coupon?.amount_off ?? 0,
    percentOff: d.coupon?.percent_off ?? null,
    duration: d.coupon?.duration ?? '',
  }));
}

// 現在の契約構成を返す（LIFF初期表示用）。移行済み・PB加入者はmetadataから構成を復元できる
planBuilder.get('/plan-builder/current', async (c) => {
  const lineUserId = c.req.query('lineUserId') ?? '';
  if (!lineUserId) return c.json({ success: false, error: 'lineUserId required' }, 400);
  const found = await getActiveSubscriptionForLine(c.env, lineUserId);
  if (!found) return c.json({ success: true, hasSubscription: false });
  const m = (found.sub.metadata ?? {}) as Record<string, string>;
  return c.json({
    success: true,
    hasSubscription: true,
    isPlanBuilder: m.source === 'plan-builder',
    packages: m.packages ? m.packages.split(',').filter(Boolean) : [],
    features: m.features ? m.features.split(',').filter(Boolean) : [],
    multiChannelSites: m.multiChannelSites ? m.multiChannelSites.split('/').filter(Boolean) : [],
  });
});

// プラン変更時の差額（日割り）をStripeのupcoming invoiceプレビューで確定額として取得する
export async function previewPlanChange(
  secretKey: string,
  sub: Record<string, unknown>,
  newItems: Array<{ price: string; quantity: number }>,
  prorationDate: number,
  // 変更後に効くdiscount一式（実更新と同じ指定にすることでプレビュー=実請求が一致する）。
  // スタック中のサブスクにcoupon=は使えないため必ずdiscounts配列で渡す
  discountsSpec?: Array<{ coupon?: string; discount?: string }>,
): Promise<{ amountDueNow: number }> {
  const params: Record<string, string> = {
    customer: String(sub.customer),
    subscription: String(sub.id),
    subscription_proration_behavior: 'always_invoice',
    subscription_proration_date: String(prorationDate),
  };
  if (discountsSpec && discountsSpec.length > 0) {
    discountsSpec.forEach((d, i) => {
      if (d.coupon) params[`discounts[${i}][coupon]`] = d.coupon;
      else if (d.discount) params[`discounts[${i}][discount]`] = d.discount;
    });
  } else if (discountsSpec) {
    params['discounts'] = ''; // 明示的に全割引なしでプレビュー
  }
  const items = (sub as { items: { data: Array<{ id: string }> } }).items.data;
  items.forEach((it, i) => {
    params[`subscription_items[${i}][id]`] = it.id;
    params[`subscription_items[${i}][deleted]`] = 'true';
  });
  newItems.forEach((it, i) => {
    const idx = items.length + i;
    params[`subscription_items[${idx}][price]`] = it.price;
    params[`subscription_items[${idx}][quantity]`] = String(it.quantity);
  });
  const upcoming = (await stripeCall(secretKey, 'invoices/upcoming', params, 'GET')) as unknown as { amount_due: number };
  return { amountDueNow: Math.max(0, upcoming.amount_due ?? 0) };
}

// 選択内容→Stripeのitems配列（migrate/変更共用のロジックと同等）
export function buildItemsFromSelection(sel: Awaited<ReturnType<typeof resolvePlanSelection>>): Array<{ price: string; quantity: number }> {
  const items: Array<{ price: string; quantity: number }> = [];
  for (const p of sel.pkgs) {
    if (!p.stripe_price_id) throw new Error(`package price missing: ${p.package_key}`);
    items.push({ price: String(p.stripe_price_id), quantity: 1 });
  }
  for (const f of sel.feats) {
    if (!f.stripe_price_id) throw new Error(`feature price missing: ${f.feature_key}`);
    const qty = f.feature_key === 'AutoMultiChannel' ? Math.max(1, sel.mcSites.length) : 1;
    items.push({ price: String(f.stripe_price_id), quantity: qty });
  }
  return items;
}

// LIFFの申込ボタン: 選択内容を保存して申込コードを発行する。
// LIFF側が liff.sendMessages でコード入りメッセージをトークに送信し、
// webhook（【プラン申し込み】）がコードからCheckoutリンクを返信する。
// →「どのプランで申込ボタンを押したか」がトークとこのテーブルに残る（行動データ）
// 既存契約者の場合は新規Checkoutではなく【プラン変更】（既存サブスクのin-place更新・差額日割り決済）になる
planBuilder.post('/plan-builder/intent', async (c) => {
  try {
    const body = (await c.req.json()) as PlanSelectionInput;
    if (!body.lineUserId) return c.json({ success: false, error: 'lineUserId required' }, 400);
    const sel = await resolvePlanSelection(c.env.GAS_DEPLOY_ID, body);

    // 既存アクティブサブスクがあれば「プラン変更」intent（二重課金の防止）
    const existing = await getActiveSubscriptionForLine(c.env, body.lineUserId);
    const code = 'PB-' + crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();

    if (existing && c.env.STRIPE_SECRET_KEY) {
      const m = (existing.sub.metadata ?? {}) as Record<string, string>;
      const same =
        m.source === 'plan-builder' &&
        (m.packages ?? '') === (body.packages ?? []).join(',') &&
        (m.features ?? '') === (body.features ?? []).join(',') &&
        (m.multiChannelSites ?? '') === (body.multiChannelSites ?? []).join('/');
      if (same) return c.json({ success: false, error: '現在ご契約中のプランと同じ内容です' }, 400);

      // 現在の月額（税抜）: items合計 − 毎月割引(forever)の合計。新月額と比較してアップ/ダウングレード判定
      // ※discount単数読みはスタック中undefinedになるためgetSubDiscountsを使う。once保留分は月額に含めない
      const subObj = existing.sub as {
        id: string;
        current_period_end: number;
        items: { data: Array<{ price: { unit_amount?: number }; quantity?: number }> };
      };
      const curDiscounts = await getSubDiscounts(c.env.STRIPE_SECRET_KEY, subObj.id);
      const foreverOff = curDiscounts.filter((d) => d.duration === 'forever').reduce((t, d) => t + d.amountOff, 0);
      const currentTotal =
        subObj.items.data.reduce((t, i) => t + (i.price.unit_amount ?? 0) * (i.quantity ?? 1), 0) - foreverOff;
      const kind = sel.total < currentTotal ? 'downgrade' : 'upgrade';

      const newItems = buildItemsFromSelection(sel);
      const prorationDate = Math.floor(Date.now() / 1000);
      // ダウングレードは決済なし・次回更新日切替のため差額プレビュー不要
      let preview = { amountDueNow: 0 };
      if (kind === 'upgrade') {
        // 実更新(plan-change.ts)と同じdiscount構成でプレビューする: 非comboのforever保持 + 新combo
        // （once系は差額invoiceに効かせず変更後に付け直すため、プレビューにも含めない）
        const comboCouponId = sel.comboAmount > 0 ? await ensureComboCoupon(c.env.STRIPE_SECRET_KEY, sel.nFull, sel.nSemi) : undefined;
        const discountsSpec: Array<{ coupon?: string; discount?: string }> = curDiscounts
          .filter((d) => !d.couponId.startsWith('combo-') && d.duration === 'forever')
          .map((d) => ({ discount: d.discountId }));
        if (comboCouponId) discountsSpec.push({ coupon: comboCouponId });
        preview = await previewPlanChange(c.env.STRIPE_SECRET_KEY, existing.sub, newItems, prorationDate, discountsSpec);
      }
      const effectiveDate = subObj.current_period_end;
      const effectiveDateText = new Date(effectiveDate * 1000 + 9 * 3600000).toISOString().slice(5, 10).replace('-', '/');

      await c.env.DB.prepare(
        'INSERT INTO plan_builder_intents (id, line_user_id, payload, created_at) VALUES (?, ?, ?, ?)',
      ).bind(
        code,
        body.lineUserId,
        JSON.stringify({
          type: 'change',
          kind,
          subscriptionId: existing.sub.id,
          prorationDate,
          amountDueNow: preview.amountDueNow,
          effectiveDate,
          packages: body.packages ?? [],
          features: body.features ?? [],
          multiChannelSites: body.multiChannelSites ?? [],
          total: sel.total,
        }),
        new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19),
      ).run();

      const message = [
        `【プラン変更】${code}`,
        '────────────',
        ...sel.summaryLines,
        '────────────',
        `新しい月額合計 ${sel.total.toLocaleString('ja-JP')}円（税抜）`,
        kind === 'upgrade'
          ? `本日のお支払い ${preview.amountDueNow.toLocaleString('ja-JP')}円（残り期間の日割り差額・税込）`
          : `本日のお支払いなし（次回更新日 ${effectiveDateText} から新プランに切り替わります）`,
      ].join('\n');

      return c.json({
        success: true,
        code,
        message,
        change: { kind, amountDueNow: preview.amountDueNow, nextTotal: sel.total, effectiveDateText },
      });
    }

    await c.env.DB.prepare(
      'INSERT INTO plan_builder_intents (id, line_user_id, payload, created_at) VALUES (?, ?, ?, ?)',
    ).bind(
      code,
      body.lineUserId,
      JSON.stringify({ packages: body.packages ?? [], features: body.features ?? [], multiChannelSites: body.multiChannelSites ?? [], total: sel.total }),
      new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19),
    ).run();

    const message = [
      `【プラン申し込み】${code}`,
      '────────────',
      ...sel.summaryLines,
      '────────────',
      `月額合計 ${sel.total.toLocaleString('ja-JP')}円（税抜）`,
    ].join('\n');

    return c.json({ success: true, code, message });
  } catch (e) {
    console.error('plan-builder intent error:', e);
    return c.json({ success: false, error: String(e) }, 500);
  }
});

planBuilder.get('/plan-builder/thanks', (c) =>
  c.html(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>お申し込みありがとうございます — FurimAuto</title></head>
<body style="font-family:'游ゴシック',YuGothic,'ヒラギノ角ゴ Pro',Meiryo,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa;">
<div style="text-align:center;padding:32px;background:#fff;border:2px solid #f27d0c;border-radius:8px;max-width:400px;">
<p style="font-size:2rem;margin:0 0 8px;">🎉</p>
<h1 style="font-size:1.2rem;color:#333;margin:0 0 12px;">お申し込みありがとうございます</h1>
<p style="font-size:.9rem;color:#666;margin:0;">決済が確認でき次第、LINEにキーコード発行のご案内が届きます。このページは閉じて大丈夫です。</p>
</div></body></html>`),
);

planBuilder.get('/plan-builder', async (c) => {
  let master: Master;
  try {
    master = await fetchMaster(c);
  } catch (e) {
    console.error('plan-builder: master fetch failed', e);
    return c.html(
      '<!DOCTYPE html><html lang="ja"><body style="font-family:sans-serif;padding:2rem;">料金情報の取得に失敗しました。時間をおいて再度お試しください。</body></html>',
      502,
    );
  }

  const embed = c.req.query('embed') === '1';
  const liff = c.req.query('liff') === '1';
  const liffId = c.req.query('liffId') ?? '';

  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>料金シミュレーション — FurimAuto</title>
${liff ? '<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>' : ''}
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "游ゴシック", YuGothic, "ヒラギノ角ゴ Pro", "Hiragino Kaku Gothic Pro", "メイリオ", Meiryo, sans-serif;
    background: ${embed ? 'transparent' : '#fafafa'};
    color: #333;
    line-height: 1.6;
  }
  .simulator { max-width: 760px; margin: 0 auto; padding: 24px 16px 40px; }
  .liff-logo { text-align: center; padding: 4px 0 14px; }
  .liff-logo img { height: 42px; width: auto; }
  .coupon-banner { background: linear-gradient(135deg, #fff3e0, #ffe0b2); border: 1px solid #f27d0c; color: #b35c00; border-radius: 8px; padding: 10px 12px; font-size: .85rem; font-weight: bold; margin-bottom: 10px; }
  .sim-title { font-size: 1.25rem; color: #333; margin-bottom: 8px; }
  .sim-lead { font-size: 1.1rem; font-weight: bold; color: #333; line-height: 1.7; margin-bottom: 6px; }
  .sim-tax-note { font-size: .78rem; color: #999; text-align: right; margin-bottom: 16px; }
  .sp-only { display: none; }
  @media (max-width: 600px) { .sp-only { display: inline; } }
  .sim-label { font-weight: bold; margin-bottom: 12px; font-size: .95rem; }
  .svc-head {
    display: flex; align-items: center; gap: 10px; margin: 28px 0 14px;
    padding-bottom: 8px; border-bottom: 2px solid #ff8c03;
  }
  .svc-head:first-of-type { margin-top: 8px; }
  .svc-num {
    flex-shrink: 0; font-size: .85rem; font-weight: bold; color: #fff; background: #ff8c03;
    border-radius: 4px; padding: 2px 8px; letter-spacing: .05em;
  }
  /* LPのサービス配色に合わせる: 01=橙 02=赤 03=青 */
  .svc-head--02 { border-bottom-color: #ff4757; }
  .svc-head--02 .svc-num { background: #ff4757; }
  .svc-head--03 { border-bottom-color: #3498db; }
  .svc-head--03 .svc-num { background: #3498db; }
  .svc-name { font-size: 1.05rem; font-weight: bold; color: #333; }
  .copy-note {
    padding: 14px 16px; background: #fff; border-radius: 6px; border: 1px solid #e8e8e8;
    font-size: .88rem; color: #555; margin-bottom: 14px;
  }
  .formula .svc-label { font-weight: bold; color: #f27d0c; }
  .formula .svc-label:not(:first-child) { margin-top: 10px; }
  .formula .svc-subtotal { font-weight: bold; border-top: 1px dashed #ddd; margin-top: 2px; }
  .premium-banner {
    margin: 4px 0 20px; padding: 18px 20px; border-radius: 10px;
    background: linear-gradient(135deg, #f27d0c, #f9b233); color: #fff;
    box-shadow: 0 3px 10px rgba(242,125,12,.35);
  }
  .premium-banner .pb-title { font-size: 1.05rem; font-weight: bold; margin-bottom: 6px; }
  .premium-banner ul { list-style: none; font-size: .88rem; margin-bottom: 12px; }
  .premium-banner li { padding-left: 1.3em; text-indent: -1.3em; }
  .premium-banner li::before { content: '✓ '; font-weight: bold; }
  .premium-banner .pb-cta {
    padding: 10px 24px; font-size: .95rem; font-weight: bold; color: #f27d0c;
    background: #fff; border: none; border-radius: 6px; cursor: pointer; transition: opacity .2s;
  }
  .premium-banner .pb-cta:hover { opacity: .85; }
  .premium-card {
    padding: 18px 20px; border-radius: 10px; border: 2px solid #f27d0c; background: #fff8f0;
    margin-bottom: 14px;
  }
  .premium-card .pc-title { font-size: 1.05rem; font-weight: bold; color: #f27d0c; margin-bottom: 4px; }
  .premium-card .pc-price { font-size: 1.4rem; font-weight: bold; color: #333; margin-bottom: 8px; }
  .premium-card ul { list-style: none; font-size: .88rem; color: #333; margin-bottom: 12px; }
  .premium-card li { padding-left: 1.3em; text-indent: -1.3em; }
  .premium-card li::before { content: '✓ '; color: #f27d0c; font-weight: bold; }
  .premium-card .pc-cancel {
    padding: 7px 16px; font-size: .85rem; color: #666; background: #fff;
    border: 1px solid #ccc; border-radius: 6px; cursor: pointer;
  }
  .site-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  @media (max-width: 600px) { .site-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; } }
  .site-card {
    position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 16px 8px; border: 2px solid #e0e0e0; border-radius: 8px; background: #fff; cursor: pointer;
    transition: border-color .2s, background-color .2s, box-shadow .2s; -webkit-tap-highlight-color: transparent;
  }
  .site-card:hover { border-color: #f27d0c; background: #fffbf7; }
  .site-card.on { border-color: #f27d0c; background: #fff8f0; box-shadow: 0 0 0 2px rgba(242,125,12,.2); }
  .site-card input { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }
  .site-card .name { font-size: .9rem; font-weight: bold; color: #333; text-align: center; line-height: 1.3; }
  .option-block { padding: 14px 16px; background: #fff; border-radius: 6px; border: 1px solid #e8e8e8; margin-bottom: 14px; }
  .option-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .option-site { font-weight: bold; font-size: 1rem; flex-shrink: 0; }
  .plan-select { flex: 1; min-width: 0; max-width: 320px; }
  .plan-select select { width: 100%; padding: 8px 12px; font-size: .95rem; border-radius: 4px; border: 1px solid #ccc; background: #fff; }
  .buffet { margin-top: 12px; padding-top: 12px; border-top: 1px dashed #ddd; }
  .buffet-title { font-size: .85rem; font-weight: bold; color: #555; margin-bottom: 8px; }
  .buffet-list { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px 12px; }
  @media (max-width: 600px) { .buffet-list { grid-template-columns: 1fr; } }
  .buffet-label { display: flex; align-items: center; gap: 6px; font-size: .85rem; padding: 3px 0; cursor: pointer; }
  .buffet-label input { width: 16px; height: 16px; accent-color: #f27d0c; flex-shrink: 0; }
  .buffet-label .p { color: #888; font-size: .8rem; }
  .inv-block { padding: 14px 16px; background: #fff; border-radius: 6px; border: 1px solid #e8e8e8; margin-bottom: 20px; }
  .inv-title { font-weight: bold; font-size: 1rem; margin-bottom: 4px; }
  .inv-note { font-size: .8rem; color: #888; margin-bottom: 8px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px 24px; }
  .chips label {
    font-size: .82rem; border: 1px solid #ccc; border-radius: 14px; padding: 3px 10px; cursor: pointer;
    user-select: none; display: flex; align-items: center; gap: 4px; background: #fff; transition: border-color .2s, background .2s;
  }
  .chips input { accent-color: #f27d0c; }
  .chips label.on { border-color: #f27d0c; background: #fff8f0; }
  .hint { font-size: .78rem; color: #888; margin-left: 24px; }
  .locked-note { font-size: .78rem; color: #f27d0c; }
  .result { padding: 20px 24px; background: #fff; border-radius: 8px; border: 2px solid #f27d0c; margin-top: 8px; }
  .result-inner { display: flex; align-items: center; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
  /* min-widthを確保して、狭い画面では折り返して総支払額が下段に回るようにする
     （min-width:0だと内訳が1文字幅まで潰れて縦書きになる） */
  .formula { flex: 1 1 240px; min-width: 240px; font-size: .9rem; color: #333; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
  .total-wrap { flex-shrink: 0; text-align: right; margin-left: auto; }
  .total { font-size: 1.75rem; font-weight: bold; color: #f27d0c; }
  .total-tax { font-size: .8rem; color: #666; }
  .cta { margin-top: 16px; text-align: center; }
  .cta button {
    padding: 14px 40px; font-size: 1.05rem; font-weight: bold; color: #fff; background: #f27d0c;
    border: none; border-radius: 8px; cursor: pointer; transition: opacity .2s; box-shadow: 0 2px 6px rgba(242,125,12,.35);
  }
  .cta button:hover { opacity: .85; }
  .cta button:disabled { background: #ccc; cursor: not-allowed; box-shadow: none; }
  .cta .err { color: #ff0033; font-size: .85rem; margin-top: 8px; }
</style>
</head>
<body>
${liff ? `<div id="pb-loading" style="position:fixed;inset:0;z-index:9999;background:#fafafa;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;transition:opacity .3s;">
  <div style="width:40px;height:40px;border:4px solid #e5e7eb;border-top-color:#06C755;border-radius:50%;animation:pbspin .9s linear infinite;"></div>
  <div style="font-weight:bold;font-size:15px;color:#333;">プラン診断を準備しています…</div>
  <div style="font-size:12px;color:#777;line-height:1.8;">ご契約状況を確認しています。<br>すでにご契約中の方は、現在のプラン内容を<br>初期表示した状態でスタートします。<br>そのまま少しお待ちください。</div>
</div>
<style>@keyframes pbspin{to{transform:rotate(360deg)}}</style>` : ''}
<div class="simulator">
  ${liff ? '<div class="liff-logo"><img src="https://furimauto.com/service/images/furimauto_logo.png" alt="FurimAuto"></div>' : ''}
  ${embed ? '' : '<h1 class="sim-title">📱 料金シミュレーション</h1>'}
  <p class="sim-lead">利用したいサイトを選んで、パッケージプランか<br class="sp-only">機能別ビュッフェ式を組み合わせられます</p>
  <p class="sim-tax-note">※ 価格はすべて税抜表示です</p>
  <div class="svc-head svc-head--01"><span class="svc-num">01</span><span class="svc-name">サブスク型 フリマサイト自動化サービス</span></div>
  <p class="sim-label" id="site-label">利用するフリマサイトを選択</p>
  <div class="site-grid" id="site-grid"></div>
  <div id="options"></div>
  <div id="premium-banner"></div>
  <div class="svc-head svc-head--02"><span class="svc-num">02</span><span class="svc-name">チケット制 コピー出品サービス</span></div>
  <div class="copy-note">🎫 コピー出品はチケット制のため、<strong>LINEメニューから枚数単位で適宜購入</strong>できます。月額プランへの追加は不要です。</div>
  <div class="svc-head svc-head--03"><span class="svc-num">03</span><span class="svc-name">サブスク型 自動併売在庫管理サービス</span></div>
  <div class="inv-block" id="inv-block"></div>
  <div class="result">
    <div class="result-inner">
      <div class="formula" id="formula">サイトとプランを選択してください</div>
      <div class="total-wrap">
        <div class="total" id="total"></div>
        <div class="total-tax" id="total-tax"></div>
      </div>
    </div>
  </div>
  ${liff ? `<div class="cta">
    <div class="coupon-banner" id="current-plan-banner" style="display:none;"></div>
    <div class="coupon-banner" id="coupon-banner" style="display:none;"></div>
    <button id="checkout-btn" disabled>この内容で申し込む</button>
    <div class="err" id="checkout-err"></div>
  </div>` : ''}
</div>
<script>
const FEATURES = ${JSON.stringify(master.features)};
const PACKAGES = ${JSON.stringify(master.packages)};
const SITE_NAMES = ${JSON.stringify(SITE_NAMES)};
const EXTRA_SITE_PRICE = ${MULTI_CHANNEL_EXTRA_SITE_PRICE};
const MC_SITES = ${JSON.stringify(MULTI_CHANNEL_SITES)};
const TAX = ${TAX_RATE_PERCENT} / 100;
const EMBED = ${embed};
const LIFF_MODE = ${liff};
const LIFF_ID = ${JSON.stringify(liffId)};

const PLAN_LABELS = { full: '全自動化プラン', semi: '半自動化プラン', basic: '基本プラン', buffet: '機能別ビュッフェ式プラン' };
const subsFeatures = FEATURES.filter(f => f.billing_type === 'subscription');
const featByKey = Object.fromEntries(subsFeatures.map(f => [f.feature_key, f]));
const pkgBySite = {};
for (const p of PACKAGES) { (pkgBySite[p.site] = pkgBySite[p.site] || []).push(p); }
const invFeature = featByKey['InventorySheet'];
const mcFeature = featByKey['AutoMultiChannel'];
const premiumPkg = PACKAGES.find(p => p.package_key === 'premium');
// プレミアム=3サービス横断の最上位プラン: 01全機能 + コピー出品チケット200枚/月 + 03在庫管理シート基本のみ込み。
// 巡回オプション(AutoMultiChannel)はプレミアムでも別途追加購入（チケット付与自体はWebhook側で処理）
const PREMIUM_TICKET_BONUS = { count: 200, worth: 3000 };

// state
const state = {
  sites: [],
  plan: {},        // siteId -> '' | package_key | 'buffet'
  buffet: {},      // siteId -> Set(feature_key)
  addon: {},       // siteId -> Set(feature_key)
  inventory: false,
  mcSites: [],
  premium: false,  // プレミアムプラン適用（01サービスの個別選択を置き換える。選択状態は保持）
};
let lineUserId = null;
let changeMode = false;

function applyLabel() { return changeMode ? 'この内容にプラン変更する' : 'この内容で申し込む'; }

function yen(n) { return n.toLocaleString('ja-JP') + '円'; }

// 既存契約者: 現在の構成をmetadataから読み込んでチェック状態を初期化（プラン変更モード）
async function loadCurrentPlan() {
  if (!lineUserId) return;
  try {
    const res = await fetch('/plan-builder/current?lineUserId=' + encodeURIComponent(lineUserId));
    const cur = await res.json();
    if (!cur.success || !cur.hasSubscription) return;
    changeMode = true;
    for (const key of cur.packages || []) {
      if (key === 'premium') { state.premium = true; continue; }
      const p = PACKAGES.find(x => x.package_key === key);
      if (!p) continue;
      if (!state.sites.includes(p.site)) state.sites.push(p.site);
      state.plan[p.site] = key;
    }
    for (const key of cur.features || []) {
      if (key === 'InventorySheet') { state.inventory = true; continue; }
      if (key === 'AutoMultiChannel') { state.mcSites = (cur.multiChannelSites || []).filter(s => MC_SITES.includes(s)); continue; }
      const f = featByKey[key];
      if (!f) continue;
      if (!state.sites.includes(f.site)) state.sites.push(f.site);
      if (state.plan[f.site] && state.plan[f.site] !== 'buffet') {
        (state.addon[f.site] = state.addon[f.site] || new Set()).add(key);
      } else {
        state.plan[f.site] = 'buffet';
        (state.buffet[f.site] = state.buffet[f.site] || new Set()).add(key);
      }
    }
    const banner = document.getElementById('current-plan-banner');
    if (banner) {
      banner.textContent = '📋 現在のご契約内容を読み込みました。変更したい内容に編集して「プラン変更」ボタンを押すと、差額のみのお支払いでプラン変更できます（変更にはキーコードの再入力が必要です）';
      banner.style.display = 'block';
    }
    const btn = document.getElementById('checkout-btn');
    if (btn) btn.textContent = applyLabel();
  } catch (e) { console.log('current plan load skipped:', e); }
}

function siteFeatures(siteId) {
  return subsFeatures.filter(f => f.site === siteId);
}

// サービス01（フリマ自動化）全機能の単品合計
function svc1UnitSum() {
  return subsFeatures.filter(f => f.service === '1_automation').reduce((s, f) => s + Number(f.monthly_price), 0);
}

function mcPrice() {
  const n = Math.max(state.mcSites.length, 1);
  const base = Number(mcFeature.monthly_price);
  return n <= 2 ? base : base + EXTRA_SITE_PRICE * (n - 2);
}

function calc() {
  const auto = { parts: [], total: 0 };
  const inv = { parts: [], total: 0 };
  if (state.premium && premiumPkg) {
    // プレミアム: 01全機能・チケット200枚・在庫管理シート基本が込み。巡回オプションは別途加算
    auto.parts.push(premiumPkg.display_name + '(' + yen(Number(premiumPkg.monthly_price)) + ')');
    auto.parts.push('※全フリマサイト自動化 全機能込み');
    auto.parts.push('※毎月コピー出品チケット' + PREMIUM_TICKET_BONUS.count + '枚（' + yen(PREMIUM_TICKET_BONUS.worth) + '相当）無料');
    auto.parts.push('※在庫管理シート基本機能（' + yen(Number(invFeature.monthly_price)) + '相当）込み');
    auto.total = Number(premiumPkg.monthly_price);
    if (state.mcSites.length > 0) {
      inv.parts.push('自動併売・巡回 ' + state.mcSites.length + 'サイト(' + yen(mcPrice()) + ')');
      inv.total += mcPrice();
    }
    return { auto, inv, total: auto.total + inv.total, premiumMode: true };
  }
  let nFull = 0, nSemi = 0, pkgCount = 0;
  for (const siteId of state.sites) {
    const sel = state.plan[siteId];
    if (!sel) continue;
    const name = SITE_NAMES[siteId];
    if (sel === 'buffet') {
      const keys = [...(state.buffet[siteId] || [])];
      if (keys.length) {
        const sum = keys.reduce((s, k) => s + Number(featByKey[k].monthly_price), 0);
        auto.parts.push(name + 'ビュッフェ: ' + keys.map(k => featByKey[k].display_name + '(' + yen(Number(featByKey[k].monthly_price)) + ')').join(' + ') + ' = ' + yen(sum));
        auto.total += sum;
      }
    } else {
      const pkg = PACKAGES.find(p => p.package_key === sel);
      if (!pkg) continue;
      auto.parts.push(name + PLAN_LABELS[pkg.plan_type] + '(' + yen(Number(pkg.monthly_price)) + ')');
      auto.total += Number(pkg.monthly_price);
      pkgCount++;
      if (pkg.plan_type === 'full') nFull++;
      if (pkg.plan_type === 'semi') nSemi++;
      const addons = [...(state.addon[siteId] || [])];
      if (addons.length && (pkg.plan_type === 'semi' || pkg.plan_type === 'basic') && siteId !== 'mercariShops') {
        const sum = addons.reduce((s, k) => s + Number(featByKey[k].monthly_price), 0);
        auto.parts.push(name + '追加ビュッフェ: ' + addons.map(k => featByKey[k].display_name + '(' + yen(Number(featByKey[k].monthly_price)) + ')').join(' + ') + ' = ' + yen(sum));
        auto.total += sum;
      }
    }
  }
  if (pkgCount >= 2) {
    const discount = 1500 * nFull + 480 * nSemi;
    if (discount > 0) {
      const d = [];
      if (nFull) d.push('全自動併用割引' + yen(1500 * nFull));
      if (nSemi) d.push('半自動併用割引' + yen(480 * nSemi));
      auto.parts.push('− 複数サイト併用割引(' + d.join(' + ') + ')');
      auto.total -= discount;
    }
  }
  addInventoryParts(inv);
  return { auto, inv, total: auto.total + inv.total };
}

function addInventoryParts(inv) {
  if (state.inventory) {
    inv.parts.push('在庫管理シート基本料金(' + yen(Number(invFeature.monthly_price)) + ')');
    inv.total += Number(invFeature.monthly_price);
  }
  if (state.mcSites.length > 0) {
    inv.parts.push('自動併売・巡回 ' + state.mcSites.length + 'サイト(' + yen(mcPrice()) + ')');
    inv.total += mcPrice();
  }
}

function selectionPayload() {
  const packages = [];
  const features = new Set();
  if (state.premium && premiumPkg) {
    // 在庫管理シート基本はプレミアムに込み。巡回オプションを付けた場合のみ別itemで課金
    const f = state.mcSites.length > 0 ? ['AutoMultiChannel'] : [];
    return { packages: ['premium'], features: f, multiChannelSites: state.mcSites };
  }
  for (const siteId of state.sites) {
    const sel = state.plan[siteId];
    if (!sel) continue;
    if (sel === 'buffet') {
      (state.buffet[siteId] || new Set()).forEach(k => features.add(k));
    } else {
      packages.push(sel);
      if (siteId !== 'mercariShops') (state.addon[siteId] || new Set()).forEach(k => features.add(k));
    }
  }
  if (state.inventory) features.add('InventorySheet');
  if (state.mcSites.length > 0) { features.add('AutoMultiChannel'); features.add('InventorySheet'); }
  return { packages, features: [...features], multiChannelSites: state.mcSites };
}

function renderSites() {
  const grid = document.getElementById('site-grid');
  grid.innerHTML = '';
  for (const [siteId, name] of Object.entries(SITE_NAMES)) {
    const on = state.sites.includes(siteId);
    const label = document.createElement('label');
    label.className = 'site-card' + (on ? ' on' : '');
    label.innerHTML = '<input type="checkbox"' + (on ? ' checked' : '') + '><span class="name">' + name + '</span>';
    label.querySelector('input').addEventListener('change', (ev) => {
      if (ev.target.checked) state.sites.push(siteId);
      else { state.sites = state.sites.filter(s => s !== siteId); state.plan[siteId] = ''; }
      render();
    });
    grid.appendChild(label);
  }
}

function renderOptions() {
  const root = document.getElementById('options');
  root.innerHTML = '';
  document.getElementById('site-label').style.display = state.premium ? 'none' : '';
  document.getElementById('site-grid').style.display = state.premium ? 'none' : '';
  if (state.premium && premiumPkg) {
    const card = document.createElement('div');
    card.className = 'premium-card';
    card.innerHTML = '<div class="pc-title">👑 ' + premiumPkg.display_name + ' 適用中</div>' +
      '<div class="pc-price">' + yen(Number(premiumPkg.monthly_price)) + '/月<span style="font-size:.8rem;color:#666;">（税抜）</span></div>' +
      '<ul>' +
      '<li>メルカリ・メルカリShops・ラクマ・ヤフフリの全機能が使い放題</li>' +
      '<li>在庫管理シート（基本機能・' + yen(Number(invFeature.monthly_price)) + '相当）込み</li>' +
      '<li>毎月コピー出品チケット' + PREMIUM_TICKET_BONUS.count + '枚（' + yen(PREMIUM_TICKET_BONUS.worth) + '相当）無料</li>' +
      '<li>単品合計' + yen(svc1UnitSum() + Number(invFeature.monthly_price)) + '相当が' + yen(Number(premiumPkg.monthly_price)) + 'に</li>' +
      '</ul>' +
      '<button type="button" class="pc-cancel">個別選択に戻す</button>';
    card.querySelector('.pc-cancel').addEventListener('click', () => { state.premium = false; render(); });
    root.appendChild(card);
    return;
  }
  for (const siteId of state.sites) {
    const block = document.createElement('div');
    block.className = 'option-block';
    const pkgs = (pkgBySite[siteId] || []);
    const sel = state.plan[siteId] || '';
    let optHtml = '<option value="">ご希望プランを選択してください</option>';
    for (const p of pkgs) {
      optHtml += '<option value="' + p.package_key + '"' + (sel === p.package_key ? ' selected' : '') + '>' + PLAN_LABELS[p.plan_type] + ' (' + yen(Number(p.monthly_price)) + ')</option>';
    }
    optHtml += '<option value="buffet"' + (sel === 'buffet' ? ' selected' : '') + '>機能別ビュッフェ式プラン</option>';
    block.innerHTML = '<div class="option-row"><span class="option-site">' + SITE_NAMES[siteId] + '</span>' +
      '<div class="plan-select"><select data-site="' + siteId + '">' + optHtml + '</select></div></div>';
    block.querySelector('select').addEventListener('change', (ev) => {
      state.plan[siteId] = ev.target.value;
      render();
    });

    const features = siteFeatures(siteId);
    if (sel === 'buffet') {
      block.appendChild(buffetList(siteId, features, state.buffet, '機能を選択（複数可）'));
    } else if (sel && siteId !== 'mercariShops') {
      const pkg = PACKAGES.find(p => p.package_key === sel);
      if (pkg && (pkg.plan_type === 'semi' || pkg.plan_type === 'basic')) {
        const included = new Set(pkg.features.split(',').map(s => s.trim()));
        const addable = features.filter(f => !included.has(f.feature_key));
        if (addable.length) block.appendChild(buffetList(siteId, addable, state.addon, '追加で機能別ビュッフェ式プランから機能を追加（任意）'));
      }
    }
    root.appendChild(block);
  }
}

function buffetList(siteId, features, store, title) {
  const wrap = document.createElement('div');
  wrap.className = 'buffet';
  wrap.innerHTML = '<p class="buffet-title">' + title + '</p>';
  const list = document.createElement('div');
  list.className = 'buffet-list';
  const set = store[siteId] = store[siteId] || new Set();
  for (const f of features) {
    const on = set.has(f.feature_key);
    const label = document.createElement('label');
    label.className = 'buffet-label';
    label.innerHTML = '<input type="checkbox"' + (on ? ' checked' : '') + '><span>' + f.display_name + '</span><span class="p">(' + yen(Number(f.monthly_price)) + ')</span>';
    label.querySelector('input').addEventListener('change', (ev) => {
      if (ev.target.checked) set.add(f.feature_key); else set.delete(f.feature_key);
      render();
    });
    list.appendChild(label);
  }
  wrap.appendChild(list);
  return wrap;
}

function renderInventory() {
  const block = document.getElementById('inv-block');
  const mcOn = state.mcSites.length > 0;
  if (state.premium) {
    block.innerHTML = '<div class="inv-note">' +
      '👑 プレミアムプランに<strong>在庫管理シート（基本機能・' + yen(Number(invFeature.monthly_price)) + '相当）</strong>が含まれています。' +
      '巡回オプションは必要に応じて追加できます。</div>' +
      '<label class="buffet-label"><input type="checkbox" id="mc-cb"' + (mcOn ? ' checked' : '') + '>' +
      '<span>自動併売・巡回オプション</span><span class="p">(' + yen(Number(mcFeature.monthly_price)) + '〜)</span></label>';
    const chips = document.createElement('div');
    chips.className = 'chips';
    chips.style.display = mcOn ? 'flex' : 'none';
    for (const s of MC_SITES) {
      const on = state.mcSites.includes(s);
      const label = document.createElement('label');
      label.className = on ? 'on' : '';
      label.innerHTML = '<input type="checkbox"' + (on ? ' checked' : '') + '>' + s;
      label.querySelector('input').addEventListener('change', (ev) => {
        if (ev.target.checked) state.mcSites.push(s);
        else state.mcSites = state.mcSites.filter(x => x !== s);
        render();
      });
      chips.appendChild(label);
    }
    block.appendChild(chips);
    if (mcOn) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = '巡回サイト ' + state.mcSites.length + 'サイト（2サイトまで' + yen(Number(mcFeature.monthly_price)) + '、3サイト目から+' + yen(EXTRA_SITE_PRICE) + '/サイト）';
      block.appendChild(hint);
    }
    document.getElementById('mc-cb').addEventListener('change', (ev) => {
      if (ev.target.checked) state.mcSites = MC_SITES.slice(0, 2);
      else state.mcSites = [];
      render();
    });
    return;
  }
  const invLocked = mcOn;
  block.innerHTML = '<div class="inv-note">複数サイトの在庫をスプレッドシートで一元管理。巡回オプションで売れた商品を自動で全サイトから取り下げます。</div>' +
    '<label class="buffet-label"><input type="checkbox" id="inv-cb"' + (state.inventory ? ' checked' : '') + (invLocked ? ' disabled' : '') + '>' +
    '<span>在庫管理シート（基本料金）' + (invLocked ? '<span class="locked-note">（巡回オプション利用時は必須）</span>' : '') + '</span>' +
    '<span class="p">(' + yen(Number(invFeature.monthly_price)) + ')</span></label>' +
    '<label class="buffet-label"><input type="checkbox" id="mc-cb"' + (mcOn ? ' checked' : '') + '>' +
    '<span>自動併売・巡回オプション</span><span class="p">(' + yen(Number(mcFeature.monthly_price)) + '〜)</span></label>';
  const chips = document.createElement('div');
  chips.className = 'chips';
  chips.style.display = mcOn ? 'flex' : 'none';
  for (const s of MC_SITES) {
    const on = state.mcSites.includes(s);
    const label = document.createElement('label');
    label.className = on ? 'on' : '';
    label.innerHTML = '<input type="checkbox"' + (on ? ' checked' : '') + '>' + s;
    label.querySelector('input').addEventListener('change', (ev) => {
      if (ev.target.checked) state.mcSites.push(s);
      else state.mcSites = state.mcSites.filter(x => x !== s);
      if (state.mcSites.length > 0) state.inventory = true;
      render();
    });
    chips.appendChild(label);
  }
  block.appendChild(chips);
  if (mcOn) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '巡回サイト ' + state.mcSites.length + 'サイト（2サイトまで' + yen(Number(mcFeature.monthly_price)) + '、3サイト目から+' + yen(EXTRA_SITE_PRICE) + '/サイト）';
    block.appendChild(hint);
  }
  document.getElementById('inv-cb').addEventListener('change', (ev) => { state.inventory = ev.target.checked; render(); });
  document.getElementById('mc-cb').addEventListener('change', (ev) => {
    if (ev.target.checked) { state.mcSites = MC_SITES.slice(0, 2); state.inventory = true; }
    else state.mcSites = [];
    render();
  });
}

function renderResult() {
  const { auto, inv, total } = calc();
  const formulaEl = document.getElementById('formula');
  const totalEl = document.getElementById('total');
  const taxEl = document.getElementById('total-tax');
  const btn = document.getElementById('checkout-btn');
  if (auto.parts.length === 0 && inv.parts.length === 0) {
    formulaEl.textContent = 'サイトとプランを選択してください';
    totalEl.textContent = '';
    taxEl.textContent = '';
    if (btn) btn.disabled = true;
    return;
  }
  formulaEl.innerHTML = '';
  const section = (label, svc) => {
    if (svc.parts.length === 0) return;
    const head = document.createElement('div');
    head.className = 'svc-label';
    head.textContent = '【' + label + '】';
    formulaEl.appendChild(head);
    const body = document.createElement('div');
    body.textContent = svc.parts.join('\\n+ ').replace(/\\+ −/g, '−').replace(/\\+ ※/g, '※');
    formulaEl.appendChild(body);
    const sub = document.createElement('div');
    sub.className = 'svc-subtotal';
    sub.textContent = '小計 ' + yen(svc.total) + '/月';
    formulaEl.appendChild(sub);
  };
  if (state.premium) {
    section('プレミアムプラン', auto);
    section('自動併売在庫管理サービス（巡回オプション）', inv);
  } else {
    section('フリマサイト自動化サービス', auto);
    section('自動併売在庫管理サービス', inv);
  }
  totalEl.textContent = '総支払額 ' + yen(total) + '/月';
  taxEl.textContent = '税抜（税込 ' + yen(Math.round(total * (1 + TAX))) + '）';
  if (btn) btn.disabled = total <= 0;
}

function renderPremiumBanner() {
  const el = document.getElementById('premium-banner');
  el.innerHTML = '';
  if (state.premium || !premiumPkg) return;
  const { auto } = calc();
  const pPrice = Number(premiumPkg.monthly_price);
  // プレミアムがカバーするのは01全機能＋在庫管理シート基本。巡回オプションは別課金なので比較に含めない
  const covered = auto.total + (state.inventory ? Number(invFeature.monthly_price) : 0);
  if (covered < pPrice) return;
  const diff = covered - pPrice;
  const banner = document.createElement('div');
  banner.className = 'premium-banner';
  banner.innerHTML = '<div class="pb-title">💡 その組み合わせなら「' + premiumPkg.display_name + '」がお得です！</div>' +
    '<ul>' +
    '<li>4サイトの全機能が使い放題で' + yen(pPrice) + '/月' + (diff > 0 ? '（今の選択より' + yen(diff) + 'お得）' : '（同じ月額で全機能が解放）') + '</li>' +
    '<li>在庫管理シート基本機能（' + yen(Number(invFeature.monthly_price)) + '相当）も込み</li>' +
    '<li>さらに毎月コピー出品チケット' + PREMIUM_TICKET_BONUS.count + '枚（' + yen(PREMIUM_TICKET_BONUS.worth) + '相当）が無料</li>' +
    '</ul>' +
    '<button type="button" class="pb-cta">プレミアムプランに切り替える</button>';
  banner.querySelector('.pb-cta').addEventListener('click', () => { state.premium = true; render(); });
  el.appendChild(banner);
}

function render() {
  renderSites();
  renderOptions();
  renderPremiumBanner();
  renderInventory();
  renderResult();
  if (EMBED && window.parent !== window) {
    // body.scrollHeightはiframe内でビューポート由来の値になることがあるため、コンテンツ実体で計測する
    const contentHeight = document.querySelector('.simulator')?.offsetHeight || 0;
    window.parent.postMessage({ type: 'plan-builder:height', height: contentHeight }, '*');
    window.parent.postMessage({ type: 'plan-builder:selection', selection: { ...selectionPayload(), monthlyTotal: calc().total } }, '*');
  }
}

// 申し込みボタンはLIFF（LINE内）のみ表示。LP埋め込みではシミュレーター専用。
// 直接Checkoutへは飛ばさず、選択内容をトークに送信→Botが決済リンクを返信する
// （どのプランで申込ボタンを押したかがトークに残る）
const checkoutBtnEl = document.getElementById('checkout-btn');
if (checkoutBtnEl) checkoutBtnEl.addEventListener('click', async () => {
  const btn = document.getElementById('checkout-btn');
  const err = document.getElementById('checkout-err');
  btn.disabled = true;
  btn.textContent = changeMode ? '変更内容を確認中…' : '申し込み内容を送信中…';
  err.textContent = '';
  try {
    const payload = { ...selectionPayload(), lineUserId };
    const res = await fetch('/plan-builder/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'intent failed');
    if (data.change) {
      // プラン変更: 実行前に支払い内容を確認してもらう
      // アップグレード=日割り差額を即時決済（Stripe算出の確定額） / ダウングレード=決済なし・次回更新日切替
      const confirmText = data.change.kind === 'downgrade'
        ? '本日のお支払いはありません。\\n' +
          '次回更新日（' + data.change.effectiveDateText + '）から新しいプランに切り替わります。\\n' +
          '新しい月額（税抜）: ' + calc().total.toLocaleString('ja-JP') + '円\\n\\n' +
          'この内容でプラン変更を予約しますか？'
        : '本日のお支払い（残り期間の日割り差額・税込）: ' + Number(data.change.amountDueNow || 0).toLocaleString('ja-JP') + '円\\n' +
          '新しい月額（次回更新から・税抜）: ' + calc().total.toLocaleString('ja-JP') + '円\\n\\n' +
          'この内容でプラン変更を実行しますか？';
      const ok = window.confirm(confirmText);
      if (!ok) {
        btn.disabled = false;
        btn.textContent = applyLabel();
        return;
      }
    }
    if (typeof liff !== 'undefined' && liff.isInClient && liff.isInClient()) {
      // 選択内容をユーザーのメッセージとしてトークに送信 → Botが決済リンクを返す
      await liff.sendMessages([{ type: 'text', text: data.message }]);
      liff.closeWindow();
    } else {
      // LINE外で開かれた場合のフォールバック: 従来どおり直接Checkoutへ
      const res2 = await fetch('/plan-builder/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data2 = await res2.json();
      if (!data2.success) throw new Error(data2.error || 'checkout failed');
      window.location.href = data2.url;
    }
  } catch (e) {
    err.textContent = (changeMode ? 'プラン変更' : '申し込み') + 'の送信に失敗しました。時間をおいて再度お試しください。';
    console.error(e);
    btn.disabled = false;
    btn.textContent = applyLabel();
  }
});

if (EMBED && window.parent !== window) {
  // 親リスナー登録前の初回メッセージ取りこぼし対策: load完了時と親からの要求時に再送
  window.addEventListener('load', render);
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'plan-builder:request-height') render();
  });
}

// Furimanクーポン資格があればCTA上にバナー表示（適用自体はcheckoutサーバ側で再判定）
async function showCouponBanner() {
  const el = document.getElementById('coupon-banner');
  if (!el || !lineUserId) return;
  try {
    const res = await fetch('/plan-builder/coupon-status?lineUserId=' + encodeURIComponent(lineUserId));
    const data = await res.json();
    if (data.eligible) {
      var off = data.percent ? '（初回のお支払いが' + data.percent + '%OFF）' : '';
      el.textContent = '🎟 ' + data.couponName + off + 'が適用中です。お申し込み時に自動で反映されます';
      el.style.display = 'block';
    }
  } catch (e) { console.log('coupon status skipped:', e); }
}

// 準備完了（現契約の初期表示まで済んだ）タイミングでローディングを閉じる
function hidePbLoading() {
  var ld = document.getElementById('pb-loading');
  if (!ld) return;
  ld.style.opacity = '0';
  setTimeout(function () { ld.remove(); }, 300);
}

(async () => {
  // 保険: 何かが固まってもローディングで操作不能のままにしない
  setTimeout(hidePbLoading, 15000);
  if (LIFF_MODE && LIFF_ID && typeof liff !== 'undefined') {
    try {
      await liff.init({ liffId: LIFF_ID });
      if (liff.isLoggedIn()) {
        const profile = await liff.getProfile();
        lineUserId = profile.userId;
        showCouponBanner();
        await loadCurrentPlan(); // 既存契約者は現構成で初期化（プラン変更モード）
      }
    } catch (e) { console.log('liff init skipped:', e); }
  }
  render();
  hidePbLoading();
})();
</script>
</body>
</html>`);
});

export { planBuilder };
