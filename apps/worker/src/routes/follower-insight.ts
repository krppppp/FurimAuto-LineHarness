import { Hono } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../index.js';

const followerInsight = new Hono<Env>();
const DAY = 86_400_000;

function parseDate(value: string | undefined): number | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const timestamp = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === iso
    ? timestamp : null;
}

// Protected by the existing app-wide authMiddleware. No D1 account row required.
followerInsight.get('/api/follower-insight', async (c) => {
  const from = parseDate(c.req.query('from'));
  const to = parseDate(c.req.query('to'));
  // LINE insight dates use UTC+9. Only completed calendar days are accepted.
  const todayJst = Math.floor((Date.now() + 9 * 3_600_000) / DAY) * DAY;
  if (from === null || to === null || from > to || to >= todayJst) {
    return c.json({ success: false, error: 'from/to must be valid yyyyMMdd dates, from <= to, and to before today (JST)' }, 400);
  }
  // Bound Worker subrequests; callers can split longer periods.
  if ((to - from) / DAY >= 31) {
    return c.json({ success: false, error: 'Maximum date range is 31 days' }, 400);
  }
  if (!c.env.LINE_CHANNEL_ACCESS_TOKEN) {
    return c.json({ success: false, error: 'Default LINE token is not configured' }, 503);
  }
  const client = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
  try {
    const data = [];
    for (let day = from; day <= to; day += DAY) {
      const date = new Date(day).toISOString().slice(0, 10).replaceAll('-', '');
      const insight = await client.getFollowersInsight(date);
      data.push({
        date,
        status: insight.status,
        followers: typeof insight.followers === 'number' ? insight.followers : null,
        targetedReaches: typeof insight.targetedReaches === 'number' ? insight.targetedReaches : null,
        blocks: typeof insight.blocks === 'number' ? insight.blocks : null,
      });
    }
    return c.json({ success: true, data });
  } catch {
    // Do not expose upstream bodies/errors: they may contain sensitive data.
    return c.json({ success: false, error: 'Failed to fetch LINE follower insight' }, 502);
  }
});

export { followerInsight };
