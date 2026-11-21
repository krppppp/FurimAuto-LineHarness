import type { Message } from '@line-crm/line-sdk';

/**
 * 年払いの LINE のやりとり（TB-3964）。
 * 「年払い」→ その人の金額の案内（Flex）→ ボタン「この内容で申し込む」（postback）→ 登録済みのカードで決済 → 結果の返事。
 * 金額と決済は furim/annual-prepay.ts（TB-3963）。ここは返す文面と Flex だけを持つ。
 */

export const ANNUAL_KEYWORD = '年払い';
export const ANNUAL_CONFIRM_POSTBACK = 'annual_prepay=confirm';
export const ANNUAL_CONFIRM_LABEL = 'この内容で申し込む';
export const ANNUAL_AGREED_TAG = '年払い同意';
export const ANNUAL_DEADLINE_LABEL = '2026年11月27日（金）19:00まで';

export const REFUND_EXCEPTION =
  'お申込みから1か月以内に、\nご利用中のフリマサイトの\n仕様変更などにより、\n当ツールで改修を行っても\n自動化処理が完結できない状態に\nなった場合に限り、\nお支払い額から使った1か月分\n（月額）を引いてお返しします。';

export type AnnualQuote = {
  ok: true;
  dryRun: true;
  kind: 'sale' | 'standard';
  priceMonths: number;
  monthly: number;
  annual: number;
  tax: number;
  total: number;
  startAt: string;
  endAt: string;
};

export type AnnualCharged = {
  ok: true;
  charged: true;
  alreadyCharged: boolean;
  annual: number;
  total: number;
  startAt: string;
  endAt: string;
  applied: boolean;
};

export type AnnualChargeFailure = { ok: false; reason: string; message: string; checkoutUrl?: string | null };

