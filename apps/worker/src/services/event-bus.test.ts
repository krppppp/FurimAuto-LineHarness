import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent } from './event-bus.js';

interface CapturedInsert {
  sql: string;
  binds: unknown[];
}

function fakeDb(opts: {
  friend?: { line_user_id: string };
  capturedInserts: CapturedInsert[];
}): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          if (sql.includes('INSERT INTO messages_log')) {
            opts.capturedInserts.push({ sql, binds: args });
          }
          return this;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: [] };
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('FROM friends WHERE id')) {
            return (opts.friend ?? null) as T | null;
          }
          return null;
        },
        async run(): Promise<{ success: true }> {
          return { success: true };
        },
      };
    },
  } as unknown as D1Database;
}

// 冪等記録のインメモリ状態（hasProcessedStripeAction/markStripeActionProcessedをモック）
const idem = vi.hoisted(() => ({ done: new Set<string>(), delivery: new Map<string, { status: string; retry_key: string | null }>() }));

vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@line-crm/db');
  return {
    ...actual,
    hasProcessedStripeAction: vi.fn(async (_db: unknown, ek: string, ak: string) => idem.done.has(`${ek}::${ak}`)),
    markStripeActionProcessed: vi.fn(async (_db: unknown, ek: string, ak: string) => { idem.done.add(`${ek}::${ak}`); }),
    getStripeActionRecord: vi.fn(async (_db: unknown, ek: string, ak: string) => idem.delivery.get(`${ek}::${ak}`) ?? null),
    ensureStripeDeliveryPending: vi.fn(async (_db: unknown, ek: string, ak: string, key: string) => {
      const k = `${ek}::${ak}`;
      const ex = idem.delivery.get(k);
      if (ex) {
        if (!ex.retry_key) ex.retry_key = key;
        return ex.retry_key;
      }
      idem.delivery.set(k, { status: 'pending', retry_key: key });
      return key;
    }),
    markStripeActionSent: vi.fn(async (_db: unknown, ek: string, ak: string) => {
      const r = idem.delivery.get(`${ek}::${ak}`);
      if (r) r.status = 'done';
    }),
    getActiveOutgoingWebhooksByEvent: vi.fn().mockResolvedValue([]),
    applyScoring: vi.fn().mockResolvedValue(undefined),
    getActiveAutomationsByEvent: vi.fn(),
    createAutomationLog: vi.fn().mockResolvedValue(undefined),
    getActiveNotificationRulesByEvent: vi.fn().mockResolvedValue([]),
    createNotification: vi.fn().mockResolvedValue(undefined),
    addTagToFriend: vi.fn().mockResolvedValue(undefined),
    removeTagFromFriend: vi.fn().mockResolvedValue(undefined),
    enrollFriendInScenario: vi.fn().mockResolvedValue(undefined),
    jstNow: () => '2026-05-08T00:00:00.000+09:00',
    getFriendScore: vi.fn().mockResolvedValue(0),
    getTemplateById: vi.fn().mockResolvedValue(null),
  };
});

// pushの挙動をテストから差し替えられるように共有implに委譲する
// （インスタンスごとのvi.fnは維持するので、mock.results経由の既存アサーションはそのまま動く）
const lineCtl = vi.hoisted(() => ({
  pushImpl: (async () => undefined) as (to: string, msgs: unknown[], retryKey?: string) => Promise<unknown>,
}));

vi.mock('@line-crm/line-sdk', () => {
  return {
    LineClient: vi.fn().mockImplementation(() => ({
      replyMessage: vi.fn().mockResolvedValue(undefined),
      pushMessage: vi.fn((to: string, msgs: unknown[], retryKey?: string) => lineCtl.pushImpl(to, msgs, retryKey)),
    })),
  };
});

vi.mock('./ad-conversion.js', () => ({
  sendAdConversions: vi.fn().mockResolvedValue(undefined),
}));

