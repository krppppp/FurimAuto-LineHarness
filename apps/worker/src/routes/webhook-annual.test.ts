import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

const lineClientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  pushMessage: vi.fn(),
}));

// Stub the DB graph — these tests focus on webhook guard behavior and the
// first-contact friend registration path without touching real D1/LINE.
vi.mock('@line-crm/db', () => ({
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getScenarioSteps: vi.fn(),
  advanceFriendScenario: vi.fn(),
  completeFriendScenario: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  getLineAccounts: vi.fn().mockResolvedValue([]),
  jstNow: vi.fn(),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
  addTagToFriend: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getMessageTemplateById: vi.fn(),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    verifySignature: vi.fn(),
    LineClient: vi.fn().mockImplementation(() => lineClientMocks),
  };
});

vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn(),
  expandVariables: vi.fn(),
  resolveMetadata: vi.fn().mockResolvedValue({}),
  messageToLogPayload: vi.fn().mockReturnValue({ messageType: 'flex', content: '{}' }),
}));

vi.mock('../furim/actions.js', () => ({
  handleFurimAction: vi.fn().mockResolvedValue(false),
  actionFurimanCoupon: vi.fn().mockResolvedValue(undefined),
  actionExtendTrial: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../furim/ai-chat.js', () => ({
  handleAIChat: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../furim/firebase-client.js', async () => {
  const actual = await vi.importActual<typeof import('../furim/firebase-client.js')>('../furim/firebase-client.js');
  return { ...actual, getAiMode: vi.fn() };
});

vi.mock('../furim/annual-prepay-line-handler.js', () => ({
  replyAnnualQuote: vi.fn().mockResolvedValue(true),
  replyAnnualConfirm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/push-notify.js', () => ({
  notifyStaffOfIncomingMessage: vi.fn().mockResolvedValue(undefined),
}));

import { verifySignature } from '@line-crm/line-sdk';
import {
  addTagToFriend,
  advanceFriendScenario,
  completeFriendScenario,
  computeNextDeliveryAt,
  enrollFriendInScenario,
  getEntryRouteByRefCode,
  getFriendByLineUserId,
  getLineAccounts,
  getMessageTemplateById,
  getScenarioSteps,
  getScenarios,
  jstNow,
  resolveStepContent,
  updateFriendFollowStatus,
  upsertChatOnMessage,
  upsertFriend,
} from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { actionExtendTrial, actionFurimanCoupon, handleFurimAction } from '../furim/actions.js';
import { handleAIChat } from '../furim/ai-chat.js';
import { getAiMode } from '../furim/firebase-client.js';
import { notifyStaffOfIncomingMessage } from '../services/push-notify.js';
import { webhook } from './webhook.js';
import { replyAnnualConfirm, replyAnnualQuote } from '../furim/annual-prepay-line-handler.js';
import { evaluateKeyCodeSet, KEY_CODE_ERROR } from '../furim/ext-auth.js';
import type { FurimCustomer } from '../furim/customer-store.js';

function setupApp() {
  const app = new Hono();
  app.route('/', webhook);
  return app;
}

const friend = {
  id: 'friend-annual', line_user_id: 'U-annual', display_name: 'A', picture_url: null, status_message: null, is_following: 1,
  user_id: null, line_account_id: null, metadata: '{}', first_tracked_link_id: null,
  created_at: '2026-11-21T09:00:00.000+09:00', updated_at: '2026-11-21T09:00:00.000+09:00',
};

const annualRule = {
  id: 'ar-annual', keyword: '年払い', match_type: 'exact' as const, response_type: 'text',
  response_content: '年払いのご希望を受け付けました。', template_id: null, is_active: 1, created_at: '2026-11-20T23:56:00.000+09:00',
};

function makeDb() {
  return {
    prepare: vi.fn((sql: string) => {
      const stmt = {
        args: [] as unknown[],
        bind: vi.fn((...a: unknown[]) => { stmt.args = a; return stmt; }),
        run: vi.fn().mockResolvedValue({}),
        all: vi.fn(async () => ({ results: sql.includes('FROM auto_replies') ? [annualRule] : [] })),
        first: vi.fn(async () => (sql.includes("match_type = 'exact'") && stmt.args[0] === annualRule.keyword ? annualRule : null)),
      };
      return stmt;
    }),
  } as unknown as D1Database;
}

async function post(event: Record<string, unknown>) {
  vi.mocked(verifySignature).mockResolvedValue(true);
  vi.mocked(getFriendByLineUserId).mockResolvedValue(friend);
  vi.mocked(jstNow).mockReturnValue('2026-11-21T09:00:00.000+09:00');
  vi.mocked(getAiMode).mockResolvedValue(false);
  vi.mocked(handleFurimAction).mockResolvedValue(false);
  const executionCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
  const res = await setupApp().request(
    '/webhook',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
      body: JSON.stringify({
        destination: 'bot',
        events: [{ replyToken: 'reply-token', timestamp: Date.now(), source: { type: 'user', userId: 'U-annual' }, webhookEventId: 'ev', deliveryContext: { isRedelivery: false }, mode: 'active', ...event }],
      }),
    },
    { DB: makeDb(), LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', STRIPE_SECRET_KEY: 'sk_test_dummy', FIREBASE_DATABASE_URL: 'https://example.firebaseio.com' },
    executionCtx,
  );
  expect(res.status).toBe(200);
  await (vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLineAccounts).mockResolvedValue([]);
});

describe('POST /webhook — 年払いの金額案内と決済（TB-3964）', () => {
  test('「年払い」は行の文面ではなく、その人の金額の案内を返す。タグ用の message_received は matched で飛ぶ', async () => {
    await post({ type: 'message', message: { type: 'text', id: 'm1', text: '年払い' } });
    expect(replyAnnualQuote).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replyAnnualQuote).mock.calls[0][4]).toMatchObject({ id: 'friend-annual', line_user_id: 'U-annual' });
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    const ev = vi.mocked(fireEvent).mock.calls.find((c) => c[1] === 'message_received');
    expect(ev?.[2]).toMatchObject({ eventData: { text: '年払い', matched: true }, replyToken: undefined });
  });

  test('「この内容で申し込む」の postback は決済に進み、auto_replies を見ない', async () => {
    await post({ type: 'postback', postback: { data: 'annual_prepay=confirm&annual=89800' } });
    expect(replyAnnualConfirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replyAnnualConfirm).mock.calls[0][3]).toBe('reply-token');
    expect(vi.mocked(replyAnnualConfirm).mock.calls[0][6]).toBe(89800);
    expect(replyAnnualQuote).not.toHaveBeenCalled();
  });

  test('ほかの postback は今までどおり', async () => {
    await post({ type: 'postback', postback: { data: 'something_else' } });
    expect(replyAnnualConfirm).not.toHaveBeenCalled();
  });
});
