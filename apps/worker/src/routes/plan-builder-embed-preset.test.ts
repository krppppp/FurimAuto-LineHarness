import { describe, expect, it } from 'vitest';
import { sheetMasterRows, type MasterRow } from '../furim/__fixtures__/master-fixture.js';
import { planBuilder } from './plan-builder.js';

// 埋め込み用の初期選択クエリ（TB-964）。/service/ の料金シミュレーションで到達時点に金額を出す。

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

type Page = {
  state: { sites: string[]; plan: Record<string, string> };
  applyEmbedPreset: (search: string) => void;
  calc: () => { total: number };
};

async function loadPage(query: string): Promise<{ html: string; page: Page }> {
  const res = await planBuilder.request(`/plan-builder${query}`, {}, { DB: makeDb(sheetMasterRows()) });
  const html = await res.text();
  const start = html.indexOf('<script>\nconst FEATURES');
  const end = html.indexOf('\nfunction renderSites()');
  const head = html.slice(start + '<script>'.length, end);
  const page = new Function(`${head}\nreturn { state, applyEmbedPreset, calc };`)() as Page;
  return { html, page };
}

describe('plan-builder 埋め込みの初期選択（TB-964）', () => {
  it('preset_site=mercari&preset_plan=basic でメルカリ＋基本プランが入り、月額が出る', async () => {
    const { page } = await loadPage('?embed=1');
    page.applyEmbedPreset('?embed=1&preset_site=mercari&preset_plan=basic');

    expect(page.state.sites).toEqual(['mercari']);
    expect(page.state.plan.mercari).toBe('m_basic');
    expect(page.calc().total).toBeGreaterThan(0);
  });

  it('クエリで入れた選択の金額は、手で同じ選択をしたときと一致する', async () => {
    for (const planType of ['full', 'semi', 'basic']) {
      const preset = (await loadPage('?embed=1')).page;
      preset.applyEmbedPreset(`?preset_site=mercari&preset_plan=${planType}`);

      const manual = (await loadPage('?embed=1')).page;
      manual.state.sites.push('mercari');
      manual.state.plan.mercari = `m_${planType}`;

      expect(preset.calc()).toEqual(manual.calc());
    }
  });

  it('preset_plan=buffet はビュッフェ式を選ぶ', async () => {
    const { page } = await loadPage('?embed=1');
    page.applyEmbedPreset('?preset_site=rakuma&preset_plan=buffet');

    expect(page.state.sites).toEqual(['rakuma']);
    expect(page.state.plan.rakuma).toBe('buffet');
  });

  it('知らない値は黙って無視する', async () => {
    const { page } = await loadPage('?embed=1');
    page.applyEmbedPreset('?preset_site=amazon&preset_plan=basic');
    page.applyEmbedPreset('?preset_site=__proto__&preset_plan=basic');
    page.applyEmbedPreset('?preset_plan=basic');
    expect(page.state.sites).toEqual([]);
    expect(page.state.plan).toEqual({});

    page.applyEmbedPreset('?preset_site=mercari&preset_plan=premium');
    expect(page.state.sites).toEqual(['mercari']);
    expect(page.state.plan.mercari).toBeUndefined();
  });

  it('効かせるのは埋め込み・LIFF でない・lineUserId 無しのときだけ', async () => {
    const { html } = await loadPage('?embed=1');
    expect(html).toContain('if (EMBED && !LIFF_MODE && !lineUserId) applyEmbedPreset(window.location.search);');
    expect(html).toContain('const EMBED = true;');
    expect((await loadPage('')).html).toContain('const EMBED = false;');
    expect((await loadPage('?liff=1&liffId=x')).html).toContain('const LIFF_MODE = true;');
  });
});
