import { describe, expect, it, vi } from 'vitest';

const getRefTrackingWithClickIds = vi.fn();
const getActiveAdPlatforms = vi.fn();
const logAdConversion = vi.fn();
vi.mock('@line-crm/db', async (orig) => ({
  ...(await orig<typeof import('@line-crm/db')>()),
  getRefTrackingWithClickIds,
  getActiveAdPlatforms,
  logAdConversion,
}));

const { sendAdConversions, buildGoogleConversionEvent, googleConversionRecord, pickFriendAddClickRef } = await import('./ad-conversion.js');

const FRIEND_AT = '2026-10-17T19:45:26.400+09:00';
const CLICK_AT = '2026-10-17T19:45:28.005+09:00';

function dbWithFriend(lineUserId: string, refs: Array<Record<string, unknown>> = [], friendAt = FRIEND_AT) {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => (/FROM friends/.test(sql) ? { line_user_id: lineUserId, created_at: friendAt } : null),
        all: async () => ({ results: /FROM ref_tracking/.test(sql) ? refs.map((r) => ({ created_at: CLICK_AT, ...r })) : [] }),
      }),
    }),
  } as unknown as D1Database;
}

describe('広告のオフライン CV 送信から検証用アカウントを除く（Capsec #301）', () => {
  it('あじゃぱー（TEST_LINE_IDS）は、gclid があっても媒体の一覧を読まずに終える', async () => {
    await sendAdConversions(dbWithFriend('Ue4941a030cb2ec8758095fb0fffff344', [{ gclid: 'CjwKCA_test' }]), 'f1', 'line_friend_add');
    expect(getActiveAdPlatforms).not.toHaveBeenCalled();
  });

  it('通常の友だちは今までどおり媒体の一覧を読んで送信に進む', async () => {
    getActiveAdPlatforms.mockResolvedValueOnce([]);
    await sendAdConversions(dbWithFriend('U0000000000000000000000000000abcd', [{ gclid: 'CjwKCA_real' }]), 'f2', 'line_friend_add');
    expect(getActiveAdPlatforms).toHaveBeenCalledTimes(1);
  });
});

describe('Google への CV 送信内容を取り消しの照合用に残す（Capsec #305）', () => {
  const config = { customer_id: '8394293197', login_customer_id: '4654620160', conversion_action_id: '7123456789', oauth_token: 'tok' } as never;

  it('保存するのは gclid・CV アクション・アカウント・eventTimestamp・値と通貨だけ', () => {
    const ev = buildGoogleConversionEvent(config, { gclid: 'CjwKCA_x' }, 3980, new Date('2026-09-17T07:07:36.123Z'));
    const record = JSON.parse(googleConversionRecord(ev));
    expect(record).toEqual({
      api: 'datamanager.events:ingest',
      transactionId: null,
      conversionActionId: '7123456789',
      customerId: '8394293197',
      loginCustomerId: '4654620160',
      gclid: 'CjwKCA_x',
      gbraid: null,
      wbraid: null,
      eventTimestamp: '2026-09-17T07:07:36.123Z',
      eventSource: 'WEB',
      conversionValue: 3980,
      currency: 'JPY',
    });
  });

  it('本文に個人情報（userData のメール・電話など）が足されても保存しない', () => {
    const ev = buildGoogleConversionEvent(config, { gclid: 'CjwKCA_x' });
    ev.body.events[0].userData = { userIdentifiers: [{ emailAddress: 'a@example.com' }, { phoneNumber: '+819012345678' }] };
    ev.body.events[0].userAddress = '東京都';
    const saved = googleConversionRecord(ev);
    expect(saved).not.toContain('example.com');
    expect(saved).not.toContain('9012345678');
    expect(saved).not.toContain('東京都');
    expect(saved).not.toContain('userData');
    expect(saved).not.toContain('consent');
  });

  it('送信した本文と同じ eventTimestamp を、送信済みの記録の request_body に入れる', async () => {
    let sentBody: { events: Array<{ eventTimestamp: string }> } | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      sentBody = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ events: [{}] }), text: async () => '' };
    }));
    getActiveAdPlatforms.mockResolvedValueOnce([{ id: 'p1', name: 'google', config: JSON.stringify({ customer_id: '8394293197', conversion_action_id: '7123456789', oauth_token: 'tok' }) }]);
    logAdConversion.mockClear();

    await sendAdConversions(dbWithFriend('U0000000000000000000000000000abcd', [{ gclid: 'CjwKCA_real' }]), 'f3', 'line_friend_add');

    const call = logAdConversion.mock.calls.find((c) => (c[1] as { status: string }).status === 'sent');
    expect(call).toBeTruthy();
    const record = JSON.parse(String((call![1] as { requestBody: string }).requestBody));
    expect(record.eventTimestamp).toBe(sentBody!.events[0].eventTimestamp);
    expect(record.gclid).toBe('CjwKCA_real');
    vi.unstubAllGlobals();
  });
});


