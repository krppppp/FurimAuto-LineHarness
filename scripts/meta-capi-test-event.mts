// Meta CAPI に友だち追加（CompleteRegistration）を test_event_code 付きで 1 件送り、イベントマネージャの「テストイベント」で受け付けを確かめる（TB-1790）。
//
//   R=<リポジトリ>; cd /tmp && node $R/node_modules/.pnpm/vite-node@*/node_modules/vite-node/vite-node.mjs --root $R/scripts $R/scripts/meta-capi-test-event.mts
//   （tsx は @line-crm/db の再エクスポートを解決できない。apps/worker の中で vite-node を動かすと Cloudflare の vite プラグインで落ちる）
//
// 鍵は /Users/kuroiwayuya-m5/.config/furimauto/meta-capi.env の META_CAPI_TOKEN・META_TEST_EVENT_CODE（META_PIXEL_ID は省略可）から読み、画面にもファイルにも出さない。
// test_event_code が無いときは送らない（本番の成果に数えないため）。D1 は読みも書きもしない。本番と同じ buildMetaConversionEvent → sendMetaConversion を通す。

import { readFileSync } from 'node:fs';
import { buildMetaConversionEvent, sendMetaConversion } from '../apps/worker/src/services/ad-conversion.js';

const envFile = '/Users/kuroiwayuya-m5/.config/furimauto/meta-capi.env';
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8').split('\n')
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, '')]),
);
const pixelId = env.META_PIXEL_ID || '1026661405227668';
if (!env.META_CAPI_TOKEN) throw new Error(`${envFile} に META_CAPI_TOKEN がありません`);
if (!env.META_TEST_EVENT_CODE) throw new Error(`${envFile} に META_TEST_EVENT_CODE がありません（無いと本番の成果に数えられるので送らない）`);

const now = new Date();
const friendId = `tb1790-test-${now.getTime()}`;
const event = await buildMetaConversionEvent(
  {
    fbclid: 'IwAR_tb1790_test',
    ip_address: '203.0.113.10',
    user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/14.0.0',
    created_at: new Date(now.getTime() - 3 * 60_000).toISOString(),
  },
  'line_friend_add',
  undefined,
  { friendId, followedAt: new Date(now.getTime() - 60_000).toISOString(), firstSeenAt: new Date(now.getTime() - 5 * 60_000).toISOString(), page: '/lp/service/' },
  now,
);
if (!event) throw new Error('event が作れませんでした');

const result = await sendMetaConversion(
  { pixel_id: pixelId, access_token: env.META_CAPI_TOKEN, test_event_code: env.META_TEST_EVENT_CODE } as never,
  event,
);
console.log(JSON.stringify({
  sent: { event_name: event.event_name, event_id: event.event_id, event_time: event.event_time, event_source_url: event.event_source_url, pixel_id: pixelId },
  response: { events_received: result.events_received, fbtrace_id: result.fbtrace_id },
}, null, 2));
