import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handleButtonAction } = await import('./button-actions.js');
const { CANCELLATION_REASON_REPLY_TEXT } = await import('./cancellation-reason.js');

function makeClient() {
  return {
    replyMessage: vi.fn().mockResolvedValue({}),
    pushMessage: vi.fn().mockResolvedValue({}),
  };
}

/**
 * SQL文字列でルーティングする簡易 D1。
 * - friends 取得 → { id: 'friend1' }
 * - tags 取得 → opts.tagExists で { id: 'tag1' } / null
 * - INSERT は記録して {} を返す
 */
function makeDb(opts: { tagExists: boolean; cancellation?: { id: string; reason_text: string | null; reason_answered_at: string | null } | null }) {
  const inserts: string[] = [];
  const binds: Array<{ sql: string; args: unknown[] }> = [];
  let tagCreated = false;
  return {
    inserts,
    binds,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          binds.push({ sql, args });
          return {
            first: async () => {
              if (/FROM friends WHERE line_user_id/.test(sql)) return { id: 'friend1' };
              if (/FROM tags WHERE name/.test(sql)) return opts.tagExists || tagCreated ? { id: 'tag1' } : null;
              if (/FROM furim_cancellations/.test(sql)) return opts.cancellation ?? null;
              return null;
            },
            run: async () => {
              inserts.push(sql);
              if (/INSERT.*INTO tags/.test(sql)) tagCreated = true;
              return {};
            },
          };
        },
      };
    },
  };
}

const env = {};

beforeEach(() => {
  vi.clearAllMocks();
});

// TB-740 子2: 解約成立直後に push する 1 問アンケート。TB-825 で旧アンケートの 6 択に戻した。
// ボタンは日本語の送信値を送り（顧客のトークに英字コードを出さない）、D1 には reason_code が入る。
// 旧と同じタグ「解約理由:<送信値>」も付け、980 円の案内も旧どおり返す（TB-748）
describe('解約理由アンケート 6択（reason_code・タグ・返信 2 吹き出し）', () => {
  const cases = [
    { value: '料金が高い', code: 'price', retention: true },
    { value: '使いこなせなかった', code: 'could_not_use', retention: true },
    { value: '成果が出なかった', code: 'no_results', retention: true },
    { value: '物販休止', code: 'paused_selling', retention: false },
    { value: '他ツールへ乗り換え', code: 'switched_tool', retention: false },
    { value: 'その他', code: 'other', retention: true },
  ];

  for (const c of cases) {
    it(`${c.value} → reason_code=${c.code}・タグ「解約理由:${c.value}」・2 通目＋${c.retention ? '980円の案内' : '再開のお待ち'}`, async () => {
      const client = makeClient();
      const db = makeDb({ tagExists: false, cancellation: { id: 'c1', reason_text: null, reason_answered_at: null } });

      const handled = await handleButtonAction(client as never, 'U1', 'rt', `【ボタン】解約理由:${c.value}`, env, db as never);

      expect(handled).toBe(true);
      const update = db.binds.find((b) => /UPDATE furim_cancellations SET reason_code/.test(b.sql));
      expect(update?.args[0]).toBe(c.code);
      expect(update?.args[2]).toBe('c1');
      const tagInsert = db.binds.find((b) => /INSERT OR IGNORE INTO tags/.test(b.sql));
      expect(tagInsert?.args[1]).toBe(`解約理由:${c.value}`);
      expect(db.binds.find((b) => /INSERT OR IGNORE INTO friend_tags/.test(b.sql))?.args.slice(0, 2)).toEqual(['friend1', 'tag1']);

      expect(client.replyMessage).toHaveBeenCalledTimes(1);
      const messages = client.replyMessage.mock.calls[0][1] as Array<{ text: string }>;
      expect(messages).toHaveLength(2);
      expect(messages[0].text).toBe(CANCELLATION_REASON_REPLY_TEXT);
      // 旧の「ご回答ありがとうございます🙇…」は 2 通目と重なるので出さない
      expect(messages.some((m) => m.text.includes('ご回答ありがとうございます🙇'))).toBe(false);
      if (c.retention) {
        expect(messages[1].text).toContain('💡【機能を絞って安く続ける選択肢も】');
        expect(messages[1].text).toContain('月980円(税抜)');
        expect(messages[1].text).toContain('liff.line.me');
      } else {
        expect(messages[1].text).toBe('また物販を再開される際は、いつでもこのLINEからお待ちしております！');
      }
    });
  }

  it('解約行が無くてもタグと返信は行う（reason_code の記録だけ諦める）', async () => {
    const client = makeClient();
    const db = makeDb({ tagExists: true, cancellation: null });

    const handled = await handleButtonAction(client as never, 'U1', 'rt', '【ボタン】解約理由:料金が高い', env, db as never);

    expect(handled).toBe(true);
    expect(db.binds.some((b) => /UPDATE furim_cancellations/.test(b.sql))).toBe(false);
    expect(db.inserts.some((s) => /INSERT OR IGNORE INTO friend_tags/.test(s))).toBe(true);
    expect((client.replyMessage.mock.calls[0][1] as unknown[]).length).toBe(2);
  });
});