describe('Google braid offline CV (TB-363)', () => {
  const config = { customer_id: 'test-customer', conversion_action_id: 'test-action', oauth_token: 'test-token' };
  const cases = [
    { ref: { gbraid: 'GB_TEST' }, type: 'gbraid', value: 'GB_TEST' },
    { ref: { wbraid: 'WB_TEST' }, type: 'wbraid', value: 'WB_TEST' },
    { ref: { gclid: 'GC_TEST', gbraid: 'GB_TEST', wbraid: 'WB_TEST' }, type: 'gclid', value: 'GC_TEST' },
    { ref: { gclid: '', gbraid: 'GB_TEST', wbraid: 'WB_TEST' }, type: 'gbraid', value: 'GB_TEST' },
  ];

  it.each(cases)('selects only $type and logs the identifier for line_friend_add', async ({ ref, type, value }) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ events: [{}] })));
    vi.stubGlobal('fetch', fetchMock);
    getActiveAdPlatforms.mockResolvedValueOnce([{ id: 'p-google', name: 'google', config: JSON.stringify(config) }]);
    logAdConversion.mockClear();
    try {
      await sendAdConversions(dbWithFriend('U-normal', [ref]), 'f-braid', 'line_friend_add');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0];
      const event = JSON.parse(String(init.body)).events[0];
      expect(event.adIdentifiers).toEqual({ [type]: value });
      expect(event.transactionId).toBe('f-braid:line_friend_add');
      expect(event).not.toHaveProperty('userData');
      expect(event).not.toHaveProperty('userIdentifiers');
      expect(event).not.toHaveProperty('customVariables');
      const logged = logAdConversion.mock.calls[0][1];
      expect(logged).toMatchObject({ eventName: 'line_friend_add', clickId: value, clickIdType: type, status: 'sent' });
      expect(JSON.parse(logged.requestBody)[type]).toBe(value);
      expect(JSON.parse(logged.requestBody).transactionId).toBe(event.transactionId);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the chosen braid identifier in failed logs, even with a Meta click ID', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rejected', { status: 400 })));
    getActiveAdPlatforms.mockResolvedValueOnce([{ id: 'p-google', name: 'google', config: JSON.stringify(config) }]);
    logAdConversion.mockClear();
    try {
      await sendAdConversions(dbWithFriend('U-normal', [{ fbclid: 'META', wbraid: 'WB_TEST' }]), 'f-braid', 'line_friend_add');
      expect(logAdConversion.mock.calls[0][1]).toMatchObject({ clickId: 'WB_TEST', clickIdType: 'wbraid', status: 'failed' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not send without a Google click identifier', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    getActiveAdPlatforms.mockResolvedValueOnce([{ id: 'p-google', name: 'google', config: JSON.stringify(config) }]);
    try {
      await sendAdConversions(dbWithFriend('U-normal', [{ fbclid: 'META' }]), 'f-braid', 'line_friend_add');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(() => buildGoogleConversionEvent(config, {})).toThrow('requires a click identifier');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});


describe('Google transactionId (TB-367)', () => {
  const config = { customer_id: 'test-customer', conversion_action_id: 'test-action' };
  const now = new Date('2026-09-27T12:00:00.000Z');
  const build = (friendId?: string | null, eventName = 'line_friend_add', date = now) =>
    buildGoogleConversionEvent(config, { gclid: 'GC_TEST' }, undefined, date, { friendId, eventName });

  it('is stable across retries and timestamps, and distinct for friends and events', () => {
    const id = build('friend-1').body.events[0].transactionId;
    expect(id).toBe('friend-1:line_friend_add');
    expect(build('friend-1', 'line_friend_add', new Date('2026-09-28')).body.events[0].transactionId).toBe(id);
    expect(build('friend-2').body.events[0].transactionId).not.toBe(id);
    expect(build('friend-1', 'purchase').body.events[0].transactionId).not.toBe(id);
  });

  it.each([undefined, null, ''])('omits the key without a friend ID: %s', (friendId) => {
    expect(build(friendId).body.events[0]).not.toHaveProperty('transactionId');
    expect(JSON.parse(googleConversionRecord(build(friendId))).transactionId).toBeNull();
  });

  it('accepts 64 characters but rejects overflow and ambiguous or unsafe components', () => {
    expect(String(build('f'.repeat(48)).body.events[0].transactionId)).toHaveLength(64);
    expect(() => build('f'.repeat(49))).toThrow('transactionId');
    expect(() => build('friend:1')).toThrow('transactionId');
    expect(() => build('friend-1', 'event:name')).toThrow('transactionId');
    expect(() => build('friend 1')).toThrow('transactionId');
  });

  it('adds only transactionId to the existing record allowlist', () => {
    const ev = build('friend-1');
    ev.body.events[0].userData = { email: 'private@example.com' };
    ev.body.events[0].futureField = 'private';
    expect(JSON.parse(googleConversionRecord(ev))).toEqual({
      ...JSON.parse(googleConversionRecord(build())),
      transactionId: 'friend-1:line_friend_add',
    });
  });
});

describe('Google ingest の応答（requestId）を response_body に残す（TB-1694）', () => {
  const config = { customer_id: '8394293197', conversion_action_id: '7714135877', oauth_token: 'tok' };
  const run = async (status: number, body: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })));
    getActiveAdPlatforms.mockResolvedValueOnce([{ id: 'p-google', name: 'google', config: JSON.stringify(config) }]);
    logAdConversion.mockClear();
    try {
      await sendAdConversions(dbWithFriend('U-normal', [{ gbraid: 'GB_TEST' }]), 'f-1694', 'line_friend_add');
    } finally {
      vi.unstubAllGlobals();
    }
    return logAdConversion.mock.calls[0][1] as { status: string; responseBody: string | null; requestBody: string; errorMessage?: string };
  };

  it('送信済みの記録に requestId を入れる（requestStatus で取り込み結果を引くため）', async () => {
    const logged = await run(200, { requestId: 'req-123' });
    expect(logged.status).toBe('sent');
    expect(JSON.parse(String(logged.responseBody))).toEqual({ api: 'datamanager.events:ingest', requestId: 'req-123', fieldWarnings: [] });
  });

  it('fieldWarnings は reason と field だけ残し、説明文や知らない項目は残さない', async () => {
    const logged = await run(200, {
      requestId: 'req-456',
      fieldWarnings: [{ reason: 'SOME_WARNING', field: 'events[0].adIdentifiers.gbraid', description: 'value a@example.com' }],
      userData: { emailAddress: 'private@example.com' },
    });
    const saved = String(logged.responseBody);
    expect(JSON.parse(saved)).toEqual({
      api: 'datamanager.events:ingest',
      requestId: 'req-456',
      fieldWarnings: [{ reason: 'SOME_WARNING', field: 'events[0].adIdentifiers.gbraid' }],
    });
    expect(saved).not.toContain('example.com');
  });

  it('requestId が返らなくても送信済みとして残し、requestId は null にする', async () => {
    const logged = await run(200, {});
    expect(logged.status).toBe('sent');
    expect(JSON.parse(String(logged.responseBody)).requestId).toBeNull();
  });

  it('200 でも events[].errors があれば failed にし、requestId は残す', async () => {
    const logged = await run(200, { requestId: 'req-789', events: [{ errors: [{ reason: 'X' }] }] });
    expect(logged.status).toBe('failed');
    expect(logged.errorMessage).toContain('Data Manager API event error');
    expect(JSON.parse(String(logged.responseBody)).requestId).toBe('req-789');
    expect(JSON.parse(logged.requestBody).gbraid).toBe('GB_TEST');
  });

  it('HTTP エラーのときは response_body を空のまま failed にする', async () => {
    const logged = await run(400, 'rejected');
    expect(logged.status).toBe('failed');
    expect(logged.responseBody).toBeNull();
  });
});

