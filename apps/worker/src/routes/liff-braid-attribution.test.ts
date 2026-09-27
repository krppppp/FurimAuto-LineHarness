import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Local Worker requests only. LINE verification is mocked; no external CV is sent.

const dbMocks = {
  // eager module-load deps
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
  // /auth/callback deps
  getFriendByLineUserId: vi.fn(),
  upsertFriend: vi.fn(),
  createUser: vi.fn().mockResolvedValue({ id: 'U-uuid' }),
  getUserByEmail: vi.fn().mockResolvedValue(null),
  linkFriendToUser: vi.fn().mockResolvedValue(undefined),
  getEntryRouteByRefCode: vi.fn().mockResolvedValue(null),
  recordRefTracking: vi.fn().mockResolvedValue(undefined),
  getTrackedLinkById: vi.fn().mockResolvedValue(null),
  getMessageTemplateById: vi.fn().mockResolvedValue(null),
  getAffiliateLinkByRefCode: vi.fn().mockResolvedValue(null),
  getAffiliateOfferById: vi.fn().mockResolvedValue(null),
  getAffiliateById: vi.fn().mockResolvedValue(null),
  addTagToFriend: vi.fn().mockResolvedValue(undefined),
  getLineAccountByChannelId: vi.fn().mockResolvedValue(null),
  getLineAccountById: vi.fn().mockResolvedValue(null),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
  getScenarios: vi.fn().mockResolvedValue([]),
  enrollFriendInScenario: vi.fn().mockResolvedValue(null),
  getScenarioSteps: vi.fn().mockResolvedValue([]),
  getTrafficPoolBySlug: vi.fn().mockResolvedValue(null),
  getTrafficPoolById: vi.fn().mockResolvedValue(null),
  getRandomPoolAccount: vi.fn().mockResolvedValue(null),
  getPoolAccounts: vi.fn().mockResolvedValue([]),
  jstNow: () => '2026-07-07 00:00:00',
};
vi.mock('@line-crm/db', () => dbMocks);

const notifyAffiliateFriendAdd = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/affiliate-notifier.js', () => ({ notifyAffiliateFriendAdd }));

const worker = (await import('../index.js')).default;

// No-op prepared statement chain; the callback's raw UPDATE/SELECT statements
// don't matter for the notification assertions.
const DB = {
  prepare: () => ({
    first: async () => null,
    bind: () => ({
      run: async () => ({ meta: { changes: 0 } }),
      first: async () => null,
      all: async () => ({ results: [] }),
    }),
  }),
} as unknown as D1Database;

const env = {
  DB,
  LIFF_URL: 'https://liff.line.me/1000000000-DefaultAA',
  WORKER_URL: 'https://worker.example.com',
  LINE_LOGIN_CHANNEL_ID: '2000000000',
  LINE_LOGIN_CHANNEL_SECRET: 'secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-token',
} as unknown as import('../index.js').Env['Bindings'];

function installFetchMock() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://api.line.me/oauth2/v2.1/token') {
        return new Response(
          JSON.stringify({ access_token: 'at', id_token: 'idt', token_type: 'Bearer' }),
          { status: 200 },
        );
      }
      if (url === 'https://api.line.me/oauth2/v2.1/verify') {
        return new Response(JSON.stringify({ sub: 'U-new-friend', name: 'Tester' }), {
          status: 200,
        });
      }
      if (url === 'https://api.line.me/v2/profile') {
        return new Response(
          JSON.stringify({ userId: 'U-new-friend', displayName: 'Tester' }),
          { status: 200 },
        );
      }
      // bot/info etc → 404 so the handler falls through to the completion page
      return new Response('not found', { status: 404 });
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  installFetchMock();
  dbMocks.createUser.mockResolvedValue({ id: 'U-uuid' });
  dbMocks.upsertFriend.mockResolvedValue({
    id: 'F-new',
    line_user_id: 'U-new-friend',
    line_account_id: null,
    user_id: null,
  });
});


afterEach(() => vi.unstubAllGlobals());
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
function request(path: string, init?: RequestInit) {
  return worker.fetch(new Request(`https://worker.example.com${path}`, init), env, ctx);
}

describe('braid attribution through auth and LIFF', () => {
  it.each(['gbraid', 'wbraid'])('carries %s through desktop QR and OAuth state to ref_tracking', async (key) => {
    dbMocks.getFriendByLineUserId.mockResolvedValue(null);
    const entry = await request(`/auth/line?ref=ad_google_search&${key}=TEST123`);
    expect(entry.status).toBe(200);
    const html = await entry.text();
    const qrTarget = new URL(decodeURIComponent(html.match(/data=([^"]+)/)![1]));
    expect(qrTarget.searchParams.get(key)).toBe('TEST123');
    const oauth = await request(`/auth/oauth?${qrTarget.searchParams}`);
    const oauthUrl = oauth.headers.get('location')!;
    const state = new URL(oauthUrl).searchParams.get('state')!;
    expect(JSON.parse(atob(state))[key]).toBe('TEST123');
    const res = await request(`/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('エラー');
    expect(dbMocks.recordRefTracking).toHaveBeenCalledWith(DB, expect.objectContaining({ refCode: 'ad_google_search', [key]: 'TEST123', friendId: 'F-new' }));
    expect(html).toContain(`${key}%3DTEST123`); // QR target
  });

  it.each(['gbraid', 'wbraid'])('carries %s through mobile /r and LIFF link', async (key) => {
    dbMocks.getFriendByLineUserId.mockResolvedValue({ id: 'F-new', user_id: 'U-uuid' });
    const entry = await request(`/auth/line?ref=ad_google_search&${key}=TEST123`, { headers: { 'user-agent': 'iPhone' } });
    expect(entry.status).toBe(302);
    const location = entry.headers.get('location')!;
    expect(location).toContain(`${key}=TEST123`);
    const landing = await request(location, { headers: { 'user-agent': 'iPhone' } });
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain(`${key}=TEST123`);
    const res = await request('/api/liff/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: 'mock', ref: 'ad_google_search', [key]: 'TEST123' }) });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('エラー');
    expect(dbMocks.recordRefTracking).toHaveBeenCalledWith(DB, expect.objectContaining({ [key]: 'TEST123' }));
  });

  it('preserves both braid IDs through forced OAuth', async () => {
    const res = await request('/auth/oauth?ref=ad_google_search&gbraid=GB&wbraid=WB');
    expect(res.status).toBe(302);
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    expect(JSON.parse(atob(state))).toMatchObject({ gbraid: 'GB', wbraid: 'WB' });
  });
});
