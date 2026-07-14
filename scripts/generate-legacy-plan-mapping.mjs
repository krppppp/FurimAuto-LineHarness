/**
 * 旧プラン一覧 → 新パッケージ/機能マスタ のマッピング表を生成する
 * （タスク#7 サブスク一括移行の入力データ。生成後にくろさんレビュー前提）
 *
 * Usage:
 *   node scripts/generate-legacy-plan-mapping.mjs \
 *     --plans=<プラン一覧TSV> \
 *     [--worker=https://line-harness.furimuato.workers.dev] \
 *     [--out=scripts/data/legacy-plan-mapping.json]
 *
 * ロジック:
 *   各旧プラン行の機能フラグ集合を、パッケージ（機能セットが部分集合になる最大のもの）＋
 *   残りの単品機能に貪欲分解する。AutoMultiChannelは値（サイト語彙）を multiChannelSites に。
 *   新価格（パッケージ+機能-併用割引）と旧価格の一致チェック付き。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const plansFile = args.find((a) => a.startsWith('--plans='))?.split('=')[1];
const workerUrl = args.find((a) => a.startsWith('--worker='))?.split('=')[1] || 'https://line-harness.furimuato.workers.dev';
const outFile = args.find((a) => a.startsWith('--out='))?.split('=')[1] || 'scripts/data/legacy-plan-mapping.json';
if (!plansFile) { console.error('--plans=<TSV> が必要'); process.exit(1); }

// ── マスタ取得 ──
const res = await fetch(`${workerUrl}/plan-builder/features`);
const master = await res.json();
if (!master.success) { console.error('features取得失敗', master); process.exit(1); }
const featByKey = Object.fromEntries(master.features.map((f) => [f.feature_key, f]));

// パッケージ: features CSV（`key` or `key=値`）→ boolキー集合。trialは移行対象外
const packages = master.packages
  .filter((p) => p.package_key !== 'trial')
  .map((p) => {
    const boolKeys = new Set();
    let mcSites = [];
    for (const raw of String(p.features).split(',')) {
      const s = raw.trim();
      if (!s) continue;
      const eq = s.indexOf('=');
      if (eq > 0) {
        const key = s.slice(0, eq);
        if (key === 'AutoMultiChannel') mcSites = s.slice(eq + 1).split('/');
        else boolKeys.add(key);
      } else {
        boolKeys.add(s);
      }
    }
    return { ...p, boolKeys, mcSites };
  })
  // 機能数の多い順（premium→full→semi→basic）に貪欲マッチ
  .sort((a, b) => b.boolKeys.size - a.boolKeys.size);

// ── プランTSVパース ──
const lines = readFileSync(plansFile, 'utf-8').split('\n').filter((l) => l.trim());
const headers = lines[0].split('\t').map((h) => {
  const t = h.trim();
  return t === 'mProfileOptionsAddition' ? 'mProfileOptions' : t; // S3リネーム前のTSV対応
});
const NON_FEATURE = new Set(['プラン名', '価格', 'PriceID', 'トライアル期間', 'キーコード接頭語']);
const featureCols = headers.filter((h) => !NON_FEATURE.has(h));

const mapping = {};
const report = [];
for (const line of lines.slice(1)) {
  const values = line.split('\t');
  const row = {};
  headers.forEach((h, i) => { row[h] = (values[i] ?? '').trim(); });
  const name = row['プラン名'];
  if (!name || name === 'String') continue;
  const price = parseInt(String(row['価格']).replace(/[^0-9]/g, ''), 10) || 0;
  // 移行対象外（半額特例・トライアル・内部・グランドファザー価格）は手動判断
  const isManual = /2台目以降|トライアル|主プラン|F&F/.test(name);

  // フラグ集合（AutoMultiChannelは値型・ticket課金機能はサブスク移行の対象外なので除外）
  const flags = new Set();
  let mcValue = '';
  for (const col of featureCols) {
    const v = row[col];
    if (col === 'AutoMultiChannel') {
      if (v && v !== 'FALSE' && v !== 'TRUE') mcValue = v;
      continue;
    }
    if (v !== 'TRUE') continue;
    const f = featByKey[col];
    if (f && f.billing_type !== 'subscription') continue; // mCopy系ticket
    flags.add(col);
  }

  const mcSites = mcValue ? mcValue.split('/').map((s) => s.trim()).filter(Boolean) : [];

  // パッケージ組み合わせの総当たり（siteごとに「どれか1つ or なし」）。
  // 旧価格と新価格が一致する組み合わせを最優先し、同点はパッケージカバー数が多いものを採用。
  // パッケージに含まれるがプランに無いフラグは「移行で解放される機能(gains)」として許容し記録する。
  const sites = [...new Set(packages.map((p) => p.site))];
  const bySite = Object.fromEntries(sites.map((st) => [st, packages.filter((p) => p.site === st)]));
  const calcFor = (chosenPkgs) => {
    const covered = new Set();
    for (const p of chosenPkgs) for (const k of p.boolKeys) covered.add(k);
    const leftovers = [...flags].filter((k) => !covered.has(k) && featByKey[k]);
    const nFull = chosenPkgs.filter((p) => p.plan_type === 'full').length;
    const nSemi = chosenPkgs.filter((p) => p.plan_type === 'semi').length;
    const combo = chosenPkgs.length >= 2 ? 1500 * nFull + 480 * nSemi : 0;
    let base = chosenPkgs.reduce((sum, p) => sum + Number(p.monthly_price), 0) - combo;
    if (mcSites.length > 0) base += Number(featByKey['AutoMultiChannel'].monthly_price) + Math.max(0, mcSites.length - 2) * 1980;

    // leftoverの部分集合を総当たりし、旧価格に一致する「残す機能」の組を探す
    // （旧シートはバンドル行と単体行でフラグが食い違うため。落とす機能=lostFlagsとして報告）
    let bestSub = null; // { keep, lost, newPrice }
    // 探索は先頭12個まで（それ以降は常に残す。JSのビット演算は32bit折り返しのため上限必須）
    const searchN = Math.min(leftovers.length, 12);
    const alwaysKeep = leftovers.slice(searchN);
    let alwaysPrice = 0;
    for (const k of alwaysKeep) alwaysPrice += Number(featByKey[k].monthly_price);
    for (let mask = (1 << searchN) - 1; mask >= 0; mask--) {
      const keep = [...alwaysKeep];
      let priceSum = base + alwaysPrice;
      for (let b = 0; b < searchN; b++) {
        if (mask & (1 << b)) { keep.push(leftovers[b]); priceSum += Number(featByKey[leftovers[b]].monthly_price); }
      }
      const cand = { keep, lost: leftovers.filter((k) => !keep.includes(k)), newPrice: priceSum };
      const betterSub = (a, b2) => {
        if (!b2) return true;
        const am = a.newPrice === price, bm = b2.newPrice === price;
        if (am !== bm) return am;
        return a.lost.length < b2.lost.length;
      };
      if (betterSub(cand, bestSub)) bestSub = cand;
    }
    const features = [...bestSub.keep];
    if (mcSites.length > 0) features.push('AutoMultiChannel');
    const gains = chosenPkgs.flatMap((p) => [...p.boolKeys].filter((k) => !flags.has(k)));
    return { features, newPrice: bestSub.newPrice, lost: bestSub.lost, gains, coverage: covered.size };
  };
  let best = null;
  const enumerate = (idx, chosen) => {
    if (idx === sites.length) {
      const r = calcFor(chosen);
      const cand = { chosenPkgs: [...chosen], ...r };
      const better = (a, b) => {
        if (!b) return true;
        const am = a.newPrice === price, bm = b.newPrice === price;
        if (am !== bm) return am;
        if (a.lost.length !== b.lost.length) return a.lost.length < b.lost.length;
        if (a.gains.length !== b.gains.length) return a.gains.length < b.gains.length;
        return a.coverage > b.coverage;
      };
      if (better(cand, best)) best = cand;
      return;
    }
    enumerate(idx + 1, chosen); // このsiteはパッケージなし
    for (const p of bySite[sites[idx]]) {
      if (p.boolKeys.size === 0) continue;
      chosen.push(p);
      enumerate(idx + 1, chosen);
      chosen.pop();
    }
  };
  enumerate(0, []);

  const entry = {
    packages: best.chosenPkgs.map((p) => p.package_key),
    features: best.features,
    multiChannelSites: mcSites,
    legacyPrice: price,
    newPrice: best.newPrice,
    priceMatch: price === best.newPrice,
    flagCount: flags.size,
    ...(isManual ? { manual: true, manualReason: '半額特例/トライアル/内部/旧価格のため要個別判断' } : {}),
    ...(best.lost.length > 0 ? { lostFlags: best.lost } : {}),
    ...(best.gains.length > 0 ? { gains: best.gains } : {}),
  };
  mapping[name] = entry;
  report.push({ name, ...entry });
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(mapping, null, 2));

const auto = report.filter((r) => !r.manual);
const mismatch = auto.filter((r) => !r.priceMatch);
const lossy = auto.filter((r) => r.priceMatch && r.lostFlags);
console.log(`プラン数: ${report.length}（自動対象 ${auto.length} / 手動判断 ${report.length - auto.length}）`);
console.log(`自動対象の価格一致: ${auto.length - mismatch.length} / 不一致: ${mismatch.length} / 一致だが機能減あり: ${lossy.length}`);
if (lossy.length > 0) {
  console.log('\n── 価格一致・機能減あり（要レビュー: 移行でOFFになるフラグ） ──');
  for (const r of lossy) console.log(`  ${r.name}: lost=[${r.lostFlags.join(',')}] → ${r.packages.join('+')}${r.features.length ? ' / ' + r.features.join(',') : ''}`);
}
console.log(`出力: ${outFile}`);
if (mismatch.length > 0) {
  console.log('\n── 価格不一致（要レビュー） ──');
  for (const r of mismatch) {
    console.log(`  ${r.name}: 旧${r.legacyPrice}円 → 新${r.newPrice}円 [${r.packages.join('+') || 'pkgなし'}${r.features.length ? ' / ' + r.features.join(',') : ''}]`);
  }
}
