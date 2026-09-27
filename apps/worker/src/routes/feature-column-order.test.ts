import { describe, it, expect } from 'vitest';
import { FEATURE_FLAG_ORDER, FEATURE_FLAG_PREFIX } from '../furim/admin-schema.js';
import { loadFeatureColumns } from './furim-admin.js';

function makeDb(keys: string[]) {
  return {
    prepare() {
      const stmt = {
        bind: () => stmt,
        all: async () => ({ results: keys.map((key) => ({ key, display_name: key, payload: '{"site":"mercari"}' })) }),
      };
      return stmt;
    },
  } as unknown as D1Database;
}

describe('FEATURE_FLAG_ORDER（顧客の機能一覧の並び・TB-413）', () => {
  it('メルカリ下書き予約出品はメルカリ群の最後（コピー出品ヤフフリの次・メルカリShops の前）', () => {
    const i = FEATURE_FLAG_ORDER.indexOf('mDraftScheduledListing');
    expect(i).toBeGreaterThan(-1);
    expect(FEATURE_FLAG_ORDER[i - 1]).toBe('mCopyYahooFleamarketListing');
    expect(FEATURE_FLAG_ORDER[i + 1]).toBe('msChangePrice');
  });

  it('マスタの rowid が最後でも loadFeatureColumns はメルカリ群の最後に並べる', async () => {
    const columns = await loadFeatureColumns(makeDb(['mChangePrice', 'mCopyYahooFleamarketListing', 'msChangePrice', 'mDraftScheduledListing']));
    expect(columns.map((c) => c.name)).toEqual(
      ['mChangePrice', 'mCopyYahooFleamarketListing', 'mDraftScheduledListing', 'msChangePrice'].map((k) => `${FEATURE_FLAG_PREFIX}${k}`),
    );
  });
});
