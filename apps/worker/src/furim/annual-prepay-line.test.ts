import { describe, expect, it } from 'vitest';
import {
  REFUND_EXCEPTION,
  annualConfirmMessages,
  annualQuoteMessages,
  jpDate,
  parseConfirmPostback,
} from './annual-prepay-line.js';
import type { AnnualQuote } from './annual-prepay.js';

const base: AnnualQuote = {
  kind: 'sale', priceMonths: 10, monthly: 8980, annual: 89800, tax: 8980, total: 98780,
  periodStart: '2026/12/05', periodLastDay: '2027/12/04', startAt: '2026-12-05T10:00:00+09:00', endAt: '2027-12-04T23:59:59+09:00', subscriptionId: 'sub_1',
};
const quote = { ok: true as const, payWith: 'card' as const, ...base };
const fail = (reason: string, extra: Record<string, unknown> = {}) => ({ ok: false as const, reason, message: 'x', customerAction: 'none' as const, ...extra });
const charged = (status: 'succeeded' | 'paid_apply_pending') => ({ ok: true as const, status, charged: true as const, applied: status === 'succeeded', alreadyCharged: false as const, annualPrepayId: 'ap_1', paymentIntentId: 'pi_1', ...base });

const texts = (n: unknown, out: string[] = []): string[] => {
  if (Array.isArray(n)) n.forEach((v) => texts(v, out));
  else if (n && typeof n === 'object') {
    const o = n as Record<string, unknown>;
    if (o.type === 'text' && typeof o.text === 'string') out.push(o.text);
    Object.values(o).forEach((v) => texts(v, out));
  }
  return out;
};

describe('jpDate', () => {
  it('JST の日付と曜日にする', () => {
    expect(jpDate('2026/11/27')).toBe('2026年11月27日（金）');
    expect(jpDate('2026/12/31')).toBe('2026年12月31日（木）');
  });
});

describe('annualQuoteMessages', () => {
  it('金額・税込・期間・締切・返金の条件を出し、ボタンは postback', () => {
    const [m] = annualQuoteMessages(quote) as unknown as [{ type: string; altText: string; contents: Record<string, unknown> }];
    expect(m.type).toBe('flex');
    const all = texts(m.contents).join('\n');
    expect(all).toContain('8,980円');
    expect(all).toContain('89,800円');
    expect(all).toContain('98,780円');
    expect(all).toContain('2026年12月5日（土）');
    expect(all).toContain('2027年12月4日（土）');
    expect(all).toContain('2026年11月27日（金）19:00まで');
    expect(all.replace(/\n/g, '')).toContain('お申込み後の途中解約・返金は原則できません。');
    expect(all.replace(/\n/g, '')).toContain('例外は、お申込みから1か月以内に、お客様がご利用中のサービスのWEBサイトの構成が変わり、当ツールで改修を行っても自動化処理ができなくなった場合だけです。このときは、お支払い額から使った1か月分を引いてお返しします。');
    expect(all).toContain(REFUND_EXCEPTION);
    expect(JSON.stringify(m.contents)).not.toContain('"span"');
    const button = (m.contents.footer as { contents: Array<{ action?: { type: string; data: string; label: string } }> }).contents[0].action!;
    expect(button).toMatchObject({ type: 'postback', data: 'annual_prepay=confirm&annual=89800', label: 'この内容で申し込む' });
    expect(all).toContain('ご登録のカードで');
  });

  it('常設（×11）は締切の行を出さない', () => {
    const [m] = annualQuoteMessages({ ...quote, kind: 'standard', priceMonths: 11, annual: 98780 }) as unknown as [{ contents: unknown }];
    const all = texts(m.contents).join('\n');
    expect(all).toContain('月額の11か月分');
    expect(all).not.toContain('2026年11月27日');
  });

  it('止まっている会員は金額を出さず担当から連絡', () => {
    const [m] = annualQuoteMessages(fail('open_invoice')) as unknown as [{ text: string }];
    expect(m.text).toContain('担当からこのトークでご連絡します');
  });

  it('月額の契約が無い人は対象外と返す', () => {
    const [m] = annualQuoteMessages(fail('too_small')) as unknown as [{ text: string }];
    expect(m.text).toContain('月額プランをご契約中の方が対象です');
  });
});

describe('parseConfirmPostback', () => {
  it('案内した金額を読む', () => {
    expect(parseConfirmPostback('annual_prepay=confirm&annual=89800')).toEqual({ expectedAnnual: 89800 });
    expect(parseConfirmPostback('annual_prepay=confirm')).toEqual({ expectedAnnual: undefined });
    expect(parseConfirmPostback('annual_prepay=confirmx')).toBeNull();
    expect(parseConfirmPostback('seminar_vote=1')).toBeNull();
  });
});

describe('annualQuoteMessages（カードが無い人）', () => {
  it('リンクを送ると書く', () => {
    const [m] = annualQuoteMessages({ ...quote, payWith: 'checkout' }) as unknown as [{ contents: unknown }];
    expect(texts(m.contents).join('').replace(/\n/g, '')).toContain('お支払いのリンクをこのトークでお送りします');
  });
});

describe('annualConfirmMessages', () => {
  it('入金済みでクーポンが後追いでも、お客さんには完了と返す', () => {
    const [m] = annualConfirmMessages(charged('paid_apply_pending')) as unknown as [{ text: string }];
    expect(m.text).toContain('お支払いが完了しました');
  });

  it('金額が変わっていたら決済せず案内し直し', () => {
    const [m] = annualConfirmMessages(fail('price_changed')) as unknown as [{ text: string }];
    expect(m.text).toContain('もう一度「年払い」');
  });

  it('成功は金額（税込）と期間', () => {
    const [m] = annualConfirmMessages(charged('succeeded')) as unknown as [{ text: string }];
    expect(m.text).toContain('お支払いが完了しました');
    expect(m.text).toContain('98,780円（税込）');
    expect(m.text).toContain('2026年12月5日（土）〜2027年12月4日（土）');
  });

  it('2 回目の押下は済んでいると返す', () => {
    const [m] = annualConfirmMessages(fail('already_paid')) as unknown as [{ text: string }];
    expect(m.text).toContain('すでに済んでいます');
    expect(m.text).not.toContain('完了しました');
  });

  it('本人確認で止まったら Checkout のリンク', () => {
    const [m] = annualConfirmMessages(fail('authentication_required', { checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_x' })) as unknown as [{ text: string }];
    expect(m.text).toContain('本人確認');
    expect(m.text).toContain('https://checkout.stripe.com/c/pay/cs_x');
  });

  it('決済しなかったときは完了と言わない', () => {
    const [m] = annualConfirmMessages(fail('not_active')) as unknown as [{ text: string }];
    expect(m.text).toContain('お支払いはまだ完了していません');
  });
});
