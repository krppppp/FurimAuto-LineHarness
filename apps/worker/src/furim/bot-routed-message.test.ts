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
    expect(normalizeBotCommand('「キーコード リセット」')).toBe('キーコードリセット');
    expect(normalizeBotCommand('【キーワード】キーコード　リセット')).toBe('キーコードリセット');
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
      // 空白を詰めると「キーコードリセット」を含む質問は、リセットに回さない（統括指摘）
      'キーコード リセットしたのに入れません',
      'キーコード　リセットはどうやるんですか？',
      'キーコード\nリセットお願いします',
    ]) {
      expect(normalizeBotCommand(t), t).toBe(t);
    }
  });

  it('表記ゆれの押下も未対応に数えない', () => {
    expect(isBotRoutedText('キーコード発行\n')).toBe(true);
    expect(isBotRoutedText('キーコード　リセット')).toBe(true);
    expect(isBotRoutedText('キーコード リセットしたのに入れません')).toBe(false);
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

describe('bot の処理の証拠と失敗の記録（Capsec #300）', () => {
  it('送信記録の時刻がオフセット無しの旧形式でも 60 秒の判定ができる', async () => {
    const { isBotHandledIncoming } = await import('./bot-routed-message.js');
    const tap = '2026-08-21 12:49:31';
    expect(isBotHandledIncoming('text', '【リッチメニュー】キーコード発行', tap, [{ created_at: '2026-08-21T12:49:40.000+09:00', content: 'pb_x' }])).toBe(true);
    expect(isBotHandledIncoming('text', '【リッチメニュー】キーコード発行', tap, [{ created_at: '2026-08-21T12:51:00.000+09:00', content: 'pb_x' }])).toBe(false);
    expect(isBotHandledIncoming('text', 'スマホ対応してますか？', tap, [{ created_at: '2026-08-21T12:49:40.000+09:00', content: 'x' }])).toBe(false);
  });

  it('ハンドラーの失敗を furim_ext_errors に method=botHandler で 1 行残す。db が無ければ何もしない', async () => {
    const { recordBotHandlerError } = await import('./bot-routed-message.js');
    const calls: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return { bind: (...binds: unknown[]) => ({ run: async () => { calls.push({ sql, binds }); return {}; } }) };
      },
    } as unknown as D1Database;
    await recordBotHandlerError(db, 'Uabc', 'handleFurimAction:限定特典GET', 'handler', new Error('Firebase 503'));
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("'botHandler'");
    expect(calls[0].binds[1]).toBe('Uabc');
    expect(calls[0].binds[2]).toBe('handleFurimAction:限定特典GET / handler / Firebase 503');
    await recordBotHandlerError(undefined, 'Uabc', 'x', 'handler', new Error('y'));
    expect(calls).toHaveLength(1);
  });
});

describe('キーコードリセットの依頼とみなす文（Capsec #298・統括決定）', () => {
  it('40 字以下の依頼はリセットに回す', async () => {
    const { isKeycodeResetRequest } = await import('./bot-routed-message.js');
    for (const t of ['キーコードリセット', '「【キーワード】キーコードリセット」', 'キーコードリセットしたい', '【pb_2ketnafp】キーコードリセット']) {
      expect(isKeycodeResetRequest(t), t).toBe(true);
    }
  });

  it('認証エラー文の貼り付け（8/4 の形）とバグ報告のひな形（9/13 の形）はリセットしない', async () => {
    const { isKeycodeResetRequest, isBotRoutedText } = await import('./bot-routed-message.js');
    const pasted = '✕ 認証できませんでした\n理由：このキーコードは別の端末で既に使用されているか、紐付けが処理中です。\nLINE で「キーコードリセット」と送信してから、もう一度入力してください。';
    const bugReport = '【バグ・エラー報告フォーマット】\nバージョン：4.3.0\n発生したページ：拡張機能のコード入力ページ\nバグ・エラー内容：キーコードリセット';
    expect(isKeycodeResetRequest(pasted)).toBe(false);
    expect(isKeycodeResetRequest(bugReport)).toBe(false);
    // bot に回さないので未返信に残り、人が判断する
    expect(isBotRoutedText(pasted)).toBe(false);
    expect(isBotRoutedText(bugReport)).toBe(false);
  });

  it('40 字以下なら名乗り付きの依頼（34・35 字）もリセットし、40 字を超える文は人に回す（統括決定で 40 字）', async () => {
    const { isKeycodeResetRequest } = await import('./bot-routed-message.js');
    expect(isKeycodeResetRequest('遅くなりました。\n\n當間浩輝です。\nキーコードリセットお願いいたします')).toBe(true);
    expect(isKeycodeResetRequest('遅くなりました。\n\n當間浩輝です。\nキーコードリセットお願い致します')).toBe(true);
    expect(isKeycodeResetRequest('お世話になっております。拡張機能が動かないので、キーコードリセットをしてみたのですが認証できません')).toBe(false);
  });
});
