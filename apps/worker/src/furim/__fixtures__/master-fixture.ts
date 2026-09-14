import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type MasterFixtureRow = Record<string, unknown>;

export type MasterFixture = { features: MasterFixtureRow[]; packages: MasterFixtureRow[]; plans: MasterFixtureRow[]; ticketPrices: MasterFixtureRow[] };

export const masterFixture = JSON.parse(readFileSync(join(__dirname, 'master-2026-09-14.json'), 'utf8')) as MasterFixture;

export type MasterRow = {
  kind: string;
  key: string;
  display_name: string | null;
  stripe_price_id: string | null;
  monthly_price: number | null;
  active: number;
  payload: string;
  fetched_at: string;
};

const toInt = (v: unknown) => (v === '' || v === null || v === undefined ? null : Math.trunc(Number(v)));

export function sheetMasterRows(): MasterRow[] {
  const rows: MasterRow[] = [];
  const at = '2026-09-14T15:00:53.152+09:00';
  for (const f of masterFixture.features) {
    rows.push({ kind: 'feature', key: String(f.feature_key), display_name: String(f.display_name), stripe_price_id: String(f.stripe_price_id), monthly_price: toInt(f.monthly_price), active: 1, payload: JSON.stringify(f), fetched_at: at });
  }
  for (const p of masterFixture.packages) {
    rows.push({ kind: 'package', key: String(p.package_key), display_name: String(p.display_name), stripe_price_id: String(p.stripe_price_id), monthly_price: toInt(p.monthly_price), active: 1, payload: JSON.stringify(p), fetched_at: at });
  }
  for (const p of masterFixture.plans) {
    rows.push({ kind: 'plan', key: String(p['プラン名']), display_name: String(p['プラン名']), stripe_price_id: String(p.PriceID), monthly_price: toInt(p['価格']), active: 1, payload: JSON.stringify(p), fetched_at: at });
  }
  for (const t of masterFixture.ticketPrices) {
    rows.push({ kind: 'ticket_price', key: String(t['単価']), display_name: String(t['単価']), stripe_price_id: String(t.PriceID), monthly_price: null, active: 1, payload: JSON.stringify(t), fetched_at: at });
  }
  return rows;
}
