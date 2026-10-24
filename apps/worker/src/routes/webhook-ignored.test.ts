import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// TB-2236: 「対応しない」タグの友だちは受信を記録するだけで、返信・通知・オートメーションに進まない
const lineClientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  pushMessage: vi.fn(),
}));

vi.mock('@line-crm/db', () => ({
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  getLineAccounts: vi.fn().mockResolvedValue([]),
  jstNow: vi.fn().mockReturnValue('2026-10-25T07:00:00.000+09:00'),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return { ...actual, verifySignature: vi.fn().mockResolvedValue(true), LineClient: vi.fn().mockImplementation(() => lineClientMocks) };
});

vi.mock('../services/event-bus.js', () => ({ fireEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/push-notify.js', () => ({ notifyStaffOfIncomingMessage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../furim/ai-chat.js', () => ({ handleAIChat: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../furim/firebase-client.js', async () => {
  const actual = await vi.importActual<typeof import('../furim/firebase-client.js')>('../furim/firebase-client.js');
  return { ...actual, getAiMode: vi.fn().mockResolvedValue(true) };
});

import { getFriendByLineUserId, upsertChatOnMessage } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { notifyStaffOfIncomingMessage } from '../services/push-notify.js';
import { handleAIChat } from '../furim/ai-chat.js';
import { webhook } from './webhook.js';

const friend = {
  id: 'friend-ignored',
  line_user_id: 'U-ignored',
  display_name: 'イタズラ',
  picture_url: null,
  status_message: null,
  is_following: 1,
  user_id: null,
  line_account_id: null,
  metadata: '{}',
  first_tracked_link_id: null,
  created_at: '2026-10-24T19:10:00.000+09:00',
  updated_at: '2026-10-24T19:10:00.000+09:00',
};

function makeDb(ignored: boolean) {
  const runs: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        run: async () => { runs.push({ sql, args }); return {}; },
        all: async () => ({ results: [] }),
        first: async () => (sql.includes('friend_tags') && ignored ? { x: 1 } : null),
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, runs };
}

async function post(db: D1Database, message: Record<string, unknown>) {
  const app = new Hono();
  app.route('/', webhook);
  const executionCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
  const res = await app.request('/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
    body: JSON.stringify({
      destination: 'bot',
      events: [{
        type: 'message', replyToken: 'reply-token', message,
        timestamp: Date.now(), source: { type: 'user', userId: 'U-ignored' },
        webhookEventId: 'ev', deliveryContext: { isRedelivery: false }, mode: 'active',
      }],
    }),
  }, { DB: db, LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't' }, executionCtx);
  expect(res.status).toBe(200);
  await (vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getFriendByLineUserId).mockResolvedValue(friend);
});

describe('POST /webhook — 「対応しない」の友だち（TB-2236）', () => {
  test('テキストは記録だけ。返信・AI チャット・通知・未読・オートメーションに進まない', async () => {
    const { db, runs } = makeDb(true);
    await post(db, { type: 'text', id: 'm1', text: 'セカオワww' });

    expect(runs.some((r) => r.sql.includes("'incoming'") && r.args.includes('セカオワww'))).toBe(true);
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    expect(lineClientMocks.pushMessage).not.toHaveBeenCalled();
    expect(handleAIChat).not.toHaveBeenCalled();
    expect(notifyStaffOfIncomingMessage).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
    expect(fireEvent).not.toHaveBeenCalled();
  });

  test('スタンプも記録だけ。未読・通知にしない', async () => {
    const { db, runs } = makeDb(true);
    await post(db, { type: 'sticker', id: 'm2', packageId: '11539', stickerId: '52114141' });

    expect(runs.some((r) => r.sql.includes("'incoming'"))).toBe(true);
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
    expect(notifyStaffOfIncomingMessage).not.toHaveBeenCalled();
  });

  test('タグが無い友だちのスタンプは今までどおり未読・通知になる', async () => {
    const { db } = makeDb(false);
    await post(db, { type: 'sticker', id: 'm3', packageId: '11539', stickerId: '52114141' });

    expect(upsertChatOnMessage).toHaveBeenCalled();
    expect(notifyStaffOfIncomingMessage).toHaveBeenCalled();
  });
});
