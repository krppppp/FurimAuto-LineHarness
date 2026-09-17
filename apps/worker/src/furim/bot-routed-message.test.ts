import { describe, expect, it } from 'vitest';
import { isBotRoutedIncoming, isBotRoutedText } from './bot-routed-message.js';

describe('isBotRoutedText', () => {
  it('webhook が bot に回す入力は true', () => {
    for (const t of [
      '【リッチメニュー】キーコード発行',
      '【ボタン】無料開放プレゼント',
      '「【キーワード】キーコードリセット」',
      'キーコードリセット',
      '【プラン変更】PB-67ED81\n────',
      '【プラン申し込み】PB-591529',
      'Furimanです',
      '解説見た ',
      '料金',
      '配信時間は9時',
    ]) {
      expect(isBotRoutedText(t), t).toBe(true);
    }
  });

  it('人が読むべき入力は false', () => {
    for (const t of [
      'スマホ対応してますか？',
      'キーコードが認証されません',
      '料金はいくらですか',
      '【ボタン】追加サポート',
      'リッチメニューのボタンが押せません',
    ]) {
      expect(isBotRoutedText(t), t).toBe(false);
    }
  });

  it('テキスト以外は対象外', () => {
    expect(isBotRoutedIncoming('image', '【リッチメニュー】ホームタブ')).toBe(false);
    expect(isBotRoutedIncoming('text', '【リッチメニュー】ホームタブ')).toBe(true);
  });
});

describe('normalizeBotCommand（Capsec #298）', () => {
  it('本番で取りこぼした表記ゆれを、bot が受け付ける形にそろえる', async () => {
    const { normalizeBotCommand } = await import('./bot-routed-message.js');
    expect(normalizeBotCommand('キーコード発行')).toBe('【リッチメニュー】キーコード発行');
    expect(normalizeBotCommand('キーコード発行\n')).toBe('【リッチメニュー】キーコード発行');
    expect(normalizeBotCommand(' プラン診断 ')).toBe('【リッチメニュー】プラン診断');
    expect(normalizeBotCommand('AIチャットボットを終了する')).toBe('【リッチメニュー】AIチャットボットを終了する');
    expect(normalizeBotCommand('「バグ・エラー報告」')).toBe('【リッチメニュー】バグ・エラー報告');
    expect(normalizeBotCommand('【リッチメニュー】 キーコード発行')).toBe('【リッチメニュー】キーコード発行');
    expect(normalizeBotCommand('キーコード　リセット')).toBe('キーコードリセット');
    expect(normalizeBotCommand('キーコード\nリセットお願いします')).toBe('キーコードリセットお願いします');
  });

  it('正しい形と自由文は変えない', async () => {
    const { normalizeBotCommand } = await import('./bot-routed-message.js');
    for (const t of [
      '【リッチメニュー】キーコード発行',
      '「【キーワード】キーコードリセット」',
      'キーコード発行ができません',
      'プラン確認したいです',
      'ホームページ見ました。料金はいくらですか？',
      'キーコード',
    ]) {
      expect(normalizeBotCommand(t), t).toBe(t);
    }
  });

  it('表記ゆれの押下も未対応に数えない', () => {
    expect(isBotRoutedText('キーコード発行\n')).toBe(true);
    expect(isBotRoutedText('キーコード　リセット')).toBe(true);
  });

  it('メニュー名の一覧は、リッチメニューとアクションの受け口と一致している', async () => {
    const { readFileSync } = await import('node:fs');
    const { RICHMENU_COMMANDS } = await import('./bot-routed-message.js');
    const richMenu = String(readFileSync(new URL('./rich-menu.ts', import.meta.url).pathname));
    const actions = String(readFileSync(new URL('./actions.ts', import.meta.url).pathname));
    const handled = new Set([
      ...[...richMenu.matchAll(/tab === '([^']+)'/g)].map((m) => m[1]),
      ...[...actions.slice(actions.indexOf('export async function handleFurimAction')).matchAll(/case '([^']+)':/g)].map((m) => m[1]),
    ]);
    expect([...handled].sort()).toEqual([...RICHMENU_COMMANDS].sort());
  });
});
