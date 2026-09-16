import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { masterFixture, sheetMasterRows, type MasterRow } from './__fixtures__/master-fixture.js';
import { buildMasterRecord, getMasterKind, masterValuesOf } from './master-schema.js';
import { applyPlanBuilderSync, buildPlanLabel, computeFeatureFlags, expandFeatureSet, loadFurimMaster } from './feature-flags.js';
import { buildLegacyCheckoutUrl, loadPlanPayload, planFeaturesToFlags } from './legacy-keywords.js';
import { planBuilder, resolvePlanSelection, buildItemsFromSelection } from '../routes/plan-builder.js';

const AFTER_PROMO = Date.parse('2026-10-01T00:00:00+09:00');

// 料金シミュレーターが読む /plan-builder/features は sort_order 順で返す（Capsec #271）。
// シート（GAS getFeatureMaster）の並びは sort_order 順とは限らない（470・480 が重複していて、
// 在庫管理シートがヤフフリの機能の後ろに置かれている）ので、期待値もここで並べ替える。
const sortOrderOf = (row: unknown): number => Number((row as { sort_order?: number | string }).sort_order ?? 0);
const bySortOrder = <T>(items: T[]): T[] => [...items].sort((a, b) => sortOrderOf(a) - sortOrderOf(b));

type Write = { sql: string; args: unknown[] };