describe('友だち追加の CV は、登録前の広告クリックだけを送る（TB-1801）', () => {
  const config = { customer_id: 'test-customer', conversion_action_id: 'test-action', oauth_token: 'test-token' };

  it.each([
    { name: 'efa6ad6a: ブログ経由で登録した 9 時間後のクリック', friendAt: '2026-10-15T09:15:16.375+09:00', clickAt: '2026-10-15T18:18:59.018+09:00' },
    { name: '4ea9a2c2: 拡張ポップで登録した 5 日後のクリック', friendAt: '2026-10-11T13:46:49.244+09:00', clickAt: '2026-10-16T15:39:18.769+09:00' },
  ])('$name は送らない', async ({ friendAt, clickAt }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    getActiveAdPlatforms.mockClear();
    try {
      await sendAdConversions(dbWithFriend('U-normal', [{ gclid: 'GC_LATE', gbraid: 'GB_LATE', created_at: clickAt }], friendAt), 'f-late', 'line_friend_add');
      expect(getActiveAdPlatforms).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('広告経由の登録（LIFF がクリック ID を作成の 2 秒後に記録）は送る', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ events: [{}] })));
    vi.stubGlobal('fetch', fetchMock);
    getActiveAdPlatforms.mockResolvedValueOnce([{ id: 'p-google', name: 'google', config: JSON.stringify(config) }]);
    try {
      await sendAdConversions(dbWithFriend('U-normal', [{ gclid: 'GC_OK', created_at: '2026-10-17T19:45:28.005+09:00' }], '2026-10-17T19:45:26.400+09:00'), 'f-ok', 'line_friend_add');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String((fetchMock.mock.calls as unknown as [string, RequestInit][])[0][1].body)).events[0].adIdentifiers).toEqual({ gclid: 'GC_OK' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('登録時のクリックと後日のクリックがあれば、登録時のクリック ID で送る', () => {
    const rows = [
      { gclid: 'GC_LATER', created_at: '2026-10-20T10:00:00.000+09:00' },
      { gclid: 'GC_AT_ADD', created_at: '2026-10-17T19:45:28.005+09:00' },
    ];
    expect(pickFriendAddClickRef(rows, '2026-10-17T19:45:26.400+09:00')?.gclid).toBe('GC_AT_ADD');
  });

  it('記録の遅れは 10 分まで許し、それを超えたら送らない。日時の形式が混ざっても同じ', () => {
    const friendAt = '2026-10-17 19:45:26';
    expect(pickFriendAddClickRef([{ created_at: '2026-10-17T19:55:26.000+09:00' }], friendAt)).not.toBeNull();
    expect(pickFriendAddClickRef([{ created_at: '2026-10-17T10:55:27.000Z' }], friendAt)).toBeNull();
    expect(pickFriendAddClickRef([{ created_at: '2026-10-17T19:45:20.000+09:00' }], friendAt)).not.toBeNull();
  });

  it('友だちの登録日時が読めなければ送らない', () => {
    expect(pickFriendAddClickRef([{ created_at: '2026-10-17T19:45:28.005+09:00' }], null)).toBeNull();
  });

  it('友だち追加以外のイベントは今までどおり最新のクリックで送る', async () => {
    getRefTrackingWithClickIds.mockResolvedValueOnce({ gclid: 'GC_LATEST' });
    getActiveAdPlatforms.mockClear();
    getActiveAdPlatforms.mockResolvedValueOnce([]);
    await sendAdConversions(dbWithFriend('U-normal', []), 'f-purchase', 'purchase');
    expect(getRefTrackingWithClickIds).toHaveBeenCalledWith(expect.anything(), 'f-purchase');
    expect(getActiveAdPlatforms).toHaveBeenCalledTimes(1);
  });
});
