#!/usr/bin/env node
/**
 * 14日化カットオーバーSQL生成（2026-08-27 くろさん決定）
 *
 * やること:
 *   1) 旧7日版シナリオを「…（7日・旧）」へリネーム（active維持＝在籍者は完走まで旧版で配信）
 *      ※リネーム後も名前は「FurimAuto ステップ配信 統合版」前方一致のため、
 *        worker側の統合版系在籍ガード（二重enroll防止）の保護対象に入り続ける
 *   2) 新シナリオ（14日版・19ステップ・連番採番）を同名でINSERT
 *      → scenario-switch の完全一致解決は新シナリオだけを見つける
 *   3) friend_add: ウェルカム文言（2週間）更新＋start_scenarioを新IDへ
 *   4) closing_daily: 4通差し替え（残1日の「この2週間で」反映）
 *
 * 使い方:
 *   OLD_SCENARIO_ID=cfb9ff75-... node scripts/apply-unified-14d.mjs        # prod
 *   OLD_SCENARIO_ID=2278b486-... node scripts/apply-unified-14d.mjs        # dev
 *   → scripts/data/unified-14d-cutover.gen.sql
 *
 * 実行順（本番）: worker deploy（試用期限14日化＋統合版系在籍ガード）→ このSQL適用。
 * 生成SQLは冪等ではない。適用前に同名シナリオが1本（旧のみ）であることを確認すること。
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETS, CLOSING_ACTIONS, welcomeAsAutomationMessages } from './furimauto-unified-flex.mjs';

const OLD_SCENARIO_ID = process.env.OLD_SCENARIO_ID;
if (!OLD_SCENARIO_ID) {
  console.error('OLD_SCENARIO_ID を環境変数で指定してください（prod: cfb9ff75-... / dev: 2278b486-...）');
  process.exit(1);
}
const NEW_SCENARIO_ID = process.env.NEW_SCENARIO_ID || randomUUID();
const SCENARIO_NAME = 'FurimAuto ステップ配信 統合版';

function sq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

const lines = [
  '-- 自動生成: apply-unified-14d.mjs (2026-08-27 無料試用14日化カットオーバー)',
  `-- 旧: ${OLD_SCENARIO_ID} / 新: ${NEW_SCENARIO_ID}`,
  '',
  '-- 1) 旧7日版をリネーム（active維持・在籍者の完走用。統合版プレフィックスは保持）',
  `UPDATE scenarios SET name = ${sq(SCENARIO_NAME + '（7日・旧）')},
  description = ${sq('旧7日版（2026-08-27に14日版へ切替済み）。切替時点の在籍者が完走するまでactive維持。全員completed後にis_active=0にしてよい')},
  updated_at = datetime('now','+9 hours')
WHERE id = ${sq(OLD_SCENARIO_ID)};`,
  '',
  '-- 2) 新シナリオ（14日版）をINSERT',
  `INSERT INTO scenarios (id, name, description, trigger_type, is_active, delivery_mode)
VALUES (${sq(NEW_SCENARIO_ID)}, ${sq(SCENARIO_NAME)}, ${sq('14日試用の分散版(2026-08-27)。Week1=無料＋15大特典への道/Week2=全自動化教育。帯色: 緑=無料/橙=段階/赤=特典/黒=クロージング。Day0+0分のウェルカムはfriend_add automation。定義の正= scripts/furimauto-unified-flex.mjs')}, 'manual', 1, 'elapsed');`,
  '',
];
let order = 0;
for (const set of SETS) {
  lines.push(`-- ${set.label}`);
  for (const m of set.messages) {
    const offsetMinutes = set.schedule.deliveryTime ? 'NULL' : String(set.schedule.offsetMinutes);
    const deliveryTime = set.schedule.deliveryTime ? sq(set.schedule.deliveryTime) : 'NULL';
    lines.push(
      `INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES (${sq(randomUUID())}, ${sq(NEW_SCENARIO_ID)}, ${order}, 0, ${sq(m.messageType)}, ${sq(m.messageContent)}, ${set.schedule.offsetDays}, ${offsetMinutes}, ${deliveryTime});`,
    );
    order++;
  }
  lines.push('');
}

lines.push('-- 3) friend_add: ウェルカム文言（2週間）＋start_scenarioを新IDへ');
lines.push(`UPDATE automation_actions SET
  params = ${sq(JSON.stringify({ messages: welcomeAsAutomationMessages() }))},
  label = 'ウェルカム2通送信（Flex版・14日）',
  updated_at = datetime('now', '+9 hours')
WHERE automation_id = (SELECT id FROM automations WHERE event_type = 'friend_add' LIMIT 1)
  AND step_order = 7;`);
lines.push(`UPDATE automation_actions SET
  params = ${sq(JSON.stringify({ scenarioId: NEW_SCENARIO_ID }))},
  updated_at = datetime('now', '+9 hours')
WHERE automation_id = (SELECT id FROM automations WHERE event_type = 'friend_add' LIMIT 1)
  AND action_type = 'start_scenario';`);
lines.push('');
lines.push('-- 4) closing_daily: 4通差し替え（残1日文面の「この2週間で」反映）');
lines.push(`DELETE FROM automation_actions WHERE automation_id = (SELECT id FROM automations WHERE event_type = 'closing_daily' LIMIT 1) AND action_type = 'send_messages';`);
for (const a of CLOSING_ACTIONS) {
  lines.push(`INSERT INTO automation_actions (id, automation_id, step_order, action_type, params, condition_json, is_active, label, created_at, updated_at)
SELECT ${sq(randomUUID())}, id, ${a.stepOrder}, 'send_messages', ${sq(JSON.stringify({ messages: a.messages }))}, ${sq(JSON.stringify(a.condition))}, 1, ${sq(a.label)}, datetime('now', '+9 hours'), datetime('now', '+9 hours')
FROM automations WHERE event_type = 'closing_daily' LIMIT 1;`);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'data');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'unified-14d-cutover.gen.sql'), lines.join('\n') + '\n');
console.log(`newScenarioId: ${NEW_SCENARIO_ID} / steps=${order} → scripts/data/unified-14d-cutover.gen.sql`);
