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

vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@line-crm/db');
  return {
    ...actual,
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

vi.mock('@line-crm/line-sdk', () => {
  return {
    LineClient: vi.fn().mockImplementation(() => ({
      replyMessage: vi.fn().mockResolvedValue(undefined),
      pushMessage: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../furim/gas-client.js', () => ({
  gasPost: vi.fn().mockResolvedValue({ success: true, keyCode: 'pb_test123' }),
  gasGet: vi.fn().mockResolvedValue({}),
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