describe('解約理由アンケート: 6 択に無い送信値（旧 5 択 TB-746 のボタン）', () => {
  for (const old of ['値段', '動かない', '使い方が分からない', '売るものがない・稼げなかった', '副業をやめた']) {
    it(`${old} → reason_code もタグも書かず、返信もしない（webhook 側へ false で返す）`, async () => {
      const client = makeClient();
      const db = makeDb({ tagExists: false, cancellation: { id: 'c1', reason_text: null, reason_answered_at: null } });

      const handled = await handleButtonAction(client as never, 'U1', 'rt', `【ボタン】解約理由:${old}`, env, db as never);

      expect(handled).toBe(false);
      expect(db.binds.some((b) => /furim_cancellations|tags/.test(b.sql))).toBe(false);
      expect(db.inserts).toHaveLength(0);
      expect(client.replyMessage).not.toHaveBeenCalled();
    });
  }
});

describe('チケット購入 N枚（決済 URL は Worker で組む・Capsec #243）', () => {
  const ticketEnv = {
    WORKER_NAME: 'line-harness-prod',
    FURIM_TICKET_LIFF_URL: 'https://liff.line.me/1660804123-VgnRNDJm',
    FURIM_TICKET_PRICE_IDS: JSON.stringify({ '15': 'price_15', '14': 'price_14', '13': 'price_13', '10': 'price_10' }),
  };

  function makeTicketDb(opts: { customer?: Record<string, unknown> | null; planName?: string | null }) {
    return {
      prepare(sql: string) {
        return {
          bind() {
            return {
              first: async () => {
                if (/FROM furim_customers WHERE line_user_id/.test(sql)) return opts.customer ?? null;
                if (/SELECT plan_name FROM friends/.test(sql)) return { plan_name: opts.planName ?? null };
                if (/SELECT metadata FROM friends/.test(sql)) return null;
                return null;
              },
              run: async () => ({}),
            };
          },
        };
      },
    } as unknown as D1Database;
  }

  it('有料会員の 200 枚 → 14 円の PriceID・D1 の顧客ID・env=prod の imagemap', async () => {
    const client = makeClient();
    const db = makeTicketDb({ customer: { stripe_customer_id: 'cus_d1' }, planName: 'PBプラン:メルカリ 基本プラン' });

    const handled = await handleButtonAction(client as never, 'U1', 'rt', '【ボタン】チケット購入 200枚', ticketEnv, db);

    expect(handled).toBe(true);
    const msg = (client.replyMessage.mock.calls[0][1] as Array<{ type: string; actions: Array<{ linkUri: string }> }>)[0];
    expect(msg.type).toBe('imagemap');
    expect(msg.actions[0].linkUri).toMatch(/^https:\/\/liff\.line\.me\/1660804123-VgnRNDJm\?price_id=price_14&quantity=200&customer_id=cus_d1&expired=\d+&env=prod$/);
  });

  it('通常会員（プラン名なし）の 1000 枚 → 15 円のまま', async () => {
    const client = makeClient();
    const db = makeTicketDb({ customer: { stripe_customer_id: 'cus_d1' }, planName: null });
    await handleButtonAction(client as never, 'U1', 'rt', '【ボタン】チケット購入 1000枚', ticketEnv, db);
    const msg = (client.replyMessage.mock.calls[0][1] as Array<{ actions: Array<{ linkUri: string }> }>)[0];
    expect(msg.actions[0].linkUri).toContain('price_id=price_15&quantity=1000&');
  });

  it('50 枚未満はエラー文を返す', async () => {
    const client = makeClient();
    const db = makeTicketDb({ customer: null, planName: null });
    await handleButtonAction(client as never, 'U1', 'rt', '【ボタン】チケット購入 10枚', ticketEnv, db);
    expect((client.replyMessage.mock.calls[0][1] as Array<{ text: string }>)[0].text).toBe('最低50枚から購入可能です');
  });
});
