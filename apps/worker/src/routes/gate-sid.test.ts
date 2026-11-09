import { describe, it, expect, vi } from 'vitest';

// note 等の外部リンクから sid 無しで /r/ に来ても gate_view を残し、LIFF にも同じ sid を渡す（TB-3251）。

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
  jstNow: () => '2026-11-09 00:00:00',
};
vi.mock('@line-crm/db', () => dbMocks);

const worker = (await import('../index.js')).default;

const DB = {
  prepare: () => ({
    first: async () => null,
    run: async () => ({ meta: { changes: 0 } }),
    all: async () => ({ results: [] }),
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
  WORKER_PUBLIC_URL: 'https://line-harness-prod.example.workers.dev',
  LINE_LOGIN_CHANNEL_ID: '2000000000',
  LINE_LOGIN_CHANNEL_SECRET: 'secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-token',
};

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const PC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function page(path: string, ua: string) {
  const res = await worker.fetch(
    new Request(`https://furimauto.com${path}`, { headers: { 'user-agent': ua } }),
    env as unknown as import('../index.js').Env['Bindings'],
    ctx,
  );
  expect(res.status).toBe(200);
  return res.text();
}

const NOTE = '/r/org_note?utm_source=note&utm_medium=social&utm_content=note_sample';

describe('/r/:ref の gate 計測 sid', () => {
  it('モバイル: sid 無しなら発行し、ビーコンと LINEで開く の両方に同じ sid が入る', async () => {
    const html = await page(NOTE, IOS_UA);
    const fallback = html.match(/if\(!sid\) sid='([0-9a-f-]{36})'/);
    expect(fallback).not.toBeNull();
    const href = html.match(/<a href="([^"]*)" class="btn">/)![1];
    const q = new URL(href.replace(/&amp;/g, '&')).searchParams;
    expect(q.get('sid')).toBe(fallback![1]);
    expect(q.get('utm_content')).toBe('note_sample');
    expect(html).toContain("var EP='https://line-harness-prod.example.workers.dev/api/lp-beacon'");
  });

  it('PC: sid 無しなら発行し、QR の LIFF URL にも同じ sid が入る', async () => {
    const html = await page(NOTE, PC_UA);
    const fallback = html.match(/if\(!sid\) sid='([0-9a-f-]{36})'/)![1];
    const data = decodeURIComponent(html.match(/data=([^"]*)" alt="QR Code"/)![1]);
    expect(new URL(data).searchParams.get('sid')).toBe(fallback);
  });

  it('sid 付きで来たら発行せず、来た sid をそのまま渡す', async () => {
    const html = await page(`${NOTE}&sid=lp-abc`, IOS_UA);
    expect(html).toContain("if(!sid) sid='';");
    const href = html.match(/<a href="([^"]*)" class="btn">/)![1];
    expect(new URL(href.replace(/&amp;/g, '&')).searchParams.get('sid')).toBe('lp-abc');
  });
});
