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
import { webhook } from './webhook.js';
import { evaluateKeyCodeSet, KEY_CODE_ERROR } from '../furim/ext-auth.js';
import type { FurimCustomer } from '../furim/customer-store.js';

function setupApp() {
  const app = new Hono();
  app.route('/', webhook);
  return app;
}

const baseEnv = {
  DB: {} as D1Database,
  LINE_CHANNEL_SECRET: 'env-default-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-default-token',
} as Record<string, unknown>;

const baseExecutionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLineAccounts).mockResolvedValue([]);
});

describe('POST /webhook — DoS defenses (#104)', () => {
  test('rejects with 413 when Content-Length declares an oversized body', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(2 * 1024 * 1024), // 2 MiB > 1 MiB cap
          'X-Line-Signature': 'whatever',
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    // Signature verification must not even be attempted on an oversized body.
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('rejects with 413 when actual body exceeds the cap even if Content-Length is absent', async () => {
    const app = setupApp();
    const oversizedBody = 'x'.repeat(1024 * 1024 + 1);
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'whatever',
        },
        body: oversizedBody,
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('verifies signature before parsing JSON — malformed body with invalid signature never reaches the parser', async () => {
    vi.mocked(verifySignature).mockResolvedValue(false);

    const app = setupApp();
    // 44-char signature (valid HMAC-SHA256 base64 length) so it clears the
    // length pre-check and reaches verifySignature. Malformed JSON body: if
    // signature were verified *after* parse (old behavior), we'd hit the
    // parser-failure branch first. With signature-first, we get the invalid-
    // signature branch and never attempt to parse.
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: '{not valid json',
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // verifySignature must run; rejection happens before any parse attempt.
    expect(verifySignature).toHaveBeenCalled();
    expect(verifySignature).toHaveBeenCalledWith('env-default-secret', '{not valid json', validShapedSignature);
  });

  test('rejects unsigned or malformed-signature requests without hitting verifySignature or D1', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Missing X-Line-Signature header entirely.
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // Fast-rejected before any crypto / DB work.
    expect(verifySignature).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — first-contact existing friends', () => {
  test('auto-registers an unknown text-message sender without firing friend_add handling', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(null);
    vi.mocked(jstNow).mockReturnValue('2026-06-18T12:00:00.000+09:00');
    lineClientMocks.getProfile.mockResolvedValue({
      userId: 'U-existing',
      displayName: 'Existing Friend',
      pictureUrl: 'https://example.com/profile.jpg',
      statusMessage: 'hello',
    });
    vi.mocked(upsertFriend).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: 'https://example.com/profile.jpg',
      status_message: 'hello',
      is_following: 1,
      user_id: null,
      line_account_id: null,
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-06-18T12:00:00.000+09:00',
      updated_at: '2026-06-18T12:00:00.000+09:00',
    });
    vi.mocked(upsertChatOnMessage).mockResolvedValue({
      id: 'chat-1',
      friend_id: 'friend-1',
      operator_id: null,
      status: 'unread',
      notes: null,
      last_message_at: '2026-06-18T12:00:00.000+09:00',
      created_at: '2026-06-18T12:00:00.000+09:00',
      updated_at: '2026-06-18T12:00:00.000+09:00',
    });

    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'message',
              replyToken: 'reply-token',
              message: { type: 'text', id: 'message-1', text: 'こんにちは' },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-existing' },
              webhookEventId: 'event-1',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    expect(lineClientMocks.getProfile).toHaveBeenCalledWith('U-existing');
    expect(upsertFriend).toHaveBeenCalledWith(db, {
      lineUserId: 'U-existing',
      displayName: 'Existing Friend',
      pictureUrl: 'https://example.com/profile.jpg',
      statusMessage: 'hello',
    });
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    // fork差分: furim automation用に第6引数actionEnv（GAS等）を渡す
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'message_received',
      expect.objectContaining({ friendId: 'friend-1' }),
      'env-default-token',
      null,
      expect.anything(),
    );
    expect(getScenarios).not.toHaveBeenCalled();
    expect(enrollFriendInScenario).not.toHaveBeenCalled();

    // Keep the unrelated DB stubs quiet but type-checked as mocked imports.
    expect(updateFriendFollowStatus).not.toHaveBeenCalled();
    expect(getScenarioSteps).not.toHaveBeenCalled();
    expect(advanceFriendScenario).not.toHaveBeenCalled();
    expect(completeFriendScenario).not.toHaveBeenCalled();
    expect(computeNextDeliveryAt).not.toHaveBeenCalled();
    expect(resolveStepContent).not.toHaveBeenCalled();
    expect(addTagToFriend).not.toHaveBeenCalled();
    expect(getEntryRouteByRefCode).not.toHaveBeenCalled();
    expect(getMessageTemplateById).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — テキスト受信での quote_token 保存', () => {
  const existingTextFriend = {
    id: 'friend-quote-1',
    line_user_id: 'U-quote',
    display_name: 'Quote Friend',
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: null,
    line_account_id: null,
    metadata: '{}',
    first_tracked_link_id: null,
    created_at: '2026-07-30T12:00:00.000+09:00',
    updated_at: '2026-07-30T12:00:00.000+09:00',
  };

  test('message.quoteToken が messages_log の INSERT に渡る', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(existingTextFriend);
    vi.mocked(jstNow).mockReturnValue('2026-07-30T12:00:00.000+09:00');
    vi.mocked(upsertChatOnMessage).mockResolvedValue({
      id: 'chat-quote-1',
      friend_id: 'friend-quote-1',
      operator_id: null,
      status: 'unread',
      notes: null,
      last_message_at: '2026-07-30T12:00:00.000+09:00',
      created_at: '2026-07-30T12:00:00.000+09:00',
      updated_at: '2026-07-30T12:00:00.000+09:00',
    });

    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'A'.repeat(43) + '=',
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'message',
              replyToken: 'reply-token',
              message: { type: 'text', id: 'message-quote-1', text: 'これに返信して', quoteToken: 'quote-token-abc' },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-quote' },
              webhookEventId: 'event-quote',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    const boundArgs = stmt.bind.mock.calls.flat();
    expect(boundArgs).toContain('quote-token-abc');
  });

  test('quoteToken なしのテキスト受信では null が渡る (undefined送信で型エラーにならない)', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(existingTextFriend);
    vi.mocked(jstNow).mockReturnValue('2026-07-30T12:00:00.000+09:00');
    vi.mocked(upsertChatOnMessage).mockResolvedValue({
      id: 'chat-quote-2',
      friend_id: 'friend-quote-1',
      operator_id: null,
      status: 'unread',
      notes: null,
      last_message_at: '2026-07-30T12:00:00.000+09:00',
      created_at: '2026-07-30T12:00:00.000+09:00',
      updated_at: '2026-07-30T12:00:00.000+09:00',
    });

    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'A'.repeat(43) + '=',
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'message',
              replyToken: 'reply-token',
              message: { type: 'text', id: 'message-quote-2', text: 'quoteTokenなし' },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-quote' },
              webhookEventId: 'event-noquote',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    const boundArgs = stmt.bind.mock.calls.flat();
    expect(boundArgs).toContain(null);
    expect(boundArgs).not.toContain(undefined);
  });
});