function makeDb(rows: MasterRow[], customer: Record<string, unknown> | null = null) {
  const writes: Write[] = [];
  const read = (sql: string, args: unknown[]) => ({
    first: async () => {
      if (/FROM furim_master WHERE kind = 'plan' AND key = \?/.test(sql)) {
        const r = rows.find((x) => x.kind === 'plan' && x.key === args[0]);
        return r ? { payload: r.payload } : null;
      }
      if (/FROM furim_customers WHERE line_user_id/.test(sql)) return customer;
      return null;
    },
    all: async () => {
      if (/FROM furim_master WHERE active = 1 AND kind IN \('feature', 'package'\)/.test(sql)) {
        return { results: rows.filter((r) => r.active === 1 && (r.kind === 'feature' || r.kind === 'package')).map((r) => ({ kind: r.kind, key: r.key, payload: r.payload })) };
      }
      return { results: [] };
    },
    run: async () => {
      writes.push({ sql, args });
      return { meta: { changes: 1 } };
    },
  });
  const db = {
    prepare(sql: string) {
      return { ...read(sql, []), bind: (...args: unknown[]) => ({ ...read(sql, args), sql, args }) };
    },
    batch: async (stmts: Write[]) => {
      writes.push(...stmts);
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  } as unknown as D1Database;
  return { db, writes };
}

const featureKeys = new Set(masterFixture.features.map((f) => String(f.feature_key)));
const ORPHAN_PACKAGE_FEATURE_KEYS = ['rBackup'];

function viaAdmin(rows: MasterRow[], resave: boolean): MasterRow[] {
  return rows.map((row) => {
    const def = getMasterKind(row.kind)!;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const ctx = { featureKeys: resave ? featureKeys : new Set([...featureKeys, ...ORPHAN_PACKAGE_FEATURE_KEYS]) };
    const { record, errors } = buildMasterRecord(def, masterValuesOf(def, payload), ctx, resave ? payload : undefined);
    expect(errors, `${row.kind}/${row.key}`).toEqual([]);
    return { ...row, display_name: record!.display_name, stripe_price_id: record!.stripe_price_id, monthly_price: record!.monthly_price, active: record!.active, payload: JSON.stringify(record!.payload) };
  });
}

const sheet = sheetMasterRows();
const resaved = viaAdmin(sheet, true);
const fresh = viaAdmin(sheet, false);
const variants: Array<[string, MasterRow[]]> = [['シート取り込み', sheet], ['管理画面で保存し直し', resaved], ['管理画面で新規入力', fresh]];

describe('#264 切り替え前後で結果が同じ', () => {
  it('本番のマスタ（2026-09-14 のシート値）は全行が管理画面の型チェックを通り、保存し直すと payload と列が文字列まで同じ', () => {
    expect(sheet.map((r) => r.kind).filter((k, i, a) => a.indexOf(k) === i)).toEqual(['feature', 'package', 'plan', 'ticket_price']);
    expect(resaved).toEqual(sheet);
  });

  it('本番のパッケージ r_full・premium・trial には機能マスタに無い rBackup が入っている。保存し直しは通り、新しく足す未知のキーは 400 の対象', () => {
    const rFull = masterFixture.packages.find((p) => p.package_key === 'r_full')!;
    expect(String(rFull.features).split(',')).toContain('rBackup');
    expect(masterFixture.packages.filter((p) => String(p.features).split(',').includes('rBackup')).map((p) => p.package_key)).toEqual(['r_full', 'premium', 'trial']);
    expect(featureKeys.has('rBackup')).toBe(false);
    const def = getMasterKind('package')!;
    const values = masterValuesOf(def, rFull);
    expect(buildMasterRecord(def, values, { featureKeys }, rFull).errors).toEqual([]);
    const m = masterFixture.packages.find((p) => p.package_key === 'm_full')!;
    expect(buildMasterRecord(def, { ...masterValuesOf(def, m), features: [...(masterValuesOf(def, m).features as string[]), 'rBackup'] }, { featureKeys }, m).errors).toEqual(['含む機能 に機能マスタに無いキーがあります: rBackup']);
  });

  it('管理画面で新規入力した行も、列（表示名・価格 ID・月額・有効）はシート取り込みと同じ', () => {
    expect(fresh.map(({ payload: _p, ...rest }) => rest)).toEqual(sheet.map(({ payload: _p, ...rest }) => rest));
  });

  it('料金シミュレーターの /plan-builder/features は、GAS getFeatureMaster の応答と同じ（シート取り込み値・保存し直し）。並びは sort_order 順', async () => {
    for (const rows of [sheet, resaved]) {
      const res = await planBuilder.request('/plan-builder/features', {}, { DB: makeDb(rows).db });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, features: bySortOrder(masterFixture.features), packages: masterFixture.packages });
    }
  });

  it('新規入力の行でも、料金シミュレーターが読む値（数値は Number・有効は真偽）は同じ', async () => {
    const norm = (items: Array<Record<string, unknown>>) =>
      items.map((o) =>
        Object.fromEntries(
          Object.entries(o).map(([k, v]) => [k, k === 'active' ? String(v).toUpperCase() === 'TRUE' : ['monthly_price', 'combo_discount', 'sort_order'].includes(k) && v !== '' ? Number(v) : v]),
        ),
      );
    const res = await planBuilder.request('/plan-builder/features', {}, { DB: makeDb(fresh).db });
    const body = (await res.json()) as { features: Array<Record<string, unknown>>; packages: Array<Record<string, unknown>> };
    expect(norm(body.features)).toEqual(norm(bySortOrder(masterFixture.features)));
    expect(norm(body.packages)).toEqual(norm(masterFixture.packages));
  });

  it.each([
    [{ packages: ['m_full'] }, { subtotal: 8980, comboAmount: 0, total: 8980 }],
    [{ packages: ['m_full', 'r_full'] }, { subtotal: 16960, comboAmount: 3000, total: 13960 }],
    [{ packages: ['m_semi', 'yf_semi'] }, { subtotal: 10460, comboAmount: 960, total: 9500 }],
    [{ features: ['mChangePrice', 'rChangePrice'] }, { subtotal: 3960, comboAmount: 0, total: 3960 }],
    [{ features: ['InventorySheet', 'AutoMultiChannel'], multiChannelSites: ['メルカリ', 'ラクマ', 'Shops'] }, { subtotal: 5960, comboAmount: 0, total: 5960 }],
    [{ packages: ['premium'], features: ['AutoMultiChannel'], multiChannelSites: ['メルカリ', 'ヤフフリ'] }, { subtotal: 22780, comboAmount: 0, total: 22780 }],
  ])('申し込み・プラン変更の金額と Stripe の明細が同じ: %j', async (sel, expected) => {
    const results = [];
    for (const [, rows] of variants) {
      const r = await resolvePlanSelection(makeDb(rows).db, sel);
      results.push({ subtotal: r.subtotal, comboAmount: r.comboAmount, total: r.total, summaryLines: r.summaryLines, items: buildItemsFromSelection(r) });
    }
    expect(results[0]).toMatchObject(expected);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it.each([
    [{ packages: 'm_full', features: '', multiChannelSites: '' }],
    [{ packages: 'premium', features: 'AutoMultiChannel', multiChannelSites: 'メルカリ/ラクマ' }],
    [{ packages: 'r_semi,yf_full', features: 'mChangePrice', multiChannelSites: '' }],
    [{ packages: '', features: 'msChangePrice,InventorySheet', multiChannelSites: '' }],
    [{ packages: 'trial', features: '', multiChannelSites: '' }],
  ])('機能フラグの再計算・プラン名が同じ: %j', async (sel) => {
    const out = [];
    for (const [, rows] of variants) {
      const master = await loadFurimMaster(makeDb(rows).db);
      out.push({ set: expandFeatureSet(master, sel), flags: computeFeatureFlags(master, [], sel, { nowMs: AFTER_PROMO }), label: buildPlanLabel(master, sel) });
    }
    expect(Object.keys(out[0].flags).sort()).toEqual([...new Set([...featureKeys, ...Object.keys(out[0].set)])].sort());
    expect(out[1]).toEqual(out[0]);
    expect(out[2]).toEqual(out[0]);
  });

  it('決済時の適用（applyPlanBuilderSync）の結果と D1 への書き込みが同じ（固定値つき）', async () => {
    const customer = { line_user_id: 'U1', key_code: 'pb_fixed00', packages: 'm_full', features: '', multi_channel_sites: '' };
    const out = [];
    for (const [, rows] of variants) {
      const { db, writes } = makeDb(rows, customer);
      const r = await applyPlanBuilderSync(db, undefined, { lineUserId: 'U1', packages: 'm_full', features: '', multiChannelSites: '', nowMs: AFTER_PROMO });
      out.push({ r, writes: writes.map((w) => ({ sql: w.sql, args: w.args.map((a) => (typeof a === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(a) ? '<now>' : a)) })) });
    }
    expect(out[0].r).toMatchObject({ keyCode: 'pb_fixed00', keyCodeIssued: false, planLabel: 'PBプラン:メルカリ 全自動化プラン' });
    expect(out[0].r.flags).toMatchObject({ mChangePrice: '1', mAuction: '1', rChangePrice: '0', mCopyRakumaListing: '1', InventorySheet: '0', AutoMultiChannel: '' });
    expect(out[1]).toEqual(out[0]);
    expect(out[2]).toEqual(out[0]);
  });

  it('旧プランのキーワード（登録URL発行・無料お試し）が読むプラン一覧の値が同じ', async () => {
    const out = [];
    for (const [, rows] of variants) {
      const { db } = makeDb(rows);
      const trial = await loadPlanPayload(db, '友達登録2週間トライアルプラン');
      out.push({
        flags: planFeaturesToFlags(trial?.features, AFTER_PROMO),
        url: await buildLegacyCheckoutUrl(db, { liffUrl: 'https://liff.line.me/x', isDev: false, lineUserId: 'U1', planName: 'F&Fメルカリ全機能2980円プラン', stripeCustomerId: 'cus_1', nowMs: AFTER_PROMO }),
      });
    }
    expect(out[0].url).toContain('price_id=price_1NBYgPF2C7KcCkFfri2QLYbH');
    expect(out[1]).toEqual(out[0]);
    expect(out[2]).toEqual(out[0]);
  });
});

describe('#264 シートからの取り込みを止めた', () => {
  const srcDir = join(__dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !p.includes('__fixtures__')) files.push(p);
    }
  };
  walk(srcDir);

  it('Worker のコードに GAS getFeatureMaster の呼び出しと 6h cron の取り込みが無い', () => {
    const hits = files.filter((p) => /getFeatureMaster|refreshFurimMaster|refresh-master|ensureFurimMaster/.test(readFileSync(p, 'utf8')));
    expect(hits).toEqual([]);
    const plan = readFileSync(join(srcDir, 'routes/plan-builder.ts'), 'utf8');
    expect(plan).not.toMatch(/gasGet|caches\.default/);
  });

  it('シート取り込み（backfill-sheets）の対象にプラン一覧・チケット単価一覧が無い', async () => {
    const { SHEET_BACKFILL_SPECS } = await import('./sheet-backfill.js');
    expect(SHEET_BACKFILL_SPECS.map((s) => s.table)).not.toContain('furim_master');
  });
});
