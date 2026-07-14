/**
 * タスク#7: 旧プランサブスクを新方式へ一括移行する（in-place更新・キャンセルなし）
 *
 * Usage:
 *   node scripts/migrate-legacy-subscriptions.mjs                         # dev dry-run
 *   node scripts/migrate-legacy-subscriptions.mjs --execute               # dev 実行
 *   node scripts/migrate-legacy-subscriptions.mjs --prod                  # 本番 dry-run
 *   node scripts/migrate-legacy-subscriptions.mjs --prod --yes --execute  # 本番 実行
 *   [--sub=sub_xxx] [--force-nickname=プラン名]   # 検証用に1件へ絞る
 *   [--mapping=scripts/data/legacy-plan-mapping.json]
 *
 * 前提: マッピング表（generate-legacy-plan-mapping.mjs で生成→くろさんレビュー済み）
 * 安全性: キャンセルを行わないため subscription.deleted webhook（退会メッセージ）は発生しない。
 *         dry-runは読み取りのみ。実行時も priceMatch=false / manual / unmapped は自動スキップ。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const isProd = args.includes('--prod');
const yes = args.includes('--yes');
const execute = args.includes('--execute');
const onlySub = args.find((a) => a.startsWith('--sub='))?.split('=')[1];
const testClock = args.find((a) => a.startsWith('--test-clock='))?.split('=')[1];
const forceNickname = args.find((a) => a.startsWith('--force-nickname='))?.split('=')[1];
const mappingFile = args.find((a) => a.startsWith('--mapping='))?.split('=')[1] || new URL('data/legacy-plan-mapping.json', import.meta.url).pathname;

if (isProd && execute && !yes) {
  console.error('⚠️  本番の実行には --yes を付けてください（全アクティブサブスクのitemsを書き換えます）');
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

const mapping = JSON.parse(readFileSync(mappingFile, 'utf8'));
console.log(`環境: ${isProd ? '🔴 本番' : '🟢 dev'} / モード: ${execute ? '⚡ 実行' : '👀 dry-run'} / マッピング: ${Object.keys(mapping).length}プラン`);

const res = await fetch(`${baseUrl}/api/furim/migrate-subscriptions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    dryRun: !execute,
    confirmProd: isProd && execute,
    mapping,
    ...(onlySub ? { onlySubscriptionId: onlySub } : {}),
    ...(forceNickname ? { forceNickname } : {}),
    ...(testClock ? { testClock } : {}),
  }),
});
const data = await res.json();
if (!data.success) { console.error('失敗:', data); process.exit(1); }

console.log(`\nアクティブサブスク総数: ${data.total} / ステータス内訳:`, data.counts);
const byStatus = {};
for (const r of data.report) (byStatus[r.status] ??= []).push(r);

for (const [status, rows] of Object.entries(byStatus)) {
  console.log(`\n── ${status} (${rows.length}件) ──`);
  for (const r of rows) {
    const amount = r.oldAmount !== undefined ? ` 旧${r.oldAmount}円→新${r.newAmount ?? '-'}円${r.amountDiff ? ` (差${r.amountDiff})` : ''}` : '';
    const map = r.packages ? ` [${r.packages.join('+')}${r.features?.length ? ' / ' + r.features.join(',') : ''}]` : '';
    console.log(`  ${r.id} ${r.nickname ?? ''}${amount}${map}${r.error ? ' ERROR: ' + r.error : ''}`);
  }
}
