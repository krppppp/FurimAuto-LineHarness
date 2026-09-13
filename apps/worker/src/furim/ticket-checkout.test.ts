import { describe, it, expect } from 'vitest';
import { buildTicketCheckoutUrl, isPaidPlan, ticketUnitPrice } from './ticket-checkout.js';

const env = {
  FURIM_TICKET_LIFF_URL: 'https://liff.line.me/1660804123-VgnRNDJm',
  FURIM_TICKET_PRICE_IDS: JSON.stringify({ '15': 'price_15', '14': 'price_14', '13': 'price_13', '10': 'price_10' }),
  WORKER_NAME: 'line-harness-prod',
};
const NOW = 1_800_000_000_000;

describe('isPaidPlan (GAS getUserPlan と同じ判定)', () => {
  it('「プラン」を含めば有料、空・キャンセル済みは通常', () => {
    expect(isPaidPlan('PBプラン:メルカリ 基本プラン')).toBe(true);
    expect(isPaidPlan('メルカリ8980円全自動化プラン')).toBe(true);
    expect(isPaidPlan('')).toBe(false);
    expect(isPaidPlan(null)).toBe(false);
    expect(isPaidPlan('キャンセル済み(メルカリ引退)')).toBe(false);
  });
});

describe('ticketUnitPrice (GAS getTicketPriceId と同じ単価表)', () => {
  it('有料: 200→14, 500→13, 1000→10, 50/100→15。通常は常に 15', () => {
    expect(ticketUnitPrice(true, 50)).toBe(15);
    expect(ticketUnitPrice(true, 100)).toBe(15);
    expect(ticketUnitPrice(true, 200)).toBe(14);
    expect(ticketUnitPrice(true, 500)).toBe(13);
    expect(ticketUnitPrice(true, 1000)).toBe(10);
    expect(ticketUnitPrice(false, 1000)).toBe(15);
  });
});

describe('buildTicketCheckoutUrl', () => {
  it('GAS と同じ並びのクエリ（price_id / quantity / customer_id / expired=+1h ms / env）', () => {
    const r = buildTicketCheckoutUrl({ ticketCount: 200, planName: 'PBプラン:メルカリ 基本プラン', stripeCustomerId: 'cus_1', env, now: NOW });
    expect(r).toEqual({
      checkoutURL: `https://liff.line.me/1660804123-VgnRNDJm?price_id=price_14&quantity=200&customer_id=cus_1&expired=${NOW + 3_600_000}&env=prod`,
    });
  });

  it('dev worker は env=dev、顧客ID 無しは空のまま（GAS と同値）', () => {
    const r = buildTicketCheckoutUrl({ ticketCount: 50, planName: null, stripeCustomerId: null, env: { ...env, WORKER_NAME: 'line-harness' }, now: NOW });
    expect('checkoutURL' in r && r.checkoutURL).toContain('price_id=price_15&quantity=50&customer_id=&expired=');
    expect('checkoutURL' in r && r.checkoutURL.endsWith('&env=dev')).toBe(true);
  });

  it('50 枚未満はエラー文', () => {
    expect(buildTicketCheckoutUrl({ ticketCount: 10, planName: null, stripeCustomerId: null, env })).toEqual({ error: '最低50枚から購入可能です' });
  });

  it('PriceID 表が壊れていれば 15 円の既定 PriceID にフォールバック', () => {
    const r = buildTicketCheckoutUrl({ ticketCount: 500, planName: 'xプラン', stripeCustomerId: 'cus_1', env: { ...env, FURIM_TICKET_PRICE_IDS: '{broken' }, now: NOW });
    expect('checkoutURL' in r && r.checkoutURL).toContain('price_id=price_1SFCiyF2C7KcCkFfzJ7IuaTA&');
  });
});
