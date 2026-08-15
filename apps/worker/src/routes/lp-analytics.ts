import { Hono } from 'hono';
import type { Env } from '../index.js';

/**
 * LP行動分析API（管理画面「LP分析」用・要認証）
 *
 * データ源: lp_events（js/lp-metrics.js のビーコン） + ref_tracking.lp_session_id
 * （友だち追加との接続）。セッション集計は lp_events を session_id で GROUP BY し、
 * summary イベントの MAX(max_scroll_pct)/MAX(ms_on_page) を採用する
 * （summary は visibilitychange 毎に重複送信されうる設計のため）。
 *
 * - GET /api/analytics/lp-pages  — 全LP横並び一覧（pageはGROUP BYで自動列挙）
 * - GET /api/analytics/lp-detail — 1LPの深掘り
 */

interface RangeFilter {
  from: string; // YYYY-MM-DD (JST想定・そのまま文字列比較)
  to: string;
  srcCond: string; // SQL condition fragment for ad/organic
}

function parseFilters(q: (k: string) => string | undefined): RangeFilter {
  const from = (q('from') || '2026-01-01').slice(0, 10);
  const to = (q('to') || '2099-12-31').slice(0, 10);
  const src = q('src') || 'all';
  const srcCond =
    src === 'ad' ? 'AND s.has_click_id = 1' : src === 'organic' ? 'AND s.has_click_id = 0' : '';
  return { from, to, srcCond };
}

/**
 * セッション単位のサブクエリ。1行=1セッション。
 * cta_clicked: cta イベントが1つでもあれば1
 * friend_added: ref_tracking に lp_session_id が一致し friend_id が付いた行があれば1
 */
function sessionCte(f: RangeFilter): string {
  return `
    WITH sessions AS (
      SELECT
        e.session_id,
        e.page,
        MAX(e.has_click_id) AS has_click_id,
        MAX(e.is_mobile) AS is_mobile,
        MAX(CASE WHEN e.event_type = 'cta' THEN 1 ELSE 0 END) AS cta_clicked,
        COALESCE(MAX(CASE WHEN e.event_type = 'summary' THEN e.max_scroll_pct END), 0) AS max_scroll,
        COALESCE(MAX(CASE WHEN e.event_type = 'summary' THEN e.ms_on_page END), 0) AS ms_on_page,
        MAX(e.utm_campaign) AS utm_campaign,
        MAX(e.utm_content) AS utm_content,
        MIN(e.created_at) AS started_at,
        EXISTS(
          SELECT 1 FROM ref_tracking rt
          WHERE rt.lp_session_id = e.session_id AND rt.friend_id IS NOT NULL
        ) AS friend_added
      FROM lp_events e
      WHERE date(e.created_at) BETWEEN ? AND ?
      GROUP BY e.session_id, e.page
    )
  `;
}

const lpAnalytics = new Hono<Env>();

