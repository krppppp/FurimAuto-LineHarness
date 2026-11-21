import type { Message } from '@line-crm/line-sdk';
import type { AnnualQuote, ChargeResult, QuoteResult } from './annual-prepay.js';

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
  '例外は、お申込みから1か月以内に、\nお客様がご利用中のサービスの\nWEBサイトの構成が変わり、\n当ツールで改修を行っても\n自動化処理ができなくなった\n場合だけです。\nこのときは、お支払い額から\n使った1か月分を引いてお返しします。';

/** postback のデータ。案内した年払い額（税抜）を載せ、決済のときに金額が変わっていないか確かめる */
export function confirmPostbackData(annual: number): string {
  return `${ANNUAL_CONFIRM_POSTBACK}&annual=${annual}`;
}

export function parseConfirmPostback(data: string): { expectedAnnual?: number } | null {
  if (data !== ANNUAL_CONFIRM_POSTBACK && !data.startsWith(`${ANNUAL_CONFIRM_POSTBACK}&`)) return null;
  const v = new URLSearchParams(data).get('annual');
  const n = v != null && /^\d+$/.test(v) ? Number(v) : undefined;
  return { expectedAnnual: n };
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/** 2026/12/05（JST の日付）→「2026年12月5日（土）」 */
export function jpDate(ymd: string): string {
  const m = ymd.match(/^(\d{4})[/-](\d{2})[/-](\d{2})/);
  if (!m) return ymd;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${+m[1]}年${+m[2]}月${+m[3]}日（${WEEK[d.getUTCDay()]}）`;
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
export function buildAnnualQuoteFlex(q: AnnualQuote & { payWith: 'card' | 'checkout' }): Message {
  const sale = q.kind === 'sale';
  const howToPay = q.payWith === 'card'
    ? 'ボタンを押すと、ご登録のカードで\nお支払いが完了します。\n期間中の月々のお支払いはありません。'
    : 'ボタンを押すと、お支払いの\nリンクをこのトークでお送りします。\n期間中の月々のお支払いはありません。';
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
            row('ご利用期間', `${jpDate(q.periodStart)}\n〜${jpDate(q.periodLastDay)}`),
            ...(sale ? [row('締切', ANNUAL_DEADLINE_LABEL, { color: RED, weight: 'bold' })] : []),
          ],
        },
        heading('お支払いについて'),
        t(howToPay, { margin: 'md' }),
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
          action: { type: 'postback', label: ANNUAL_CONFIRM_LABEL, data: confirmPostbackData(q.annual), displayText: ANNUAL_CONFIRM_LABEL },
        },
        t('上の内容と返金の条件に同意のうえ、お申込みください', { size: 'xxs', color: '#777777', align: 'center' }),
      ],
    },
  };
  return { type: 'flex', altText: `年払いプランのご案内（${yen(q.annual)}・税抜）`, contents } as unknown as Message;
}

const CONTACT = 'ご契約の状態を確かめて、担当からこのトークでご連絡します。';
const DONE = '年払いのお手続きは、すでに済んでいます。';
const DONE_REASONS = ['already_annual', 'already_paid'];
const NOT_TARGET_REASONS = ['too_small', 'no_customer'];

const text = (s: string) => ({ type: 'text', text: s }) as Message;

/** 「年払い」への返事 */
export function annualQuoteMessages(r: QuoteResult): Message[] {
  if (r.ok) return [buildAnnualQuoteFlex(r)];
  if (DONE_REASONS.includes(r.reason)) return [text(DONE)];
  if (NOT_TARGET_REASONS.includes(r.reason)) return [text('年払いは、月額プランをご契約中の方が対象です。\nご不明な点は、このLINEでお聞きください。')];
  return [text(`年払いのご希望を受け付けました。\n${CONTACT}`)];
}

/** 「この内容で申し込む」への返事 */
export function annualConfirmMessages(r: ChargeResult): Message[] {
  if (r.ok) {
    if ('dryRun' in r) return [];
    return [text(
      'お申込みありがとうございます。\nご登録のカードでお支払いが完了しました。\n\n' +
        `お支払い額: ${yen(r.total)}（税込）\nご利用期間: ${jpDate(r.periodStart)}〜${jpDate(r.periodLastDay)}\n\n` +
        '期間中の月々のお支払いはありません。\nキーコードは今までどおり毎月自動で延びます。',
    )];
  }
  if (r.checkoutUrl) {
    const why = r.reason === 'authentication_required'
      ? 'カード会社の本人確認が必要なため、ご登録のカードでのお支払いが完了しませんでした。'
      : r.reason === 'no_payment_method'
        ? 'お申込みありがとうございます。'
        : 'ご登録のカードでお支払いができませんでした。';
    return [text(`${why}\n下のリンクからお支払いいただけます。\n${r.checkoutUrl}`)];
  }
  if (DONE_REASONS.includes(r.reason)) return [text(DONE)];
  if (r.reason === 'in_progress') return [text('お手続き中です。\n少しお待ちください。')];
  if (r.reason === 'price_changed') return [text('ご案内した金額から変わっています。\nお手数ですが、もう一度「年払い」とお送りください。')];
  return [text(`お申込みを受け付けました。\nお支払いはまだ完了していません。\n${CONTACT}`)];
}