describe('fireEvent — send_message action logging', () => {
  let captured: CapturedInsert[];

  beforeEach(async () => {
    captured = [];
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: 'auto-1',
        line_account_id: 'acc-1',
        conditions: JSON.stringify({ keyword: 'コスト比較' }),
        actions: JSON.stringify([
          {
            type: 'send_message',
            params: {
              messageType: 'flex',
              content: '{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"hi"}]}}',
              altText: 'hi',
            },
          },
        ]),
      },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('logs flex outgoing message to messages_log when send_message fires via reply', async () => {
    const db = fakeDb({
      friend: { line_user_id: 'U_test' },
      capturedInserts: captured,
    });
    await fireEvent(
      db,
      'message_received',
      {
        friendId: 'friend-1',
        eventData: { text: 'コスト比較', matched: true },
        replyToken: 'reply-token-xyz',
      },
      'channel-token',
      'acc-1',
    );

    expect(captured).toHaveLength(1);
    const insert = captured[0];
    expect(insert.sql).toContain('INSERT INTO messages_log');
    // bind order: id, friendId, messageType, content, deliveryType, source, lineAccountId, createdAt
    expect(insert.binds[1]).toBe('friend-1');
    expect(insert.binds[2]).toBe('flex');
    expect(insert.binds[4]).toBe('reply');
    expect(insert.binds[5]).toBe('automation');
    expect(insert.binds[6]).toBe('acc-1');
  });

  it('logs delivery_type=push when no replyToken provided', async () => {
    const db = fakeDb({
      friend: { line_user_id: 'U_test' },
      capturedInserts: captured,
    });
    await fireEvent(
      db,
      'message_received',
      {
        friendId: 'friend-1',
        eventData: { text: 'コスト比較', matched: true },
      },
      'channel-token',
      'acc-1',
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].binds[4]).toBe('push');
  });

  it('logs even when text message (not flex) is sent', async () => {
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: 'auto-2',
        line_account_id: null,
        conditions: JSON.stringify({}),
        actions: JSON.stringify([
          {
            type: 'send_message',
            params: { messageType: 'text', content: 'hello' },
          },
        ]),
      },
    ]);

    const dbFake = fakeDb({
      friend: { line_user_id: 'U_test' },
      capturedInserts: captured,
    });
    await fireEvent(
      dbFake,
      'tag_added',
      { friendId: 'friend-1', eventData: {} },
      'channel-token',
      null,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].binds[2]).toBe('text');
    expect(captured[0].binds[3]).toBe('hello');
    expect(captured[0].binds[6]).toBe(null);
  });

  it('resolves params.template_id via templates table when set', async () => {
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: 'auto-tpl',
        line_account_id: null,
        conditions: JSON.stringify({}),
        actions: JSON.stringify([
          {
            type: 'send_message',
            params: {
              template_id: 'tpl-1',
              // content / messageType を空にして template 経由 resolve を強制
            },
          },
        ]),
      },
    ]);
    (db.getTemplateById as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      id: 'tpl-1',
      name: 'test-tpl',
      category: 'general',
      message_type: 'flex',
      message_content: '{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"from-template"}]}}',
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const dbFake = fakeDb({
      friend: { line_user_id: 'U_test' },
      capturedInserts: captured,
    });
    await fireEvent(
      dbFake,
      'manual_test',
      { friendId: 'friend-1', eventData: {} },
      'channel-token',
      null,
    );

    expect(captured).toHaveLength(1);
    // log には template から取得した messageType / content が記録される
    expect(captured[0].binds[2]).toBe('flex');
    expect(String(captured[0].binds[3])).toContain('from-template');
  });
});

vi.mock('../furim/gas-client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gasPost: vi.fn().mockResolvedValue({ success: true, keyCode: 'pb_test123' }),
  gasGet: vi.fn().mockResolvedValue({}),
}));

vi.mock('../furim/gas-retry-queue.js', () => ({
  enqueueGasRetryJob: vi.fn(),
}));

