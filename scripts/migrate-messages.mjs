/**
 * 既存メッセージデータを messages + template_messages に移行
 * Usage:
 *   node scripts/migrate-messages.mjs          # dev
 *   node scripts/migrate-messages.mjs --prod   # prod
 */

import { execSync } from 'child_process';
import crypto from 'crypto';

const isProd = process.argv.includes('--prod');
const DB_NAME = isProd ? 'line-crm-prod' : 'line-crm';
const CWD = new URL('../apps/worker', import.meta.url).pathname;
console.log(`[migrate-messages] DB: ${DB_NAME} (${isProd ? 'PROD' : 'DEV'})\n`);

function query(sql) {
  const escaped = sql.replace(/'/g, "'\\''");
  const out = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --command '${escaped}' --json`,
    { cwd: CWD, stdio: 'pipe' },
  ).toString();
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

function runSQL(sql) {
  const escaped = sql.replace(/'/g, "'\\''");
  try {
    execSync(`npx wrangler d1 execute ${DB_NAME} --remote --command '${escaped}'`, { stdio: 'pipe', cwd: CWD });
  } catch (e) {
    const msg = e.stderr?.toString() ?? e.message;
    if (msg.includes('UNIQUE constraint') || msg.includes('already exists')) {
      process.stdout.write(' [skip]');
    } else {
      console.error('\n  [error]', msg.slice(0, 300));
    }
  }
}

function jstNow() {
  return new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

function esc(s) {
  return String(s ?? '').replace(/'/g, "''");
}

// ── 1. automation_actions の send_messages を移行 ─────────────────────────

console.log('[1] automation_actions.send_messages → messages + templates + template_messages');

const actions = query(
  "SELECT id, params, label FROM automation_actions WHERE action_type = 'send_messages' AND template_id IS NULL"
);

console.log(`  対象: ${actions.length}件`);

for (const action of actions) {
  let msgs;
  try {
    const params = JSON.parse(action.params);
    msgs = params.messages;
    if (!Array.isArray(msgs) || msgs.length === 0) {
      console.log(`  [skip] action ${action.id}: messages配列なし`);
      continue;
    }
  } catch (e) {
    console.log(`  [skip] action ${action.id}: JSON parse error`);
    continue;
  }

  process.stdout.write(`  action: ${action.id} (${msgs.length}通)`);

  // テンプレート作成
  const templateId = crypto.randomUUID();
  const templateName = esc(`migrated_action_${action.id.slice(0, 8)}`);
  const now = jstNow();
  runSQL(`INSERT INTO templates (id, name, category, message_type, message_content, created_at, updated_at) VALUES ('${templateId}', '${templateName}', 'migrated', 'text', '', '${now}', '${now}')`);

  // 各メッセージを messages テーブルに登録
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const msgId = crypto.randomUUID();
    const msgType = esc(m.messageType ?? 'text');
    const content = esc(m.content ?? '');
    const altText = m.altText ? `'${esc(m.altText)}'` : 'NULL';
    const label = esc(`${action.label ?? 'message'}_${i + 1}`);
    runSQL(`INSERT INTO messages (id, message_type, content, alt_text, tags, label, created_at, updated_at) VALUES ('${msgId}', '${msgType}', '${content}', ${altText}, '[]', '${label}', '${now}', '${now}')`);

    // template_messages に紐付け
    const tmId = crypto.randomUUID();
    runSQL(`INSERT INTO template_messages (id, template_id, message_id, step_order, created_at) VALUES ('${tmId}', '${templateId}', '${msgId}', ${i}, '${now}')`);
  }

  // automation_actions.template_id を更新
  runSQL(`UPDATE automation_actions SET template_id = '${templateId}' WHERE id = '${action.id}'`);
  process.stdout.write(' → done\n');
}

// ── 2. scenario_steps を移行 ──────────────────────────────────────────────

console.log('\n[2] scenario_steps → messages + templates + template_messages');

const steps = query(
  "SELECT id, message_type, message_content, scenario_id FROM scenario_steps WHERE template_id IS NULL AND message_content IS NOT NULL AND message_content != ''"
);

console.log(`  対象: ${steps.length}件`);

for (const step of steps) {
  process.stdout.write(`  step: ${step.id}`);
  const now = jstNow();

  // メッセージ作成
  const msgId = crypto.randomUUID();
  const msgType = esc(step.message_type ?? 'text');
  const content = esc(step.message_content ?? '');
  runSQL(`INSERT INTO messages (id, message_type, content, alt_text, tags, label, created_at, updated_at) VALUES ('${msgId}', '${msgType}', '${content}', NULL, '[]', 'migrated_step_${esc(step.id.slice(0, 8))}', '${now}', '${now}')`);

  // テンプレート作成
  const templateId = crypto.randomUUID();
  const templateName = esc(`migrated_step_${step.id.slice(0, 8)}`);
  runSQL(`INSERT INTO templates (id, name, category, message_type, message_content, created_at, updated_at) VALUES ('${templateId}', '${templateName}', 'migrated', '${msgType}', '', '${now}', '${now}')`);

  // template_messages 紐付け
  const tmId = crypto.randomUUID();
  runSQL(`INSERT INTO template_messages (id, template_id, message_id, step_order, created_at) VALUES ('${tmId}', '${templateId}', '${msgId}', 0, '${now}')`);

  // scenario_steps.template_id 更新
  runSQL(`UPDATE scenario_steps SET template_id = '${templateId}' WHERE id = '${step.id}'`);
  process.stdout.write(' → done\n');
}

console.log('\n✅ 移行完了');
