/**
 * 移行時に自動生成されたテンプレート名を日本語の意味のある名前に変更
 * Usage:
 *   node scripts/rename-migrated-templates.mjs          # dev
 *   node scripts/rename-migrated-templates.mjs --prod   # prod
 */

import { execSync } from 'child_process';

const isProd = process.argv.includes('--prod');
const DB_NAME = isProd ? 'line-crm-prod' : 'line-crm';
const CWD = new URL('../apps/worker', import.meta.url).pathname;
console.log(`[rename-migrated-templates] DB: ${DB_NAME}\n`);

function query(sql) {
  const escaped = sql.replace(/'/g, "'\\''");
  const out = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --command '${escaped}' --json`,
    { cwd: CWD, stdio: 'pipe' },
  ).toString();
  return JSON.parse(out)[0]?.results ?? [];
}

function runSQL(sql) {
  const escaped = sql.replace(/'/g, "'\\''");
  execSync(`npx wrangler d1 execute ${DB_NAME} --remote --command '${escaped}'`, { stdio: 'pipe', cwd: CWD });
}

function esc(s) {
  return String(s ?? '').replace(/'/g, "''");
}

// ── scenario_steps 由来のテンプレートをリネーム ───────────────────────────

console.log('[1] scenario_steps 由来テンプレートをリネーム');

const stepTemplates = query(`
  SELECT ss.template_id, s.name as scenario_name, ss.step_order
  FROM scenario_steps ss
  JOIN scenarios s ON ss.scenario_id = s.id
  JOIN templates t ON ss.template_id = t.id
  WHERE ss.template_id IS NOT NULL
    AND t.name LIKE 'migrated_step_%'
`);

console.log(`  対象: ${stepTemplates.length}件`);
for (const row of stepTemplates) {
  const newName = esc(`${row.scenario_name} ステップ${row.step_order}`);
  runSQL(`UPDATE templates SET name = '${newName}' WHERE id = '${row.template_id}'`);
  process.stdout.write(`  step_order=${row.step_order} "${row.scenario_name}" → "${row.scenario_name} ステップ${row.step_order}"\n`);
}

// ── automation_actions 由来のテンプレートをリネーム ───────────────────────

console.log('\n[2] automation_actions 由来テンプレートをリネーム');

const actionTemplates = query(`
  SELECT aa.template_id, a.name as automation_name, aa.label, aa.step_order
  FROM automation_actions aa
  JOIN automations a ON aa.automation_id = a.id
  JOIN templates t ON aa.template_id = t.id
  WHERE aa.template_id IS NOT NULL
    AND t.name LIKE 'migrated_action_%'
`);

console.log(`  対象: ${actionTemplates.length}件`);
for (const row of actionTemplates) {
  const suffix = row.label ? ` ${row.label}` : ` Step${row.step_order}`;
  const newName = esc(`${row.automation_name}${suffix}`);
  runSQL(`UPDATE templates SET name = '${newName}' WHERE id = '${row.template_id}'`);
  process.stdout.write(`  "${row.automation_name}"${suffix}\n`);
}

console.log('\n✅ リネーム完了');
