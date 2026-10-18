/**
 * 広告CV送信サービス
 *
 * LINE内アクション発生時に、友だちの広告クリックIDを元に
 * 各広告媒体のConversion APIへオフラインCVを送信する。
 */

import {
  getActiveAdPlatforms,
  getRefTrackingWithClickIds,
  logAdConversion,
  type AdPlatformConfig,
  type RefTracking,
  toJstString,
} from '@line-crm/db';
import { TEST_LINE_IDS } from '../furim/segments.js';
import { parseJstDateTime } from '../furim/customer-store.js';

const FRIEND_ADD_EVENT = 'line_friend_add';

// ref_tracking.created_at はクリックの時刻ではなく LIFF が記録した時刻。広告経由の登録では友だち作成の 0〜9 秒後に記録される（本番 19 件・2026-10-18）。
// それより大きく遅れた記録は、すでにいる友だちが後から広告を押したもので、友だち追加の CV にしない（TB-1801）
const FRIEND_ADD_CLICK_GRACE_MS = 10 * 60_000;

export function pickFriendAddClickRef<T extends { created_at: string }>(
  rows: T[],
  friendCreatedAt: string | null | undefined,
): T | null {
  const friendAt = parseJstDateTime(friendCreatedAt);
  if (friendAt == null) return null;
  let picked: { row: T; at: number } | null = null;
  for (const row of rows) {
    const at = parseJstDateTime(row.created_at);
    if (at == null || at > friendAt + FRIEND_ADD_CLICK_GRACE_MS) continue;
    if (!picked || at > picked.at) picked = { row, at };
  }
  return picked?.row ?? null;
}

