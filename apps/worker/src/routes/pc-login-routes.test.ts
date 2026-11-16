import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// PC の QR 画面に「このパソコンで LINE にログイン」→ /auth/oauth → /auth/callback で友だちか確かめる（TB-3475）。

const dbMocks = {
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
  getEntryRouteByRefCode: vi.fn().mockResolvedValue(null),
  getAffiliateLinkByRefCode: vi.fn().mockResolvedValue(null),
  getTrafficPoolBySlug: vi.fn().mockResolvedValue(null),
  getTrafficPoolById: vi.fn().mockResolvedValue(null),
  getRandomPoolAccount: vi.fn().mockResolvedValue(null),
  getPoolAccounts: vi.fn().mockResolvedValue([]),
  getLineAccountById: vi.fn().mockResolvedValue(null),
  getLineAccountByChannelId: vi.fn().mockResolvedValue(null),
  getFriendByLineUserId: vi.fn(),
  upsertFriend: vi.fn(),
  createUser: vi.fn().mockResolvedValue({ id: 'user-1' }),
  getUserByEmail: vi.fn().mockResolvedValue(null),
  linkFriendToUser: vi.fn(),
  recordRefTracking: vi.fn(),
  getScenarios: vi.fn().mockResolvedValue([]),
  getTrackedLinkById: vi.fn().mockResolvedValue(null),
  getMessageTemplateById: vi.fn().mockResolvedValue(null),
  getAffiliateOfferById: vi.fn().mockResolvedValue(null),
  getAffiliateById: vi.fn().mockResolvedValue(null),
  addTagToFriend: vi.fn(),
  jstNow: () => '2026-11-16 00:00:00',
};
vi.mock('@line-crm/db', () => dbMocks);

const worker = (await import('../index.js')).default;

let sqls: { sql: string; args: unknown[] }[] = [];
const DB = {
  prepare: (sql: string) => {
    const stmt = {
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
      all: async () => ({ results: [] }),
      bind: (...args: unknown[]) => {
        sqls.push({ sql, args });
        return stmt;
      },
    };
    return stmt;
  },
} as unknown as D1Database;

const env = {
  DB,
  LIFF_URL: 'https://liff.line.me/1000000000-DefaultAA',
  WORKER_URL: 'https://worker.example.com',
  WORKER_PUBLIC_URL: 'https://line-harness-prod.example.workers.dev',
  LINE_LOGIN_CHANNEL_ID: '2000000000',
  LINE_LOGIN_CHANNEL_SECRET: 'secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-token',
};

const PC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function get(url: string) {
  return worker.fetch(
    new Request(url, { headers: { 'user-agent': PC_UA } }),
    env as unknown as import('../index.js').Env['Bindings'],
    ctx,
  );
}

function pcLoginHref(html: string): URL {
  const m = html.match(/href="([^"]+)" class="pc-login"/);
  expect(m).not.toBeNull();
  return new URL(m![1].replace(/&amp;/g, '&'));
}

const lpEvents = () => sqls.filter((s) => s.sql.includes('INSERT INTO lp_events')).map((s) => s.args[2]);
const state = (o: Record<string, string>) => btoa(JSON.stringify(o));

function mockLine(friendFlag: boolean | null) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/oauth2/v2.1/token')) return Response.json({ access_token: 'at', id_token: 'it', token_type: 'Bearer' });
    if (url.includes('/oauth2/v2.1/verify')) return Response.json({ sub: 'Uaaa', name: 'テスト' });
    if (url.includes('/v2/profile')) return Response.json({ userId: 'Uaaa', displayName: 'テスト' });
    if (url.includes('/friendship/v1/status')) {
      return friendFlag === null ? new Response('x', { status: 500 }) : Response.json({ friendFlag });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  sqls = [];
  dbMocks.getFriendByLineUserId.mockReset();
  dbMocks.upsertFriend.mockReset();
  dbMocks.upsertFriend.mockResolvedValue({ id: 'f-1', line_user_id: 'Uaaa', is_following: 1, user_id: null, metadata: '{}' });
});
afterEach(() => vi.unstubAllGlobals());

