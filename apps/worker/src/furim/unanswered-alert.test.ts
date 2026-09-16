import { describe, it, expect } from 'vitest';
import { buildUnansweredAlert, isClosingMessage, UNANSWERED_RED_HOURS, UNANSWERED_YELLOW_HOURS } from './unanswered-alert.js';
import type { UnansweredRow } from '../services/unanswered-inbox.js';

const text = (content: string, opts: Partial<{ hadHumanReply: boolean; mediaSinceReply: boolean }> = {}) =>
  isClosingMessage({ type: 'text', content, hadHumanReply: opts.hadHumanReply ?? true, mediaSinceReply: opts.mediaSinceReply ?? false });

describe('会話の締めの判定（Capsec #295・案 C）', () => {
  it('今朝の 4 件: 中園さん・くりさんは締め、もちをさん・佐藤さんは対象', () => {
    expect(text('ご連絡ありがとうございます。 了解いたしました 検討します！')).toBe(true);
    expect(text('お世話になります。承知しました、ありがとうございます。')).toBe(true);
    expect(text('お世話になっております。 グーグルレビューを投稿しました。 ご確認をお願いします。', { mediaSinceReply: true })).toBe(false);
    expect(text('お世話になっております。現在FurimAutoを利用させていただいております。（現在、値下げツール等の契約で月額13,068円（税込）をお支払いしております）販路はすべて連携できますか？')).toBe(false);
  });

  it('「確認しました」は締め、「ご確認お願いします」は対象', () => {
    expect(text('確認しました')).toBe(true);
    expect(text('確認できました、ありがとうございます')).toBe(true);
    expect(text('ご確認お願いします')).toBe(false);
    expect(text('確認してください')).toBe(false);
  });

  it('スタンプ単体は、人の返信のあとなら締め', () => {
    expect(isClosingMessage({ type: 'sticker', content: '{}', hadHumanReply: true, mediaSinceReply: false })).toBe(true);
    expect(isClosingMessage({ type: 'sticker', content: '{}', hadHumanReply: false, mediaSinceReply: false })).toBe(false);
  });

  it('画像は締めにしない（報告の可能性がある）', () => {
    expect(isClosingMessage({ type: 'image', content: '{}', hadHumanReply: true, mediaSinceReply: false })).toBe(false);
    expect(text('ありがとうございます', { mediaSinceReply: true })).toBe(false);
  });

  it('お礼で始まっても質問が続けば対象', () => {
    expect(text('ありがとうございます。ところで設定はどこですか？')).toBe(false);
  });

  it('「よろしくお願いします」は依頼の結びなら対象、単独の締めなら除外', () => {
    expect(text('使い方を教えてください。よろしくお願いします')).toBe(false);
    expect(text('わかりました、よろしくお願いします')).toBe(true);
  });

  it('40 文字を超える長文は締めにしない', () => {
    expect(text('ありがとうございます。いつも大変お世話になっております。今月から在庫管理シートも使い始めました。')).toBe(false);
  });
});

const NOW = Date.parse('2026-09-17T12:00:00+09:00');
const row = (id: string, hoursAgo: number, content: string, opts: Partial<UnansweredRow> = {}): UnansweredRow => ({
  friendId: id,
  displayName: id,
  pictureUrl: null,
  accountId: 'a',
  accountName: 'acc',
  lastIncomingAt: new Date(NOW - hoursAgo * 3600_000).toISOString(),
  lastManualAt: new Date(NOW - (hoursAgo + 1) * 3600_000).toISOString(),
  lastMachineAt: null,
  lastIncomingType: 'text',
  lastIncomingContent: content,
  ...opts,
});

describe('未返信の集計', () => {
  it('3 時間未満は数えない', () => {
    expect(buildUnansweredAlert([row('a', 2, '使い方を教えてください')], new Set(), NOW)).toBeNull();
  });

  it('3 時間以上で黄、12 時間以上で赤。最古の時間で色を決める', () => {
    const y = buildUnansweredAlert([row('a', UNANSWERED_YELLOW_HOURS + 1, '使い方を教えてください')], new Set(), NOW)!;
    expect(y.severity).toBe('yellow');
    const r = buildUnansweredAlert([row('a', 4, '教えてください'), row('b', UNANSWERED_RED_HOURS + 6, 'ご確認お願いします')], new Set(), NOW)!;
    expect(r.severity).toBe('red');
    expect(r.count).toBe(2);
    expect(r.oldestHours).toBe(18);
    expect(r.top[0].friendId).toBe('b');
  });

  it('締めは件数から外し、除外件数として返す（黙って消さない）', () => {
    const a = buildUnansweredAlert([row('a', 5, '了解しました'), row('b', 5, '設定を教えてください')], new Set(), NOW)!;
    expect(a.count).toBe(1);
    expect(a.excludedClosing).toBe(1);
  });

  it('締めしか無ければ項目を出さない', () => {
    expect(buildUnansweredAlert([row('a', 20, 'ありがとうございます')], new Set(), NOW)).toBeNull();
  });

  it('上位は 5 件までで、本文は先頭 30 文字', () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(`u${i}`, 4 + i, '在庫管理シートの統合の手順を詳しく教えてください。よろしくお願いいたします'));
    const a = buildUnansweredAlert(rows, new Set(), NOW)!;
    expect(a.top).toHaveLength(5);
    expect(a.top[0].preview.length).toBeLessThanOrEqual(30);
  });
});
