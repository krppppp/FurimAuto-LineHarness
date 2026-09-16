import { Hono } from 'hono';
import type { Env } from '../index.js';
import { jstNow } from '@line-crm/db';
import { EXCLUDED_LINE_IDS } from '../furim/segments.js';

/**
 * 管理画面トップのダッシュボード API（Capsec #282 段階2 / #285）。
 *
 * - GET /api/furim/dashboard?granularity=day|month|year&period=3m|6m|1y|all
 *   6 区画（友だち追加・月次課金実績・解約・広告費・試用中・異常）を 1 往復で返す。
 *   区画ごとに ok を持たせ、1 つが落ちても他は出す（取得失敗と 0 件を画面で区別するため）。
 * - POST /api/furim/ad-spend/import
 *   Google 広告 API から取った日次の費用を upsert する（GoogleAds/ad_spend_to_d1.py が叩く）。
 *
 * 日時の扱い: 列によって ISO+09:00 / オフセット無し / UTC 空白区切りが混在しているので、
 * 比較も集計も substr(replace(x,' ','T'),1,N) に揃える（Capsec #260）。
 * datetime('now','+9 hours') は datetime-format-guard.test.ts で禁止されているので使わない。
 */

export const furimDashboard = new Hono<Env>();

export type Granularity = 'day' | 'month' | 'year';
export type Period = '3m' | '6m' | '1y' | 'all';

const KEY_LEN: Record<Granularity, number> = { day: 10, month: 7, year: 4 };
const EXCLUDED = [...EXCLUDED_LINE_IDS];

export function parseGranularity(v: string | undefined): Granularity {
  return v === 'day' || v === 'year' ? v : 'month';
}
export function parsePeriod(v: string | undefined): Period {
  return v === '3m' || v === '6m' || v === 'all' ? v : '1y';
}

/** 期間の下限（JST の YYYY-MM-DD）。all は D1 にある最古より前の固定値 */
export function rangeStart(period: Period, today: string): string {
  if (period === 'all') return '2000-01-01';
  const [y, m, d] = today.split('-').map(Number);
  const months = period === '3m' ? 3 : period === '6m' ? 6 : 12;
  const base = new Date(Date.UTC(y, m - 1 - months, d));
  return base.toISOString().slice(0, 10);
}

/** 期間キー（粒度ごとの GROUP BY 用） */
const bucketOf = (col: string, g: Granularity) => `substr(replace(${col}, ' ', 'T'), 1, ${KEY_LEN[g]})`;
/** 日付（期間の絞り込み用） */
const dayOf = (col: string) => `substr(replace(${col}, ' ', 'T'), 1, 10)`;
/** 秒まで（現在時刻との比較用） */
const secOf = (col: string) => `substr(replace(${col}, ' ', 'T'), 1, 19)`;

/** 社内・検証用アカウントを除く条件（NULL は残す） */
function exclude(col: string): string {
  return `AND (${col} IS NULL OR ${col} NOT IN (${EXCLUDED.map(() => '?').join(',')}))`;
}

const CLICK_ID_COND = '(r.gclid IS NOT NULL OR r.fbclid IS NOT NULL OR r.twclid IS NOT NULL OR r.ttclid IS NOT NULL)';

type Section<T> = { ok: true } & T;
type Failed = { ok: false; error: string };

async function section<T>(name: string, run: () => Promise<T>): Promise<Section<T> | Failed> {
  try {
    return { ok: true, ...(await run()) };
  } catch (e) {
    console.error(`[dashboard] ${name} failed:`, e);
    return { ok: false, error: e instanceof Error ? e.message : '集計に失敗しました' };
  }
}

const num = (v: unknown): number => Number(v ?? 0);

