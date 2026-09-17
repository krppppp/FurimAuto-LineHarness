import { describe, expect, it } from 'vitest';
import { FALLBACK_TEXT, buildAIChatPrompt, decodeBase64Utf8, howtoAnchorUrl, parseAIReply } from './ai-chat.js';

describe('AI チャットのプロンプト（Capsec #307）', () => {
  const history = [
    { role: 'user' as const, text: '前の質問', ts: Date.UTC(2026, 8, 17, 5, 0) },
    { role: 'model' as const, text: '前の回答', ts: Date.UTC(2026, 8, 17, 5, 1) },
  ];

  it('固定の指示・説明書・faq.md を先頭に、会話履歴とお客様のメッセージを末尾に置く', () => {
    const { prefix, suffix } = buildAIChatPrompt({ howtoText: '説明書の本文', faqText: 'FAQの本文', history, queryText: '下書きを予約出品できますか' });
    expect(prefix.indexOf('説明書の本文')).toBeLessThan(prefix.indexOf('FAQの本文'));
    expect(prefix).not.toContain('下書きを予約出品できますか');
    expect(prefix).not.toContain('前の質問');
    expect(suffix.indexOf('前の回答')).toBeLessThan(suffix.indexOf('お客様からのメッセージ: 下書きを予約出品できますか'));
  });

  it('先頭は、会話履歴やメッセージが変わっても同じ文字列になる（暗黙キャッシュが効く）', () => {
    const a = buildAIChatPrompt({ howtoText: 'H', faqText: 'F', history: [], queryText: 'A' });
    const b = buildAIChatPrompt({ howtoText: 'H', faqText: 'F', history, queryText: 'B' });
    expect(a.prefix).toBe(b.prefix);
  });

  it('説明書を正とする指示・要点だけ（200 文字目安・「・」最大 3 つ）・章の id を書かせる指示・動画の案内をしない指示を入れる', () => {
    const { prefix } = buildAIChatPrompt({ howtoText: 'H', faqText: 'F', history: [], queryText: 'Q' });
    expect(prefix).toContain('必ず資料1を正として回答');
    expect(prefix).toContain('200文字以内');
    expect(prefix).toContain('最大3つ');
    expect(prefix).toContain('[[howto:その章のid]]');
    expect(prefix).toContain('動画の案内はしないでください');
  });

  it('説明書が取れないときは faq.md だけと書き、章の id を書かせない', () => {
    const { prefix } = buildAIChatPrompt({ howtoText: '', faqText: 'F', history: [], queryText: 'Q' });
    expect(prefix).toContain('資料2（よくある質問）だけを根拠');
    expect(prefix).not.toContain('[[howto:その章のid]]');
  });

  it('答えられないときの定型文は、長尺動画への誘導を外し、担当者への案内だけにする', () => {
    expect(FALLBACK_TEXT).not.toMatch(/youtube|動画/i);
    expect(FALLBACK_TEXT).toContain('追加サポートを希望する');
  });
});

describe('AI の返答の後処理（Capsec #307 方針変更）', () => {
  const ids = new Set(['mDraftScheduledListing', 'msRelist', 'ｍCommentDelete']);

  it('一覧にある章の id だけを採用し、本文から札を消す', () => {
    const r = parseAIReply('【AIチャットボット】\nはい、できます。\n・下書き一覧で予約します\n[[howto:mDraftScheduledListing]]', ids);
    expect(r.anchorId).toBe('mDraftScheduledListing');
    expect(r.anchorRejected).toBeNull();
    expect(r.text).toBe('【AIチャットボット】\nはい、できます。\n・下書き一覧で予約します');
  });

  it('一覧に無い id（作り話）は URL にせず、anchorRejected に残す', () => {
    const r = parseAIReply('【AIチャットボット】\n答え\n[[howto:mMadeUpSection]]', ids);
    expect(r.anchorId).toBeNull();
    expect(r.anchorRejected).toBe('mMadeUpSection');
    expect(r.text).not.toContain('[[');
  });

  it('章の id が無ければ URL も却下も無い', () => {
    const r = parseAIReply('【AIチャットボット】\n料金は月額です。', ids);
    expect(r).toMatchObject({ anchorId: null, anchorRejected: null, keycodeReset: false, fallback: false });
  });

  it('「[下書き予約出品機能]」のような [ ] だけの行と ** は消し、[キーコードリセット] は取り出す', () => {
    const r = parseAIReply('【AIチャットボット】\n**キーコードをリセット**してください。\n[下書き予約出品機能]\n[キーコードリセット]', ids);
    expect(r.text).toBe('【AIチャットボット】\nキーコードをリセットしてください。');
    expect(r.keycodeReset).toBe(true);
  });

  it('定型文を返した回は fallback になる', () => {
    expect(parseAIReply(`【AIチャットボット】\n${FALLBACK_TEXT}`, ids).fallback).toBe(true);
  });

  it('全角の id はパーセントエンコードした URL にする', () => {
    expect(howtoAnchorUrl('ｍCommentDelete')).toBe('https://furimauto.com/howto/#%EF%BD%8DCommentDelete');
    expect(howtoAnchorUrl('msRelist')).toBe('https://furimauto.com/howto/#msRelist');
  });
});

describe('faq.md の取得（Capsec #307）', () => {
  it('GitHub API の base64 を UTF-8 として戻す（atob だけだと日本語が文字化けしていた）', () => {
    const b64 = Buffer.from('# よくある質問\n料金は月額です。', 'utf8').toString('base64').replace(/(.{20})/g, '$1\n');
    expect(decodeBase64Utf8(b64)).toBe('# よくある質問\n料金は月額です。');
    expect(atob(b64.replace(/\n/g, ''))).not.toBe('# よくある質問\n料金は月額です。');
  });
});
