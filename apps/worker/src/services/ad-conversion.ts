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
} from '@line-crm/db';

export async function sendAdConversions(
  db: D1Database,
  friendId: string,
  eventName: string,
  eventValue?: number,
): Promise<void> {
  const ref = await getRefTrackingWithClickIds(db, friendId);
  if (!ref) return;

  const platforms = await getActiveAdPlatforms(db);

  for (const platform of platforms) {
    const config: AdPlatformConfig = JSON.parse(platform.config);

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
          if (ref.gclid) {
            await sendGoogleConversion(config, ref, eventName, eventValue);
            await logAdConversion(db, {
              platformId: platform.id, friendId, eventName,
              clickId: ref.gclid, clickIdType: 'gclid', status: 'sent',
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
        clickId: ref.fbclid || ref.twclid || ref.gclid || ref.ttclid || '',
        clickIdType: platform.name,
        status: 'failed',
        errorMessage: String(error),
      });
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
async function sendGoogleConversion(
  config: AdPlatformConfig,
  ref: RefTracking,
  _eventName: string,
  eventValue?: number,
): Promise<void> {
  const accessToken = await getGoogleAccessToken(config);
  const url = 'https://datamanager.googleapis.com/v1/events:ingest';

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
    eventTimestamp: new Date().toISOString(), // RFC3339 Z-normalized
    adIdentifiers: { gclid: ref.gclid },
    // 友だち追加は自社サービス上の明示アクション。同意ありで送る
    consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_GRANTED' },
  };
  if (eventValue) {
    event.conversionValue = eventValue;
    event.currency = 'JPY';
  }

  const body = { destinations: [destination], events: [event], validateOnly: false };

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
  const result = await response.json<{ events?: Array<{ errors?: unknown[] }> }>();
  const failed = (result.events || []).find((e) => e.errors && e.errors.length > 0);
  if (failed) {
    throw new Error(`Data Manager API event error: ${JSON.stringify(failed.errors)}`);
  }
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