furimDashboard.get('/api/furim/dashboard', async (c) => {
  const db = c.env.DB;
  const g = parseGranularity(c.req.query('granularity'));
  const period = parsePeriod(c.req.query('period'));
  const now = jstNow();
  const today = now.slice(0, 10);
  const from = rangeStart(period, today);
  const now19 = now.slice(0, 19);
  const range = { from, to: today, granularity: g, period, tz: 'Asia/Tokyo' };

  const friends = await section('friends', async () => {
    const rows = await db
      .prepare(
        `SELECT ${bucketOf('created_at', g)} AS t,
                COALESCE(NULLIF(TRIM(ref_code), ''), '(不明)') AS route,
                COUNT(*) AS n
         FROM friends
         WHERE ${dayOf('created_at')} BETWEEN ? AND ? ${exclude('line_user_id')}
         GROUP BY t, route`,
      )
      .bind(from, today, ...EXCLUDED)
      .all<{ t: string; route: string; n: number }>();

    const ads = await db
      .prepare(
        `SELECT ${bucketOf('f.created_at', g)} AS t, COUNT(DISTINCT f.id) AS n
         FROM friends f JOIN ref_tracking r ON r.friend_id = f.id
         WHERE ${CLICK_ID_COND} AND ${dayOf('f.created_at')} BETWEEN ? AND ? ${exclude('f.line_user_id')}
         GROUP BY t`,
      )
      .bind(from, today, ...EXCLUDED)
      .all<{ t: string; n: number }>();

    const routes = await db.prepare('SELECT ref_code, name FROM entry_routes').all<{ ref_code: string; name: string }>();
    const routeName = new Map((routes.results ?? []).map((r) => [r.ref_code, r.name]));
    const adByT = new Map((ads.results ?? []).map((r) => [r.t, num(r.n)]));

    const byT = new Map<string, { t: string; total: number; fromAds: number; byRoute: Record<string, number> }>();
    for (const r of rows.results ?? []) {
      const e = byT.get(r.t) ?? { t: r.t, total: 0, fromAds: 0, byRoute: {} };
      const label = routeName.get(r.route) ?? r.route;
      e.byRoute[label] = (e.byRoute[label] ?? 0) + num(r.n);
      e.total += num(r.n);
      byT.set(r.t, e);
    }
    for (const [t, n] of adByT) {
      const e = byT.get(t) ?? { t, total: 0, fromAds: 0, byRoute: {} };
      e.fromAds = n;
      byT.set(t, e);
    }

    const following = await db
      .prepare(`SELECT COUNT(*) AS n FROM friends WHERE is_following = 1 ${exclude('line_user_id')}`)
      .bind(...EXCLUDED)
      .first<{ n: number }>();

    return { series: [...byT.values()].sort((a, b) => a.t.localeCompare(b.t)), following: num(following?.n) };
  });

  // 「月次課金実績」（厳密な MRR ではなく、実際に入った課金の合計・Capsec #285 のくろさん決定）
  const revenue = await section('revenue', async () => {
    const rows = await db
      .prepare(
        `SELECT ${bucketOf('paid_at', g)} AS t,
                COUNT(*) AS invoices,
                COUNT(DISTINCT line_user_id) AS payers,
                SUM(price_excl_tax) AS excl_tax,
                SUM(actual_paid_amount) AS incl_tax,
                SUM(CASE WHEN billing_reason = 'subscription_create' THEN 1 ELSE 0 END) AS new_paid
         FROM furim_payments
         WHERE ${dayOf('paid_at')} BETWEEN ? AND ? AND actual_paid_amount > 0 ${exclude('line_user_id')}
         GROUP BY t`,
      )
      .bind(from, today, ...EXCLUDED)
      .all<{ t: string; invoices: number; payers: number; excl_tax: number; incl_tax: number; new_paid: number }>();

    // 無料→有料の転換: その人にとって初めての課金が成立した日。1 人 1 回だけ数える
    const conv = await db
      .prepare(
        `WITH first_paid AS (
           SELECT line_user_id, MIN(${secOf('paid_at')}) AS first_at
           FROM furim_payments
           WHERE line_user_id IS NOT NULL AND actual_paid_amount > 0 AND billing_reason = 'subscription_create'
           GROUP BY line_user_id
         )
         SELECT substr(first_at, 1, ${KEY_LEN[g]}) AS t, COUNT(*) AS n
         FROM first_paid
         WHERE substr(first_at, 1, 10) BETWEEN ? AND ?
         GROUP BY t`,
      )
      .bind(from, today)
      .all<{ t: string; n: number }>();
    const convByT = new Map((conv.results ?? []).map((r) => [r.t, num(r.n)]));

    const members = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM furim_customers
         WHERE TRIM(COALESCE(plan_label, '')) <> ''
           AND subscription_end_at IS NOT NULL AND ${secOf('subscription_end_at')} > ?
           ${exclude('line_user_id')}`,
      )
      .bind(now19, ...EXCLUDED)
      .first<{ n: number }>();

    const series = (rows.results ?? []).map((r) => ({
      t: r.t,
      invoices: num(r.invoices),
      payers: num(r.payers),
      revenueExclTax: num(r.excl_tax),
      revenueInclTax: num(r.incl_tax),
      newPaidInvoices: num(r.new_paid),
      converted: convByT.get(r.t) ?? 0,
    }));
    for (const [t, n] of convByT) {
      if (!series.some((s) => s.t === t)) {
        series.push({ t, invoices: 0, payers: 0, revenueExclTax: 0, revenueInclTax: 0, newPaidInvoices: 0, converted: n });
      }
    }
    return { series: series.sort((a, b) => a.t.localeCompare(b.t)), members: num(members?.n) };
  });

  const churn = await section('churn', async () => {
    const rows = await db
      .prepare(
        `SELECT ${bucketOf('canceled_at', g)} AS t, COUNT(*) AS n
         FROM furim_cancellations
         WHERE ${dayOf('canceled_at')} BETWEEN ? AND ? ${exclude('line_user_id')}
         GROUP BY t`,
      )
      .bind(from, today, ...EXCLUDED)
      .all<{ t: string; n: number }>();
    const blocked = await db
      .prepare(`SELECT COUNT(*) AS n FROM friends WHERE is_following = 0 ${exclude('line_user_id')}`)
      .bind(...EXCLUDED)
      .first<{ n: number }>();
    return { series: (rows.results ?? []).map((r) => ({ t: r.t, churned: num(r.n) })), blocked: num(blocked?.n) };
  });

  const adSpend = await section('adSpend', async () => {
    const rows = await db
      .prepare(
        `SELECT ${bucketOf('date', g)} AS t, SUM(cost_yen) AS cost, SUM(clicks) AS clicks, SUM(impressions) AS impressions
         FROM furim_ad_spend WHERE date BETWEEN ? AND ? GROUP BY t`,
      )
      .bind(from, today)
      .all<{ t: string; cost: number; clicks: number; impressions: number }>();
    const last = await db.prepare('SELECT MAX(imported_at) AS m FROM furim_ad_spend').first<{ m: string | null }>();
    return {
      series: (rows.results ?? []).map((r) => ({
        t: r.t,
        cost: num(r.cost),
        clicks: num(r.clicks),
        impressions: num(r.impressions),
      })),
      lastImportedAt: last?.m ?? null,
    };
  });

  const trial = await section('trial', async () => {
    const soon = new Date(Date.parse(`${today}T00:00:00+09:00`) + 3 * 86400_000).toISOString().slice(0, 10);
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS active,
                SUM(CASE WHEN ${dayOf('subscription_end_at')} <= ? THEN 1 ELSE 0 END) AS ending
         FROM furim_customers
         WHERE TRIM(COALESCE(plan_label, '')) = ''
           AND subscription_end_at IS NOT NULL AND ${secOf('subscription_end_at')} > ?
           ${exclude('line_user_id')}`,
      )
      .bind(soon, now19, ...EXCLUDED)
      .first<{ active: number; ending: number }>();
    return { active: num(row?.active), endingSoon: num(row?.ending) };
  });

  const anomalies = await section('anomalies', async () => {
    const items: Array<{ kind: string; label: string; count: number; since: string | null; href: string }> = [];
    const add = async (
      kind: string,
      label: string,
      href: string,
      sql: string,
      binds: unknown[] = [],
    ): Promise<void> => {
      const r = await db.prepare(sql).bind(...binds).first<{ n: number; since: string | null }>();
      if (num(r?.n) > 0) items.push({ kind, label, count: num(r?.n), since: r?.since ?? null, href });
    };

    await add(
      'gas_retry_pending', '同期の保留ジョブ', '/data/table?name=gas_retry_jobs',
      "SELECT COUNT(*) AS n, MIN(created_at) AS since FROM gas_retry_jobs WHERE status = 'pending'",
    );
    await add(
      'gas_retry_failed', '同期の失敗ジョブ', '/data/table?name=gas_retry_jobs',
      "SELECT COUNT(*) AS n, MIN(updated_at) AS since FROM gas_retry_jobs WHERE status = 'failed'",
    );
    await add(
      'plan_change_alert', '未反映のプラン変更', '/data/table?name=plan_builder_intents',
      "SELECT COUNT(*) AS n, MIN(created_at) AS since FROM plan_builder_intents WHERE stage LIKE 'watch:alert:%'",
    );
    await add(
      'sync_diff', 'シートと D1 の差分', '/data/table?name=furim_sync_diffs',
      'SELECT COUNT(*) AS n, MIN(first_seen_at) AS since FROM furim_sync_diffs WHERE resolved_at IS NULL',
    );
    await add(
      'stripe_pending', 'Stripe イベントの滞留', '/data/table?name=stripe_events',
      "SELECT COUNT(*) AS n, MIN(processed_at) AS since FROM stripe_events WHERE status IN ('pending','failed')",
    );
    await add(
      'delivery_pending', '送信が確認できていない配信', '/data/table?name=stripe_processed_actions',
      "SELECT COUNT(*) AS n, MIN(created_at) AS since FROM stripe_processed_actions WHERE status = 'pending'",
    );
    await add(
      'ad_cv_failed', '広告 CV 送信の失敗', '/data/table?name=ad_conversion_logs',
      "SELECT COUNT(*) AS n, MIN(created_at) AS since FROM ad_conversion_logs WHERE status <> 'sent'",
    );
    await add(
      'ext_errors', '拡張のエラー（直近 24 時間）', '/data/table?name=furim_ext_errors',
      `SELECT COUNT(*) AS n, MIN(created_at) AS since FROM furim_ext_errors WHERE ${secOf('created_at')} >= ?`,
      [new Date(Date.parse(now.slice(0, 19) + '+09:00') - 86400_000).toISOString().slice(0, 19)],
    );

    // 広告費の取り込みが止まっていないか（自動実行が死んでも気づけるように）
    const lastAd = await db.prepare('SELECT MAX(date) AS d FROM furim_ad_spend').first<{ d: string | null }>();
    const staleDays = lastAd?.d
      ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastAd.d}T00:00:00Z`)) / 86400_000)
      : null;
    if (staleDays === null || staleDays >= 2) {
      items.push({
        kind: 'ad_spend_stale',
        label: lastAd?.d ? `広告費が ${staleDays} 日更新されていない（最終 ${lastAd.d}）` : '広告費がまだ 1 件も取り込まれていない',
        count: staleDays ?? 0,
        since: lastAd?.d ?? null,
        href: '/data/table?name=furim_ad_spend',
      });
    }

    // 初回課金の数え方のズレ（billing_reason が空の古い行の取りこぼしを黙って見逃さない）
    const gap = await db
      .prepare(
        `SELECT
           (SELECT COUNT(DISTINCT line_user_id) FROM furim_payments WHERE actual_paid_amount > 0 AND line_user_id IS NOT NULL) AS payers,
           (SELECT COUNT(DISTINCT line_user_id) FROM furim_payments WHERE actual_paid_amount > 0 AND line_user_id IS NOT NULL AND billing_reason = 'subscription_create') AS created`,
      )
      .first<{ payers: number; created: number }>();
    const diff = num(gap?.payers) - num(gap?.created);
    if (diff > 0) {
      items.push({
        kind: 'first_paid_gap',
        label: `初回課金を特定できない人が ${diff} 人（billing_reason が空の古い行）`,
        count: diff,
        since: null,
        href: '/data/table?name=furim_payments',
      });
    }

    return { items };
  });

  return c.json({ success: true, range, sections: { friends, revenue, churn, adSpend, trial, anomalies } });
});

type AdSpendRow = {
  date?: string;
  source?: string;
  campaign_id?: string | number;
  campaign_name?: string | null;
  cost_yen?: number;
  clicks?: number | null;
  impressions?: number | null;
};

// POST /api/furim/ad-spend/import — 日次の広告費を upsert（GoogleAds/ad_spend_to_d1.py が叩く）
furimDashboard.post('/api/furim/ad-spend/import', async (c) => {
  const body = await c.req.json<{ rows?: AdSpendRow[] }>().catch(() => ({ rows: undefined }));
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) return c.json({ success: false, error: 'rows が空です' }, 400);
  if (rows.length > 500) return c.json({ success: false, error: 'rows は 500 件までです' }, 400);

  const now = jstNow();
  const stmts = [];
  for (const r of rows) {
    const date = String(r.date ?? '').slice(0, 10);
    const source = String(r.source ?? 'google');
    const campaignId = String(r.campaign_id ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !campaignId) {
      return c.json({ success: false, error: `date か campaign_id が不正です: ${date} / ${campaignId}` }, 400);
    }
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO furim_ad_spend (date, source, campaign_id, campaign_name, cost_yen, clicks, impressions, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(date, source, campaign_id) DO UPDATE SET
           campaign_name = excluded.campaign_name,
           cost_yen = excluded.cost_yen,
           clicks = excluded.clicks,
           impressions = excluded.impressions,
           imported_at = excluded.imported_at`,
      ).bind(date, source, campaignId, r.campaign_name ?? null, Math.round(Number(r.cost_yen ?? 0)), r.clicks ?? null, r.impressions ?? null, now),
    );
  }
  await c.env.DB.batch(stmts);
  return c.json({ success: true, upserted: stmts.length, importedAt: now });
});