async function getRefTrackingClickRows(db: D1Database, friendId: string): Promise<RefTracking[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM ref_tracking
       WHERE friend_id = ?
       AND (fbclid IS NOT NULL OR gclid IS NOT NULL OR gbraid IS NOT NULL OR wbraid IS NOT NULL OR twclid IS NOT NULL OR ttclid IS NOT NULL)`,
    )
    .bind(friendId)
    .all<RefTracking>();
  return rows.results ?? [];
}

export async function sendAdConversions(
  db: D1Database,
  friendId: string,
  eventName: string,
  eventValue?: number,
): Promise<void> {
  const friend = await db.prepare('SELECT line_user_id, created_at FROM friends WHERE id = ?').bind(friendId).first<{ line_user_id: string | null; created_at: string | null }>();
  const ref = eventName === FRIEND_ADD_EVENT
    ? pickFriendAddClickRef(await getRefTrackingClickRows(db, friendId), friend?.created_at)
    : await getRefTrackingWithClickIds(db, friendId);
  if (!ref) return;

  // 検証用アカウントのテストを広告の成果として送らない（Capsec #301・2026-09-17 16:07 にあじゃぱーの実機テストが送られた）
  if (friend?.line_user_id && TEST_LINE_IDS.has(friend.line_user_id)) {
    console.log('[ad-conversion] 検証用アカウントなので送信しない:', friendId, eventName);
    return;
  }

  const platforms = await getActiveAdPlatforms(db);
  const googleClickId = selectGoogleClickId(ref);

  for (const platform of platforms) {
    const config: AdPlatformConfig = JSON.parse(platform.config);

    // 冪等ガード: 同一 (platform, friend, event) の送信済みログがあればスキップ。
    // follow webhook と cron catch-up (retryMissedAdConversions) の二重送信防止。
    const alreadySent = await db
      .prepare(
        `SELECT 1 FROM ad_conversion_logs
         WHERE ad_platform_id = ? AND friend_id = ? AND event_name = ? AND status = 'sent' LIMIT 1`,
      )
      .bind(platform.id, friendId, eventName)
      .first();
    if (alreadySent) continue;

    let googleRecord: string | null = null;
    let googleResponse: string | null = null;
    try {
      switch (platform.name) {
        case 'meta':
          if (ref.fbclid) {
            await sendMetaConversion(config, ref, eventName, eventValue);
            await logAdConversion(db, {
              platformId: platform.id, friendId, eventName,
              clickId: ref.fbclid, clickIdType: 'fbclid', status: 'sent',
            });
          }
          break;
        case 'x':
          if (ref.twclid) {
            await sendXConversion(config, ref, eventName, eventValue);
            await logAdConversion(db, {
              platformId: platform.id, friendId, eventName,
              clickId: ref.twclid, clickIdType: 'twclid', status: 'sent',
            });
          }
          break;
        case 'google':
          if (googleClickId) {
            // 取り消し（調整）のときに照合できるよう、送った eventTimestamp 等を request_body に残す（Capsec #305）
            const googleEvent = buildGoogleConversionEvent(config, ref, eventValue, new Date(), { friendId, eventName });
            googleRecord = googleConversionRecord(googleEvent);
            const sent = await sendGoogleConversion(config, googleEvent);
            googleResponse = sent.responseBody;
            if (sent.eventErrors) {
              throw new Error(`Data Manager API event error: ${JSON.stringify(sent.eventErrors)}`);
            }
            await logAdConversion(db, {
              platformId: platform.id, friendId, eventName,
              clickId: googleClickId.value, clickIdType: googleClickId.type, status: 'sent',
              requestBody: googleRecord,
              responseBody: googleResponse,
            });
          }
          break;
        case 'tiktok':
          if (ref.ttclid) {
            await sendTikTokConversion(config, ref, eventName, eventValue);
            await logAdConversion(db, {
              platformId: platform.id, friendId, eventName,
              clickId: ref.ttclid, clickIdType: 'ttclid', status: 'sent',
            });
          }
          break;
      }
    } catch (error) {
      await logAdConversion(db, {
        platformId: platform.id,
        friendId,
        eventName,
        clickId: platform.name === 'google' ? googleClickId?.value ?? '' : ref.fbclid || ref.twclid || ref.gclid || ref.ttclid || '',
        clickIdType: platform.name === 'google' ? googleClickId?.type ?? 'google' : platform.name,
        status: 'failed',
        errorMessage: String(error),
        requestBody: googleRecord,
        responseBody: googleResponse,
      });
    }
  }
}

/**
 * follow webhook 時の広告CV送信が ref_tracking 書き込みとのレース（サブ秒）で
 * スキップされた分を catch-up 再送する。アンバサダー紹介の再試行と同じ思想で
 * 冪等（sendAdConversions 内の送信済みガードが二重送信を防ぐ）。
 * 対象: 直近7日の新規友だちのうち、クリックID付き ref_tracking があるのに
 * line_friend_add の送信済みログが無いもの。
 */
export async function retryMissedAdConversions(db: D1Database): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT rt.friend_id AS friend_id
       FROM ref_tracking rt
       JOIN friends f ON f.id = rt.friend_id
       WHERE (rt.gclid IS NOT NULL OR rt.gbraid IS NOT NULL OR rt.wbraid IS NOT NULL OR rt.fbclid IS NOT NULL OR rt.twclid IS NOT NULL OR rt.ttclid IS NOT NULL)
         AND substr(replace(f.created_at, ' ', 'T'), 1, 19) >= ?
         AND NOT EXISTS (
           SELECT 1 FROM ad_conversion_logs l
           WHERE l.friend_id = rt.friend_id
             AND l.event_name = 'line_friend_add'
             AND l.status = 'sent'
         )`,
    )
    .bind(toJstString(new Date(Date.now() - 7 * 24 * 60 * 60_000)).slice(0, 19))
    .all<{ friend_id: string }>();

  for (const r of rows.results ?? []) {
    try {
      await sendAdConversions(db, r.friend_id, 'line_friend_add');
    } catch (err) {
      console.error('[ad-conversion retry] send error:', err);
    }
  }
}