describe('PC の QR 画面のボタン', () => {
  it('/r/:ref に QR とボタンがあり、ボタンは Worker の /auth/oauth へ ref・sid・広告 ID を渡す', async () => {
    const res = await get('https://furimauto.com/r/org_seo?sid=S1&gclid=G1');
    const html = await res.text();
    expect(html).toContain('/api/qr?');
    const u = pcLoginHref(html);
    expect(u.origin + u.pathname).toBe('https://line-harness-prod.example.workers.dev/auth/oauth');
    expect(u.searchParams.get('ref')).toBe('org_seo');
    expect(u.searchParams.get('sid')).toBe('S1');
    expect(u.searchParams.get('gclid')).toBe('G1');
    expect(u.searchParams.get('via')).toBe('pc_qr');
  });

  it('/r/:ref に sid が無くても、QR と同じ発行済み sid をボタンに渡す', async () => {
    const html = await (await get('https://furimauto.com/r/org_seo')).text();
    const sid = pcLoginHref(html).searchParams.get('sid');
    expect(sid).toBeTruthy();
    expect(html).toContain(`sid%3D${sid}`);
  });

  it('/auth/line の PC 画面にもボタンがあり、sid が無ければ発行して auth_hit を残す', async () => {
    const html = await (await get('https://line-harness-prod.example.workers.dev/auth/line?ref=ext_welcome')).text();
    const u = pcLoginHref(html);
    expect(u.searchParams.get('ref')).toBe('ext_welcome');
    expect(u.searchParams.get('sid')).toBeTruthy();
    expect(lpEvents()).toContain('auth_hit');
  });
});

describe('/auth/oauth', () => {
  it('via=pc_qr を state に入れ、oauth_start を残す', async () => {
    const res = await get('https://line-harness-prod.example.workers.dev/auth/oauth?ref=org_seo&sid=S1&via=pc_qr');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('bot_prompt')).toBe('aggressive');
    expect(JSON.parse(atob(loc.searchParams.get('state')!)).via).toBe('pc_qr');
    expect(lpEvents()).toContain('oauth_start');
  });
});

describe('/auth/callback', () => {
  const cb = (q: string) => get(`https://line-harness-prod.example.workers.dev/auth/callback?${q}`);
  const pcState = state({ ref: 'org_seo', sid: 'S1', via: 'pc_qr' });

  it('友だち追加を飛ばした人は friends を作らず、同意画面を出し直すボタンを見せる', async () => {
    mockLine(false);
    dbMocks.getFriendByLineUserId.mockResolvedValue(null);
    const html = await (await cb(`code=c&state=${encodeURIComponent(pcState)}`)).text();
    expect(html).toContain('友だち追加がまだです');
    expect(html).toContain('prompt=consent');
    expect(dbMocks.upsertFriend).not.toHaveBeenCalled();
    expect(lpEvents()).toEqual(['oauth_done']);
  });

  it('新規で友だちになった人は friends を作り pendingFollow を付け、完了画面を見せる', async () => {
    mockLine(true);
    dbMocks.getFriendByLineUserId.mockResolvedValue(null);
    const html = await (await cb(`code=c&state=${encodeURIComponent(pcState)}`)).text();
    expect(html).toContain('登録完了');
    expect(dbMocks.upsertFriend).toHaveBeenCalled();
    expect(sqls.some((s) => s.sql.includes('pendingFollow'))).toBe(true);
    expect(lpEvents()).toEqual(['oauth_done', 'oauth_friend']);
  });

  it('既に友だちの人は pendingFollow を付けず、oauth_friend も数えない', async () => {
    mockLine(true);
    dbMocks.getFriendByLineUserId.mockResolvedValue({ id: 'f-1', is_following: 1 });
    const html = await (await cb(`code=c&state=${encodeURIComponent(pcState)}`)).text();
    expect(html).toContain('登録完了');
    expect(sqls.some((s) => s.sql.includes('pendingFollow'))).toBe(false);
    expect(lpEvents()).toEqual(['oauth_done']);
  });

  it('友だちか確かめられないときは今までどおり進める', async () => {
    mockLine(null);
    dbMocks.getFriendByLineUserId.mockResolvedValue(null);
    await cb(`code=c&state=${encodeURIComponent(pcState)}`);
    expect(dbMocks.upsertFriend).toHaveBeenCalled();
  });

  it('ログイン画面でやめた人（error=access_denied）にはもう一度進むボタンを見せる', async () => {
    mockLine(true);
    const html = await (await cb(`error=access_denied&state=${encodeURIComponent(pcState)}`)).text();
    expect(html).toContain('途中で止まりました');
    expect(html).toContain('prompt=consent');
    expect(lpEvents()).toEqual(['oauth_done']);
  });

  it('PC のボタン以外から来た人のやめた画面は今までどおり', async () => {
    const html = await (await cb(`error=access_denied&state=${encodeURIComponent(state({ ref: 'x' }))}`)).text();
    expect(html).toContain('エラー');
  });
});
