/**
 * LINE の AI チャットボットに渡す「よくある質問（faq.md）」の本文（TB-2976）。
 *
 * これまでは毎メッセージ private の GitHub（krppppp/furimauto-faq）を GITHUB_PAT で取りに行き、
 * 失敗しても console.warn して空文字を返すだけだったため、9/24 ごろから 40 日、AI に faq.md が 1 文字も渡っていなかった（TB-2975）。
 *
 * - 本文は KV（FURIM_EXT_CACHE）の FAQ_CACHE_KEY に置く。期限なし。書き込みは scripts/push-faq-kv.mjs（LineHarness のルートで・faq.md を直したら流す）
 * - Worker は実行時に GitHub を見に行かない（PAT を使わない）
 * - KV に無い・壊れている・短すぎるときは text='' と error を返す。呼び出し側が furim_ext_errors に残す
 */

export const FAQ_CACHE_KEY = 'furim:ai-chat:faq-text:v1';
/** 取れた本文がこれより短ければ壊れているとみなす（本来は約 3 万字） */
export const FAQ_MIN_CHARS = 5_000;

export type FaqLoadResult = { text: string; source: 'kv' | 'failed'; error?: string };

export async function loadFaqText(kv: KVNamespace | undefined): Promise<FaqLoadResult> {
  if (!kv) return { text: '', source: 'failed', error: 'faq: FURIM_EXT_CACHE が無い' };
  try {
    const raw = await kv.get(FAQ_CACHE_KEY);
    if (!raw) return { text: '', source: 'failed', error: `faq: KV に ${FAQ_CACHE_KEY} が無い` };
    const text = (JSON.parse(raw) as { text?: string }).text ?? '';
    if (text.length < FAQ_MIN_CHARS) return { text: '', source: 'failed', error: `faq: 本文が短すぎる (${text.length} chars)` };
    return { text, source: 'kv' };
  } catch (e) {
    return { text: '', source: 'failed', error: `faq: ${e instanceof Error ? e.message : String(e)}` };
  }
}
