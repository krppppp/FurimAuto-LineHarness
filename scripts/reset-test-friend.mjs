/**
 * 動作検証用: 友達データを全リセットして「新規友達」から検証をやり直す
 *
 * Usage:
 *   node scripts/reset-test-friend.mjs <LINE_USER_ID>                # dev
 *   node scripts/reset-test-friend.mjs <LINE_USER_ID> --prod --yes   # 本番（要 --yes）
 *   node scripts/reset-test-friend.mjs <LINE_USER_ID> --force        # 月額会員タグ付きでも強制
 *
 * 消えるもの: D1(friends+タグ+シナリオ+ログ類) / スプシのマスター行 /
 *            Stripe顧客(サブスクごと。devはテスト・prodは本番) /
 *            Firebase(特典配布状態・AIモード・チャット履歴)
 * 手順: このスクリプト実行 → LINEでブロック→ブロック解除 → 新規登録フローが最初から走る
 *
 * 安全装置:
 * - 本番は --yes 必須（スクリプト側）+ confirmProd必須（worker側）
 * - 月額会員タグ付きユーザーは --force がない限りworker側で中断（実顧客の誤削除防止）
 * - APIキー: devは apps/worker/.dev.vars、prodは ~/.claude.json のMCP設定(line-harness-prod)から自動取得
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const lineUserId = args.find((a) => a.startsWith('U'));
const isProd = args.includes('--prod');
const yes = args.includes('--yes');
const force = args.includes('--force');

if (!lineUserId) {
  console.error('Usage: node scripts/reset-test-friend.mjs <LINE_USER_ID> [--prod --yes] [--force]');
  console.error('LINE_USER_ID は管理画面の友達一覧か、スプシのLINE_ID列で確認できます');
  process.exit(1);
}
if (isProd && !yes) {
  console.error('⚠️  本番リセットです。実顧客データ・本番Stripe顧客・本番スプシ行を削除します。');
  console.error('   実行するには --yes を付けてください:');
  console.error(`   node scripts/reset-test-friend.mjs ${lineUserId} --prod --yes`);
  process.exit(1);
}

let apiKey;
let baseUrl;
if (isProd) {
  baseUrl = 'https://line-harness-prod.furimuato.workers.dev';
  try {
    const cfg = JSON.parse(readFileSync(`${homedir()}/.claude.json`, 'utf8'));
    apiKey = cfg?.mcpServers?.['line-harness-prod']?.env?.LINE_HARNESS_API_KEY;
  } catch { /* fallthrough */ }
  if (!apiKey) {
    console.error('~/.claude.json のMCP設定(line-harness-prod)から本番APIキーを取得できませんでした');
    process.exit(1);
  }
} else {
  baseUrl = 'https://line-harness.furimuato.workers.dev';
  const devVars = readFileSync(new URL('../apps/worker/.dev.vars', import.meta.url), 'utf8');
  apiKey = devVars.match(/^API_KEY\s*=\s*"?([^"\n]+)"?/m)?.[1];
  if (!apiKey) {
    console.error('apps/worker/.dev.vars に API_KEY が見つかりません');
    process.exit(1);
  }
}

console.log(`環境: ${isProd ? '🔴 本番 (line-harness-prod)' : '🟢 dev (line-harness)'} / 対象: ${lineUserId}`);

const res = await fetch(`${baseUrl}/api/furim/test-reset`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ lineUserId, confirmProd: isProd, force }),
});
const data = await res.json();
console.log('status:', res.status);
console.log(JSON.stringify(data, null, 2));
if (data.success) {
  console.log('\n✅ リセット完了。LINEでブロック→ブロック解除すると新規登録フローが最初から走ります');
}