describe('fireEvent — 汎用eventData等値条件', () => {
  let captured: CapturedInsert[];

  beforeEach(async () => {
    captured = [];
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: 'auto-inv-new',
        line_account_id: 'acc-1',
        conditions: JSON.stringify({ isNewSubscription: true }),
        actions: JSON.stringify([
          { type: 'send_message', params: { messageType: 'text', content: '新規登録ありがとうございます' } },
        ]),
      },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('eventDataの値が一致すれば発火する', async () => {
    const db = fakeDb({ friend: { line_user_id: 'U_test' }, capturedInserts: captured });
    await fireEvent(
      db,
      'stripe_invoice_paid',
      { friendId: 'friend-1', eventData: { isNewSubscription: true } },
      'channel-token',
      'acc-1',
    );
    expect(captured).toHaveLength(1);
  });

  it('eventDataの値が不一致なら発火しない（継続課金に新規メッセージが飛ばない）', async () => {
    const db = fakeDb({ friend: { line_user_id: 'U_test' }, capturedInserts: captured });
    await fireEvent(
      db,
      'stripe_invoice_paid',
      { friendId: 'friend-1', eventData: { isNewSubscription: false } },
      'channel-token',
      'acc-1',
    );
    expect(captured).toHaveLength(0);
  });

  it('eventDataにキー自体が無ければ発火しない', async () => {
    const db = fakeDb({ friend: { line_user_id: 'U_test' }, capturedInserts: captured });
    await fireEvent(
      db,
      'stripe_invoice_paid',
      { friendId: 'friend-1', eventData: {} },
      'channel-token',
      'acc-1',
    );
    expect(captured).toHaveLength(0);
  });
});

describe('fireEvent — call_gas_post capture', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('GAS応答のフィールドをeventDataに保存し後続send_messagesで展開する', async () => {
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: 'auto-friend-add',
        line_account_id: 'acc-1',
        conditions: JSON.stringify({}),
        actions: JSON.stringify([
          {
            type: 'call_gas_post',
            params: {
              method: 'syncFeaturesFromSubscription',
              args: { lineUserId: '{{line_user_id}}', packages: 'trial' },
              capture: { keyCode: 'keyCode' },
            },
          },
          {
            type: 'send_messages',
            params: {
              messages: [{ messageType: 'text', content: 'あなたのキーコード: {{eventData.keyCode}}' }],
            },
          },
        ]),
      },
    ]);

    const dbFake = fakeDb({ friend: { line_user_id: 'U_test' }, capturedInserts: [] });
    await fireEvent(
      dbFake,
      'friend_add',
      { friendId: 'friend-1', eventData: { isNewUser: true } },
      'channel-token',
      'acc-1',
      { gasDeployId: 'gas-dep-test' },
    );

    const gas = await import('../furim/gas-client.js');
    const gasPostMock = gas.gasPost as unknown as { mock: { calls: unknown[][] } };
    expect(gasPostMock.mock.calls).toHaveLength(1);
    expect(gasPostMock.mock.calls[0][1]).toMatchObject({
      method: 'syncFeaturesFromSubscription',
      lineUserId: 'U_test',
      packages: 'trial',
    });

    const { LineClient } = await import('@line-crm/line-sdk');
    const instances = (LineClient as unknown as { mock: { results: Array<{ value: { pushMessage: { mock: { calls: unknown[][] } } } }> } }).mock.results;
    const pushCalls = instances.flatMap((r) => r.value.pushMessage.mock.calls);
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0][1]).toEqual([
      { type: 'text', text: 'あなたのキーコード: pb_test123' },
    ]);
  });
});