async function sendMetaConversion(
  config: AdPlatformConfig,
  ref: RefTracking,
  eventName: string,
  eventValue?: number,
): Promise<void> {
  const url = `https://graph.facebook.com/v21.0/${config.pixel_id}/events`;

  const eventData: Record<string, unknown> = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'website',
    user_data: {
      fbc: `fb.1.${Date.now()}.${ref.fbclid}`,
      client_ip_address: ref.ip_address || undefined,
      client_user_agent: ref.user_agent || undefined,
    },
  };

  if (eventValue) {
    eventData.custom_data = { currency: 'JPY', value: eventValue };
  }

  const body: Record<string, unknown> = {
    data: [eventData],
    access_token: config.access_token,
  };

  if (config.test_event_code) {
    body.test_event_code = config.test_event_code;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Meta CAPI error: ${response.status} ${errorBody}`);
  }
}

async function sendXConversion(
  config: AdPlatformConfig,
  ref: RefTracking,
  eventName: string,
  eventValue?: number,
): Promise<void> {
  const url = 'https://ads-api.x.com/12/measurement/conversions';

  const body = {
    conversions: [{
      conversion_time: new Date().toISOString(),
      event_id: crypto.randomUUID(),
      identifiers: [{ twclid: ref.twclid }],
      conversion_id: config.pixel_id,
      event_name: eventName,
      ...(eventValue && { value: { currency: 'JPY', amount: String(eventValue) } }),
    }],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // OAuth 1.0a signature required — placeholder for production implementation
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`X Conversion API error: ${response.status} ${errorBody}`);
  }
}

// refresh_token から短命のアクセストークンを取得する。
// 静的な oauth_token は約1時間で失効し、失効後は全CV送信が401で失敗するため、
// refresh_token が設定されていれば送信のたびにここで取り直す。
async function getGoogleAccessToken(config: AdPlatformConfig): Promise<string> {
  if (config.refresh_token && config.client_id && config.client_secret) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: config.refresh_token,
        client_id: config.client_id,
        client_secret: config.client_secret,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google OAuth token refresh failed: ${res.status} ${body}`);
    }
    const json = await res.json<{ access_token?: string }>();
    if (!json.access_token) throw new Error('Google OAuth: access_token missing in response');
    return json.access_token;
  }
  // フォールバック（旧方式・静的トークン）
  if (config.oauth_token) return config.oauth_token;
  throw new Error('Google config: refresh_token(+client_id/secret) も oauth_token も未設定');
}

// Data Manager API へオフラインCVを送る（uploadClickConversions は新規統合不可のため移行）。
// エンドポイント: POST https://datamanager.googleapis.com/v1/events:ingest
// 必要スコープ: https://www.googleapis.com/auth/datamanager（refresh_token 再取得が前提）。
// account指定は destinations 内（login=MCC / operating=顧客 / productDestinationId=CVアクションID）。
// developer-token / login-customer-id ヘッダーは不要。
type GoogleConversionEvent = { body: { destinations: Array<Record<string, unknown>>; events: Array<Record<string, unknown>>; validateOnly: boolean } };

type GoogleClickIds = Partial<Pick<RefTracking, 'gclid' | 'gbraid' | 'wbraid'>>;

function selectGoogleClickId(ref: GoogleClickIds) {
  for (const type of ['gclid', 'gbraid', 'wbraid'] as const) {
    const value = ref[type];
    if (value) return { type, value };
  }
  return null;
}

/** Data Manager API に送る本文を作る（送信と記録で同じものを使うため分けた） */
export function buildGoogleConversionEvent(
  config: AdPlatformConfig,
  ref: GoogleClickIds,
  eventValue?: number,
  now: Date = new Date(),
  identity?: { friendId?: string | null; eventName: string },
): GoogleConversionEvent {
  const clickId = selectGoogleClickId(ref);
  if (!clickId) throw new Error('Google conversion requires a click identifier');

  const destination: Record<string, unknown> = {
    reference: 'd1',
    operatingAccount: { product: 'GOOGLE_ADS', accountId: config.customer_id },
    productDestinationId: config.conversion_action_id,
  };
  // MCC経由のときのみ loginAccount を付ける
  if (config.login_customer_id) {
    destination.loginAccount = { product: 'GOOGLE_ADS', accountId: config.login_customer_id };
  }

  const event: Record<string, unknown> = {
    destinationReferences: ['d1'],
    eventSource: 'WEB', // 友だち追加はLP→LINEのWeb由来（Data Manager API必須フィールド）
    eventTimestamp: now.toISOString(), // RFC3339 Z-normalized
    // Click-ID only: do not add enhanced-conversion userData for braid events.
    adIdentifiers: { [clickId.type]: clickId.value },
    // 友だち追加は自社サービス上の明示アクション。同意ありで送る
    consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_GRANTED' },
  };
  if (identity?.friendId) {
    // Keep the separator unambiguous; never sanitize/truncate into a colliding key.
    const transactionId = `${identity.friendId}:${identity.eventName}`;
    if (!/^[A-Za-z0-9_-]+$/.test(identity.friendId)
      || !/^[A-Za-z0-9_-]+$/.test(identity.eventName)
      || transactionId.length > 64) {
      throw new Error('Google conversion transactionId requires safe components and at most 64 characters');
    }
    event.transactionId = transactionId;
  }
  if (eventValue) {
    event.conversionValue = eventValue;
    event.currency = 'JPY';
  }
  return { body: { destinations: [destination], events: [event], validateOnly: false } };
}

