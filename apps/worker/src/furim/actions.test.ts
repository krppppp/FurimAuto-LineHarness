import { describe, it, expect, vi, beforeEach } from 'vitest';

// gasGet / gasPost を差し替え、他の furim モジュールは実体を使う。
// キーコード発行・月額会員ページ・限定特典GET は D1 furim_customers を読む（Capsec #243）
const gasGet = vi.fn();
const gasPost = vi.fn();
vi.mock('./gas-client.js', () => ({ gasGet, gasPost, getGasErrorFromResponse: () => null }));
vi.mock('./firebase-client.js', () => ({
  getSentGiftBatches: vi.fn().mockResolvedValue([]),
  setSentGiftBatches: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@line-crm/db', () => ({
  jstNow: () => '2026-09-13T12:00:00.000+09:00',
  getFriendByLineUserId: vi.fn(),
  getAffiliateByFriendId: vi.fn(),
  createAffiliate: vi.fn(),
  enrollAffiliateInOffer: vi.fn(),
}));

const { handleFurimAction } = await import('./actions.js');

function makeClient() {
  return {
    replyMessage: vi.fn().mockResolvedValue({}),
    pushMessage: vi.fn().mockResolvedValue({}),
  };
}

type Write = { sql: string; args: unknown[] };

/** SQL 文字列でルーティングする簡易 D1 */
function makeDb(opts: { customer?: Record<string, unknown> | null; friendMeta?: string; tagId?: string | null } = {}) {
  const writes: Write[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            run: async () => { writes.push({ sql, args }); return {}; },
            first: async () => {
              if (/FROM furim_customers WHERE line_user_id/.test(sql)) return opts.customer ?? null;
              if (/SELECT metadata FROM friends/.test(sql)) return opts.friendMeta != null ? { metadata: opts.friendMeta } : null;
              if (/SELECT id FROM friends WHERE line_user_id/.test(sql)) return { id: 'friend1' };
              if (/FROM tags WHERE name/.test(sql)) return opts.tagId === null ? null : { id: opts.tagId ?? 'tag1' };
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, writes };
}

const env = { GAS_DEPLOY_ID: 'deploy-id' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('actionKeycodeIssue (キーコード発行は D1 から返す)', () => {
  it('正常系: D1 の key_code を reply で返し、初回発行フラグを D1→GAS の順で立てる', async () => {
    gasPost.mockResolvedValueOnce({ success: true });
    const client = makeClient();
    const { db, writes } = makeDb({ customer: { key_code: 'pb_abcd1234', key_code_issued: 0 } });

    const handled = await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】キーコード発行', env, db);

    expect(handled).toBe(true);
    expect(gasGet).not.toHaveBeenCalled();
    expect(client.replyMessage).toHaveBeenCalledWith('rt', [{ type: 'text', text: 'pb_abcd1234' }]);
    expect(client.pushMessage).not.toHaveBeenCalled();
    const issued = writes.find((w) => /INSERT INTO furim_customers/.test(w.sql));
    expect(issued?.sql).toContain('key_code_issued = excluded.key_code_issued');
    expect(gasPost).toHaveBeenCalledWith('deploy-id', { method: 'setCustomerFields', lineUserId: 'Uxxx', fields: { '初回発行': true } });
    // セグメント3 昇格
    expect(writes.some((w) => /INSERT OR IGNORE INTO friend_tags/.test(w.sql))).toBe(true);
  });

  it('初回発行済みなら GAS への鏡写しはしない', async () => {
    const client = makeClient();
    const { db } = makeDb({ customer: { key_code: 'pb_abcd1234', key_code_issued: 1 } });

    await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】キーコード発行', env, db);

    expect(client.replyMessage).toHaveBeenCalledWith('rt', [{ type: 'text', text: 'pb_abcd1234' }]);
    expect(gasPost).not.toHaveBeenCalled();
  });

  it('鏡写しの GAS が失敗しても顧客には返信済みで、再実行キューに積む', async () => {
    gasPost.mockRejectedValueOnce(new Error('GAS POST 500'));
    const client = makeClient();
    const { db, writes } = makeDb({ customer: { key_code: 'pb_abcd1234', key_code_issued: 0 } });

    await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】キーコード発行', env, db);

    expect(client.replyMessage).toHaveBeenCalledWith('rt', [{ type: 'text', text: 'pb_abcd1234' }]);
    expect(client.pushMessage).not.toHaveBeenCalled();
    const q = writes.find((w) => /INSERT INTO gas_retry_jobs/.test(w.sql));
    expect(q).toBeTruthy();
    expect(q!.args).toContain('setCustomerFields');
    expect(q!.args).toContain('setCustomerFields:初回発行');
  });

  it('reply が失敗 (replyToken失効) → 同じ内容を push で届ける', async () => {
    const client = makeClient();
    client.replyMessage.mockRejectedValueOnce(new Error('Invalid reply token'));
    const { db } = makeDb({ customer: { key_code: 'pb_abcd1234', key_code_issued: 1 } });

    await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】キーコード発行', env, db);

    expect(client.pushMessage).toHaveBeenCalledWith('Uxxx', [{ type: 'text', text: 'pb_abcd1234' }]);
  });

  it('D1 に行が無い / key_code が空 → 準備中案内（GAS 時代の 401 と同じ文面）', async () => {
    const client = makeClient();
    const { db } = makeDb({ customer: null });

    await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】キーコード発行', env, db);

    expect((client.replyMessage.mock.calls[0][1] as { text: string }[])[0].text).toContain('準備中');
    expect(gasGet).not.toHaveBeenCalled();
    expect(gasPost).not.toHaveBeenCalled();
  });
});

describe('actionMemberPage (月額会員ページ)', () => {
  const stripeEnv = { GAS_DEPLOY_ID: 'deploy-id', STRIPE_SECRET_KEY: 'sk_test_x' };

  it('D1 の Stripe顧客ID で Billing Portal を作り imagemap で返す（GAS は呼ばない）', async () => {
    const fetchStub = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ url: 'https://billing.stripe.com/p/session_1' }) });
    vi.stubGlobal('fetch', fetchStub);
    try {
      const client = makeClient();
      const { db } = makeDb({ customer: { stripe_customer_id: 'cus_d1' } });

      await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】月額会員ページ', stripeEnv, db);

      expect(gasGet).not.toHaveBeenCalled();
      expect(String(fetchStub.mock.calls[0][0])).toContain('billing_portal/sessions');
      expect((fetchStub.mock.calls[0][1] as { body: string }).body).toBe('customer=cus_d1');
      const msg = (client.replyMessage.mock.calls[0][1] as Array<{ type: string; actions: Array<{ linkUri: string }> }>)[0];
      expect(msg.type).toBe('imagemap');
      expect(msg.actions[0].linkUri).toBe('https://billing.stripe.com/p/session_1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('furim_customers に無ければ friends.metadata.stripeCustomerId を使う', async () => {
    const fetchStub = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ url: 'https://billing.stripe.com/p/s2' }) });
    vi.stubGlobal('fetch', fetchStub);
    try {
      const client = makeClient();
      const { db } = makeDb({ customer: null, friendMeta: JSON.stringify({ stripeCustomerId: 'cus_meta' }) });
      await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】月額会員ページ', stripeEnv, db);
      expect((fetchStub.mock.calls[0][1] as { body: string }).body).toBe('customer=cus_meta');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('顧客ID がどこにも無ければ「会員情報が見つかりませんでした。」', async () => {
    const client = makeClient();
    const { db } = makeDb({ customer: null });
    await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】月額会員ページ', stripeEnv, db);
    expect((client.replyMessage.mock.calls[0][1] as { text: string }[])[0].text).toBe('会員情報が見つかりませんでした。');
  });
});

