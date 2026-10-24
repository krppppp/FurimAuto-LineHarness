import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// TB-2209: 新 LINE（FURIM_MODE=off・D1 line-crm-fmb）で、経路 URL /r/fmb_* から友だち追加した人に
// friends.ref_code と流入タグが残ることを、本物の SQLite（本番 D1 を作るのと同じ SQL ファイル 3 本）で確かめる。
// LINE の API（ID トークンの検証・返信）だけ fetch を差し替える

// vite 5 は node:sqlite を組み込みと見なさず解決に失敗するので require で読む
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url).href);

/** 本番の D1 を作る手順と同じ: 表の作り（line-crm-prod の写し）→ 経路と流入タグ → あいさつ・応答（下書き） */
function createFmbDatabase(): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['fmb-000-schema.sql', 'fmb-001-entry-routes.sql', 'fmb-002-greeting-replies.draft.sql']) {
    sqlite.exec(readFileSync(repo(`scripts/data/${file}`), 'utf8'));
  }
  return sqlite;
}

function asD1(sqlite: DatabaseSync): D1Database {
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => {
      const r = sqlite.prepare(sql).run(...(args as never[]));
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    first: async (col?: string) => {
      const row = (sqlite.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined) ?? null;
      return col && row ? row[col] : row;
    },
    all: async () => ({ success: true, results: sqlite.prepare(sql).all(...(args as never[])) }),
    raw: async () => sqlite.prepare(sql).all(...(args as never[])).map((r) => Object.values(r as object)),
    _exec: () => sqlite.prepare(sql).run(...(args as never[])),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: Array<ReturnType<typeof statement>>) => Promise.all(stmts.map((s) => s.run())),
    exec: async (sql: string) => { sqlite.exec(sql); return { count: 1, duration: 0 }; },
  } as unknown as D1Database;
}

const LIFF_ID = '2012165991-hkyX2epY';
const CHANNEL_SECRET = 'fmb-test-channel-secret';
const USER = 'U0000000000000000000000000000fmb1';

const sqlite = createFmbDatabase();
const env = {
  DB: asD1(sqlite),
  FURIM_MODE: 'off',
  LINE_CHANNEL_SECRET: CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN: 'fmb-test-access-token',
  LINE_LOGIN_CHANNEL_ID: '2012165991',
  LIFF_URL: `https://liff.line.me/${LIFF_ID}`,
  WORKER_URL: 'https://line-harness-fmb.furimuato.workers.dev',
  API_KEY: 'fmb-test-api-key',
};

const lineCalls: Array<{ url: string; body: unknown }> = [];
const waits: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const worker = (await import('./index.js')).default;

async function call(path: string, init?: RequestInit) {
  const res = await worker.fetch(new Request(`https://furimauto.com${path}`, init), env as never, ctx);
  await Promise.all(waits.splice(0));
  return res;
}

async function webhook(events: unknown[]) {
  const body = JSON.stringify({ destination: 'Ufmb', events });
  const signature = createHmac('sha256', CHANNEL_SECRET).update(body).digest('base64');
  return call('/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Line-Signature': signature }, body });
}

const inflowTags = () =>
  (sqlite.prepare(`SELECT t.name FROM friend_tags ft JOIN tags t ON t.id = ft.tag_id JOIN friends f ON f.id = ft.friend_id WHERE f.line_user_id = ? ORDER BY t.name`).all(USER) as Array<{ name: string }>).map((r) => r.name);
const friendRow = () => sqlite.prepare('SELECT ref_code, is_following FROM friends WHERE line_user_id = ?').get(USER) as { ref_code: string | null; is_following: number } | undefined;

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    let body: unknown = init?.body;
    try { body = JSON.parse(String(init?.body)); } catch { /* form body */ }
    lineCalls.push({ url, body });
    if (url === 'https://api.line.me/oauth2/v2.1/verify') return Response.json({ sub: USER, name: 'テスト' });
    if (url.includes('/v2/bot/profile/')) return Response.json({ userId: USER, displayName: 'テスト' });
    return Response.json({});
  }));
});
afterAll(() => vi.unstubAllGlobals());

