#!/usr/bin/env node
/**
 * FurimAuto シナリオ改訂 適用スクリプト（2026-07-18 3軸改訂）
 *
 * seed-furimauto-all-scenarios.mjs と違い、既存シナリオを削除・再作成せず
 * 「名前一致する既存シナリオのステップだけを全削除→再登録」する。
 * → シナリオIDが変わらないため、GAS の scenario-switch 連携を壊さない。
 *
 * 使い方:
 *   DEV:  WORKER_URL=https://line-harness.furimuato.workers.dev API_KEY=xxx node scripts/apply-scenario-revision.mjs
 *   PROD: WORKER_URL=https://line-harness-prod.furimuato.workers.dev API_KEY=xxx node scripts/apply-scenario-revision.mjs
 *
 * オプション:
 *   DRY_RUN=1  差し替え内容のサマリだけ表示して何も書き込まない
 */

import { SCENARIOS, toSteps } from './seed-furimauto-all-scenarios.mjs';

const BASE_URL = process.env.WORKER_URL || 'https://line-harness.furimuato.workers.dev';
const API_KEY = process.env.API_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';

if (!API_KEY) {
  console.error('Error: API_KEY 環境変数が未設定です');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`,
};

async function req(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`${method} ${path} status=${res.status} body=${text.slice(0, 300)}`);
  }
  if (!res.ok && !json.success) throw new Error(`${method} ${path} failed: ${JSON.stringify(json).slice(0, 300)}`);
  return json.data;
}

async function main() {
  const existing = await req('GET', '/api/scenarios');
  const byName = new Map(existing.map((s) => [s.name, s]));

  for (const scenario of SCENARIOS) {
    const target = byName.get(scenario.name);
    const steps = toSteps(scenario.days);

    if (!target) {
      console.log(`[SKIP] 見つからない: ${scenario.name}`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`[DRY] ${target.id} ${scenario.name}: ${target.stepCount ?? '?'}steps → ${steps.length}steps`);
      continue;
    }

    process.stdout.write(`[${scenario.name.slice(0, 40)}] id=${target.id} `);

    const detail = await req('GET', `/api/scenarios/${target.id}`);
    for (const old of detail.steps ?? []) {
      await req('DELETE', `/api/scenarios/${target.id}/steps/${old.id}`);
    }
    process.stdout.write(`(del ${detail.steps?.length ?? 0}) `);

    for (const step of steps) {
      await req('POST', `/api/scenarios/${target.id}/steps`, step);
      process.stdout.write('.');
    }
    console.log(` (add ${steps.length})`);
  }

  console.log('\n=== 適用完了 ===');
  console.log('※ isActive は変更していない。有効化は別途 manage_scenarios / 管理画面で行う');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
