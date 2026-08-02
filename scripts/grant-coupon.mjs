/**
 * 有料会員へキャンペーンクーポン（次回請求1回限りの固定額OFF）を付与する。
 * 併用割引とスタックされ両方効く。onceクーポンは適用後に自動でサブスクから外れる。
 *
 * Usage:
 *   node scripts/grant-coupon.mjs <LINE_USER_ID> --amount=1000                    # dev
 *   node scripts/grant-coupon.mjs <LINE_USER_ID> --amount=1000 --prod --yes       # 本番
 *   [--name=口コミ感謝クーポン]   # 省略時「キャンペーンクーポン ◯円OFF」
 *   [--no-notify]                # LINE通知を送らない
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const lineUserId = args.find((a) => a.startsWith('U'));
const isProd = args.includes('--prod');
const yes = args.includes('--yes');
const amount = Number(args.find((a) => a.startsWith('--amount='))?.split('=')[1] ?? 0);
const name = args.find((a) => a.startsWith('--name='))?.split('=')[1];
const notify = !args.includes('--no-notify');

if (!lineUserId || !amount) {
  console.error('Usage: node scripts/grant-coupon.mjs <LINE_USER_ID> --amount=1000 [--name=◯◯] [--prod --yes] [--no-notify]');
  process.exit(1);
}
if (isProd && !yes) {
  console.error('⚠️  本番の実顧客に割引を付与します。実行するには --yes を付けてください');
  process.exit(1);
}

let apiKey;
let baseUrl;
if (isProd) {
  baseUrl = 'https://line-harness-prod.furimuato.workers.dev';
  const cfg = JSON.parse(readFileSync(`${homedir()}/.claude.json`, 'utf8'));
  apiKey = cfg?.mcpServers?.['line-harness-prod']?.env?.LINE_HARNESS_API_KEY;
} else {
  baseUrl = 'https://line-harness.furimuato.workers.dev';
  const devVars = readFileSync(new URL('../apps/worker/.dev.vars', import.meta.url), 'utf8');
  apiKey = devVars.match(/^API_KEY\s*=\s*"?([^"\n]+)"?/m)?.[1];
}
if (!apiKey) { console.error('APIキーを取得できませんでした'); process.exit(1); }

console.log(`環境: ${isProd ? '🔴 本番' : '🟢 dev'} / 対象: ${lineUserId} / ${amount}円OFF${name ? ` (${name})` : ''}${notify ? '' : ' / 通知なし'}`);

const res = await fetch(`${baseUrl}/api/furim/grant-coupon`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ lineUserId, amountOff: amount, ...(name ? { name } : {}), notify }),
});
const data = await res.json();
console.log('status:', res.status);
console.log(JSON.stringify(data, null, 2));
if (data.success) console.log('\n✅ 付与完了。次回請求で自動適用されます');
