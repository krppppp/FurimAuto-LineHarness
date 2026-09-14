import { describe, it, expect, vi, beforeEach } from 'vitest';

const gasGet = vi.fn();
vi.mock('./gas-client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gasGet,
  gasPost: vi.fn(),
}));

const {
  expandFeatureSet,
  computeFeatureFlags,
  buildPlanLabel,
  decidePlanBuilderKeyCode,
  refreshFurimMaster,
  applyPlanBuilderSync,
  INVENTORY_PATROL_ALL_SITES,
} = await import('./feature-flags.js');

const master = {
  features: [
    { feature_key: 'mChangePrice', site: 'mercari', display_name: '値段変更', billing_type: 'subscription' },
    { feature_key: 'rChangePrice', site: 'rakuma', display_name: '値段変更', billing_type: 'subscription' },
    { feature_key: 'AutoMultiChannel', site: '', display_name: '自動併売', billing_type: 'subscription' },
    { feature_key: 'InventorySheet', site: '', display_name: '在庫管理シート', billing_type: 'subscription' },
    { feature_key: 'mCopyRakumaListing', site: 'mercari', display_name: 'コピー出品', billing_type: 'ticket' },
  ],
  packages: [
    { package_key: 'm_full', display_name: 'メルカリ 全自動化プラン', features: 'mChangePrice,mRelist,mAutoComment' },
    { package_key: 'premium', display_name: '全フリマ全機能解放プレミアムプラン', features: 'mChangePrice,rChangePrice,AutoMultiChannel,InventorySheet' },
  ],
};

// 在庫管理シート無料プロモ（〜2026-09-15）を跨がない時刻
const AFTER_PROMO = Date.parse('2026-10-01T00:00:00+09:00');
const DURING_PROMO = Date.parse('2026-09-14T12:00:00+09:00');

type Write = { sql: string; args: unknown[] };