describe('actionLimitedGift (限定特典GET)', () => {
  it('D1 の 6 フラグで解放判定し、GAS は呼ばない（アンケート済み → 特典③④が解放）', async () => {
    const client = makeClient();
    const { db } = makeDb({ customer: { survey_answer: '紹介', key_code_issued: 0, device_activated: 0, free30_ticket: 0, youtube_coupon: null, extend_keyword: null } });

    await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】限定特典GET', env, db);

    expect(gasGet).not.toHaveBeenCalled();
    const messages = client.replyMessage.mock.calls[0][1] as Array<{ type: string; text?: string }>;
    expect(messages[0].text).toContain('アンケートご回答ありがとうございます');
    expect(messages[0].text).toContain('③ ロードマップ❸');
  });

  it('行が無ければ全 false（次の特典①のヒントを返す）', async () => {
    const client = makeClient();
    const { db } = makeDb({ customer: null });
    await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】限定特典GET', env, db);
    const messages = client.replyMessage.mock.calls[0][1] as Array<{ type: string; text?: string }>;
    expect(messages.some((m) => (m.text ?? '').includes('アンケートにご回答いただくと'))).toBe(true);
  });
});

describe('handleFurimAction の汎用エラーフォールバック', () => {
  it('アクション内で例外 → push でエラー案内 (無言にしない)', async () => {
    const client = makeClient();
    const db = { prepare() { throw new Error('D1 down'); } } as unknown as D1Database;

    const handled = await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】キーコード発行', env, db);

    expect(handled).toBe(true);
    expect(client.pushMessage).toHaveBeenCalledTimes(1);
    expect((client.pushMessage.mock.calls[0][1] as { text: string }[])[0].text).toContain('エラーが発生しました');
  });
});
