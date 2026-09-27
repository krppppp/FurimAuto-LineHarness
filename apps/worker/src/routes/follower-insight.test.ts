import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { followerInsight } from './follower-insight.js';
import { authMiddleware } from '../middleware/auth.js';
import type { Env } from '../index.js';

vi.mock('@line-crm/db', () => ({ getStaffByApiKey: vi.fn(async () => null) }));
const fetchMock = vi.fn();
const env = { API_KEY: 'test-admin', LINE_CHANNEL_ACCESS_TOKEN: 'test-line' } as Env['Bindings'];
const app = new Hono<Env>();
app.use('*', authMiddleware);
app.route('/', followerInsight);
const request = (query = 'from=20260913&to=20260913', bindings = env, headers = { Authorization: 'Bearer test-admin' }) =>
  app.request(`/api/follower-insight?${query}`, { headers }, bindings);
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-26T15:00:00Z'));
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('default follower insight', () => {
  it('requires existing admin auth before contacting LINE', async () => {
    expect((await request(undefined, env, { Authorization: '' })).status).toBe(401);
    expect((await request(undefined, env, { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('uses default token without D1 and requests every inclusive date once', async () => {
    fetchMock.mockImplementation(async () => response({ status: 'ready', followers: 21, targetedReaches: 20, blocks: 0 }));
    const res = await request('from=20260913&to=20260926');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[] };
    expect(body.data).toHaveLength(14);
    expect(fetchMock).toHaveBeenCalledTimes(14);
    for (let i = 0; i < 14; i++) {
      expect(fetchMock).toHaveBeenNthCalledWith(i + 1, `https://api.line.me/v2/bot/insight/followers?date=202609${13 + i}`, {
        method: 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-line' },
      });
    }
    expect(body.data[0]).toEqual({ date: '20260913', status: 'ready', followers: 21, targetedReaches: 20, blocks: 0 });
  });
  it('preserves unavailable status and uses null rather than zero for missing numbers', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 'unready' }))
      .mockResolvedValueOnce(response({ status: 'out_of_service' }));
    const body = await (await request('from=20260913&to=20260914')).json() as { data: unknown[] };
    expect(body.data).toEqual(['unready', 'out_of_service'].map((status, i) => ({
      date: `202609${13 + i}`, status, followers: null, targetedReaches: null, blocks: null,
    })));
  });
  it.each([
    '', 'from=20260913', 'from=2026-09-13&to=20260914',
    'from=20260230&to=20260301', 'from=20260914&to=20260913',
    'from=20260927&to=20260927', 'from=20260913&to=20260928',
    'from=20260801&to=20260901',
  ])('rejects invalid or excessive ranges: %s', async query => {
    expect((await request(query)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('accepts 31 days across a leap-day boundary', async () => {
    fetchMock.mockImplementation(async () => response({ status: 'ready' }));
    expect((await request('from=20240201&to=20240302')).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(31);
    expect(fetchMock.mock.calls[28][0]).toContain('date=20240229');
  });
  it('fails safely on missing configuration', async () => {
    expect((await request(undefined, { ...env, LINE_CHANNEL_ACCESS_TOKEN: '' })).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([401, 429, 500])('does not leak upstream error content (%s)', async status => {
    fetchMock.mockResolvedValue(new Response('sensitive upstream content', { status }));
    const res = await request();
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('sensitive');
  });
  it('handles network failures without returning partial results', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 'ready', followers: 22 }))
      .mockRejectedValueOnce(new Error('sensitive upstream content'));
    const res = await request('from=20260913&to=20260914');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, error: 'Failed to fetch LINE follower insight' });
  });
});