describe('新 LINE の経路 URL → 友だち追加 → D1（TB-2209）', () => {
  it('seed で 8 本の経路と確認用の 1 本・流入タグが入る', () => {
    const routes = sqlite.prepare(`SELECT er.ref_code, t.name AS tag FROM entry_routes er JOIN tags t ON t.id = er.tag_id ORDER BY er.ref_code`).all();
    expect(routes).toEqual([
      { ref_code: 'fmb_blog', tag: '流入:ブログ' },
      { ref_code: 'fmb_media_s0', tag: '流入:メディアサイト' },
      { ref_code: 'fmb_media_s0_stage', tag: '流入:メディアサイト' },
      { ref_code: 'fmb_media_top', tag: '流入:メディアサイト' },
      { ref_code: 'fmb_note', tag: '流入:note' },
      { ref_code: 'fmb_other', tag: '流入:その他' },
      { ref_code: 'fmb_test', tag: '流入:テスト' },
      { ref_code: 'fmb_tt', tag: '流入:TikTok' },
      { ref_code: 'fmb_yt', tag: '流入:YouTube' },
    ]);
  });

  it('/r/fmb_note（スマホ）は新 LINE の LIFF に ref を付けて進ませる', async () => {
    const res = await call('/r/fmb_note', { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`href="https://liff.line.me/${LIFF_ID}?liffId=${LIFF_ID}&ref=fmb_note"`);
    expect(html).not.toContain('furim');
  });

  it('/r/fmb_note（パソコン）は QR だけで、FurimAuto の試用の一文と計測の送り先を出さず、QR の画像は Worker から読む', async () => {
    const res = await call('/r/fmb_note', { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' } });
    const html = await res.text();
    expect(html).toContain(encodeURIComponent(`https://liff.line.me/${LIFF_ID}?liffId=${LIFF_ID}&ref=fmb_note`));
    expect(html).not.toContain('無料体験');
    expect(html).not.toContain('line-harness-prod');
    // furimauto.com/r/fmb_* で受けるので、QR の画像は Worker の住所から読む（相対だと WordPress に行って 404）
    expect(html).toContain('<img src="https://line-harness-fmb.furimuato.workers.dev/api/qr?');
  });

  it('LIFF の紐づけ（/api/liff/link）で ref_code・ref_tracking・流入タグが入る', async () => {
    const res = await call('/api/liff/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: 'id-token', displayName: 'テスト', ref: 'fmb_note' }) });
    expect(res.status).toBe(200);
    expect(friendRow()).toEqual({ ref_code: 'fmb_note', is_following: 0 });
    expect(inflowTags()).toEqual(['流入:note']);
    expect(sqlite.prepare('SELECT ref_code, entry_route_id FROM ref_tracking').all()).toEqual([{ ref_code: 'fmb_note', entry_route_id: 'fmb-route-note' }]);
  });

  it('続く友だち追加（follow）で is_following=1・あいさつを返信で 1 回・FurimAuto の試用は書かない', async () => {
    const res = await webhook([{ type: 'follow', replyToken: 'rt-follow', timestamp: Date.now(), source: { type: 'user', userId: USER }, webhookEventId: 'ev1', deliveryContext: { isRedelivery: false }, mode: 'active' }]);
    expect(res.status).toBe(200);
    expect(friendRow()).toEqual({ ref_code: 'fmb_note', is_following: 1 });
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM furim_customers').get() as { n: number }).n).toBe(0);
    const replies = lineCalls.filter((c) => c.url.endsWith('/v2/bot/message/reply'));
    expect(replies).toHaveLength(1);
    const messages = (replies[0].body as { replyToken: string; messages: Array<{ text: string }> });
    expect(messages.replyToken).toBe('rt-follow');
    expect(messages.messages).toHaveLength(2);
    expect(messages.messages[0].text).toContain('合同会社T4 が\n運営しています。');
    expect(lineCalls.some((c) => c.url.includes('/message/push'))).toBe(false);
  });

  it('あとから別の経路を踏んでも ref_code は最初の 1 回のまま（流入タグは足される）', async () => {
    await call('/api/liff/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: 'id-token', ref: 'fmb_yt' }) });
    expect(friendRow()?.ref_code).toBe('fmb_note');
    expect(inflowTags()).toEqual(['流入:YouTube', '流入:note']);
  });

  it('Stripe の受け口は閉じている（署名の鍵を置かないので、開いていると誰でもイベントを入れられる）', async () => {
    const res = await call('/api/integrations/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } }) });
    expect(res.status).toBe(404);
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM stripe_events').get() as { n: number }).n).toBe(0);
  });

  it('「特典」を送ると応答（D-1）が返信で届き、特典受取のタグが付く', async () => {
    lineCalls.splice(0);
    await webhook([{ type: 'message', replyToken: 'rt-msg', timestamp: Date.now(), source: { type: 'user', userId: USER }, message: { type: 'text', id: 'm1', text: '特典', quoteToken: 'q' }, webhookEventId: 'ev2', deliveryContext: { isRedelivery: false }, mode: 'active' }]);
    const replies = lineCalls.filter((c) => c.url.endsWith('/v2/bot/message/reply'));
    expect(replies).toHaveLength(1);
    expect((replies[0].body as { messages: Array<{ text: string }> }).messages[0].text).toContain('売れているメルカリアカウントの調べ方');
    expect(inflowTags()).toContain('特典受取');
  });
});

describe('新 LINE の文面（seed）の決まり（TB-1353 計画 4 節）', () => {
  const NG_WORDS = ['稼げる', '儲かる', '月◯万', '誰でも', '簡単に', '在宅で', '不労所得', '放置'];
  const texts = [
    ...(sqlite.prepare("SELECT response_content AS t FROM auto_replies WHERE id LIKE 'fmb-%'").all() as Array<{ t: string }>).map((r) => r.t),
    ...(sqlite.prepare("SELECT params AS p FROM automation_actions WHERE id LIKE 'fmb-%' AND action_type = 'send_messages'").all() as Array<{ p: string }>)
      .flatMap((r) => (JSON.parse(r.p) as { messages: Array<{ content: string }> }).messages.map((m) => m.content)),
  ];

  it('使わない言葉が入っていない', () => {
    expect(texts.length).toBeGreaterThan(10);
    for (const t of texts) for (const w of NG_WORDS) expect(t, w).not.toContain(w);
  });

  it('FurimAuto の名前・URL を出す吹き出しには、同じ合同会社T4の自社サービスである一文がある', () => {
    const withFurim = texts.filter((t) => /furimauto|FurimAuto/i.test(t));
    expect(withFurim.length).toBeGreaterThan(0);
    for (const t of withFurim) expect(t).toContain('合同会社T4の自社サービスです');
  });

  it('経路と流入タグの SQL（本番に流す 001）には原稿待ちの印が無い', () => {
    const sql = readFileSync(repo('scripts/data/fmb-001-entry-routes.sql'), 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n');
    expect(sql).not.toMatch(/原稿待ち|\{\{/);
    expect(sql).not.toMatch(/furim/i);
  });
});
