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

// Date を Google Ads 要求形式 "yyyy-MM-dd HH:mm:ss+09:00"（JST実時刻）に整形する。
// 旧実装は toISOString()（UTC）に "+09:00" を付けるだけで実時刻が9時間ずれていた。
function toJstConversionDateTime(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())} `
    + `${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}:${p(jst.getUTCSeconds())}+09:00`;
}

async function sendGoogleConversion(
  config: AdPlatformConfig,
  ref: RefTracking,
  eventName: string,
  eventValue?: number,
): Promise<void> {
  const accessToken = await getGoogleAccessToken(config);
  const url = `https://googleads.googleapis.com/v21/customers/${config.customer_id}:uploadClickConversions`;

  const body = {
    conversions: [{
      gclid: ref.gclid,
      conversion_action: `customers/${config.customer_id}/conversionActions/${config.conversion_action_id}`,
      conversion_date_time: toJstConversionDateTime(new Date()),
      ...(eventValue && { conversion_value: eventValue, currency_code: 'JPY' }),
    }],
    partial_failure: true,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': config.developer_token || '',
  };
  // MCC経由のときは login-customer-id が必須
  if (config.login_customer_id) headers['login-customer-id'] = config.login_customer_id;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google Ads API error: ${response.status} ${errorBody}`);
  }
  // partial_failure=true のとき、HTTP 200でも partialFailureError に個別失敗が入る
  const result = await response.json<{ partialFailureError?: { message?: string } }>();
  if (result.partialFailureError?.message) {
    throw new Error(`Google Ads partial failure: ${result.partialFailureError.message}`);
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
