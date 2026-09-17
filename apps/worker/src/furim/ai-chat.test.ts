import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAIChatPrompt } from './ai-chat.js';

describe('AI チャットのプロンプト（Capsec #307）', () => {
  const history = [
    { role: 'user' as const, text: '前の質問', ts: Date.UTC(2026, 8, 17, 5, 0) },
    { role: 'model' as const, text: '前の回答', ts: Date.UTC(2026, 8, 17, 5, 1) },
  ];

  it('固定の指示・説明書・faq.md を先頭に、会話履歴とお客様のメッセージを末尾に置く', () => {
    const { prefix, suffix } = buildAIChatPrompt({ howtoText: '説明書の本文', faqText: 'FAQの本文', history, queryText: '下書きを予約出品できますか' });
    expect(prefix).toContain('説明書の本文');
    expect(prefix).toContain('FAQの本文');
    expect(prefix.indexOf('説明書の本文')).toBeLessThan(prefix.indexOf('FAQの本文'));
    expect(prefix).not.toContain('下書きを予約出品できますか');
    expect(prefix).not.toContain('前の質問');
    expect(suffix).toContain('前の質問');
    expect(suffix.indexOf('前の回答')).toBeLessThan(suffix.indexOf('お客様からのメッセージ: 下書きを予約出品できますか'));
    expect(suffix.endsWith('下書きを予約出品できますか')).toBe(true);
  });

  it('先頭は、会話履歴やメッセージが変わっても同じ文字列になる（暗黙キャッシュが効く）', () => {
    const a = buildAIChatPrompt({ howtoText: 'H', faqText: 'F', history: [], queryText: 'A' });
    const b = buildAIChatPrompt({ howtoText: 'H', faqText: 'F', history, queryText: 'B' });
    expect(a.prefix).toBe(b.prefix);
  });

  it('説明書と faq.md が食い違ったら説明書を正とする指示を入れる。説明書が取れないときは faq.md だけと書く', () => {
    expect(buildAIChatPrompt({ howtoText: 'H', faqText: 'F', history: [], queryText: 'Q' }).prefix).toContain('必ず資料1を正として回答');
    const faqOnly = buildAIChatPrompt({ howtoText: '', faqText: 'F', history: [], queryText: 'Q' }).prefix;
    expect(faqOnly).not.toContain('資料1: 利用方法説明書');
    expect(faqOnly).toContain('資料2（よくある質問）だけを根拠');
  });

  it('コメント削除の説明書リンクは、説明書に実在する全角の ｍCommentDelete を指す', () => {
    const src = String(readFileSync(new URL('./ai-chat.ts', import.meta.url).pathname));
    expect(src).toContain("'https://furimauto.com/howto/#ｍCommentDelete'");
    expect(src).not.toContain('#mCommentDelete');
  });
});
