// コピー出品チケットの決済 URL 組み立て（GAS getTicketCheckoutUrl.js の移植・Capsec #243）。
// 受け口は CloudStorage/client/js/checkout.js（price_id / quantity / customer_id / expired / env）。
// 単価: 通常 15 円。有料プラン（プラン名に「プラン」を含み「キャンセル済み」始まりでない）は
// 200枚→14 / 500枚→13 / 1000枚→10。50・100 枚は有料でも 15。PriceID は環境ごとに vars で持つ。

export type TicketCheckoutEnv = {
  FURIM_TICKET_LIFF_URL?: string;
  FURIM_TICKET_PRICE_IDS?: string; // JSON {"15":"price_…","14":…,"13":…,"10":…}
  WORKER_NAME?: string;
};

const PROD_TICKET_LIFF_URL = 'https://liff.line.me/1660804123-VgnRNDJm';
// GAS と同じフォールバック（本番の 15 円）
const FALLBACK_PRICE_ID_15 = 'price_1SFCiyF2C7KcCkFfzJ7IuaTA';
export const MIN_TICKET_COUNT = 50;
const URL_TTL_MS = 60 * 60 * 1000;

export function isPaidPlan(planName: string | null | undefined): boolean {
  const p = String(planName ?? '').trim();
  if (!p) return false;
  if (p.startsWith('キャンセル済み')) return false;
  return p.includes('プラン');
}

export function ticketUnitPrice(paid: boolean, ticketCount: number): 15 | 14 | 13 | 10 {
  if (!paid) return 15;
  if (ticketCount === 200) return 14;
  if (ticketCount === 500) return 13;
  if (ticketCount === 1000) return 10;
  return 15;
}

function priceIdFor(unit: number, env: TicketCheckoutEnv): string {
  let map: Record<string, string> = {};
  if (env.FURIM_TICKET_PRICE_IDS) {
    try {
      map = JSON.parse(env.FURIM_TICKET_PRICE_IDS) as Record<string, string>;
    } catch (e) {
      console.error('[furim/ticket-checkout] FURIM_TICKET_PRICE_IDS parse failed:', e);
    }
  }
  return map[String(unit)] || map['15'] || FALLBACK_PRICE_ID_15;
}

export type TicketCheckoutInput = {
  ticketCount: number;
  planName: string | null | undefined;
  stripeCustomerId: string | null | undefined;
  env: TicketCheckoutEnv;
  now?: number;
};

export function buildTicketCheckoutUrl(input: TicketCheckoutInput): { checkoutURL: string } | { error: string } {
  const count = Number.isFinite(input.ticketCount) ? Math.trunc(input.ticketCount) : 0;
  if (count < MIN_TICKET_COUNT) return { error: `最低${MIN_TICKET_COUNT}枚から購入可能です` };
  const unit = ticketUnitPrice(isPaidPlan(input.planName), count);
  const priceId = priceIdFor(unit, input.env);
  const liff = input.env.FURIM_TICKET_LIFF_URL || PROD_TICKET_LIFF_URL;
  const envName = input.env.WORKER_NAME === 'line-harness' ? 'dev' : 'prod';
  const expired = (input.now ?? Date.now()) + URL_TTL_MS;
  // GAS と同じ並び・同じ生値（顧客ID が無ければ空のまま）
  const checkoutURL = `${liff}?price_id=${priceId}&quantity=${count}&customer_id=${input.stripeCustomerId ?? ''}&expired=${expired}&env=${envName}`;
  return { checkoutURL };
}