describe('POST /webhook — incoming image/video → R2 JSON', () => {
  const existingFriend = {
    id: 'friend-1',
    line_user_id: 'U-media',
    display_name: 'Media Friend',
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: null,
    line_account_id: null,
    metadata: '{}',
    first_tracked_link_id: null,
    created_at: '2026-07-20T12:00:00.000+09:00',
    updated_at: '2026-07-20T12:00:00.000+09:00',
  };

  function makeMediaFetchStub() {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/content/preview')) {
        return new Response(new ArrayBuffer(10), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      if (url.includes('api-data.line.me')) {
        const isVideo = url.includes('msg-video');
        return new Response(new ArrayBuffer(100), {
          status: 200,
          headers: { 'Content-Type': isVideo ? 'video/mp4' : 'image/jpeg' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  async function postMediaEvent(messageType: 'image' | 'video', messageId: string) {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(existingFriend);
    vi.mocked(jstNow).mockReturnValue('2026-07-20T12:00:00.000+09:00');
    vi.mocked(upsertChatOnMessage).mockResolvedValue({
      id: 'chat-1',
      friend_id: 'friend-1',
      operator_id: null,
      status: 'unread',
      notes: null,
      last_message_at: '2026-07-20T12:00:00.000+09:00',
      created_at: '2026-07-20T12:00:00.000+09:00',
      updated_at: '2026-07-20T12:00:00.000+09:00',
    });

    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const r2 = {
      put: vi.fn().mockResolvedValue(null),
    };

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'A'.repeat(43) + '=',
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'message',
              replyToken: 'reply-token',
              message: { type: messageType, id: messageId },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-media' },
              webhookEventId: 'event-media',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db, IMAGES: r2, WORKER_URL: 'https://worker.example.com' },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;
    return { stmt, r2 };
  }

  test('画像受信で messages_log に R2 URL の JSON が入る', async () => {
    const fetchStub = makeMediaFetchStub();
    vi.stubGlobal('fetch', fetchStub);
    try {
      const { stmt, r2 } = await postMediaEvent('image', 'msg-image-1');

      expect(r2.put).toHaveBeenCalled();
      const contentArg = stmt.bind.mock.calls
        .flat()
        .find((arg) => typeof arg === 'string' && arg.includes('originalContentUrl')) as string;
      expect(contentArg).toBeTruthy();
      const parsed = JSON.parse(contentArg);
      expect(parsed.originalContentUrl).toBe('https://worker.example.com/images/incoming-unknown-msg-image-1.jpg');
      expect(parsed.previewImageUrl).toBe(parsed.originalContentUrl);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('動画受信で messages_log に本体+サムネ URL の JSON が入る', async () => {
    const fetchStub = makeMediaFetchStub();
    vi.stubGlobal('fetch', fetchStub);
    try {
      const { stmt, r2 } = await postMediaEvent('video', 'msg-video-1');

      const keys = r2.put.mock.calls.map((call) => call[0]);
      expect(keys).toContain('incoming-unknown-msg-video-1.mp4');
      expect(keys).toContain('incoming-unknown-msg-video-1-preview.jpg');
      const contentArg = stmt.bind.mock.calls
        .flat()
        .find((arg) => typeof arg === 'string' && arg.includes('originalContentUrl')) as string;
      expect(contentArg).toBeTruthy();
      const parsed = JSON.parse(contentArg);
      expect(parsed.originalContentUrl).toBe('https://worker.example.com/images/incoming-unknown-msg-video-1.mp4');
      expect(parsed.previewImageUrl).toBe('https://worker.example.com/images/incoming-unknown-msg-video-1-preview.jpg');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('POST /webhook — 特定キーワードはAIチャットモード中でも通る', () => {
  const aiModeFriend = {
    id: 'friend-ai-1',
    line_user_id: 'U-ai',
    display_name: 'AI Mode Friend',
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: null,
    line_account_id: null,
    metadata: '{}',
    first_tracked_link_id: null,
    created_at: '2026-07-31T12:00:00.000+09:00',
    updated_at: '2026-07-31T12:00:00.000+09:00',
  };

  const aiEnv = {
    ...baseEnv,
    GAS_DEPLOY_ID: 'gas-deploy-id',
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    FIREBASE_DATABASE_URL: 'https://example.firebaseio.com',
    GEMINI_API_KEY: 'gemini-key',
    GITHUB_PAT: 'github-pat',
  };

  async function postText(text: string, opts: { exactAutoReplyKeyword?: string; aiMode?: boolean } = {}) {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(aiModeFriend);
    vi.mocked(jstNow).mockReturnValue('2026-07-31T12:00:00.000+09:00');
    vi.mocked(getAiMode).mockResolvedValue(opts.aiMode ?? true);
    vi.mocked(handleFurimAction).mockResolvedValue(false);

    const exactRule = opts.exactAutoReplyKeyword
      ? {
          id: 'ar-exact-1',
          keyword: opts.exactAutoReplyKeyword,
          match_type: 'exact' as const,
          response_type: 'flex',
          response_content: '{"type":"bubble"}',
          template_id: null,
          is_active: 1,
          created_at: '2026-09-28T00:00:00.000+09:00',
        }
      : null;

    const db = {
      prepare: vi.fn((sql: string) => {
        const stmt = {
          args: [] as unknown[],
          bind: vi.fn((...a: unknown[]) => { stmt.args = a; return stmt; }),
          run: vi.fn().mockResolvedValue({}),
          all: vi.fn(async () => ({
            results: exactRule && sql.includes('FROM auto_replies') ? [exactRule] : [],
          })),
          // findExactAutoReply の lookup。バインドしたキーワードと一致するときだけ行を返す
          first: vi.fn(async () =>
            exactRule && sql.includes("match_type = 'exact'") && stmt.args[0] === exactRule.keyword
              ? exactRule
              : null,
          ),
        };
        return stmt;
      }),
    } as unknown as D1Database;

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'A'.repeat(43) + '=',
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'message',
              replyToken: 'reply-token',
              message: { type: 'text', id: 'message-ai-1', text },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-ai' },
              webhookEventId: 'event-ai',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...aiEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;
  }

  test('AIモードONでも「Furimanです」はクーポン処理に到達する', async () => {
    await postText('Furimanです');
    expect(actionFurimanCoupon).toHaveBeenCalledTimes(1);
    expect(handleAIChat).not.toHaveBeenCalled();
  });

  test('AIモードONでも「解説見た」は無料期間延長処理に到達する', async () => {
    await postText('解説見た');
    expect(actionExtendTrial).toHaveBeenCalledTimes(1);
    expect(handleAIChat).not.toHaveBeenCalled();
  });

  test('AIモードONの通常テキストは引き続きAIチャットが応答する', async () => {
    await postText('こんにちは、使い方を教えて');
    expect(handleAIChat).toHaveBeenCalledTimes(1);
    expect(actionFurimanCoupon).not.toHaveBeenCalled();
    expect(actionExtendTrial).not.toHaveBeenCalled();
  });

  // TB-718: ai_mode は「AIチャットボットを終了する」を押すまで true のままなので、
  // ボタン文言（exact の auto_reply）が AI の定型文に吸われていた
  test('AIモードONでも exact の auto_reply にマッチする文言は自動返信が返る', async () => {
    await postText('ライブ参加', { exactAutoReplyKeyword: 'ライブ参加' });
    expect(handleAIChat).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).toHaveBeenCalledTimes(1);
  });

  test('AIモードONで exact ルールと一致しない自由文は AIチャットのまま', async () => {
    await postText('ライブ参加ってどうやるんですか？', { exactAutoReplyKeyword: 'ライブ参加' });
    expect(handleAIChat).toHaveBeenCalledTimes(1);
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
  });

  // TB-765: 【ボタン】付きの文は Worker の handleButtonAction → exact の auto_reply → 「準備中」の順で必ず返す
  test('AIモードONでも handleButtonAction に無い【ボタン】xxx は exact の auto_reply が返る', async () => {
    await postText('【ボタン】ライブ参加', { exactAutoReplyKeyword: '【ボタン】ライブ参加' });
    expect(handleAIChat).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).toHaveBeenCalledTimes(1);
    expect(lineClientMocks.replyMessage.mock.calls[0]?.[1]).not.toEqual([expect.objectContaining({ text: '現在急ピッチで準備中です！' })]);
  });

  test('AIモードOFFでも【ボタン】xxx は exact の auto_reply が返る', async () => {
    await postText('【ボタン】ライブ参加', { exactAutoReplyKeyword: '【ボタン】ライブ参加', aiMode: false });
    expect(handleAIChat).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).toHaveBeenCalledTimes(1);
  });

  test('【ボタン】xxx がどこにも当たらなければ「準備中」を返す（黙って捨てない）', async () => {
    await postText('【ボタン】まだ無いボタン');
    expect(handleAIChat).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith('reply-token', [expect.objectContaining({ text: '現在急ピッチで準備中です！' })]);
  });

  test('既存の【ボタン】アンケート開始 は auto_reply より handleButtonAction が先に答える', async () => {
    await postText('【ボタン】アンケート開始', { exactAutoReplyKeyword: '【ボタン】アンケート開始' });
    expect(handleAIChat).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fireEvent)).not.toHaveBeenCalled();
  });
});

// TB-740 子2: 5択を押した直後の自由記述だけを reason_text に控え、その 1 通は AIチャットに流さない
describe('POST /webhook — 解約理由の自由記述（TB-740）', () => {
  const friend = {
    id: 'friend-cx-1',
    line_user_id: 'U-cx',
    display_name: 'Cancelled',
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: null,
    line_account_id: null,
    metadata: '{}',
    first_tracked_link_id: null,
    created_at: '2026-07-31T12:00:00.000+09:00',
    updated_at: '2026-07-31T12:00:00.000+09:00',
  };

  const cxEnv = {
    ...baseEnv,
    GAS_DEPLOY_ID: 'gas-deploy-id',
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    FIREBASE_DATABASE_URL: 'https://example.firebaseio.com',
    GEMINI_API_KEY: 'gemini-key',
    GITHUB_PAT: 'github-pat',
  };

  async function postFreeText(text: string, answeredAt: string | null) {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(friend);
    vi.mocked(jstNow).mockReturnValue('2026-07-31T12:00:00.000+09:00');
    vi.mocked(getAiMode).mockResolvedValue(true);
    vi.mocked(handleFurimAction).mockResolvedValue(false);

    const updates: string[] = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        const stmt = {
          bind: vi.fn(() => stmt),
          run: vi.fn(async () => { updates.push(sql); return {}; }),
          all: vi.fn(async () => ({ results: [] })),
          first: vi.fn(async () =>
            /FROM furim_cancellations/.test(sql)
              ? { id: 'c1', reason_text: null, reason_answered_at: answeredAt }
              : null,
          ),
        };
        return stmt;
      }),
    } as unknown as D1Database;

    const executionCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'message',
              replyToken: 'reply-token',
              message: { type: 'text', id: 'message-cx-1', text },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-cx' },
              webhookEventId: 'event-cx',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...cxEnv, DB: db },
      executionCtx,
    );
    expect(res.status).toBe(200);
    await (vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>);
    return { updates };
  }

  test('5択を押してから24時間以内の自由文は reason_text に入り、AIチャットに流れない', async () => {
    const { updates } = await postFreeText('値上げがきつかったです', '2026-07-31T11:00:00.000+09:00');
    expect(updates.some((s) => /UPDATE furim_cancellations SET reason_text/.test(s))).toBe(true);
    expect(handleAIChat).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).toHaveBeenCalledTimes(1);
  });

  // TB-760: 返金・二重請求の問い合わせが混ざるので、お礼で閉じてもスタッフの受信箱には必ず残す
  test('reason_text に入れた文もチャットを作成/更新する（unread になる）', async () => {
    await postFreeText('返金してもらえますか', '2026-07-31T11:00:00.000+09:00');
    expect(upsertChatOnMessage).toHaveBeenCalledWith(expect.anything(), 'friend-cx-1');
  });

  test('お礼の返信が失敗してもチャットの作成/更新は通す', async () => {
    lineClientMocks.replyMessage.mockRejectedValueOnce(new Error('reply token expired'));
    await postFreeText('請求が二重になっています', '2026-07-31T11:00:00.000+09:00');
    expect(upsertChatOnMessage).toHaveBeenCalledWith(expect.anything(), 'friend-cx-1');
  });

  test('24時間を過ぎたテキストは記録せず、今までどおり AIチャットに流れる', async () => {
    const { updates } = await postFreeText('別件の問い合わせです', '2026-07-29T12:00:00.000+09:00');
    expect(updates.some((s) => /UPDATE furim_cancellations SET reason_text/.test(s))).toBe(false);
    expect(handleAIChat).toHaveBeenCalledTimes(1);
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
  });

  test('5択に未回答（reason_answered_at が NULL）なら今までどおり AIチャットに流れる', async () => {
    const { updates } = await postFreeText('こんにちは', null);
    expect(updates.some((s) => /UPDATE furim_cancellations SET reason_text/.test(s))).toBe(false);
    expect(handleAIChat).toHaveBeenCalledTimes(1);
  });

  // ボタンタップ（AUTO_KEYWORDS）は自由記述ではない。解約直後でも reason_text に入れず、
  // 今までどおり auto_reply の経路へ落とす（unread にもしない）
  test('窓の中でもボタンタップの定型文は reason_text に入れない', async () => {
    const { updates } = await postFreeText('料金', '2026-07-31T11:00:00.000+09:00');
    expect(updates.some((s) => /UPDATE furim_cancellations SET reason_text/.test(s))).toBe(false);
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — follow（新規）で試用期間を D1 に先に書く（Capsec #262）', () => {
  const NOW_MS = Date.parse('2026-09-14T12:34:56.789+09:00');
  const DAY_MS = 24 * 60 * 60_000;

  const TRIAL_PLAN_PAYLOAD = JSON.stringify({
    'プラン名': '友達登録2週間トライアルプラン',
    'キーコード接頭語': '2weektrial_',
    features: { mChangePrice: true, mSoldCSV: false, mCopyRakumaListing: false, AutoMultiChannel: 'メルカリ/ラクマ' },
  });

  function followDb(existing: Partial<FurimCustomer> | null, opts: { plan?: string | null } = {}) {
    const upserts: Array<{ sql: string; args: unknown[] }> = [];
    const flagUpserts: Array<{ sql: string; args: unknown[] }> = [];
    const plan = opts.plan === undefined ? TRIAL_PLAN_PAYLOAD : opts.plan;
    const db = {
      prepare: vi.fn((sql: string) => {
        const stmt = {
          sql,
          args: [] as unknown[],
          bind: (...a: unknown[]) => { stmt.args = a; return stmt; },
          first: vi.fn(async () => {
            if (sql.startsWith('SELECT * FROM furim_customers')) return existing;
            if (sql.includes('FROM furim_master')) return plan ? { payload: plan } : null;
            return null;
          }),
          run: vi.fn(async () => {
            if (sql.startsWith('INSERT INTO furim_customers')) upserts.push({ sql, args: stmt.args });
            return {};
          }),
          all: vi.fn(async () => ({ results: [] })),
        };
        return stmt;
      }),
      batch: vi.fn(async (stmts: Array<{ sql: string; args: unknown[] }>) => {
        for (const s of stmts) if (s.sql.includes('INSERT INTO furim_feature_flags')) flagUpserts.push({ sql: s.sql, args: s.args });
        return stmts.map(() => ({ meta: { changes: 1 } }));
      }),
    } as unknown as D1Database;
    return { db, upserts, flagUpserts };
  }

  function flagValues(rows: Array<{ args: unknown[] }>): Record<string, { value: unknown; source: unknown }> {
    // buildFeatureFlagUpserts の bind 順: line_user_id, feature_key, value, source, updated_at
    return Object.fromEntries(rows.map((r) => [String(r.args[1]), { value: r.args[2], source: r.args[3] }]));
  }

  async function follow(db: D1Database, existingFriend: Awaited<ReturnType<typeof getFriendByLineUserId>> = null) {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(existingFriend);
    vi.mocked(jstNow).mockReturnValue('2026-09-14T12:34:56.789+09:00');
    lineClientMocks.getProfile.mockResolvedValue({ userId: 'U-new', displayName: 'New Friend' });
    vi.mocked(upsertFriend).mockResolvedValue({
      id: 'friend-new', line_user_id: 'U-new', display_name: 'New Friend', picture_url: null, status_message: null, is_following: 1,
      user_id: null, line_account_id: null, metadata: '{}', first_tracked_link_id: null,
      created_at: '2026-09-14T12:34:56.789+09:00', updated_at: '2026-09-14T12:34:56.789+09:00',
    });
    const executionCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
    const res = await setupApp().request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
        body: JSON.stringify({
          destination: 'bot',
          events: [{ type: 'follow', replyToken: 'rt', timestamp: NOW_MS, source: { type: 'user', userId: 'U-new' }, webhookEventId: 'ev-follow', deliveryContext: { isRedelivery: false }, mode: 'active' }],
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );
    expect(res.status).toBe(200);
    await (vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>);
  }

  function upsertedColumns(u: { sql: string; args: unknown[] }): Record<string, unknown> {
    const cols = u.sql.match(/INSERT INTO furim_customers \(([^)]+)\)/)![1].split(', ');
    return Object.fromEntries(cols.map((c, i) => [c, u.args[i]]));
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('キーコードと一緒に 登録＝今・終了＝今＋14 日（ISO+09:00・丸めなし）を 1 回の upsert で書く', async () => {
    const { db, upserts } = followDb(null);
    await follow(db);
    expect(upserts).toHaveLength(1);
    const row = upsertedColumns(upserts[0]);
    expect(row.line_user_id).toBe('U-new');
    expect(String(row.key_code)).toMatch(/^2weektrial_[0-9a-z]{8}$/);
    expect(row.subscription_start_at).toBe('2026-09-14T12:34:56.789+09:00');
    expect(row.subscription_end_at).toBe('2026-09-28T12:34:56.789+09:00');
    expect(fireEvent).toHaveBeenCalledWith(db, 'friend_add', expect.objectContaining({ eventData: expect.objectContaining({ isNewUser: true }) }), expect.anything(), null, expect.anything());
  });

  test('試用プランの機能フラグを follow 直後に source=plan で D1 へ書く（TB-300）', async () => {
    const { db, upserts, flagUpserts } = followDb(null);
    await follow(db);
    const row = upsertedColumns(upserts[0]);
    const flags = flagValues(flagUpserts);
    // プラン payload の true/false がそのまま・コピー出品は常時 1（planFeaturesToFlags と同値）
    expect(flags.mChangePrice).toEqual({ value: '1', source: 'plan' });
    expect(flags.mSoldCSV).toEqual({ value: '0', source: 'plan' });
    expect(flags.mCopyRakumaListing).toEqual({ value: '1', source: 'plan' });
    expect(new Set(flagUpserts.map((f) => f.args[0]))).toEqual(new Set(['U-new']));
    expect(String(row.key_code)).toMatch(/^2weektrial_[0-9a-z]{8}$/);
  });

  test('再フォロー（isNewUser=false）では機能フラグを書かない（TB-300）', async () => {
    const { db, upserts, flagUpserts } = followDb(null);
    await follow(db, {
      id: 'friend-old', line_user_id: 'U-new', display_name: 'Old Friend', picture_url: null, status_message: null, is_following: 0,
      user_id: null, line_account_id: null, metadata: '{}', first_tracked_link_id: null,
      created_at: '2026-01-01T00:00:00.000+09:00', updated_at: '2026-01-01T00:00:00.000+09:00',
    } as Awaited<ReturnType<typeof getFriendByLineUserId>>);
    expect(upserts).toHaveLength(0);
    expect(flagUpserts).toHaveLength(0);
  });

  test('試用プランが furim_master に無ければ機能フラグは書かない（TB-300）', async () => {
    const { db, flagUpserts } = followDb(null, { plan: null });
    await follow(db);
    expect(flagUpserts).toHaveLength(0);
  });

  test('期限が入っている行（有料・再追加）は日時を上書きせず、キーコードが無ければキーコードだけ書く', async () => {
    const { db, upserts } = followDb({ line_user_id: 'U-new', key_code: null, subscription_start_at: '2026-01-01T00:00:00.000+09:00', subscription_end_at: '2026-12-01T00:00:00.000+09:00' });
    await follow(db);
    expect(upserts).toHaveLength(1);
    const row = upsertedColumns(upserts[0]);
    expect(Object.keys(row)).toEqual(['line_user_id', 'key_code', 'created_at', 'updated_at']);
  });

  test('D1 に入った期限で Worker 認証が 14 日を過ぎたら「無料期間終了」になる', async () => {
    const { db, upserts } = followDb(null);
    await follow(db);
    const row = upsertedColumns(upserts[0]);
    const customer = { line_user_id: 'U-new', key_code: row.key_code, subscription_end_at: row.subscription_end_at, plan_label: null, device_code: 'dev-1', mercari_url: null, copy_tickets: 0 } as unknown as FurimCustomer;
    const input = { keyCode: String(row.key_code), discriminationCode: 'dev-1', mercariAccountUrl: null };
    const within = evaluateKeyCodeSet({ customer, flags: {} }, input, { nowMs: NOW_MS + 14 * DAY_MS - 1000, mercariUrlOwnedByOther: false });
    expect(within.ok).toBe(true);
    const after = evaluateKeyCodeSet({ customer, flags: {} }, input, { nowMs: NOW_MS + 14 * DAY_MS + 1000, mercariUrlOwnedByOther: false });
    expect(after).toMatchObject({ ok: false, error: KEY_CODE_ERROR.TRIAL_ENDED });
  });
});
