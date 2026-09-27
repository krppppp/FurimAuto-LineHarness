#!/usr/bin/env node
// TB-137 パッケージに含まれる機能が別 item でも課金されていた 2 名を Stripe live で直す。
//
// 使い方（くろさんの端末で実行。鍵は画面入力・どこにも保存しない）:
//   node scripts/stripe-fix-duplicate-items.mjs            # 下読みだけ（既定）
//   node scripts/stripe-fix-duplicate-items.mjs --apply    # 実際に外す（APPLY と打つ確認あり）
//
// やること: 対象サブスクを読む → 現在の item と月額を表示 → 想定と一致したときだけ
// 重複 item を proration_behavior=none（日割りなし）で外し、metadata.features を直す → 読み直して結果を表示。
// 返金は対象外（2026-09-25 にくろさんが手動で実施済み）。

import { createInterface } from 'node:readline';

// 動作確認用にだけ 127.0.0.1 の偽サーバへ向けられる（それ以外の値は無視して本番へ送る）
const API = /^http:\/\/127\.0\.0\.1(:\d+)?\//.test(process.env.STRIPE_API_BASE ?? '')
  ? process.env.STRIPE_API_BASE.replace(/\/$/, '')
  : 'https://api.stripe.com/v1';

const TARGETS = [
  {
    label: '中村航さん',
    subscriptionId: 'sub_1NOIaAF2C7KcCkFfgwQUHq2t',
    customerId: 'cus_O645GI71VQLRoK',
    packagePriceId: 'price_1TquuPF2C7KcCkFflMqbM8ZU', // m_full メルカリ 全自動化プラン 8,980
    expectedBefore: 12420,
    expectedAfter: 8980,
    remove: [
      { key: 'mRelist', name: '再出品', priceId: 'price_1TqutYF2C7KcCkFfT4OJ4ItP', amount: 1980 },
      { key: 'mDeleteProduct', name: '商品削除', priceId: 'price_1TqutZF2C7KcCkFf505ObCor', amount: 980 },
      { key: 'mSoldCSV', name: '売上表CSV出力機能', priceId: 'price_1TqutbF2C7KcCkFfqivf7IPx', amount: 480 },
    ],
    featuresAfter: '',
  },
  {
    label: 'あおいさん',
    subscriptionId: 'sub_1UF5NbF2C7KcCkFf9FysLUR1',
    customerId: 'cus_VFaYEpApjKlGlO',
    packagePriceId: 'price_1TquuPF2C7KcCkFfVBOCqZCA', // m_semi メルカリ 半自動化プラン 5,980
    expectedBefore: 6960,
    expectedAfter: 5980,
    remove: [
      { key: 'mAttributeCheckbox', name: 'チェックコントローラー', priceId: 'price_1TqutZF2C7KcCkFfRskvdFtL', amount: 980 },
    ],
    featuresAfter: '',
  },
];

const apply = process.argv.includes('--apply');

function yen(n) {
  return `${n.toLocaleString('ja-JP')}円`;
}

function promptSecret(label) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('鍵の入力には TTY が必要です（ターミナルから直接実行してください）'));
      return;
    }
    process.stdout.write(label);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const done = (fn, arg) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      fn(arg);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(resolve, buf);
        if (ch === '\u0003') return done(reject, new Error('中止しました'));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function promptLine(label) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(label, (a) => { rl.close(); resolve(a.trim()); }));
}

function makeClient(key) {
  return async function call(method, path, params) {
    const init = { method, headers: { Authorization: `Bearer ${key}` } };
    if (params) {
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(params).toString();
    }
    const res = await fetch(`${API}${path}`, init);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.error?.message ?? `HTTP ${res.status}`;
      throw new Error(`${method} ${path} → ${res.status} ${msg}`);
    }
    return json;
  };
}

function itemLines(sub) {
  return (sub.items?.data ?? []).map((it) => ({
    id: it.id,
    priceId: it.price?.id ?? '',
    nickname: it.price?.nickname ?? it.price?.product ?? '',
    unit: it.price?.unit_amount ?? 0,
    quantity: it.quantity ?? 1,
    total: (it.price?.unit_amount ?? 0) * (it.quantity ?? 1),
  }));
}

function sum(lines) {
  return lines.reduce((t, l) => t + l.total, 0);
}

function showItems(lines) {
  for (const l of lines) {
    console.log(`    - ${l.id}  ${l.priceId}  ${l.nickname || '(名称なし)'}  ${yen(l.unit)} × ${l.quantity} = ${yen(l.total)}`);
  }
  console.log(`    合計 ${yen(sum(lines))}`);
}

