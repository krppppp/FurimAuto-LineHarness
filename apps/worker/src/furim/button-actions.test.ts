import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./gas-client.js', () => ({ gasGet: vi.fn(), gasPost: vi.fn() }));

const { handleButtonAction } = await import('./button-actions.js');

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
function makeDb(opts: { tagExists: boolean }) {
  const inserts: string[] = [];
  let tagCreated = false;
  return {
    inserts,
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => {
              if (/FROM friends WHERE line_user_id/.test(sql)) return { id: 'friend1' };
              if (/FROM tags WHERE name/.test(sql)) return opts.tagExists || tagCreated ? { id: 'tag1' } : null;
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

const env = { GAS_DEPLOY_ID: 'deploy-id' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('解約理由アンケート回答', () => {
  it('料金理由 → タグ新規作成・付与＋お礼＋ダウングレード提案を返す', async () => {
    const client = makeClient();
    const db = makeDb({ tagExists: false });

    const handled = await handleButtonAction(client as never, 'U1', 'rt', '【ボタン】解約理由:料金が高い', env, db as never);

    expect(handled).toBe(true);
    expect(db.inserts.some((s) => /INSERT OR IGNORE INTO tags/.test(s))).toBe(true);
    expect(db.inserts.some((s) => /INSERT OR IGNORE INTO friend_tags/.test(s))).toBe(true);
    const messages = client.replyMessage.mock.calls[0][1] as Array<{ text: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0].text).toContain('ご回答ありがとうございます');
    expect(messages[1].text).toContain('liff.line.me');
  });

  it('物販休止 → タグ付与＋お礼のみ（提案なし）', async () => {
    const client = makeClient();
    const db = makeDb({ tagExists: true });

    const handled = await handleButtonAction(client as never, 'U1', 'rt', '【ボタン】解約理由:物販休止', env, db as never);

    expect(handled).toBe(true);
    expect(db.inserts.some((s) => /INSERT OR IGNORE INTO friend_tags/.test(s))).toBe(true);
    const messages = client.replyMessage.mock.calls[0][1] as Array<{ text: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].text).not.toContain('liff.line.me');
  });
});

describe('チケット購入 N枚（決済 URL は Worker で組む・Capsec #243）', () => {
  const ticketEnv = {
    GAS_DEPLOY_ID: 'deploy-id',
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
