#!/usr/bin/env node
// LINE の AI チャットボットが読む faq.md を、Worker の KV（FURIM_EXT_CACHE）の furim:ai-chat:faq-text:v1 に書き込む（TB-2976）。
// Worker は実行時に GitHub を見に行かない。faq.md（~/github/furimauto-faq）を直したら、commit・push のあとにこれを流す。
//
//   node scripts/push-faq-kv.mjs            # dryRun（書き込まない。文字数・コミット・今の KV との差だけ出す）
//   node scripts/push-faq-kv.mjs --apply    # 本番 KV に 1 回 put
//   --faq <path> で faq.md の場所を変えられる
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const KEY = 'furim:ai-chat:faq-text:v1';
const PROD_NAMESPACE_ID = '0e6c4e7a19d047b9a4a4ca1044c29967';
const MIN_CHARS = 5_000;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const faqIdx = args.indexOf('--faq');
const faqPath = faqIdx >= 0 ? args[faqIdx + 1] : join(homedir(), 'github/furimauto-faq/faq.md');

const text = readFileSync(faqPath, 'utf8');
if (text.length < MIN_CHARS) throw new Error(`faq.md が短すぎる (${text.length} chars)`);

const git = (...a) => execFileSync('git', ['-C', dirname(faqPath), ...a], { encoding: 'utf8' }).trim();
const commit = git('rev-parse', '--short', 'HEAD');
const dirty = git('status', '--porcelain', '--', 'faq.md') !== '';
if (dirty && apply) throw new Error('faq.md に commit していない変更がある。commit・push してから流す');

const wrangler = (...a) => execFileSync('npx', ['wrangler', 'kv', 'key', ...a, '--namespace-id', PROD_NAMESPACE_ID, '--remote'], { cwd: 'apps/worker', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let current = null;
try {
  current = JSON.parse(wrangler('get', KEY));
} catch {
  current = null;
}

console.log(`faq.md: ${faqPath}`);
console.log(`  chars ${text.length} / commit ${commit}${dirty ? '（未 commit の変更あり）' : ''}`);
console.log(`KV ${KEY}: ${current ? `chars ${current.text?.length ?? 0} / commit ${current.commit} / pushedAt ${current.pushedAt}` : '無し'}`);
if (current?.text === text) console.log('  → 中身は同じ');

if (!apply) {
  console.log('dryRun（--apply で書き込む）');
  process.exit(0);
}

const file = join(mkdtempSync(join(tmpdir(), 'faq-kv-')), 'value.json');
writeFileSync(file, JSON.stringify({ text, commit, pushedAt: new Date().toISOString() }));
wrangler('put', KEY, '--path', file);
const after = JSON.parse(wrangler('get', KEY));
if (after.text !== text) throw new Error('読み戻した本文が一致しない');
console.log(`put 済み: chars ${after.text.length} / commit ${after.commit} / pushedAt ${after.pushedAt}`);
