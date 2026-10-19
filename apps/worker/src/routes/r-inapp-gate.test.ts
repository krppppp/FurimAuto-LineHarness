import { describe, it, expect, vi, beforeEach } from 'vitest';

// TB-1826: /r/:ref の中継ページを、アプリ内ブラウザ（Android WebView・iPhone アプリ内）で出し分ける。
// PC・普通のスマホブラウザの出し方は変えない。
const dbMocks = {
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getTrafficPoolBySlug: vi.fn(),
  getTrafficPoolById: vi.fn(),
  getRandomPoolAccount: vi.fn(),
  getPoolAccounts: vi.fn(),
  getLineAccountById: vi.fn(),
  getAffiliateLinkByRefCode: vi.fn(),
  incrementAffiliateLinkClick: vi.fn(),
  jstNow: vi.fn(() => '2026-10-19 00:00:00'),
};
vi.mock('@line-crm/db', () => dbMocks);

const worker = (await import('../index.js')).default;

const DB = { prepare: vi.fn(() => ({ bind: () => ({ run: () => Promise.resolve() }) })) } as unknown as D1Database;

const env = {
  DB,
  LIFF_URL: 'https://liff.line.me/1000000000-DefaultAA',
} as unknown as import('../index.js').Env['Bindings'];

const UA = {
  androidWebView:
    'Mozilla/5.0 (Linux; Android 14; SC-53C Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/153.0.8010.57 Mobile Safari/537.36 open_news open_news_u_s/8105',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  iphoneInApp:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1',
  pc: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

const QS = '?gclid=TESTCLICK&utm_campaign=pmax_v2_3lp&sid=s-123';

async function page(ua: string) {
  const res = await worker.fetch(
    new Request(`https://worker.example.com/r/ad_google_search${QS}`, { headers: { 'user-agent': ua } }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
  expect(res.status).toBe(200);
  return res.text();
}

function mainHref(html: string) {
  const m = html.match(/<a href="([^"]+)" class="btn"[^>]*>/);
  return m ? m[1] : '';
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getLineAccounts.mockResolvedValue([]);
  dbMocks.getEntryRouteByRefCode.mockResolvedValue(null);
  dbMocks.getAffiliateLinkByRefCode.mockResolvedValue(null);
  dbMocks.getTrafficPoolBySlug.mockResolvedValue(null);
});

describe('/r/:ref — アプリ内ブラウザの出し分け', () => {
  it('Android WebView: 主ボタンは liff.line.me の普通のリンク。Chrome で開く・URL コピーを並べる', async () => {
    const html = await page(UA.androidWebView);
    const href = mainHref(html);
    expect(href.startsWith('https://liff.line.me/1000000000-DefaultAA?')).toBe(true);
    expect(href).toContain('gclid=TESTCLICK');
    expect(href).toContain('sid=s-123');
    expect(href).toContain('ref=ad_google_search');
    expect(html).not.toContain('package=jp.naver.line.android');
    expect(html).toMatch(/href="intent:\/\/liff\.line\.me\/[^"]*gclid=TESTCLICK[^"]*package=com\.android\.chrome;end"[^>]*data-gate="chrome"/);
    expect(html).toMatch(/data-gate="copy"[^>]*data-url="https:\/\/liff\.line\.me\/[^"]*gclid=TESTCLICK/);
    expect(html).toContain("var V='android_wv'");
    expect(html).toMatch(/class="btn"[^>]*data-gate="liff"/);
  });

  it('iPhone アプリ内（UA に Safari なし）: 長押しの案内と Safari で開く（URL コピー）を最初から出す', async () => {
    const html = await page(UA.iphoneInApp);
    const href = mainHref(html);
    expect(href.startsWith('https://liff.line.me/1000000000-DefaultAA?')).toBe(true);
    expect(href).toContain('gclid=TESTCLICK');
    expect(html).toContain('class="guide"');
    expect(html).toContain('長押し');
    expect(html).toMatch(/data-gate="copy"[^>]*data-url="https:\/\/liff\.line\.me\/[^"]*gclid=TESTCLICK/);
    expect(html).toContain('Safari');
    expect(html).toContain("var V='ios_inapp'");
  });

  it('Android Chrome: 今までどおり intent:// で LINE アプリへ渡す', async () => {
    const html = await page(UA.androidChrome);
    const href = mainHref(html);
    expect(href.startsWith('intent://liff.line.me/')).toBe(true);
    expect(href).toContain('package=jp.naver.line.android');
    expect(href).toContain('gclid%3DTESTCLICK');
    expect(html).not.toContain('data-gate="chrome"');
    expect(html).not.toContain('data-gate="copy"');
    expect(html).toContain("var V='android'");
    expect(html).toMatch(/class="btn"[^>]*data-gate="intent"/);
  });

  it('iPhone Safari: 今までどおり liff.line.me のボタンと小さな長押しの案内だけ', async () => {
    const html = await page(UA.iphoneSafari);
    expect(mainHref(html).startsWith('https://liff.line.me/')).toBe(true);
    expect(html).toContain('class="hint"');
    expect(html).not.toContain('class="guide"');
    expect(html).not.toContain('data-gate="copy"');
    expect(html).toContain("var V='ios'");
  });

  it('PC: 今までどおり QR', async () => {
    const html = await page(UA.pc);
    expect(html).toContain('/api/qr?size=240x240&data=');
    expect(html).not.toContain('class="btn"');
  });

  it('計測: gate_view は端末の種類、gate_open は押したボタンの種類を detail に入れる', async () => {
    const html = await page(UA.androidWebView);
    expect(html).toContain("send('gate_view', 'mobile:'+V)");
    expect(html).toContain("send('gate_open', 'mobile:'+V+':'+el.getAttribute('data-gate'))");
  });
});
