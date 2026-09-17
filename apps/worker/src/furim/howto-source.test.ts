import { describe, expect, it, vi } from 'vitest';
import { HOWTO_CACHE_KEY, HOWTO_CACHE_TTL_SECONDS, howtoHtmlToText, loadHowtoText } from './howto-source.js';

const PAGE = `<!doctype html><html><head><style>.x{color:red}</style><script>var a=1</script></head><body>
<nav class="sidebar-navigation"><a href="#x">目次の見出し</a></nav>
<main class="main-content">
  <h2 id="mRelist" class="guides-step__heading">
    再出品
  </h2>
  <span id="ｍRelist"></span>
  <p>商品を
    停止してから出品し直します。<br>
    メルカリShopsにも対応しています。</p>
  <!-- スクショ: 再出品ボタンを押した直後の画面 -->
  <img loading="lazy" src="images/relist.webp">
  <ul><li>ラクマ</li><li>ヤフフリ</li></ul>
  <video data-src="video/a.mp4"></video>
  <svg><text>SVGの文字</text></svg>
  <script>console.log('in main')</script>
  <table><tr><th>機能</th><th>料金</th></tr><tr><td>再出品</td><td>&yen;980 &amp; 税</td></tr></table>
</main>
<footer>フッター</footer>
</body></html>`;

describe('説明書の HTML → AI に渡すテキスト（Capsec #307）', () => {
  it('main の本文だけを残し、見出し・段落・箇条書き・表をテキストにする', () => {
    const t = howtoHtmlToText(PAGE);
    expect(t).toContain('## 再出品');
    expect(t).toContain('商品を 停止してから出品し直します。\nメルカリShopsにも対応しています。');
    expect(t).toContain('・ラクマ\n・ヤフフリ');
    expect(t).toContain('機能 | 料金 |');
    expect(t).toContain('&');
  });

  it('script・style・nav・svg・動画・画像の注記（HTML コメント）・フッター・旧アンカーの受け皿を除く', () => {
    const t = howtoHtmlToText(PAGE);
    for (const gone of ['color:red', 'var a=1', '目次の見出し', 'スクショ', 'SVGの文字', 'in main', 'フッター', 'relist.webp', 'video/a.mp4', 'ｍRelist']) {
      expect(t, gone).not.toContain(gone);
    }
  });
});

function makeKv(initial: string | null = null) {
  const store = new Map<string, string>();
  if (initial) store.set(HOWTO_CACHE_KEY, initial);
  const put = vi.fn(async (k: string, v: string) => { store.set(k, v); });
  return { kv: { get: vi.fn(async (k: string) => store.get(k) ?? null), put } as unknown as KVNamespace, put };
}

const longPage = PAGE.replace('<p>商品を', `<p>${'説明書の本文。'.repeat(1000)}商品を`);

describe('説明書の本文の取得とキャッシュ（Capsec #307）', () => {
  it('KV にあれば取得しない', async () => {
    const { kv } = makeKv('キャッシュ済みの本文');
    const fetchImpl = vi.fn();
    const r = await loadHowtoText(kv, undefined, fetchImpl as never);
    expect(r).toEqual({ text: 'キャッシュ済みの本文', source: 'cache' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('KV に無ければ取得してテキスト化し、3 時間の TTL で KV に置く', async () => {
    const { kv, put } = makeKv();
    const fetchImpl = vi.fn(async () => new Response(longPage, { status: 200 }));
    const r = await loadHowtoText(kv, undefined, fetchImpl as never);
    expect(r.source).toBe('fetched');
    expect(r.text).toContain('## 再出品');
    expect(put).toHaveBeenCalledWith(HOWTO_CACHE_KEY, r.text, { expirationTtl: HOWTO_CACHE_TTL_SECONDS });
    expect(HOWTO_CACHE_TTL_SECONDS).toBe(10800);
  });

  it('取得に失敗したら空文字を返し（faq.md だけで答える）、furim_ext_errors に aiChatHowto で残す。KV には置かない', async () => {
    const { kv, put } = makeKv();
    const runs: unknown[][] = [];
    const db = { prepare: (sql: string) => ({ bind: (...a: unknown[]) => ({ run: async () => { runs.push([sql, ...a]); return {}; } }) }) } as unknown as D1Database;
    const r = await loadHowtoText(kv, db, vi.fn(async () => new Response('down', { status: 503 })) as never);
    expect(r).toMatchObject({ text: '', source: 'failed', error: 'howto fetch 503' });
    expect(put).not.toHaveBeenCalled();
    expect(String(runs[0][0])).toContain("'aiChatHowto'");
    expect(runs[0][2]).toBe('howto fetch 503');
  });

  it('本文が極端に短い（壊れたページ）ときも失敗として扱う', async () => {
    const { kv, put } = makeKv();
    const r = await loadHowtoText(kv, undefined, vi.fn(async () => new Response(PAGE, { status: 200 })) as never);
    expect(r.source).toBe('failed');
    expect(put).not.toHaveBeenCalled();
  });
});
