import { describe, it, expect, vi } from 'vitest';
import { withOutgoingLog } from './message-log.js';

function makeClient() {
  return {
    replyMessage: vi.fn().mockResolvedValue({}),
    pushMessage: vi.fn().mockResolvedValue({}),
  };
}

/**
 * SQL文字列でルーティングする簡易 D1。
 * friends には「ラップ対象(friend1 = Uowner)」と「別人(friend2 = Uother)」の2人がいる。
 * INSERT された messages_log の行は inserted に貯める。
 */
function makeDb(inserted: Array<{ friendId: string; content: string }>) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            first: async () => {
              if (/SELECT line_user_id FROM friends WHERE id/.test(sql)) {
                return args[0] === 'friend1' ? { line_user_id: 'Uowner' } : null;
              }
              if (/SELECT id FROM friends WHERE line_user_id/.test(sql)) {
                if (args[0] === 'Uowner') return { id: 'friend1' };
                if (args[0] === 'Uother') return { id: 'friend2' };
                return null;
              }
              return null;
            },
            run: async () => {
              if (/INSERT INTO messages_log/.test(sql)) {
                inserted.push({ friendId: String(args[1]), content: String(args[3]) });
              }
              return {};
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('withOutgoingLog', () => {
  it('自分宛のpushは自分の履歴に残る', async () => {
    const inserted: Array<{ friendId: string; content: string }> = [];
    const client = makeClient();
    const wrapped = withOutgoingLog(client as never, makeDb(inserted), 'friend1');

    await wrapped.pushMessage('Uowner', [{ type: 'text', text: 'あなた宛' } as never]);

    expect(client.pushMessage).toHaveBeenCalledOnce();
    expect(inserted).toEqual([{ friendId: 'friend1', content: 'あなた宛' }]);
  });

  // 紹介成立処理では、被紹介者でラップしたクライアントからアンバサダーへも push する。
  // 宛先を見ずに記録すると、アンバサダー宛の文面が被紹介者のチャットに混ざる
  it('別人宛のpushはその相手の履歴に残る（送信元の履歴には残さない）', async () => {
    const inserted: Array<{ friendId: string; content: string }> = [];
    const client = makeClient();
    const wrapped = withOutgoingLog(client as never, makeDb(inserted), 'friend1');

    await wrapped.pushMessage('Uother', [{ type: 'text', text: 'アンバサダー宛' } as never]);

    expect(inserted).toEqual([{ friendId: 'friend2', content: 'アンバサダー宛' }]);
  });

  it('友だち登録が無い相手へのpushは記録しない（記録先を決められないため）', async () => {
    const inserted: Array<{ friendId: string; content: string }> = [];
    const client = makeClient();
    const wrapped = withOutgoingLog(client as never, makeDb(inserted), 'friend1');

    await wrapped.pushMessage('Uunknown', [{ type: 'text', text: '宛先不明' } as never]);

    expect(client.pushMessage).toHaveBeenCalledOnce();  // 送信自体は行う
    expect(inserted).toEqual([]);
  });

  it('replyは宛先がreplyTokenなので、ラップ対象の履歴に残る', async () => {
    const inserted: Array<{ friendId: string; content: string }> = [];
    const client = makeClient();
    const wrapped = withOutgoingLog(client as never, makeDb(inserted), 'friend1');

    await wrapped.replyMessage('replytoken123', [{ type: 'text', text: '返信' } as never]);

    expect(client.replyMessage).toHaveBeenCalledOnce();
    expect(inserted).toEqual([{ friendId: 'friend1', content: '返信' }]);
  });
});
