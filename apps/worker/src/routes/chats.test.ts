import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lineClientMocks = vi.hoisted(() => ({
  pushTextMessage: vi.fn().mockResolvedValue(undefined),
  pushFlexMessage: vi.fn().mockResolvedValue(undefined),
  pushImageMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    LineClient: vi.fn().mockImplementation(() => lineClientMocks),
  };
});

vi.mock('@line-crm/db', () => ({
  getOperators: vi.fn(),
  getOperatorById: vi.fn(),
  createOperator: vi.fn(),
  updateOperator: vi.fn(),
  deleteOperator: vi.fn(),
  getChats: vi.fn(),
  getChatById: vi.fn(),
  createChat: vi.fn(),
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
  updateChat: vi.fn().mockResolvedValue(undefined),
  jstNow: vi.fn(() => '2026-07-30T12:00:00.000+09:00'),
}));

import { getChatById, getFriendById } from '@line-crm/db';
import { chats } from './chats.js';

function setupApp() {
  const app = new Hono();
  app.route('/', chats);
  return app;
}

const existingChat = {
  id: 'chat-1',
  friend_id: 'friend-1',
  operator_id: null,
  status: 'in_progress',
  notes: null,
  last_message_at: '2026-07-30T11:00:00.000+09:00',
  created_at: '2026-07-01T00:00:00.000+09:00',
  updated_at: '2026-07-30T11:00:00.000+09:00',
};

const existingFriend = {
  id: 'friend-1',
  line_user_id: 'U-friend-1',
  line_account_id: null,
  display_name: 'Test Friend',
};

const baseEnv = { LINE_CHANNEL_ACCESS_TOKEN: 'default-token' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/chats/:id/send — 引用返信', () => {
  test('replyToMessageIdを指定するとquote_tokenをDBから取得しpushTextMessageに渡し、INSERTにreply_to_message_idが入る', async () => {
    vi.mocked(getChatById).mockResolvedValue(existingChat as never);
    vi.mocked(getFriendById).mockResolvedValue(existingFriend as never);

    const selectStmt = {
      bind: vi.fn(),
      first: vi.fn().mockResolvedValue({ quote_token: 'quote-abc' }),
    };
    selectStmt.bind.mockReturnValue(selectStmt);
    const insertStmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
    };
    insertStmt.bind.mockReturnValue(insertStmt);

    const db = {
      prepare: vi.fn((sql: string) => (sql.includes('SELECT quote_token') ? selectStmt : insertStmt)),
    } as unknown as D1Database;

    const app = setupApp();
    const res = await app.request(
      '/api/chats/chat-1/send',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '了解です', replyToMessageId: 'msg-original-1' }),
      },
      { ...baseEnv, DB: db },
    );

    expect(res.status).toBe(200);
    expect(selectStmt.bind).toHaveBeenCalledWith('msg-original-1', 'friend-1');
    expect(lineClientMocks.pushTextMessage).toHaveBeenCalledWith('U-friend-1', '了解です', 'quote-abc');
    expect(insertStmt.bind).toHaveBeenCalledWith(
      expect.any(String),
      'friend-1',
      'text',
      '了解です',
      'msg-original-1',
      '2026-07-30T12:00:00.000+09:00',
    );
  });

  test('引用元がquote_tokenを持たない場合はpushTextMessageにquoteTokenを渡さない', async () => {
    vi.mocked(getChatById).mockResolvedValue(existingChat as never);
    vi.mocked(getFriendById).mockResolvedValue(existingFriend as never);

    const selectStmt = {
      bind: vi.fn(),
      first: vi.fn().mockResolvedValue({ quote_token: null }),
    };
    selectStmt.bind.mockReturnValue(selectStmt);
    const insertStmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
    };
    insertStmt.bind.mockReturnValue(insertStmt);

    const db = {
      prepare: vi.fn((sql: string) => (sql.includes('SELECT quote_token') ? selectStmt : insertStmt)),
    } as unknown as D1Database;

    const app = setupApp();
    const res = await app.request(
      '/api/chats/chat-1/send',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '了解です', replyToMessageId: 'msg-no-token' }),
      },
      { ...baseEnv, DB: db },
    );

    expect(res.status).toBe(200);
    expect(lineClientMocks.pushTextMessage).toHaveBeenCalledWith('U-friend-1', '了解です', undefined);
  });

  test('messageTypeがtext以外でreplyToMessageIdを指定すると400を返しLINE APIを呼ばない', async () => {
    vi.mocked(getChatById).mockResolvedValue(existingChat as never);
    vi.mocked(getFriendById).mockResolvedValue(existingFriend as never);

    const db = { prepare: vi.fn() } as unknown as D1Database;

    const app = setupApp();
    const res = await app.request(
      '/api/chats/chat-1/send',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageType: 'image', content: '{}', replyToMessageId: 'msg-original-1' }),
      },
      { ...baseEnv, DB: db },
    );

    expect(res.status).toBe(400);
    expect(lineClientMocks.pushImageMessage).not.toHaveBeenCalled();
    expect(db.prepare).not.toHaveBeenCalled();
  });

  test('replyToMessageIdなしの通常送信はquote_tokenを取得せずreply_to_message_idはNULLで記録される', async () => {
    vi.mocked(getChatById).mockResolvedValue(existingChat as never);
    vi.mocked(getFriendById).mockResolvedValue(existingFriend as never);

    const insertStmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
    };
    insertStmt.bind.mockReturnValue(insertStmt);
    const db = { prepare: vi.fn().mockReturnValue(insertStmt) } as unknown as D1Database;

    const app = setupApp();
    const res = await app.request(
      '/api/chats/chat-1/send',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '通常メッセージ' }),
      },
      { ...baseEnv, DB: db },
    );

    expect(res.status).toBe(200);
    expect(lineClientMocks.pushTextMessage).toHaveBeenCalledWith('U-friend-1', '通常メッセージ', undefined);
    expect(insertStmt.bind).toHaveBeenCalledWith(
      expect.any(String),
      'friend-1',
      'text',
      '通常メッセージ',
      null,
      '2026-07-30T12:00:00.000+09:00',
    );
  });
});
