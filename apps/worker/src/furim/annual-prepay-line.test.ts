import { describe, expect, it } from 'vitest';
import {
  ANNUAL_CONFIRM_POSTBACK,
  REFUND_EXCEPTION,
  annualConfirmMessages,
  annualQuoteMessages,
  jpDate,
  type AnnualQuote,
} from './annual-prepay-line.js';

const quote: AnnualQuote = {
  ok: true, dryRun: true, kind: 'sale', priceMonths: 10, monthly: 8980, annual: 89800, tax: 8980, total: 98780,
  startAt: '2026-12-05T10:00:00+09:00', endAt: '2027-12-04T10:00:00+09:00',
};

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
    expect(jpDate('2026-11-27T19:00:00+09:00')).toBe('2026年11月27日（金）');
    expect(jpDate('2026-12-31T23:30:00+09:00')).toBe('2026年12月31日（木）');
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
    expect(all.replace(/\n/g, '')).toContain('お申込みから1か月以内に、ご利用中のフリマサイトの仕様変更などにより、当ツールで改修を行っても自動化処理が完結できない状態になった場合に限り、お支払い額から使った1か月分（月額）を引いてお返しします。');
    expect(all).toContain(REFUND_EXCEPTION);
    expect(JSON.stringify(m.contents)).not.toContain('"span"');
    const button = (m.contents.footer as { contents: Array<{ action?: { type: string; data: string; label: string } }> }).contents[0].action!;
    expect(button).toMatchObject({ type: 'postback', data: ANNUAL_CONFIRM_POSTBACK, label: 'この内容で申し込む' });
  });

  it('常設（×11）は締切の行を出さない', () => {
    const [m] = annualQuoteMessages({ ...quote, kind: 'standard', priceMonths: 11, annual: 98780 }) as unknown as [{ contents: unknown }];
    const all = texts(m.contents).join('\n');
    expect(all).toContain('月額の11か月分');
    expect(all).not.toContain('2026年11月27日');
  });

  it('止まっている会員は金額を出さず担当から連絡', () => {
    const [m] = annualQuoteMessages({ ok: false, reason: 'open_invoice', message: 'x' }) as unknown as [{ text: string }];
    expect(m.text).toContain('担当からこのトークでご連絡します');
  });

  it('月額の契約が無い人は対象外と返す', () => {
    const [m] = annualQuoteMessages({ ok: false, reason: 'too_small', message: 'x' }) as unknown as [{ text: string }];
    expect(m.text).toContain('月額プランをご契約中の方が対象です');
  });
});

describe('annualConfirmMessages', () => {
  it('成功は金額（税込）と期間', () => {
    const [m] = annualConfirmMessages({ ok: true, charged: true, alreadyCharged: false, annual: 89800, total: 98780, startAt: quote.startAt, endAt: quote.endAt, applied: true }) as unknown as [{ text: string }];
    expect(m.text).toContain('お支払いが完了しました');
    expect(m.text).toContain('98,780円（税込）');
    expect(m.text).toContain('2026年12月5日（土）〜2027年12月4日（土）');
  });

  it('2 回目の押下は済んでいると返す', () => {
    const [m] = annualConfirmMessages({ ok: true, charged: true, alreadyCharged: true, annual: 89800, total: 98780, startAt: quote.startAt, endAt: quote.endAt, applied: true }) as unknown as [{ text: string }];
    expect(m.text).toContain('すでに済んでいます');
    expect(m.text).not.toContain('完了しました');
  });

  it('本人確認で止まったら Checkout のリンク', () => {
    const [m] = annualConfirmMessages({ ok: false, reason: 'needs_action', message: 'x', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_x' }) as unknown as [{ text: string }];
    expect(m.text).toContain('本人確認');
    expect(m.text).toContain('https://checkout.stripe.com/c/pay/cs_x');
  });

  it('決済しなかったときは完了と言わない', () => {
    const [m] = annualConfirmMessages({ ok: false, reason: 'past_due', message: 'x' }) as unknown as [{ text: string }];
    expect(m.text).toContain('お支払いはまだ完了していません');
  });
});
