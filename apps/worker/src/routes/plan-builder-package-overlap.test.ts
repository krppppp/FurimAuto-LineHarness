import { describe, expect, it } from 'vitest';
import { sheetMasterRows, type MasterRow } from '../furim/__fixtures__/master-fixture.js';
import { buildItemsFromSelection, includedFeatureKeys, resolvePlanSelection } from './plan-builder.js';

// パッケージに含まれる機能が追加機能としても課金される二重課金（Capsec #334）。
// 2026-09-24 に中村航さんが 基本+再出品+商品削除 → 全自動化 へ変更したところ、m_full に含まれる
// mRelist・mDeleteProduct・mSoldCSV が別 item でも課金され 12,420 円/月になった（正しくは 8,980 円）。

function makeDb(rows: MasterRow[]) {
  const db = {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async first() { return null; },
        async all() {
          if (/FROM furim_master WHERE active = 1 AND kind IN \('feature', 'package'\)/.test(sql)) {
            return { results: rows.filter((r) => r.active === 1 && (r.kind === 'feature' || r.kind === 'package')).map((r) => ({ kind: r.kind, key: r.key, payload: r.payload })) };
          }
          return { results: [] };
        },
        async run() { return { meta: { changes: 1 } }; },
      };
    },
  };
  return db as unknown as D1Database;
}

const db = makeDb(sheetMasterRows());

describe('パッケージ包含の機能を追加機能から外す（Capsec #334）', () => {
  it('中村航さん型: 全自動化 + 再出品・商品削除・売上表CSV は 8,980 円（12,420 円にならない）', async () => {
    const sel = await resolvePlanSelection(db, { packages: ['m_full'], features: ['mRelist', 'mDeleteProduct', 'mSoldCSV'] });

    expect(sel.total).toBe(8980);
    expect(sel.excludedFeatureKeys).toEqual(['mRelist', 'mDeleteProduct', 'mSoldCSV']);
    expect(sel.feats).toEqual([]);
    // Stripe の明細もパッケージ 1 行だけ
    expect(buildItemsFromSelection(sel)).toHaveLength(1);
    // 選択内容サマリにも追加機能を出さない（お客様が二重に払うと誤解する）
    expect(sel.summaryLines.join('\n')).not.toContain('再出品');
  });

  it('あおいさん型: 半自動化 + チェックコントローラー は 5,980 円（6,960 円にならない）', async () => {
    const sel = await resolvePlanSelection(db, { packages: ['m_semi'], features: ['mAttributeCheckbox'] });

    expect(sel.total).toBe(5980);
    expect(sel.excludedFeatureKeys).toEqual(['mAttributeCheckbox']);
    expect(buildItemsFromSelection(sel)).toHaveLength(1);
  });

  it('パッケージに含まれない追加機能はそのまま課金する（半自動化 + 再出品 = 7,960 円）', async () => {
    const sel = await resolvePlanSelection(db, { packages: ['m_semi'], features: ['mRelist'] });

    expect(sel.total).toBe(5980 + 1980);
    expect(sel.excludedFeatureKeys).toEqual([]);
    expect(sel.feats.map((f) => f.feature_key)).toEqual(['mRelist']);
    expect(buildItemsFromSelection(sel)).toHaveLength(2);
  });

  it('プレミアムに含まれる機能も外す（巡回オプションは別課金なので残る）', async () => {
    const sel = await resolvePlanSelection(db, {
      packages: ['premium'],
      features: ['mRelist', 'InventorySheet', 'AutoMultiChannel'],
      multiChannelSites: ['メルカリ', 'ラクマ'],
    });

    expect(sel.excludedFeatureKeys).toEqual(['mRelist', 'InventorySheet']);
    expect(sel.feats.map((f) => f.feature_key)).toEqual(['AutoMultiChannel']);
  });

  it('包含の突き合わせは "=" の前で切る（trial の AutoMultiChannel=… を取りこぼさない）', () => {
    const keys = includedFeatureKeys([{ features: 'mRelist,AutoMultiChannel=メルカリ/ラクマ/Shops' }]);
    expect(keys.has('AutoMultiChannel')).toBe(true);
    expect(keys.has('AutoMultiChannel=メルカリ/ラクマ/Shops')).toBe(false);
  });

  it('パッケージ包含ぶんを外した結果、選択が空になるなら申し込ませない', async () => {
    await expect(resolvePlanSelection(db, { packages: [], features: [] })).rejects.toThrow('nothing selected');
  });
});
