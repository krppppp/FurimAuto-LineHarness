import { describe, expect, test, vi, beforeEach } from 'vitest';
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

  async function postText(text: string) {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(aiModeFriend);
    vi.mocked(jstNow).mockReturnValue('2026-07-31T12:00:00.000+09:00');
    vi.mocked(getAiMode).mockResolvedValue(true);
    vi.mocked(handleFurimAction).mockResolvedValue(false);

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
});
