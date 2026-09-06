#!/usr/bin/env node
/**
 * 統合版シナリオの「可読性レイアウト版」差し替えSQL生成（2026-09-06 くろさん決定）
 *
 * furimauto-unified-flex.mjs の t()/bubble() 変更（lineSpacing・段落分割・余白）を
 * 既存の本番/devシナリオへ UPDATE で反映する。文言・スケジュール・step_order は変えない
 * ので、在籍者の進行位置に影響しない。冪等（何度流しても同じ結果）。
 *
 * 使い方:
 *   SCENARIO_ID=37459be2-... node scripts/apply-unified-readability.mjs   # dev
 *   SCENARIO_ID=373c47a6-... node scripts/apply-unified-readability.mjs   # prod
 *   → scripts/data/unified-readability.gen.sql
 *   npx wrangler d1 execute <db名> --remote --file scripts/data/unified-readability.gen.sql
 *
 * 前提: 対象シナリオの step_order 0..18 が SETS の順（apply-unified-14d.mjs と同じ採番）で
 * 入っていること。適用前に message_type が一致するかを SQL 側の WHERE で保護している。
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETS, CLOSING_ACTIONS, welcomeAsAutomationMessages } from './furimauto-unified-flex.mjs';

const SCENARIO_ID = process.env.SCENARIO_ID;
if (!SCENARIO_ID) {
  console.error('SCENARIO_ID を環境変数で指定してください（prod: 373c47a6-... / dev: 37459be2-...）');
  process.exit(1);
}
function sq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
const lines = [
  '-- 自動生成: apply-unified-readability.mjs (2026-09-06 可読性レイアウト版)',
  `-- scenario: ${SCENARIO_ID}`,
  '',
];
let order = 0;
for (const set of SETS) {
  lines.push(`-- ${set.label}`);
  for (const m of set.messages) {
    lines.push(
      `UPDATE scenario_steps SET message_content = ${sq(m.messageContent)}
WHERE scenario_id = ${sq(SCENARIO_ID)} AND step_order = ${order} AND message_type = ${sq(m.messageType)};`,
    );
    order++;
  }
}
lines.push('', '-- friend_add: ウェルカム2通（step_order=7 は 14d カットオーバー時の採番）');
lines.push(`UPDATE automation_actions SET
  params = ${sq(JSON.stringify({ messages: welcomeAsAutomationMessages() }))},
  updated_at = datetime('now', '+9 hours')
WHERE automation_id = (SELECT id FROM automations WHERE event_type = 'friend_add' LIMIT 1)
  AND step_order = 7 AND action_type = 'send_messages';`);
lines.push('', '-- closing_daily: 4通差し替え');
lines.push(`DELETE FROM automation_actions WHERE automation_id = (SELECT id FROM automations WHERE event_type = 'closing_daily' LIMIT 1) AND action_type = 'send_messages';`);
for (const a of CLOSING_ACTIONS) {
  lines.push(`INSERT INTO automation_actions (id, automation_id, step_order, action_type, params, condition_json, is_active, label, created_at, updated_at)
SELECT ${sq(randomUUID())}, id, ${a.stepOrder}, 'send_messages', ${sq(JSON.stringify({ messages: a.messages }))}, ${sq(JSON.stringify(a.condition))}, 1, ${sq(a.label)}, datetime('now', '+9 hours'), datetime('now', '+9 hours')
FROM automations WHERE event_type = 'closing_daily' LIMIT 1;`);
}
const outDir = join(dirname(fileURLToPath(import.meta.url)), 'data');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'unified-readability.gen.sql'), lines.join('\n') + '\n');
console.log(`steps=${order} → scripts/data/unified-readability.gen.sql`);
