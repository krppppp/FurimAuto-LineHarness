import { describe, it, expect, vi, beforeEach } from 'vitest';

// TB-1417: LP の CTA を押した人が /auth/line と /r/:ref に届いたかを、ブラウザのビーコンに頼らず
// サーバー側で lp_events に残す。10/8 以降、スマホで押した 5 セッションが /r/ の gate_view を
// 1 件も残さず、「届いていない」のか「ビーコンが落ちた」のかを分けられなかったため。

const dbMocks = {
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
  getEntryRouteByRefCode: vi.fn().mockResolvedValue(null),
  getAffiliateLinkByRefCode: vi.fn().mockResolvedValue(null),
  incrementAffiliateLinkClick: vi.fn().mockResolvedValue(undefined),
  getLineAccountByChannelId: vi.fn().mockResolvedValue(null),
  getLineAccountById: vi.fn().mockResolvedValue(null),
  getTrafficPoolBySlug: vi.fn().mockResolvedValue(null),
  getTrafficPoolById: vi.fn().mockResolvedValue(null),
  getRandomPoolAccount: vi.fn().mockResolvedValue(null),
  getPoolAccounts: vi.fn().mockResolvedValue([]),
  jstNow: () => '2026-10-12T10:00:00.000+09:00',
};
vi.mock('@line-crm/db', () => dbMocks);

const worker = (await import('../index.js')).default;
const { decodeOAuthState } = await import('./liff.js');

type Insert = { sql: string; args: unknown[] };
let inserts: Insert[];
let pending: Promise<unknown>[];

const DB = {
  prepare: (sql: string) => ({
    bind: (...args: unknown[]) => ({
      run: async () => {
        inserts.push({ sql, args });
        return { meta: { changes: 1 } };
      },
      first: async () => null,
      all: async () => ({ results: [] }),
    }),
    first: async () => null,
  }),
} as unknown as D1Database;

const env = {
  DB,
  LIFF_URL: 'https://liff.line.me/1000000000-DefaultAA',
  WORKER_URL: 'https://worker.example.com',
  LINE_LOGIN_CHANNEL_ID: '2000000000',
} as unknown as import('../index.js').Env['Bindings'];

const ctx = {
  waitUntil(p: Promise<unknown>) { pending.push(p); },
  passThroughOnException() {},
} as unknown as ExecutionContext;

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36';

async function get(path: string, ua: string) {
  const res = await worker.fetch(new Request(`https://worker.example.com${path}`, { headers: { 'user-agent': ua } }), env, ctx);
  await Promise.all(pending);
  return res;
}

function hops() {
  return inserts
    .filter((i) => /INSERT INTO lp_events/.test(i.sql))
    .map((i) => {
      const cols = i.sql.match(/\(([^)]*)\)\s*VALUES/)![1].split(',').map((s) => s.trim());
      return Object.fromEntries(cols.map((c, n) => [c, i.args[n]]));
    });
}

beforeEach(() => {
  inserts = [];
  pending = [];
});

describe('TB-1417 サーバー側の到達記録', () => {
  it('スマホで /auth/line に来たら auth_hit を 1 行書き、/r/ へ 302 する', async () => {
    const res = await get('/auth/line?ref=ad_google_search&utm_content=lp_service&gclid=G1&sid=S1', IPHONE);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/r/ad_google_search');
    const rows = hops();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 'S1',
      page: '/r/ad_google_search',
      event_type: 'auth_hit',
      ref: 'ad_google_search',
      has_click_id: 1,
      utm_content: 'lp_service',
      is_mobile: 1,
      created_at: '2026-10-12T10:00:00.000+09:00',
    });
    expect(JSON.parse(String(rows[0].detail)).ua).toContain('iPhone');
  });

  it('PC で /auth/line に来ても auth_hit を書く（QR ページはビーコンが無いので、ここでしか測れない）', async () => {
    const res = await get('/auth/line?ref=ad_google_search&sid=S2', MAC);
    expect(res.status).toBe(200);
    const rows = hops();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: 'S2', event_type: 'auth_hit', is_mobile: 0, has_click_id: 0 });
  });

  it('/r/:ref を表示したら gate_hit を 1 行書く', async () => {
    const res = await get('/r/ad_google_search?utm_content=lp_service&gbraid=B1&sid=S3', IPHONE);
    expect(res.status).toBe(200);
    const rows = hops();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: 'S3', page: '/r/ad_google_search', event_type: 'gate_hit', has_click_id: 1, is_mobile: 1 });
  });

  it('sid が無い（LP を通っていない）ときは書かない', async () => {
    await get('/auth/line?ref=ad_google_search', IPHONE);
    await get('/r/ad_google_search', IPHONE);
    expect(hops()).toHaveLength(0);
  });

  it('X Harness の使い捨てトークン（xh:）は ref に残さない', async () => {
    await get('/auth/line?ref=xh%3Asecret&sid=S4', MAC);
    expect(hops()).toHaveLength(0);
  });

  it('書き込みが失敗しても転送は止めない', async () => {
    const failing = {
      prepare: () => ({ bind: () => ({ run: async () => { throw new Error('D1 down'); } }) }),
    } as unknown as D1Database;
    const res = await worker.fetch(
      new Request('https://worker.example.com/auth/line?ref=ad_google_search&sid=S5', { headers: { 'user-agent': IPHONE } }),
      { ...env, DB: failing },
      ctx,
    );
    await Promise.allSettled(pending);
    expect(res.status).toBe(302);
  });
});

// TB-1417 本当の原因: 検索広告の utm_term（{keyword}＝「フリマート」など日本語）が付くと、
// OAuth の state を btoa() で作る所で例外になり、/auth/line が 500「Internal Server Error」を返していた。
describe('TB-1417 日本語の utm_term で /auth/line が落ちない', () => {
  const JA = encodeURIComponent('メルカリ 自動 再 出品 ツール');

  it('スマホ: 302 で /r/ へ送り、utm_term も引き継ぐ', async () => {
    const res = await get(`/auth/line?ref=ad_google_search&gclid=G1&utm_term=${JA}&sid=S6`, IPHONE);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!, 'https://worker.example.com');
    expect(loc.pathname).toBe('/r/ad_google_search');
    expect(loc.searchParams.get('utm_term')).toBe('メルカリ 自動 再 出品 ツール');
  });

  it('PC: QR ページを返す', async () => {
    const res = await get(`/auth/line?ref=ad_google_search&utm_term=${JA}&sid=S7`, MAC);
    expect(res.status).toBe(200);
  });

  it('LINE ログインへ送る state を戻すと日本語がそのまま出る', async () => {
    const res = await get(`/auth/line?ref=ad_google_search&account=C1&utm_term=${JA}&sid=S8`, IPHONE);
    expect(res.status).toBe(302);
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    expect(decodeOAuthState(state)).toMatchObject({ ref: 'ad_google_search', utmTerm: 'メルカリ 自動 再 出品 ツール', sid: 'S8' });
  });

  it('今までの英数字だけの state（btoa で作ったもの）も同じように戻せる', () => {
    const old = btoa(JSON.stringify({ ref: 'org_seo', gclid: 'G2', sid: 'S9' }));
    expect(decodeOAuthState(old)).toEqual({ ref: 'org_seo', gclid: 'G2', sid: 'S9' });
  });
});