// GET /api/analytics/lp-pages — 一覧（リーダーボード）
lpAnalytics.get('/api/analytics/lp-pages', async (c) => {
  try {
    const f = parseFilters((k) => c.req.query(k));
    const rows = await c.env.DB.prepare(
      `${sessionCte(f)}
       SELECT
         s.page,
         COUNT(*) AS sessions,
         SUM(s.has_click_id) AS ad_sessions,
         SUM(s.is_mobile) AS mobile_sessions,
         SUM(s.cta_clicked) AS cta_sessions,
         SUM(s.friend_added) AS friend_adds,
         SUM(CASE WHEN s.max_scroll >= 50 THEN 1 ELSE 0 END) AS scroll50,
         SUM(CASE WHEN s.max_scroll >= 90 THEN 1 ELSE 0 END) AS scroll90,
         SUM(CASE WHEN s.ms_on_page > 0 AND s.ms_on_page < 3000 THEN 1 ELSE 0 END) AS bounce3s,
         ROUND(AVG(s.ms_on_page)) AS avg_ms,
         MAX(s.started_at) AS last_seen_at
       FROM sessions s
       WHERE 1=1 ${f.srcCond}
       GROUP BY s.page
       ORDER BY sessions DESC`,
    )
      .bind(f.from, f.to)
      .all();

    const data = (rows.results ?? []).map((r) => ({
      page: r.page,
      sessions: r.sessions,
      adSessions: r.ad_sessions,
      mobileSessions: r.mobile_sessions,
      ctaSessions: r.cta_sessions,
      friendAdds: r.friend_adds,
      scroll50: r.scroll50,
      scroll90: r.scroll90,
      bounce3s: r.bounce3s,
      avgMs: r.avg_ms,
      lastSeenAt: r.last_seen_at,
    }));
    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/analytics/lp-pages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/analytics/lp-detail?page= — 1LPの深掘り
lpAnalytics.get('/api/analytics/lp-detail', async (c) => {
  try {
    const page = c.req.query('page') || '';
    if (!page) return c.json({ success: false, error: 'page is required' }, 400);
    const f = parseFilters((k) => c.req.query(k));
    const cte = sessionCte(f);
    const db = c.env.DB;

    // スクロール到達ファネル + 深度別の追加率クロス
    const scrollBuckets = await db
      .prepare(
        `${cte}
         SELECT
           COUNT(*) AS sessions,
           SUM(s.cta_clicked) AS cta_sessions,
           SUM(s.friend_added) AS friend_adds,
           SUM(CASE WHEN s.max_scroll >= 25 THEN 1 ELSE 0 END) AS reach25,
           SUM(CASE WHEN s.max_scroll >= 50 THEN 1 ELSE 0 END) AS reach50,
           SUM(CASE WHEN s.max_scroll >= 75 THEN 1 ELSE 0 END) AS reach75,
           SUM(CASE WHEN s.max_scroll >= 90 THEN 1 ELSE 0 END) AS reach90,
           SUM(CASE WHEN s.max_scroll >= 75 AND s.friend_added THEN 1 ELSE 0 END) AS deep_friend_adds,
           SUM(CASE WHEN s.max_scroll < 75 AND s.friend_added THEN 1 ELSE 0 END) AS shallow_friend_adds,
           SUM(s.has_click_id) AS ad_sessions,
           SUM(CASE WHEN s.has_click_id AND s.friend_added THEN 1 ELSE 0 END) AS ad_friend_adds,
           SUM(s.is_mobile) AS mobile_sessions,
           SUM(CASE WHEN s.is_mobile AND s.cta_clicked THEN 1 ELSE 0 END) AS mobile_cta
         FROM sessions s WHERE s.page = ? ${f.srcCond}`,
      )
      .bind(f.from, f.to, page)
      .first();

    // 滞在時間分布（FV即離脱の可視化）
    const timeBuckets = await db
      .prepare(
        `${cte}
         SELECT
           SUM(CASE WHEN s.ms_on_page < 3000 THEN 1 ELSE 0 END) AS under3s,
           SUM(CASE WHEN s.ms_on_page >= 3000 AND s.ms_on_page < 10000 THEN 1 ELSE 0 END) AS under10s,
           SUM(CASE WHEN s.ms_on_page >= 10000 AND s.ms_on_page < 30000 THEN 1 ELSE 0 END) AS under30s,
           SUM(CASE WHEN s.ms_on_page >= 30000 AND s.ms_on_page < 60000 THEN 1 ELSE 0 END) AS under60s,
           SUM(CASE WHEN s.ms_on_page >= 60000 THEN 1 ELSE 0 END) AS over60s
         FROM sessions s WHERE s.page = ? ${f.srcCond}`,
      )
      .bind(f.from, f.to, page)
      .first();

    // 日別推移
    const daily = await db
      .prepare(
        `${cte}
         SELECT date(s.started_at) AS day,
                COUNT(*) AS sessions,
                SUM(s.cta_clicked) AS cta_sessions,
                SUM(s.friend_added) AS friend_adds
         FROM sessions s WHERE s.page = ? ${f.srcCond}
         GROUP BY day ORDER BY day`,
      )
      .bind(f.from, f.to, page)
      .all();

    // 広告バリアント別（utm_campaign / utm_content）
    const variants = await db
      .prepare(
        `${cte}
         SELECT COALESCE(s.utm_campaign, '(none)') AS utm_campaign,
                COALESCE(s.utm_content, '(none)') AS utm_content,
                COUNT(*) AS sessions,
                SUM(s.cta_clicked) AS cta_sessions,
                SUM(s.friend_added) AS friend_adds,
                SUM(CASE WHEN s.max_scroll >= 50 THEN 1 ELSE 0 END) AS scroll50
         FROM sessions s WHERE s.page = ? ${f.srcCond}
         GROUP BY s.utm_campaign, s.utm_content
         ORDER BY sessions DESC LIMIT 50`,
      )
      .bind(f.from, f.to, page)
      .all();

    const sb = scrollBuckets as Record<string, number> | null;
    const tb = timeBuckets as Record<string, number> | null;
    return c.json({
      success: true,
      data: {
        page,
        totals: {
          sessions: sb?.sessions ?? 0,
          ctaSessions: sb?.cta_sessions ?? 0,
          friendAdds: sb?.friend_adds ?? 0,
          adSessions: sb?.ad_sessions ?? 0,
          adFriendAdds: sb?.ad_friend_adds ?? 0,
          mobileSessions: sb?.mobile_sessions ?? 0,
          mobileCta: sb?.mobile_cta ?? 0,
        },
        scrollFunnel: {
          reach25: sb?.reach25 ?? 0,
          reach50: sb?.reach50 ?? 0,
          reach75: sb?.reach75 ?? 0,
          reach90: sb?.reach90 ?? 0,
          deepFriendAdds: sb?.deep_friend_adds ?? 0,
          shallowFriendAdds: sb?.shallow_friend_adds ?? 0,
        },
        timeBuckets: {
          under3s: tb?.under3s ?? 0,
          under10s: tb?.under10s ?? 0,
          under30s: tb?.under30s ?? 0,
          under60s: tb?.under60s ?? 0,
          over60s: tb?.over60s ?? 0,
        },
        daily: (daily.results ?? []).map((r) => ({
          day: r.day,
          sessions: r.sessions,
          ctaSessions: r.cta_sessions,
          friendAdds: r.friend_adds,
        })),
        variants: (variants.results ?? []).map((r) => ({
          utmCampaign: r.utm_campaign,
          utmContent: r.utm_content,
          sessions: r.sessions,
          ctaSessions: r.cta_sessions,
          friendAdds: r.friend_adds,
          scroll50: r.scroll50,
        })),
      },
    });
  } catch (err) {
    console.error('GET /api/analytics/lp-detail error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { lpAnalytics };
