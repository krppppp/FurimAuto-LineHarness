import { describe, it, expect, vi } from 'vitest';

// /r/ は furimauto.com から配信されるため、QR の img が相対パスだと furimauto.com/api/qr を叩いて 404 になる（TB-2361）。

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
  jstNow: () => '2026-10-27 00:00:00',
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

const baseEnv = {
  DB,
  LIFF_URL: 'https://liff.line.me/1000000000-DefaultAA',
  WORKER_URL: 'https://worker.example.com',
  LINE_LOGIN_CHANNEL_ID: '2000000000',
  LINE_LOGIN_CHANNEL_SECRET: 'secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-token',
};

const PC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function qrSrc(path: string, extraEnv: Record<string, string> = {}) {
  const res = await worker.fetch(
    new Request(`https://furimauto.com${path}`, { headers: { 'user-agent': PC_UA } }),
    { ...baseEnv, ...extraEnv } as unknown as import('../index.js').Env['Bindings'],
    ctx,
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  const m = html.match(/<img src="([^"]*)" alt="QR Code">/);
  expect(m).not.toBeNull();
  return m![1];
}

const PUBLIC = { WORKER_PUBLIC_URL: 'https://line-harness-prod.example.workers.dev' };

describe('PC 用 QR 画像の src', () => {
  it('/r/:ref は WORKER_PUBLIC_URL の絶対 URL', async () => {
    const src = await qrSrc('/r/org_note?utm_source=note&utm_medium=social', PUBLIC);
    expect(src.startsWith('https://line-harness-prod.example.workers.dev/api/qr?size=240x240&data=')).toBe(true);
  });

  it('/o は WORKER_PUBLIC_URL の絶対 URL', async () => {
    const src = await qrSrc('/o?liffId=1000000000-DefaultAA', PUBLIC);
    expect(src.startsWith('https://line-harness-prod.example.workers.dev/api/qr?size=240x240&data=')).toBe(true);
  });

  it('/auth/line は WORKER_PUBLIC_URL の絶対 URL', async () => {
    const src = await qrSrc('/auth/line?ref=org_note', PUBLIC);
    expect(src.startsWith('https://line-harness-prod.example.workers.dev/api/qr?size=240x240&data=')).toBe(true);
  });

  it('WORKER_PUBLIC_URL が無ければ相対パスのまま', async () => {
    expect((await qrSrc('/r/org_note')).startsWith('/api/qr?')).toBe(true);
    expect((await qrSrc('/o?liffId=1000000000-DefaultAA')).startsWith('/api/qr?')).toBe(true);
    expect((await qrSrc('/auth/line?ref=org_note')).startsWith('/api/qr?')).toBe(true);
  });
});
