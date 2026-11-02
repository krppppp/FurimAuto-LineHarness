#!/usr/bin/env node
/**
 * TB-2388 前の週に ref なしで友だちになった人へ「広告_LINE友だち追加（推定）」を付ける（月曜の定例 routine 4d058ef3）。
 *
 * 使い方（1 コマンド 1 操作。&& で繋げない）:
 *   node run.mjs dryrun                 読み取りのみ。期間・件数・日別（JST）の内訳を出す
 *   node run.mjs apply --expect <件数>  本番 D1 に INSERT OR IGNORE を 1 回だけ流し、runs.csv に 1 行足す。件数が dryrun とずれたら流さない
 *   node run.mjs verify                 読み取りのみ。直近の期間でタグ付き件数・うち ref あり（0 のはず）を出す
 *
 * 期間: runs.csv の最後の until 〜 今週月曜 0:00 JST。ad-periods.csv の広告 ON の期間（off_at が空なら続いている）と重なるところだけ。
 * 広告を止めたら ad-periods.csv の off_at に止めた時刻を入れる。再開したら on_at の行を足す。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';

const here = new URL('.', import.meta.url).pathname;
const TAG_ID = '2b4f698f-c897-450f-9e05-8e100cf19fd1';
const ISSUE = process.env.ISSUE ?? '';

const csv = (name) => readFileSync(here + name, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
const iso = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 19) + '+09:00';

const runs = csv('runs.csv');
const from = Date.parse(runs.at(-1)[1]);
const nowJst = new Date(Date.now() + 9 * 3600_000);
const until = Date.UTC(nowJst.getUTCFullYear(), nowJst.getUTCMonth(), nowJst.getUTCDate() - ((nowJst.getUTCDay() + 6) % 7)) - 9 * 3600_000;

const windows = csv('ad-periods.csv')
  .map(([on, off]) => [Math.max(from, Date.parse(on)), Math.min(until, off ? Date.parse(off) : Infinity)])
  .filter(([a, b]) => a < b);
const where = windows.length
  ? windows.map(([a, b]) => `(datetime(f.created_at) >= datetime('${iso(a)}') AND datetime(f.created_at) < datetime('${iso(b)}'))`).join(' OR ')
  : '0';
const target = readFileSync(here + 'target.sql', 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n').replace('{{WINDOW}}', where);

const d1 = (sql) => {
  const out = execFileSync('npx', ['wrangler@4.77.0', 'd1', 'execute', 'line-crm-prod', '--remote', '--command', sql, '--json'], {
    cwd: new URL('../../../apps/worker/', import.meta.url).pathname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out)[0];
};

const mode = process.argv[2];
console.log(`期間: ${iso(from)} 〜 ${iso(until)}（広告 ON と重なる部分: ${windows.map(([a, b]) => `${iso(a)}〜${iso(b)}`).join('・') || 'なし'}）`);

if (mode === 'dryrun') {
  const rows = d1(`SELECT t.friend_id, t.is_following, date(datetime(t.created_at), '+9 hours') AS day, EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = t.friend_id AND ft.tag_id = '${TAG_ID}') AS tagged FROM (${target}) t`).results;
  const byDay = {};
  for (const r of rows) byDay[r.day] = (byDay[r.day] ?? 0) + 1;
  console.log(`対象 ${rows.length} 人（うち友だちのまま ${rows.filter((r) => r.is_following).length}・付与済み ${rows.filter((r) => r.tagged).length}）`);
  for (const [day, n] of Object.entries(byDay).sort()) console.log(`  ${day}  ${n}`);
} else if (mode === 'apply') {
  if (until <= from) throw new Error('今週の分はもう付けてある（runs.csv の最後の until が今週月曜 0:00 以降）');
  const expect = Number(process.argv[process.argv.indexOf('--expect') + 1]);
  const n = d1(`SELECT COUNT(*) AS n FROM (${target})`).results[0].n;
  if (!(expect > 0) || n !== expect) throw new Error(`件数が合わない（dryrun ${expect}・今 ${n}）。0 件の週は付けない`);
  const meta = d1(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id) SELECT friend_id, '${TAG_ID}' FROM (${target})`).meta;
  appendFileSync(here + 'runs.csv', `${iso(from)},${iso(until)},${meta.changes},${iso(Date.now())},${ISSUE}\n`);
  console.log(`付与 ${meta.changes} 件（対象 ${n}）→ runs.csv に 1 行足した`);
} else if (mode === 'verify') {
  const last = runs.at(-1);
  const sql = `SELECT COUNT(*) AS tagged, SUM(f.ref_code IS NOT NULL OR EXISTS (SELECT 1 FROM ref_tracking r WHERE r.friend_id = f.id)) AS with_ref FROM friend_tags ft JOIN friends f ON f.id = ft.friend_id WHERE ft.tag_id = '${TAG_ID}' AND datetime(f.created_at) >= datetime('${last[0]}') AND datetime(f.created_at) < datetime('${last[1]}')`;
  const all = d1(`SELECT COUNT(*) AS n FROM friend_tags WHERE tag_id = '${TAG_ID}'`).results[0].n;
  console.log(`直近の行（${last[0]}〜${last[1]}・${last[4]}）: `, d1(sql).results[0], `／タグ付き合計 ${all}`);
} else {
  console.log('dryrun | apply --expect <件数> | verify');
}
