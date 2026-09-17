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
