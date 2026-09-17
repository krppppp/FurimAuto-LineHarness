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

const { sendAdConversions, buildGoogleConversionEvent, googleConversionRecord } = await import('./ad-conversion.js');

function dbWithFriend(lineUserId: string) {
  return {
    prepare: (sql: string) => ({
      bind: () => ({ first: async () => (/FROM friends/.test(sql) ? { line_user_id: lineUserId } : null) }),
    }),
  } as unknown as D1Database;
}

describe('広告のオフライン CV 送信から検証用アカウントを除く（Capsec #301）', () => {
  it('あじゃぱー（TEST_LINE_IDS）は、gclid があっても媒体の一覧を読まずに終える', async () => {
    getRefTrackingWithClickIds.mockResolvedValueOnce({ gclid: 'CjwKCA_test' });
    await sendAdConversions(dbWithFriend('Ue4941a030cb2ec8758095fb0fffff344'), 'f1', 'line_friend_add');
    expect(getActiveAdPlatforms).not.toHaveBeenCalled();
  });

  it('通常の友だちは今までどおり媒体の一覧を読んで送信に進む', async () => {
    getRefTrackingWithClickIds.mockResolvedValueOnce({ gclid: 'CjwKCA_real' });
    getActiveAdPlatforms.mockResolvedValueOnce([]);
    await sendAdConversions(dbWithFriend('U0000000000000000000000000000abcd'), 'f2', 'line_friend_add');
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
      conversionActionId: '7123456789',
      customerId: '8394293197',
      loginCustomerId: '4654620160',
      gclid: 'CjwKCA_x',
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
    getRefTrackingWithClickIds.mockResolvedValueOnce({ gclid: 'CjwKCA_real' });
    getActiveAdPlatforms.mockResolvedValueOnce([{ id: 'p1', name: 'google', config: JSON.stringify({ customer_id: '8394293197', conversion_action_id: '7123456789', oauth_token: 'tok' }) }]);
    logAdConversion.mockClear();

    await sendAdConversions(dbWithFriend('U0000000000000000000000000000abcd'), 'f3', 'line_friend_add');

    const call = logAdConversion.mock.calls.find((c) => (c[1] as { status: string }).status === 'sent');
    expect(call).toBeTruthy();
    const record = JSON.parse(String((call![1] as { requestBody: string }).requestBody));
    expect(record.eventTimestamp).toBe(sentBody!.events[0].eventTimestamp);
    expect(record.gclid).toBe('CjwKCA_real');
    vi.unstubAllGlobals();
  });
});
