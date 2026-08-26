#!/usr/bin/env node
/**
 * 統合版シナリオを Flexデザイン版（furimauto-unified-flex.mjs）へ差し替えるSQL生成。
 *
 * 進行中の友だちがいる前提で、シナリオIDは変えずにステップだけ入れ替える。
 * step_order は旧テキスト版（39ステップ）の各セット先頭の番号を引き継ぐ
 * 「レガシー互換採番」を使う。これにより進行中の current_step_order が
 * どこを指していても「次のセット」が正しく選ばれる（例: Day1夜(17)まで
 * 消化済みの人の次は 18=Day2朝）。
 *
 * 使い方:
 *   SCENARIO_ID=cfb9ff75-... node scripts/apply-unified-flex.mjs
 *   → scripts/data/unified-flex-scenario.gen.sql   （ステップ差し替え）
 *   → scripts/data/unified-flex-automations.gen.sql（ウェルカム＋クロージング差し替え）
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETS, CLOSING_ACTIONS, welcomeAsAutomationMessages } from './furimauto-unified-flex.mjs';

const SCENARIO_ID = process.env.SCENARIO_ID;
if (!SCENARIO_ID) {
  console.error('SCENARIO_ID を環境変数で指定してください（prod: cfb9ff75-... / dev: 2278b486-...）');
  process.exit(1);
}

// 旧テキスト版のセット先頭 step_order（レガシー互換採番の基準）
const LEGACY_HEAD_ORDERS = [0, 5, 10, 13, 15, 16, 18, 21, 22, 25, 26, 29, 31, 33, 36, 38];
if (LEGACY_HEAD_ORDERS.length !== SETS.length) {
  throw new Error(`セット数不一致: legacy=${LEGACY_HEAD_ORDERS.length} sets=${SETS.length}`);
}

function sq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

const lines = [
  '-- 自動生成: apply-unified-flex.mjs (2026-08-27 Flexデザイン版への差し替え)',
  `-- 対象シナリオ: ${SCENARIO_ID}（IDは変えずステップのみ入れ替え・レガシー互換採番）`,
  '',
  `DELETE FROM scenario_steps WHERE scenario_id = ${sq(SCENARIO_ID)};`,
  '',
];
let total = 0;
SETS.forEach((set, i) => {
  lines.push(`-- ${set.label}`);
  let order = LEGACY_HEAD_ORDERS[i];
  for (const m of set.messages) {
    const offsetMinutes = set.schedule.deliveryTime ? 'NULL' : String(set.schedule.offsetMinutes);
    const deliveryTime = set.schedule.deliveryTime ? sq(set.schedule.deliveryTime) : 'NULL';
    lines.push(
      `INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES (${sq(randomUUID())}, ${sq(SCENARIO_ID)}, ${order}, 0, ${sq(m.messageType)}, ${sq(m.messageContent)}, ${set.schedule.offsetDays}, ${offsetMinutes}, ${deliveryTime});`,
    );
    order++;
    total++;
  }
  lines.push('');
});
lines.push(
  `UPDATE scenarios SET description = ${sq('Flexデザイン版(2026-08-27)。帯色: 緑=無料/橙=段階/赤=15大特典への道/黒=クロージング。Day0+0分のウェルカムはfriend_add automationが送る。step_orderは旧39ステップ互換の飛び番。定義の正= scripts/furimauto-unified-flex.mjs')}, updated_at = datetime('now','+9 hours') WHERE id = ${sq(SCENARIO_ID)};`,
);

const autoLines = [
  '-- 自動生成: apply-unified-flex.mjs (2026-08-27 Flexデザイン版)',
  '',
  '-- 1) friend_add step7: ウェルカムをFlexカード＋動画に差し替え',
  `UPDATE automation_actions SET
  params = ${sq(JSON.stringify({ messages: welcomeAsAutomationMessages() }))},
  label = 'ウェルカム2通送信（Flex版）',
  updated_at = datetime('now', '+9 hours')
WHERE automation_id = (SELECT id FROM automations WHERE event_type = 'friend_add' LIMIT 1)
  AND step_order = 7;`,
  '',
  '-- 2) closing_daily: 4通をFlex版（黒帯）に差し替え（start_scenarioアクションは触らない）',
  `DELETE FROM automation_actions WHERE automation_id = (SELECT id FROM automations WHERE event_type = 'closing_daily' LIMIT 1) AND action_type = 'send_messages';`,
];
for (const a of CLOSING_ACTIONS) {
  autoLines.push(`INSERT INTO automation_actions (id, automation_id, step_order, action_type, params, condition_json, is_active, label, created_at, updated_at)
SELECT ${sq(randomUUID())}, id, ${a.stepOrder}, 'send_messages', ${sq(JSON.stringify({ messages: a.messages }))}, ${sq(JSON.stringify(a.condition))}, 1, ${sq(a.label)}, datetime('now', '+9 hours'), datetime('now', '+9 hours')
FROM automations WHERE event_type = 'closing_daily' LIMIT 1;`);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'data');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'unified-flex-scenario.gen.sql'), lines.join('\n') + '\n');
writeFileSync(join(outDir, 'unified-flex-automations.gen.sql'), autoLines.join('\n') + '\n');
console.log(`steps=${total} → scripts/data/unified-flex-scenario.gen.sql / unified-flex-automations.gen.sql`);
