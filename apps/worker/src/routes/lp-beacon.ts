import { Hono } from 'hono';
import type { Env } from '../index.js';

/**
 * POST /api/lp-beacon — FurimAuto 静的LPの行動計測ビーコン（認証不要）
 *
 * furimauto.com の js/lp-metrics.js から navigator.sendBeacon で届く。
 * sendBeacon は text/plain で送るため preflight が発生せず、レスポンスも
 * 読まれない（opaque）。よって CORS ヘッダは不要で、常に 204 を返す。
 *
 * page は location.pathname をそのまま受けるので、新しいLPを
 * /lp/ 配下に置くだけで自動的に計測対象になる（サーバ側設定不要）。
 * 不正なペイロードは黙って捨てる（攻撃者にバリデーション詳細を返さない）。
 */

const MAX_EVENTS = 20;
const MAX_STR = 200;

const ALLOWED_EVENT_TYPES = new Set(['view', 'summary', 'cta']);

function allowedPage(page: string): boolean {
  return page.startsWith('/lp/') || page.startsWith('/service/');
}

function clampStr(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  return v.slice(0, MAX_STR);
}

function clampInt(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(min, Math.min(max, Math.round(v)));
}

const lpBeacon = new Hono<Env>();

lpBeacon.post('/api/lp-beacon', async (c) => {
  try {
    // sendBeacon は Blob(text/plain) で送るため c.req.json() ではなく text で受ける
    const raw = await c.req.text();
    if (!raw || raw.length > 10_000) return c.body(null, 204);

    let body: {
      sid?: unknown;
      page?: unknown;
      events?: unknown;
      ref?: unknown;
      hasClickId?: unknown;
      utmCampaign?: unknown;
      utmContent?: unknown;
      mobile?: unknown;
    };
    try {
      body = JSON.parse(raw);
    } catch {
      return c.body(null, 204);
    }

    const sid = clampStr(body.sid);
    const page = clampStr(body.page);
    if (!sid || !page || !allowedPage(page)) return c.body(null, 204);
    if (!Array.isArray(body.events) || body.events.length === 0) return c.body(null, 204);

    const ref = clampStr(body.ref);
    const hasClickId = body.hasClickId ? 1 : 0;
    const utmCampaign = clampStr(body.utmCampaign);
    const utmContent = clampStr(body.utmContent);
    const isMobile = body.mobile ? 1 : 0;

    const stmt = c.env.DB.prepare(
      `INSERT INTO lp_events
       (session_id, page, event_type, max_scroll_pct, ms_on_page,
        ref, has_click_id, utm_campaign, utm_content, is_mobile)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const batch = [];
    for (const ev of body.events.slice(0, MAX_EVENTS)) {
      if (typeof ev !== 'object' || ev === null) continue;
      const e = ev as { type?: unknown; scroll?: unknown; ms?: unknown };
      const type = typeof e.type === 'string' && ALLOWED_EVENT_TYPES.has(e.type) ? e.type : null;
      if (!type) continue;
      batch.push(
        stmt.bind(
          sid,
          page,
          type,
          clampInt(e.scroll, 0, 100),
          clampInt(e.ms, 0, 24 * 60 * 60 * 1000),
          ref,
          hasClickId,
          utmCampaign,
          utmContent,
          isMobile,
        ),
      );
    }
    if (batch.length > 0) await c.env.DB.batch(batch);

    return c.body(null, 204);
  } catch (err) {
    console.error('POST /api/lp-beacon error:', err);
    return c.body(null, 204);
  }
});

export { lpBeacon };