export type AnnualQuoteResult = AnnualQuote | AnnualChargeFailure;
export type AnnualChargeResult = AnnualCharged | AnnualChargeFailure;

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/** JST の ISO（2026-12-05T10:00:00+09:00 など）→「2026年12月5日（土）」 */
export function jpDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${WEEK[d.getUTCDay()]}）`;
}

const yen = (n: number) => `${n.toLocaleString('ja-JP')}円`;

const BLUE = '#1F5FBF';
const RED = '#D7263D';
const INK = '#1A1A1A';
const SUB = '#555555';

function t(text: string, extra: Record<string, unknown> = {}) {
  return { type: 'text', text, size: 'sm', color: INK, wrap: true, lineSpacing: '6px', ...extra };
}

function row(label: string, value: string, valueExtra: Record<string, unknown> = {}) {
  return {
    type: 'box', layout: 'horizontal', spacing: 'md',
    contents: [
      t(label, { color: SUB, flex: 5, gravity: 'center' }),
      t(value, { align: 'end', flex: 7, ...valueExtra }),
    ],
  };
}

function heading(text: string, bar = BLUE) {
  return {
    type: 'box', layout: 'horizontal', spacing: 'md', margin: 'xl',
    contents: [
      { type: 'box', layout: 'vertical', width: '4px', backgroundColor: bar, cornerRadius: '2px', contents: [{ type: 'filler' }] },
      t(text, { size: 'md', weight: 'bold', flex: 1 }),
    ],
  };
}

/** 金額案内の Flex。ボタンは postback（押した記録が同意の記録になる） */
export function buildAnnualQuoteFlex(q: AnnualQuote): Message {
  const sale = q.kind === 'sale';
  const contents = {
    type: 'bubble',
    size: 'giga',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: BLUE, paddingAll: '22px', spacing: 'xs',
      contents: [
        t('年払いプランのご案内', { size: 'xl', color: '#FFFFFF', weight: 'bold' }),
        t(`今のプランのまま、月額の${q.priceMonths}か月分で12か月`, { size: 'xs', color: '#EAF1FF' }),
      ],
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '22px', spacing: 'sm',
      contents: [
        t('ご契約中のプランから\nお見積りしました。'),
        {
          type: 'box', layout: 'vertical', backgroundColor: '#F4F7FD', cornerRadius: '8px', paddingAll: '16px', spacing: 'md', margin: 'lg',
          contents: [
            row('今の月額（税抜）', yen(q.monthly)),
            row('年払い（税抜）', yen(q.annual), { size: 'lg', color: RED, weight: 'bold' }),
            row('お支払い（税込）', yen(q.total), { weight: 'bold' }),
            { type: 'separator', color: '#DDE3EE' },
            row('ご利用期間', `${jpDate(q.startAt)}\n〜${jpDate(q.endAt)}`),
            ...(sale ? [row('締切', ANNUAL_DEADLINE_LABEL, { color: RED, weight: 'bold' })] : []),
          ],
        },
        heading('お支払いについて'),
        t('ボタンを押すと、ご登録のカードで\nお支払いが完了します。\n期間中の月々のお支払いはありません。', { margin: 'md' }),
        heading('返金について', '#F9B233'),
        t('お申込み後の途中解約・返金は\n原則できません。', { weight: 'bold', margin: 'md' }),
        t(REFUND_EXCEPTION, { margin: 'sm' }),
      ],
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
      contents: [
        {
          type: 'button', style: 'primary', color: RED, height: 'md',
          action: { type: 'postback', label: ANNUAL_CONFIRM_LABEL, data: ANNUAL_CONFIRM_POSTBACK, displayText: ANNUAL_CONFIRM_LABEL },
        },
        t('上の内容と返金の条件に同意のうえ、お申込みください', { size: 'xxs', color: '#777777', align: 'center' }),
      ],
    },
  };
  return { type: 'flex', altText: `年払いプランのご案内（${yen(q.annual)}・税抜）`, contents } as unknown as Message;
}

const CONTACT = 'ご契約の状態を確かめて、担当からこのトークでご連絡します。';

/** 金額を出せなかったときの返事 */
function quoteFailureText(r: AnnualChargeFailure): string {
  switch (r.reason) {
    case 'already_annual':
    case 'already_paid':
    case 'already_charged':
      return '年払いのお手続きは、すでに済んでいます。';
    case 'no_customer':
    case 'no_subscription':
    case 'not_member':
    case 'too_small':
      return '年払いは、月額プランをご契約中の方が対象です。\nご不明な点は、このLINEでお聞きください。';
    default:
      return `年払いのご希望を受け付けました。\n${CONTACT}`;
  }
}

/** 「年払い」への返事 */
export function annualQuoteMessages(r: AnnualQuoteResult): Message[] {
  if (r.ok) return [buildAnnualQuoteFlex(r)];
  return [{ type: 'text', text: quoteFailureText(r) } as Message];
}

/** 「この内容で申し込む」への返事 */
export function annualConfirmMessages(r: AnnualChargeResult): Message[] {
  if (r.ok) {
    const period = `${jpDate(r.startAt)}〜${jpDate(r.endAt)}`;
    if (r.alreadyCharged) {
      return [{ type: 'text', text: `年払いのお手続きは、すでに済んでいます。\nご利用期間: ${period}` } as Message];
    }
    return [{
      type: 'text',
      text:
        'お申込みありがとうございます。\nご登録のカードでお支払いが完了しました。\n\n' +
        `お支払い額: ${yen(r.total)}（税込）\nご利用期間: ${period}\n\n` +
        '期間中の月々のお支払いはありません。\nキーコードは今までどおり毎月自動で延びます。',
    } as Message];
  }
  if (r.checkoutUrl) {
    const why = r.reason === 'checkout_only'
      ? 'お申込みありがとうございます。'
      : r.reason === 'needs_action'
        ? 'カード会社の本人確認が必要なため、ご登録のカードでのお支払いが完了しませんでした。'
        : 'ご登録のカードでお支払いができませんでした。';
    return [{ type: 'text', text: `${why}\n下のリンクからお支払いいただけます。\n${r.checkoutUrl}` } as Message];
  }
  if (['already_annual', 'already_paid', 'already_charged'].includes(r.reason)) {
    return [{ type: 'text', text: '年払いのお手続きは、すでに済んでいます。' } as Message];
  }
  return [{ type: 'text', text: `お申込みを受け付けました。\nお支払いはまだ完了していません。\n${CONTACT}` } as Message];
}
