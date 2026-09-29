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

const env = { GAS_DEPLOY_ID: 'deploy-id' };

beforeEach(() => {
  vi.clearAllMocks();
});

// TB-740 子2: 解約成立直後に push する 1 問アンケート（5択は英字コードで飛ぶ）
describe('解約理由アンケート 5択（英字コード）', () => {
  it('reason_code を最新の解約行に書き、自由記述のお願いを 1 通だけ返す', async () => {
    const client = makeClient();
    const db = makeDb({ tagExists: false, cancellation: { id: 'c1', reason_text: null, reason_answered_at: null } });

    const handled = await handleButtonAction(client as never, 'U1', 'rt', '【ボタン】解約理由:price', env, db as never);

    expect(handled).toBe(true);
    const update = db.binds.find((b) => /UPDATE furim_cancellations SET reason_code/.test(b.sql));
    expect(update?.args[0]).toBe('price');
    // 5択の側ではタグを作らない（旧フローの分岐に落ちていない証拠）
    expect(db.inserts.some((s) => /INTO tags/.test(s))).toBe(false);
    const messages = client.replyMessage.mock.calls[0][1] as Array<{ text: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain('差し支えなければ');
    // 新アンケート側には引き止め・再契約導線を置かない（TB-740。旧分岐の 980 円案内はここには来ない）
    expect(messages[0].text).not.toContain('liff.line.me');
  });

  it('解約行が無くてもお礼は返す（記録だけ諦める）', async () => {
    const client = makeClient();
    const db = makeDb({ tagExists: false, cancellation: null });

    const handled = await handleButtonAction(client as never, 'U1', 'rt', '【ボタン】解約理由:not_working', env, db as never);

    expect(handled).toBe(true);
    expect(db.binds.some((b) => /UPDATE furim_cancellations/.test(b.sql))).toBe(false);
    expect(client.replyMessage).toHaveBeenCalledTimes(1);
  });

  it('未知のコードは旧フロー（タグ記録）に落ちる', async () => {
    const client = makeClient();
    const db = makeDb({ tagExists: true, cancellation: { id: 'c1', reason_text: null, reason_answered_at: null } });

    await handleButtonAction(client as never, 'U1', 'rt', '【ボタン】解約理由:toString', env, db as never);

    expect(db.binds.some((b) => /UPDATE furim_cancellations/.test(b.sql))).toBe(false);
    expect(db.inserts.some((s) => /INSERT OR IGNORE INTO friend_tags/.test(s))).toBe(true);
  });
});

describe('解約理由アンケート回答', () => {
  // 「月980円〜」の案内は旧分岐に残す（TB-748 で F事業のリーダーが決定Aを改めた）。
  // 新アンケート（5択）には元から入っていないので TB-740 の要件は満たしている
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