/** SQL でルーティングする簡易 D1。batch も run 相当で記録する */
function makeDb(opts: { customer?: Record<string, unknown> | null; masterRows?: Array<{ kind: string; key: string; payload: string }>; flagKeys?: string[]; lockedFlags?: Record<string, string> } = {}) {
  const writes: Write[] = [];
  const db = {
    prepare(sql: string) {
      const make = (args: unknown[]) => ({
        run: async () => { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
        first: async () => {
          if (/FROM furim_customers WHERE line_user_id/.test(sql)) return opts.customer === undefined ? null : opts.customer;
          if (/SELECT copy_tickets FROM furim_customers/.test(sql)) return { copy_tickets: 200 };
          return null;
        },
        all: async () => {
          if (/FROM furim_master/.test(sql)) return { results: opts.masterRows ?? [] };
          if (/SELECT feature_key, value, locked FROM furim_feature_flags/.test(sql)) {
            return {
              results: [
                ...(opts.flagKeys ?? []).map((k) => ({ feature_key: k, value: '1', locked: 0 })),
                ...Object.entries(opts.lockedFlags ?? {}).map(([k, v]) => ({ feature_key: k, value: v, locked: 1 })),
              ],
            };
          }
          return { results: [] };
        },
        sql,
        args,
      });
      return { bind: (...args: unknown[]) => make(args), ...make([]) };
    },
    async batch(stmts: Array<{ sql: string; args: unknown[]; run: () => Promise<unknown> }>) {
      const out = [];
      for (const s of stmts) { writes.push({ sql: s.sql, args: s.args }); out.push({ meta: { changes: 1 } }); }
      return out;
    },
  } as unknown as D1Database;
  return { db, writes };
}

const masterRows = [
  ...master.features.map((f) => ({ kind: 'feature', key: f.feature_key, payload: JSON.stringify(f) })),
  ...master.packages.map((p) => ({ kind: 'package', key: p.package_key, payload: JSON.stringify(p) })),
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('expandFeatureSet', () => {
  it('パッケージはマスタの features で展開し、AutoMultiChannel は巡回サイト文字列になる', () => {
    const set = expandFeatureSet(master, { packages: 'm_full', features: 'AutoMultiChannel,rChangePrice', multiChannelSites: 'メルカリ/ラクマ' });
    expect(set).toEqual({ AutoMultiChannel: 'メルカリ/ラクマ', rChangePrice: true, mChangePrice: true, mRelist: true, mAutoComment: true });
  });

  it('不明なパッケージは投げる', () => {
    expect(() => expandFeatureSet(master, { packages: 'nope', features: '', multiChannelSites: '' })).toThrow(/不明なパッケージ/);
  });
});

describe('computeFeatureFlags', () => {
  it('契約に含まれる機能は 1・それ以外は 0・コピー出品は常に 1・未購入の AutoMultiChannel は空文字', () => {
    const flags = computeFeatureFlags(master, ['mRelist', 'yfRelist'], { packages: 'm_full', features: '', multiChannelSites: '' }, { nowMs: AFTER_PROMO });
    expect(flags).toMatchObject({ mChangePrice: '1', mRelist: '1', mAutoComment: '1', rChangePrice: '0', yfRelist: '0', mCopyRakumaListing: '1', InventorySheet: '0', AutoMultiChannel: '' });
    expect(flags.mCopyMShopsListing).toBe('1');
  });

  it('プロモ期間中は在庫管理シートと全サイト巡回を付与する（GAS と同値・9/15 まで）', () => {
    const flags = computeFeatureFlags(master, [], { packages: 'm_full', features: '', multiChannelSites: '' }, { nowMs: DURING_PROMO });
    expect(flags.InventorySheet).toBe('1');
    expect(flags.AutoMultiChannel).toBe(INVENTORY_PATROL_ALL_SITES);
  });

  it('解約（clearAll）はコピー出品だけ残して全 OFF。プロモ中でも付与しない', () => {
    const flags = computeFeatureFlags(master, ['mRelist'], { packages: 'premium', features: '', multiChannelSites: 'メルカリ' }, { clearAll: true, nowMs: DURING_PROMO });
    expect(flags).toMatchObject({ mChangePrice: '0', rChangePrice: '0', mRelist: '0', InventorySheet: '0', AutoMultiChannel: '', mCopyRakumaListing: '1' });
  });
});

describe('buildPlanLabel', () => {
  it('パッケージ名＋サイト名前置の機能名を + で繋ぎ、AutoMultiChannel は巡回サイトを括弧で付ける', () => {
    expect(buildPlanLabel(master, { packages: 'm_full', features: 'rChangePrice,AutoMultiChannel', multiChannelSites: 'メルカリ/ラクマ' })).toBe('PBプラン:メルカリ 全自動化プラン+ラクマ値段変更+自動併売(メルカリ/ラクマ)');
    expect(buildPlanLabel(master, { packages: 'm_full', features: 'rChangePrice', multiChannelSites: '' }, false)).toBe('PBプラン:メルカリ 全自動化プラン+値段変更');
  });

  it('何も無ければ空文字', () => {
    expect(buildPlanLabel(master, { packages: '', features: '', multiChannelSites: '' })).toBe('');
  });
});

describe('decidePlanBuilderKeyCode（集合比較・#238）', () => {
  const sel = { packages: 'm_full', features: 'rChangePrice', multiChannelSites: '' };
  const gen = () => 'pb_generated';

  it('未発行は新規発行', () => {
    expect(decidePlanBuilderKeyCode(null, sel, { generate: gen })).toMatchObject({ keyCode: 'pb_generated', issued: true, reissued: false, reason: 'new' });
  });

  it('trial コードのまま有料 PB → 再発行', () => {
    const c = { key_code: '2weektrial_abc', packages: null, features: null, multi_channel_sites: null };
    expect(decidePlanBuilderKeyCode(c, sel, { generate: gen })).toMatchObject({ issued: true, reissued: true, reason: 'trial' });
  });

  it('pb_ でも trial でもない旧接頭語 → 一度だけ再発行', () => {
    const c = { key_code: 'm398_abcd', packages: null, features: null, multi_channel_sites: null };
    expect(decidePlanBuilderKeyCode(c, sel, { generate: gen })).toMatchObject({ reissued: true, reason: 'legacy' });
  });

  it('D1 に集合が無い pb_ 顧客は記録だけ（ラベルの形式差で再発行しない）', () => {
    const c = { key_code: 'pb_keep1234', packages: null, features: null, multi_channel_sites: null };
    expect(decidePlanBuilderKeyCode(c, sel, { generate: gen })).toEqual({ keyCode: 'pb_keep1234', issued: false, reissued: false, reason: 'none' });
  });

  it('集合が同じ（順序違い・空要素）なら更新課金でもそのまま', () => {
    const c = { key_code: 'pb_keep1234', packages: 'm_full', features: 'rChangePrice', multi_channel_sites: '' };
    expect(decidePlanBuilderKeyCode(c, { packages: 'm_full,', features: ' rChangePrice ', multiChannelSites: '' }, { generate: gen }).reason).toBe('none');
    const c2 = { key_code: 'pb_keep1234', packages: 'm_full', features: 'rChangePrice,AutoMultiChannel', multi_channel_sites: 'ラクマ/メルカリ' };
    expect(decidePlanBuilderKeyCode(c2, { packages: 'm_full', features: 'AutoMultiChannel,rChangePrice', multiChannelSites: 'メルカリ/ラクマ' }, { generate: gen }).reason).toBe('none');
  });

  it('集合が変わればプラン変更として再発行', () => {
    const c = { key_code: 'pb_keep1234', packages: 'm_full', features: '', multi_channel_sites: '' };
    expect(decidePlanBuilderKeyCode(c, sel, { generate: gen })).toMatchObject({ keyCode: 'pb_generated', reissued: true, reason: 'plan_change' });
  });

  it('解約（clearAll）は触らない', () => {
    const c = { key_code: '2weektrial_abc', packages: 'm_full', features: '', multi_channel_sites: '' };
    expect(decidePlanBuilderKeyCode(c, sel, { clearAll: true, generate: gen })).toMatchObject({ keyCode: '2weektrial_abc', issued: false });
  });
});

describe('refreshFurimMaster', () => {
  it('GAS getFeatureMaster の行を furim_master に upsert し、無くなったキーは active=0 にする', async () => {
    gasGet.mockResolvedValueOnce({ success: true, features: master.features, packages: master.packages });
    const { db, writes } = makeDb();
    const r = await refreshFurimMaster(db, 'dep-1');
    expect(r).toEqual({ features: 5, packages: 2 });
    const upserts = writes.filter((w) => /INSERT INTO furim_master/.test(w.sql));
    expect(upserts).toHaveLength(7);
    expect(upserts[0].args.slice(0, 3)).toEqual(['feature', 'mChangePrice', '値段変更']);
    const deact = writes.filter((w) => /SET active = 0/.test(w.sql));
    expect(deact).toHaveLength(2);
    expect(deact[0].args).toEqual(['feature', 'mChangePrice', 'rChangePrice', 'AutoMultiChannel', 'InventorySheet', 'mCopyRakumaListing']);
  });

  it('GAS が失敗を返したら投げる', async () => {
    gasGet.mockResolvedValueOnce({ success: false, error: 'シートなし' });
    const { db } = makeDb();
    await expect(refreshFurimMaster(db, 'dep-1')).rejects.toThrow(/getFeatureMaster failed/);
  });
});

describe('applyPlanBuilderSync', () => {
  it('trial → PB 初回: pb_ を新規発行し端末判定をクリア、フラグ・集合・プラン名を書き、プレミアムは台帳 +200', async () => {
    const { db, writes } = makeDb({
      customer: { line_user_id: 'U1', key_code: '2weektrial_abc', packages: null, features: null, multi_channel_sites: null },
      masterRows,
      flagKeys: ['mRelist'],
    });
    const r = await applyPlanBuilderSync(db, undefined, undefined, {
      lineUserId: 'U1', stripeCustomerId: 'cus_1', packages: 'premium', features: '', multiChannelSites: 'メルカリ/ラクマ', subscriptionId: 'sub_1',
      grantPremiumTickets: true, invoiceId: 'in_1', nowMs: AFTER_PROMO,
    });
    expect(r.keyCode).toMatch(/^pb_[0-9a-z]{8}$/);
    expect(r.keyCodeIssued).toBe(true);
    expect(r.planLabel).toBe('PBプラン:全フリマ全機能解放プレミアムプラン');
    expect(r.flags).toMatchObject({ mChangePrice: '1', rChangePrice: '1', InventorySheet: '1', AutoMultiChannel: 'メルカリ/ラクマ', mRelist: '0', mCopyRakumaListing: '1' });
    expect(r.ticketsGranted).toBe(200);
    const upsert = writes.find((w) => /INSERT INTO furim_customers/.test(w.sql));
    expect(upsert?.sql).toMatch(/key_code = excluded.key_code/);
    expect(upsert?.sql).toMatch(/device_code = excluded.device_code/);
    expect(upsert?.args).toContain('premium');
    expect(writes.filter((w) => /INSERT INTO furim_feature_flags/.test(w.sql)).length).toBe(Object.keys(r.flags).length);
    const ledger = writes.find((w) => /INSERT OR IGNORE INTO furim_ticket_ledger/.test(w.sql));
    expect(ledger?.args).toContain('premium_monthly:in_1');
    expect(ledger?.sql).not.toMatch(/invoice_id/);
    expect(ledger?.args).not.toContain('in_1');
  });

  it('同一内容の更新課金はキーコード不変・端末判定も触らない', async () => {
    const { db, writes } = makeDb({
      customer: { line_user_id: 'U1', key_code: 'pb_keep1234', packages: 'm_full', features: '', multi_channel_sites: '' },
      masterRows,
    });
    const r = await applyPlanBuilderSync(db, undefined, undefined, { lineUserId: 'U1', packages: 'm_full', features: '', multiChannelSites: '' });
    expect(r).toMatchObject({ keyCode: 'pb_keep1234', keyCodeIssued: false, ticketsGranted: 0 });
    const upsert = writes.find((w) => /INSERT INTO furim_customers/.test(w.sql));
    expect(upsert?.sql).not.toMatch(/device_code/);
    expect(upsert?.sql).not.toMatch(/key_code = excluded/);
  });

  it('解約（clearAll）は集合を消してフラグを全 OFF にし、キーコードは触らない', async () => {
    const { db, writes } = makeDb({ customer: { line_user_id: 'U1', key_code: null, packages: 'm_full', features: '', multi_channel_sites: '' }, masterRows });
    const r = await applyPlanBuilderSync(db, undefined, undefined, { lineUserId: 'U1', packages: '', features: '', multiChannelSites: '', clearAll: true });
    expect(r.planLabel).toBe('');
    expect(r.flags).toMatchObject({ mChangePrice: '0', mCopyRakumaListing: '1', AutoMultiChannel: '' });
    const upsert = writes.find((w) => /INSERT INTO furim_customers/.test(w.sql));
    expect(upsert?.args.slice(1, 4)).toEqual([null, null, null]);
  });

  it('#261 案 A: 固定した機能は再計算でも解約でも書かず、返す flags（GAS へ渡す値）は固定値。固定していない機能は従来どおり上書き', async () => {
    const customer = { line_user_id: 'U1', key_code: 'pb_keep1234', packages: 'm_full', features: '', multi_channel_sites: '' };
    const locked = { mBackup: '1', mChangePrice: '0', AutoMultiChannel: 'ヤフフリ' };
    for (const clearAll of [false, true]) {
      const { db, writes } = makeDb({ customer, masterRows, lockedFlags: locked });
      const r = await applyPlanBuilderSync(db, undefined, undefined, { lineUserId: 'U1', packages: clearAll ? '' : 'm_full', features: '', multiChannelSites: '', clearAll, nowMs: AFTER_PROMO });
      const flagWrites = writes.filter((w) => /INSERT INTO furim_feature_flags/.test(w.sql));
      const writtenKeys = flagWrites.map((w) => w.args[1]);
      for (const k of Object.keys(locked)) expect(writtenKeys, `${clearAll} ${k}`).not.toContain(k);
      expect(r.flags).toMatchObject(locked);
      expect(flagWrites.length).toBe(Object.keys(r.flags).length - Object.keys(locked).length);
      expect(flagWrites.every((w) => w.args[3] === (clearAll ? 'clear' : 'plan'))).toBe(true);
      expect(writtenKeys).toContain('rChangePrice');
    }
  });

  it('#261 案 A: 固定を外した後（locked=0・手動値 1 が残っている）の再計算は契約どおり 0 に戻す', async () => {
    const customer = { line_user_id: 'U1', key_code: 'pb_keep1234', packages: 'm_full', features: '', multi_channel_sites: '' };
    const { db, writes } = makeDb({ customer, masterRows, flagKeys: ['mBackup'] });
    const r = await applyPlanBuilderSync(db, undefined, undefined, { lineUserId: 'U1', packages: 'm_full', features: '', multiChannelSites: '', nowMs: AFTER_PROMO });
    const mBackup = writes.find((w) => /INSERT INTO furim_feature_flags/.test(w.sql) && w.args[1] === 'mBackup');
    expect(mBackup?.args[2]).toBe(r.flags.mBackup);
    expect(r.flags.mBackup).toBe('0');
    expect(mBackup?.args[3]).toBe('plan');
  });

  it('#261 案 A: 在庫管理シートのプロモ中の付与は、固定していなければ従来どおり', async () => {
    const customer = { line_user_id: 'U1', key_code: 'pb_keep1234', packages: 'm_full', features: '', multi_channel_sites: '' };
    const plain = await applyPlanBuilderSync(makeDb({ customer, masterRows }).db, undefined, undefined, { lineUserId: 'U1', packages: 'm_full', features: '', multiChannelSites: '', nowMs: DURING_PROMO });
    const { db, writes } = makeDb({ customer, masterRows, lockedFlags: { mBackup: '1' } });
    const r = await applyPlanBuilderSync(db, undefined, undefined, { lineUserId: 'U1', packages: 'm_full', features: '', multiChannelSites: '', nowMs: DURING_PROMO });
    expect(r.flags.InventorySheet).toBe(plain.flags.InventorySheet);
    expect(r.flags.AutoMultiChannel).toBe(plain.flags.AutoMultiChannel);
    const inv = writes.find((w) => /INSERT INTO furim_feature_flags/.test(w.sql) && w.args[1] === 'InventorySheet');
    expect(inv?.args[2]).toBe(plain.flags.InventorySheet);
  });

  it('マスタが空でパッケージ指定があれば投げる（呼び出し側が GAS 判定にフォールバック）', async () => {
    const { db } = makeDb({ customer: null, masterRows: [] });
    await expect(applyPlanBuilderSync(db, undefined, undefined, { lineUserId: 'U1', packages: 'm_full', features: '', multiChannelSites: '' })).rejects.toThrow(/furim_master/);
  });
});
