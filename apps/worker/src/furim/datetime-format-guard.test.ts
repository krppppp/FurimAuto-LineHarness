import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = join(__dirname, '../../../..');
const ROOTS = ['apps/worker/src', 'packages/db/src'];

const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: 'datetime("now"', re: /datetime\(\s*"now"/ },
  { name: "datetime('now'", re: /datetime\(\s*'now'/ },
  { name: ".replace('T',' ').slice(0,19)", re: /\.replace\(\s*['"]T['"]\s*,\s*['"] ['"]\s*\)\s*\.slice\(\s*0\s*,\s*19\s*\)/ },
];

const EXCLUDED: Array<{ file: string; pattern: string; reason: string }> = [
  { file: 'apps/worker/src/furim/customer-store.ts', pattern: ".replace('T',' ').slice(0,19)", reason: 'formatJstDateTime はシートへの鏡写し専用（D1 には formatJstIso）' },
  { file: 'apps/worker/src/services/event-bus.ts', pattern: ".replace('T',' ').slice(0,19)", reason: '{{now_jst}}/{{trial_end_jst}} は GAS 経由でシートに書く値' },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'client' || name === 'node_modules') continue;
      out.push(...walk(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe('日時の書き込み形式のガード（Capsec #260）', () => {
  it('D1 に書く時刻は jstNow/formatJstIso 系だけ。SQL の datetime("now") とスペース区切りの手書きが無い', () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join(REPO, root))) {
        const rel = relative(REPO, file);
        readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
          for (const f of FORBIDDEN) {
            if (!f.re.test(line)) continue;
            if (EXCLUDED.some((e) => e.file === rel && e.pattern === f.name)) continue;
            hits.push(`${rel}:${i + 1} ${f.name}`);
          }
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
