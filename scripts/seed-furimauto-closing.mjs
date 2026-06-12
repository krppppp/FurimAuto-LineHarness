#!/usr/bin/env node
/**
 * closing_daily オートメーション seed
 * 解説見た(seg8)ユーザーへの試用終盤クロージング配信。kaisetsu cron が毎日21時に
 * closing_daily イベントを残日数付きで発火する。各 step を remaining_days で出し分け。
 *
 * cron は残日数<=0 で分類処理（配信せず）するため、最終送信は残1日。
 * 当日(残0)分は残1日メッセージに統合済み（実質5通: 残7/5/3/2/1）。
 *
 * 使い方:
 *   node scripts/seed-furimauto-closing.mjs            # dev (line-crm)
 *   node scripts/seed-furimauto-closing.mjs --rebase   # line-crm-rebase
 *   node scripts/seed-furimauto-closing.mjs --prod     # line-crm-prod
 */

import { execSync } from 'child_process';

const isProd = process.argv.includes('--prod');
const isRebase = process.argv.includes('--rebase');
const DB_NAME = isProd ? 'line-crm-prod' : isRebase ? 'line-crm-rebase' : 'line-crm';
const CWD = new URL('../apps/worker', import.meta.url).pathname;
console.log(`[seed-closing] DB: ${DB_NAME}\n`);

function runSQL(sql) {
  const escaped = sql.replace(/'/g, "'\\''");
  try {
    execSync(`npx wrangler d1 execute ${DB_NAME} --remote --command '${escaped}'`, { stdio: 'pipe', cwd: CWD });
  } catch (e) {
    const msg = e.stderr?.toString() ?? e.message;
    console.error('\n  [error]', msg.slice(0, 300));
    process.exitCode = 1;
  }
}

function jstNow() {
  return new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

const AUTOMATION_ID = crypto.randomUUID();
const now = jstNow();

// 既存 closing_daily を掃除して再作成（冪等）
console.log('既存 closing_daily automation を削除...');
runSQL(`DELETE FROM automation_actions WHERE automation_id IN (SELECT id FROM automations WHERE event_type='closing_daily')`);
runSQL(`DELETE FROM automations WHERE event_type='closing_daily'`);

console.log('closing_daily automation 作成...');
runSQL(`INSERT INTO automations (id, name, description, event_type, conditions, actions, is_active, priority, created_at, updated_at) VALUES ('${AUTOMATION_ID}', 'クロージング配信（試用終盤）', '解説見た(seg8)ユーザーへ試用終盤に残日数別のクロージングを日次配信', 'closing_daily', '{}', '[]', 1, 0, '${now}', '${now}')`);

function text(t) {
  return { messageType: 'text', content: t };
}

function insertStep({ stepOrder, label, remaining, messages }) {
  const id = crypto.randomUUID();
  const cond = { remaining_days_gte: remaining, remaining_days_lte: remaining };
  const params = JSON.stringify({ messages }).replace(/'/g, "''");
  const condJson = JSON.stringify(cond).replace(/'/g, "''");
  process.stdout.write(`  step${stepOrder} (残${remaining}日): ${label}...`);
  runSQL(`INSERT INTO automation_actions (id, automation_id, step_order, action_type, params, condition_json, on_error, is_active, label, created_at, updated_at) VALUES ('${id}', '${AUTOMATION_ID}', ${stepOrder}, 'send_messages', '${params}', '${condJson}', 'continue', 1, '${label.replace(/'/g, "''")}', '${now}', '${now}')`);
  console.log(' ok');
}

// ── ① 残7日: 成果証明＋宣言 ──
insertStep({ stepOrder: 0, remaining: 7, label: '残7日: 成果証明＋宣言', messages: [
  text(`解説動画ご視聴ありがとうございます🎬
FurimAutoがどんなツールか、もうイメージできたかと思います。

解説まで見てくださったあなたに、無料期間が終わるまで毎日1通だけ「登録前に知っておくと得する話」をお届けします📩

まずは実績から。
✅ 累計導入者500名以上
✅ 顧客満足度90%超
✅ 売上貢献度99%
✅ Google公式ストア★5

「毎日の100円値下げとセールコメント、もうやらなくていい」——多くの方がそう言って続けてくれています。明日は"どれだけラクになるか"の話を。`),
]});

// ── ② 残5日: ROI・全体価値 ──
insertStep({ stepOrder: 1, remaining: 5, label: '残5日: ROI・価値', messages: [
  text(`昨日の続きです。FurimAutoを入れると、この毎日の作業が全部消えます👇

・SEOのための100円値下げ（出品数が増えるほど地獄）
・追いセールコメントの投稿と削除
・取引中の定型文コピペ

毎日30分なら月15時間。時給1,000円換算で月15,000円分の時間が浮きます。
FurimAutoは最安480円〜（1日16円）。"時間で見てもお金で見ても元が取れる"——これが選ばれる理由です。`),
]});

// ── ③ 残3日: 割引クーポンの取り方 ──
insertStep({ stepOrder: 2, remaining: 3, label: '残3日: 割引クーポン（Furimanです）', messages: [
  text(`そろそろ"一番お得に始める方法"をお伝えします🎁

FurimAutoには初月割引クーポンがあります。
取り方は、1分解説動画シリーズを最後まで見ると出てくる合言葉「Furimanです」をこのLINEに送るだけ📩

・友だち登録から1週間以内に送る → 初月50%OFF
・1週間を過ぎてから送る → 初月20%OFF

まだの方は、今が一番割引の大きいタイミングです。すでにお持ちの方は、そのまま登録にお使いいただけます👇`),
]});

// ── ④ 残2日: 登録はこんなに簡単（案内切り替え） ──
insertStep({ stepOrder: 3, remaining: 2, label: '残2日: 登録案内（説明会不要・キーワードコピペ）', messages: [
  text(`「登録ってなんだか面倒そう」と思っていませんか？実はとても簡単です✨

長編解説動画はすでにご覧いただいているので、オンライン説明会への参加は不要。このまま月額プランへご登録いただけます。

登録の流れはこれだけ👇
① ご希望プランのキーワードを、弊社からLINEでお送りします
② それをまるっとコピペして、このLINEに送るだけ
③ 自動返信で登録フォームが届くので、クレカ決済して完了

登録したいプランが決まっていましたら、ぜひ教えてください😊`),
]});

// ── ⑤ 残1日: 締切前日＋ラストコール（統合） ──
insertStep({ stepOrder: 4, remaining: 1, label: '残1日: 締切＋ラストコール', messages: [
  text(`⚠️ お試し期間はまもなく終了です。
終了するとキーコードが無効になり、設定した自動化も止まってしまいます。

登録はキーワードをコピペして送るだけ、最短3分。
割引クーポンも今がラストチャンスです🎁

「もう手作業には戻れない」と感じていただけたなら、ぜひ今のうちに。
ご希望のプランを教えていただければ、すぐにキーワードをお送りします。最後にもう一度だけ、背中を押させてください👇`),
]});

console.log(`\n✅ closing_daily automation 作成完了（5ステップ / 残7・5・3・2・1日）`);