describe('fireEvent — 冪等 (idempotencyKey / stripe再処理)', () => {
  beforeEach(() => { idem.done.clear(); });
  afterEach(() => { vi.clearAllMocks(); idem.done.clear(); });

  async function setupSingleAddTag() {
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      { id: 'auto-idem', line_account_id: null, conditions: '{}', actions: JSON.stringify([{ type: 'add_tag', params: { tagId: 't1' } }]) },
    ]);
    return db;
  }

  it('同じidempotencyKeyでは成功済みアクションを再実行しない (exactly-once)', async () => {
    const db = await setupSingleAddTag();
    const addTag = db.addTagToFriend as unknown as { mock: { calls: unknown[][] } };
    const dbFake = fakeDb({ friend: { line_user_id: 'U' }, capturedInserts: [] });
    const ok1 = await fireEvent(dbFake, 'stripe_invoice_paid', { friendId: 'f1', idempotencyKey: 'evt_1', eventData: {} });
    const ok2 = await fireEvent(dbFake, 'stripe_invoice_paid', { friendId: 'f1', idempotencyKey: 'evt_1', eventData: {} });
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
    expect(addTag.mock.calls).toHaveLength(1); // 2回目はスキップ＝二重実行しない
  });

  it('idempotencyKey無しなら毎回実行する (後方互換・非stripe経路は挙動不変)', async () => {
    const db = await setupSingleAddTag();
    const addTag = db.addTagToFriend as unknown as { mock: { calls: unknown[][] } };
    const dbFake = fakeDb({ friend: { line_user_id: 'U' }, capturedInserts: [] });
    await fireEvent(dbFake, 'stripe_invoice_paid', { friendId: 'f1', eventData: {} });
    await fireEvent(dbFake, 'stripe_invoice_paid', { friendId: 'f1', eventData: {} });
    expect(addTag.mock.calls).toHaveLength(2);
  });

  it('途中失敗したアクションは再処理で再実行される (取りこぼし補完・堤腰さん事象の再現)', async () => {
    const db = await setupSingleAddTag();
    const addTag = db.addTagToFriend as unknown as {
      mockRejectedValueOnce: (e: unknown) => void;
      mock: { calls: unknown[][] };
    };
    addTag.mockRejectedValueOnce(new Error('GAS timeout (初回waitUntil途中死を模擬)'));
    const dbFake = fakeDb({ friend: { line_user_id: 'U' }, capturedInserts: [] });
    const ok1 = await fireEvent(dbFake, 'stripe_invoice_paid', { friendId: 'f1', idempotencyKey: 'evt_2', eventData: {} });
    const ok2 = await fireEvent(dbFake, 'stripe_invoice_paid', { friendId: 'f1', idempotencyKey: 'evt_2', eventData: {} });
    expect(ok1).toBe(false); // 初回失敗→未完(=stripe_eventはcompletedにならずcron再処理される)
    expect(ok2).toBe(true);  // 再処理で成功
    expect((addTag as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(2); // 失敗分だけ再実行
  });
});

