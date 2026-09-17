/**
 * LINE の AI チャットボットに渡す「説明書（https://furimauto.com/howto/）の本文」（Capsec #307・2026-09-17）。
 *
 * これまで AI は GitHub の faq.md だけを根拠にしていたが、faq.md の機能説明は説明書の書き直し前の仕様のままで、
 * 食い違いが 15 件以上あった。説明書の本文も渡し、食い違ったら説明書を正とする。
 *
 * - 本文は <main> の中だけを使い、script・style・nav・svg・動画・iframe、画像の注記（<!-- スクショ: … --> の HTML コメント）、
 *   旧アンカーの受け皿（中身の無い id だけの span 等）を除いてテキストにする
 * - 取得は KV に 3 時間キャッシュし、毎メッセージは fetch しない（説明書は 1 日に何度かデプロイされるので長くしない）。
 *   workers.dev のドメインでは Cache API が効かないため KV を使う
 * - 取得に失敗したら空文字を返す（呼び出し側は faq.md だけで答える）。失敗は furim_ext_errors に method=aiChatHowto で残す
 */

import { jstNow } from '@line-crm/db';

export const HOWTO_URL = 'https://furimauto.com/howto/';
export const HOWTO_CACHE_KEY = 'furim:ai-chat:howto-text:v2';
export const HOWTO_CACHE_TTL_SECONDS = 3 * 60 * 60;
const HOWTO_FETCH_TIMEOUT_MS = 8_000;
/** 取れた本文がこれより短ければ壊れたページとみなす（本来は約 5.4 万字） */
const HOWTO_MIN_CHARS = 5_000;

const DROP_BLOCK_TAGS = ['script', 'style', 'nav', 'noscript', 'svg', 'iframe', 'video', 'button', 'template', 'select'];

const decodeEntities = (s: string): string =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

/** 説明書の HTML → AI に渡すテキスト（見出しは # 付き・段落は空行区切り） */
export function howtoHtmlToText(html: string): string {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  let t = main ? main[1] : html;

  t = t.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of DROP_BLOCK_TAGS) {
    t = t.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
  }
  // 旧アンカーの受け皿: 中身の無い、id だけを持つ要素
  t = t.replace(/<(span|a|div)\b[^>]*\bid="[^"]*"[^>]*>\s*<\/\1>/gi, '');
  t = t.replace(/<img\b[^>]*>/gi, '');

  // ソースの改行・インデントは意味を持たないので先に詰め、そのあとタグから段落と改行を作る
  t = t.replace(/\s+/g, ' ');
  // 見出しに id があれば「〔id: …〕」を付け、AI が根拠の章を id で言えるようにする（Capsec #307 方針変更）
  t = t.replace(/<h([1-4])\b([^>]*)>([\s\S]*?)<\/h\1>/gi, (_, level: string, attrs: string, inner: string) => {
    const heading = inner.replace(/<[^>]+>/g, '').trim();
    if (!heading) return '';
    const id = attrs.match(/\bid="([^"]+)"/)?.[1];
    return `\n\n${'#'.repeat(Number(level))} ${heading}${id ? ` 〔id: ${id}〕` : ''}\n`;
  });
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<hr\b[^>]*>/gi, '\n');
  t = t.replace(/<li\b[^>]*>/gi, '\n・');
  t = t.replace(/<\/t[dh]>/gi, ' | ');
  t = t.replace(/<\/(p|div|tr|section|table|ul|ol|aside|article|dl|dt|dd)>/gi, '\n');
  t = t.replace(/<[^>]+>/g, '');
  t = decodeEntities(t);

  return t
    .replace(/[ \t　]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 説明書の <main> の見出し（h1〜h4）に付いた id の一覧。AI が出した章の id は、これにあるときだけ URL にする */
export function howtoHeadingIds(html: string): string[] {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const t = main ? main[1] : html;
  const ids = [...t.matchAll(/<h[1-4]\b[^>]*\bid="([^"]+)"[^>]*>/gi)].map((m) => m[1]);
  return [...new Set(ids)];
}

export type HowtoLoadResult = { text: string; ids: string[]; source: 'cache' | 'fetched' | 'failed'; error?: string };

async function recordHowtoFailure(db: D1Database | undefined, error: string): Promise<void> {
  if (!db) return;
  try {
    await db
      .prepare(
        `INSERT INTO furim_ext_errors (id, line_user_id, key_code, method, error, mercari_url, discrimination_code, client, created_at)
         VALUES (?, NULL, NULL, 'aiChatHowto', ?, NULL, NULL, 'webhook', ?)`,
      )
      .bind(crypto.randomUUID(), error.slice(0, 500), jstNow())
      .run();
  } catch (e) {
    console.error('[furim/howto-source] failure record failed:', e);
  }
}

/**
 * 説明書の本文を返す。KV にあればそれを、無ければ取得してテキスト化し 3 時間キャッシュする。
 * 失敗したら text='' で返す（AI は faq.md だけで答える）
 */
export async function loadHowtoText(
  kv: KVNamespace | undefined,
  db: D1Database | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<HowtoLoadResult> {
  if (kv) {
    try {
      const cached = await kv.get(HOWTO_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as { text?: string; ids?: string[] };
        if (parsed.text) return { text: parsed.text, ids: parsed.ids ?? [], source: 'cache' };
      }
    } catch (e) {
      console.warn('[furim/howto-source] KV get failed:', e);
    }
  }

  try {
    const res = await fetchImpl(HOWTO_URL, {
      headers: { 'User-Agent': 'line-harness-worker (FurimAuto AI chat)' },
      signal: AbortSignal.timeout(HOWTO_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`howto fetch ${res.status}`);
    const html = await res.text();
    const text = howtoHtmlToText(html);
    const ids = howtoHeadingIds(html);
    if (text.length < HOWTO_MIN_CHARS) throw new Error(`howto text too short (${text.length} chars)`);
    if (kv) {
      try {
        await kv.put(HOWTO_CACHE_KEY, JSON.stringify({ text, ids }), { expirationTtl: HOWTO_CACHE_TTL_SECONDS });
      } catch (e) {
        console.warn('[furim/howto-source] KV put failed:', e);
      }
    }
    return { text, ids, source: 'fetched' };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error('[furim/howto-source] howto load failed, faq.md only:', error);
    await recordHowtoFailure(db, error);
    return { text: '', ids: [], source: 'failed', error };
  }
}