/**
 * ad_conversion_logs.request_body に残す内容（Capsec #305）。
 * 取り消し（調整）の照合に要る項目だけを許可リストで取り出す: transactionId・gclid / gbraid / wbraid・CV アクション・アカウント・eventTimestamp・値と通貨。
 * 本文に userData（メール・電話などのハッシュ）や住所などが将来足されても、ここで拾わないので保存されない
 */
export function googleConversionRecord(ev: GoogleConversionEvent): string {
  const d = ev.body.destinations[0] ?? {};
  const e = ev.body.events[0] ?? {};
  const record = {
    api: 'datamanager.events:ingest',
    transactionId: e.transactionId ?? null,
    conversionActionId: d.productDestinationId ?? null,
    customerId: (d.operatingAccount as { accountId?: string } | undefined)?.accountId ?? null,
    loginCustomerId: (d.loginAccount as { accountId?: string } | undefined)?.accountId ?? null,
    gclid: (e.adIdentifiers as GoogleClickIds | undefined)?.gclid ?? null,
    gbraid: (e.adIdentifiers as GoogleClickIds | undefined)?.gbraid ?? null,
    wbraid: (e.adIdentifiers as GoogleClickIds | undefined)?.wbraid ?? null,
    eventTimestamp: e.eventTimestamp ?? null,
    eventSource: e.eventSource ?? null,
    conversionValue: e.conversionValue ?? null,
    currency: e.currency ?? null,
  };
  return JSON.stringify(record);
}

/**
 * ad_conversion_logs.response_body に残す内容（TB-1694）。
 * events:ingest は 200 を返しても取り込みは非同期で、失敗は requestStatus:retrieve に requestId を渡さないと見えない。
 * 許可リストで requestId と fieldWarnings の reason・field だけを残す（説明文や将来の項目に値が入っても保存しない）
 */
export function googleIngestResponseRecord(result: { requestId?: unknown; fieldWarnings?: unknown }): string {
  const warnings = Array.isArray(result.fieldWarnings) ? result.fieldWarnings : [];
  return JSON.stringify({
    api: 'datamanager.events:ingest',
    requestId: typeof result.requestId === 'string' ? result.requestId : null,
    fieldWarnings: warnings.map((w: { reason?: unknown; field?: unknown }) => ({
      reason: typeof w?.reason === 'string' ? w.reason : null,
      field: typeof w?.field === 'string' ? w.field : null,
    })),
  });
}

async function sendGoogleConversion(
  config: AdPlatformConfig,
  ev: GoogleConversionEvent,
): Promise<{ responseBody: string; eventErrors: unknown[] | null }> {
  const accessToken = await getGoogleAccessToken(config);
  const url = 'https://datamanager.googleapis.com/v1/events:ingest';
  const body = ev.body;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Data Manager API error: ${response.status} ${errorBody}`);
  }
  // 200でも events[].errors に個別失敗が入る場合がある
  const result = await response.json<{ requestId?: string; fieldWarnings?: unknown[]; events?: Array<{ errors?: unknown[] }> }>();
  const failed = (result.events || []).find((e) => e.errors && e.errors.length > 0);
  return { responseBody: googleIngestResponseRecord(result), eventErrors: failed?.errors ?? null };
}

async function sendTikTokConversion(
  config: AdPlatformConfig,
  ref: RefTracking,
  eventName: string,
  eventValue?: number,
): Promise<void> {
  const url = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

  const body = {
    pixel_code: config.pixel_code,
    event: eventName,
    event_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    context: {
      user_agent: ref.user_agent || '',
      ip: ref.ip_address || '',
    },
    properties: {
      ...(ref.ttclid && { ttclid: ref.ttclid }),
      ...(eventValue && { currency: 'JPY', value: eventValue }),
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Access-Token': config.access_token || '',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`TikTok Events API error: ${response.status} ${errorBody}`);
  }
}