describe('fireEvent — call_gas_post 失敗時のキュー退避（2026-08-14 Stripe経路統合）', () => {
  afterEach(() => {
    vi.clearAllMocks();
    idem.done.clear();
  });

  async function setupGasAutomation(method: string) {
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: 'auto-gas',
        line_account_id: 'acc-1',
        conditions: JSON.stringify({}),
        actions: JSON.stringify([
          { type: 'call_gas_post', params: { method, args: { stripeCustomerID: 'cus_1', subscriptionID: 'sub_1' } } },
        ]),
      },
    ]);
  }

  it('ホワイトリストのメソッドはgasPost例外でキュー退避し、automationは成功扱いになる', async () => {
    await setupGasAutomation('setSubscriptionData');
    const gas = await import('../furim/gas-client.js');
    (gas.gasPost as unknown as { mockRejectedValueOnce: (e: unknown) => void }).mockRejectedValueOnce(new Error('GAS fetch hang'));
    const queue = await import('../furim/gas-retry-queue.js');

    const dbFake = fakeDb({ friend: { line_user_id: 'U_test' }, capturedInserts: [] });
    const ok = await fireEvent(dbFake, 'stripe_invoice_paid', { friendId: 'friend-1', idempotencyKey: 'evt_q1', eventData: {} }, 'tok', 'acc-1', { gasDeployId: 'dep-1' });

    expect(ok).toBe(true);
    const enq = queue.enqueueGasRetryJob as unknown as { mock: { calls: unknown[][] } };
    expect(enq.mock.calls).toHaveLength(1);
    expect(enq.mock.calls[0][1]).toMatchObject({
      lineUserId: 'U_test',
      method: 'setSubscriptionData',
      callType: 'post',
      doneCheck: 'subscriptionRecorded',
      dedupeKey: 'setSubscriptionData:evt_q1',
      maxAttempts: 20,
      params: { stripeCustomerID: 'cus_1', subscriptionID: 'sub_1' },
    });
  });

  it('success:false応答も失敗としてキュー退避される（無言ロストの穴を塞ぐ）', async () => {
    await setupGasAutomation('setTransactionData');
    const gas = await import('../furim/gas-client.js');
    (gas.gasPost as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({ success: false, error: '該当レコードなし' });
    const queue = await import('../furim/gas-retry-queue.js');

    const dbFake = fakeDb({ friend: { line_user_id: 'U_test' }, capturedInserts: [] });
    const ok = await fireEvent(dbFake, 'stripe_invoice_paid', { friendId: 'friend-1', idempotencyKey: 'evt_q2', eventData: {} }, 'tok', 'acc-1', { gasDeployId: 'dep-1' });

    expect(ok).toBe(true);
    const enq = queue.enqueueGasRetryJob as unknown as { mock: { calls: unknown[][] } };
    expect(enq.mock.calls).toHaveLength(1);
    expect(enq.mock.calls[0][1]).toMatchObject({ method: 'setTransactionData', doneCheck: 'transactionRecorded' });
  });

  it('ホワイトリスト外メソッドのsuccess:falseはautomation失敗になり、キューには積まれない', async () => {
    await setupGasAutomation('setSurveyResult');
    const gas = await import('../furim/gas-client.js');
    (gas.gasPost as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({ success: false, error: 'boom' });
    const queue = await import('../furim/gas-retry-queue.js');

    const dbFake = fakeDb({ friend: { line_user_id: 'U_test' }, capturedInserts: [] });
    const ok = await fireEvent(dbFake, 'stripe_invoice_paid', { friendId: 'friend-1', idempotencyKey: 'evt_q3', eventData: {} }, 'tok', 'acc-1', { gasDeployId: 'dep-1' });

    expect(ok).toBe(false);
    expect((queue.enqueueGasRetryJob as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0);
  });
});


describe('fireEvent — 配信の2段階先記録とX-Line-Retry-Key（2026-08-18）', () => {
  afterEach(() => {
    vi.clearAllMocks();
    idem.done.clear();
    idem.delivery.clear();
    lineCtl.pushImpl = async () => undefined;
  });

  it('送信失敗はpendingのまま残り、再処理が同一Retry-Keyで再送し、成功後はスキップされる', async () => {
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: 'auto-delivery',
        line_account_id: 'acc-1',
        conditions: JSON.stringify({}),
        actions: JSON.stringify([
          { type: 'send_messages', params: { messages: [{ messageType: 'text', content: '継続課金ありがとうございます' }] } },
        ]),
      },
    ]);

    const seenKeys: Array<string | undefined> = [];
    let failFirst = true;
    lineCtl.pushImpl = async (_to, _msgs, retryKey) => {
      seenKeys.push(retryKey);
      if (failFirst) {
        failFirst = false;
        throw new Error('LINE API error: 500');
      }
      return undefined;
    };

    const dbFake = fakeDb({ friend: { line_user_id: 'U_test' }, capturedInserts: [] });

    // 1回目: 送信失敗 → 自動化は未完(false)・記録はpendingのまま
    const ok1 = await fireEvent(dbFake, 'stripe_invoice_paid', { friendId: 'friend-1', idempotencyKey: 'evt_dl_1', eventData: {} }, 'tok', 'acc-1');
    expect(ok1).toBe(false);
    expect(idem.delivery.get('evt_dl_1::auto-delivery:0')?.status).toBe('pending');

    // 2回目(再処理): pendingなので再送される。Retry-Keyは1回目と同一
    const ok2 = await fireEvent(dbFake, 'stripe_invoice_paid', { friendId: 'friend-1', idempotencyKey: 'evt_dl_1', eventData: {} }, 'tok', 'acc-1');
    expect(ok2).toBe(true);
    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).toBeTruthy();
    expect(seenKeys[1]).toBe(seenKeys[0]);
    expect(idem.delivery.get('evt_dl_1::auto-delivery:0')?.status).toBe('done');

    // 3回目: doneなので送信されない
    const ok3 = await fireEvent(dbFake, 'stripe_invoice_paid', { friendId: 'friend-1', idempotencyKey: 'evt_dl_1', eventData: {} }, 'tok', 'acc-1');
    expect(ok3).toBe(true);
    expect(seenKeys).toHaveLength(2);
  });
});