// 読み取りだけで対象の現況を確かめ、外して良いかを判定する
function inspect(target, sub) {
  const lines = itemLines(sub);
  const before = sum(lines);
  const removePriceIds = new Set(target.remove.map((r) => r.priceId));
  const hits = lines.filter((l) => removePriceIds.has(l.priceId));
  const rest = lines.filter((l) => !removePriceIds.has(l.priceId));
  const after = sum(rest);
  const hasPackage = lines.some((l) => l.priceId === target.packagePriceId);
  const problems = [];

  if (sub.status !== 'active' && sub.status !== 'trialing') problems.push(`status が ${sub.status}（active/trialing 以外は触らない）`);
  if (sub.customer !== target.customerId) problems.push(`顧客が ${sub.customer}（想定 ${target.customerId}）`);
  if (!hasPackage) problems.push(`パッケージ item（${target.packagePriceId}）が見つからない`);
  if (hits.length === 0) problems.push('外す対象の item が無い（既に修正済みの可能性）');
  else if (hits.length !== target.remove.length) problems.push(`外す対象が ${hits.length} 件（想定 ${target.remove.length} 件）`);
  if (before !== target.expectedBefore) problems.push(`現在の月額が ${yen(before)}（想定 ${yen(target.expectedBefore)}）`);
  if (after !== target.expectedAfter) problems.push(`変更後の月額が ${yen(after)}（想定 ${yen(target.expectedAfter)}）`);
  if (rest.length === 0) problems.push('全 item が対象になっている（サブスクが空になる）');

  return { lines, hits, rest, before, after, problems };
}

async function main() {
  const key = (process.env.STRIPE_LIVE_RESTRICTED_KEY || await promptSecret('Stripe live の制限付きキー（画面には出ません）: ')).trim();
  if (!key) throw new Error('鍵が空です');
  if (key.includes('*')) throw new Error('伏字（*）が混ざっています。ダッシュボードで表示した実際の値を貼ってください');
  if (!/^(rk|sk)_live_/.test(key)) throw new Error('live の鍵ではありません（rk_live_ / sk_live_ で始まる値）');
  console.log(`鍵: ****${key.slice(-4)}（${apply ? '実行モード' : '下読みモード'}）\n`);

  const call = makeClient(key);
  const plans = [];

  for (const target of TARGETS) {
    console.log(`■ ${target.label}  ${target.subscriptionId}`);
    const sub = await call('GET', `/subscriptions/${target.subscriptionId}?expand[]=items.data.price`);
    const r = inspect(target, sub);
    console.log(`  現在（status=${sub.status} / metadata.features=${sub.metadata?.features ?? '(なし)'}）`);
    showItems(r.lines);
    if (r.problems.length > 0) {
      console.log('  → 触らない。理由:');
      for (const p of r.problems) console.log(`    ! ${p}`);
      console.log('');
      continue;
    }
    console.log('  外す item:');
    for (const h of r.hits) {
      const spec = target.remove.find((x) => x.priceId === h.priceId);
      console.log(`    - ${spec.name}（${spec.key}） ${h.id} ${yen(h.total)}`);
    }
    console.log(`  月額 ${yen(r.before)} → ${yen(r.after)}（日割りなし・即時請求は立たない）`);
    console.log(`  metadata.features: ${sub.metadata?.features ?? '(なし)'} → ${target.featuresAfter || '(空)'}`);
    console.log('');
    plans.push({ target, ...r });
  }

  if (plans.length === 0) {
    console.log('実行できる対象がありません。');
    return;
  }
  if (!apply) {
    console.log('下読みのみ。実行するには --apply を付けて再実行してください。');
    return;
  }

  console.log('この内容で Stripe live を変更します。会員の請求額が下がります。');
  const ans = await promptLine('実行するなら APPLY と入力: ');
  if (ans !== 'APPLY') {
    console.log('中止しました。何も変更していません。');
    return;
  }

  for (const plan of plans) {
    const { target } = plan;
    console.log(`\n■ ${target.label} 実行`);
    for (const h of plan.hits) {
      await call('DELETE', `/subscription_items/${h.id}`, { proration_behavior: 'none' });
      console.log(`  外した: ${h.id} ${h.priceId}`);
    }
    await call('POST', `/subscriptions/${target.subscriptionId}`, { 'metadata[features]': target.featuresAfter });
    console.log(`  metadata.features を「${target.featuresAfter || '(空)'}」にした`);

    const after = await call('GET', `/subscriptions/${target.subscriptionId}?expand[]=items.data.price`);
    const lines = itemLines(after);
    console.log('  変更後の item:');
    showItems(lines);
    console.log(`  metadata.features=${after.metadata?.features ?? '(なし)'} / status=${after.status}`);
    if (sum(lines) !== target.expectedAfter) console.log(`  ! 合計が想定（${yen(target.expectedAfter)}）と違う。要確認`);

    try {
      const upcoming = await call('GET', `/invoices/upcoming?subscription=${target.subscriptionId}`);
      const at = upcoming.next_payment_attempt ?? upcoming.period_end;
      console.log(`  次回請求: ${yen(upcoming.total ?? 0)}（${at ? new Date(at * 1000).toISOString().slice(0, 10) : '日付不明'}）`);
    } catch (e) {
      console.log(`  次回請求のプレビューは取れず（権限不足の可能性）: ${e.message}`);
    }
  }

  console.log('\n完了。この結果を TB-137 に記録してください（D1 の subscription_price / features / plan_label の直しは別途）。');
}

main().catch((e) => {
  console.error(`\nエラー: ${e.message}`);
  process.exit(1);
});
