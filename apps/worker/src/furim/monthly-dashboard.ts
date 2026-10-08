// 月次ダッシュボード（TB-1189）。選んだ期間を日・週・月ごと（TB-1265）に、友だち追加・ブロック・月額会員・MRR・新規加入・解約・
// 友だち追加月ごとのファネル（試用開始・有料化）・流入経路別・セグメント別を出す。読み取りだけ。
// 行数が少ない（友だち・請求とも数千）ので、生の行を読んで JS で数える。定義を 1 か所に置いてテストで固めるため。
// 月額会員・新規加入・解約は Stripe のサブスク一覧で数える（くろさんが見る Stripe の画面と合わせる。TB-1192）。
import { EXCLUDED_LINE_IDS, TEST_LINE_IDS, segmentOf } from './segments.js';

const EXCLUDED: ReadonlySet<string> = new Set([...EXCLUDED_LINE_IDS, ...TEST_LINE_IDS]);
const isExcluded = (lineUserId: string | null | undefined) => !!lineUserId && EXCLUDED.has(lineUserId);

/** ISO+09:00 / オフセット無し / 空白区切りが混在するので 'YYYY-MM-DDTHH:MM:SS' にそろえる（furim-dashboard.ts と同じ扱い） */
const sec = (v: string | null | undefined) => String(v ?? '').replace(' ', 'T').slice(0, 19);
const monthOf = (v: string | null | undefined) => sec(v).slice(0, 7);

export const ROUTE_GROUPS = ['広告', '運用（SEO・SNS）', '拡張機能', '紹介', 'その他', '経路なし'] as const;
export type RouteGroup = (typeof ROUTE_GROUPS)[number];

export const SEGMENT_GROUPS = ['有料化', 'セグメント5〜8', 'セグメント4', 'セグメント3', 'セグメント2', 'セグメント1', 'ブロック', '対象外'] as const;
export type SegmentGroup = (typeof SEGMENT_GROUPS)[number];

export type Granularity = 'day' | 'week' | 'month';

export type BucketRow = {
  /** 日・週は始まりの日 'YYYY-MM-DD'、月は 'YYYY-MM' */
  t: string;
  /** 範囲で切った始まりと終わりの日（終わりの日を含む） */
  start: string;
  end: string;
  friendsAdded: number;
  /** ブロックの記録（ブロック時フローの実行ログ）が始まる前の区切りは null */
  blocked: number | null;
  net: number | null;
  members: number;
  mrr: number;
  newPaid: number;
  churned: number;
  /** 以下はこの区切りに友だち追加した人の、いま時点の到達（コホート） */
  trialStarted: number;
  cohortPaid: number;
  routesAdded: Record<RouteGroup, number>;
  routesPaid: Record<RouteGroup, number>;
  segments: Record<SegmentGroup, number>;
};

export type CardMetric = { value: number | null; prev: number | null };

export type MonthlyDashboard = {
  range: {
    start: string;
    end: string;
    all: boolean;
    granularity: Granularity;
    /** ひとつ前の同じ長さの期間（全期間のときは null） */
    prevStart: string | null;
    prevEnd: string | null;
    asOf: string;
    /** データのある最初の日（友だち・Stripe の古い方） */
    dataStart: string;
    blockedSince: string | null;
  };
  buckets: BucketRow[];
  /** 流れ（追加・加入・解約）は期間内の合計、在庫（会員・MRR）は期間末。prev はひとつ前の同じ長さの期間 */
  cards: {
    friendsAdded: CardMetric;
    net: CardMetric;
    members: CardMetric;
    mrr: CardMetric;
    newPaid: CardMetric;
    churned: CardMetric;
  };
  routeDetail: Array<{ route: string; group: RouteGroup; added: number; paid: number }>;
};

type FriendRow = { id: string; line_user_id: string | null; created_at: string; ref_code: string | null; is_following: number };
type CustomerRow = Parameters<typeof segmentOf>[0] & { line_user_id: string };
type PaymentRow = { line_user_id: string | null; subscription_id: string | null; billing_reason: string | null; price_excl_tax: number | null; paid_at: string };
type InvoiceRow = { subscription_id: string; price_excl_tax: number | null; paid_at: string };

/** Stripe のサブスク（一覧 API の読み取り）。月額会員・MRR・新規加入・解約は Stripe を正にする（TB-1192） */
export type StripeSub = { id: string; customer: string; status: string; start_date: number; trial_end: number | null; ended_at: number | null };
type Span = { sub: string; customer: string; from: string; to: string };

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM' の n か月後 */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** 'YYYY-MM-DD' の n 日後 */
export function addDays(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);
/** 'YYYY-MM-DDTHH:MM:SS' の n 日後 */
const shiftDays = (s19: string, n: number) => new Date(Date.parse(`${s19}Z`) + n * 86400_000).toISOString().slice(0, 19);

/** グラフの刻み: 31 日までは日、6 か月（186 日）までは週、それより長ければ月 */
export function granularityOf(start: string, end: string): Granularity {
  const days = daysBetween(start, end) + 1;
  return days <= 31 ? 'day' : days <= 186 ? 'week' : 'month';
}

/** 期間 [start, end]（日付・end を含む）を区切る。週は月曜はじまり。端の区切りは範囲で切る */
export function bucketsOf(start: string, end: string, g: Granularity): Array<{ t: string; start: string; end: string }> {
  const out: Array<{ t: string; start: string; end: string }> = [];
  for (let d = start; d <= end; ) {
    let next: string;
    if (g === 'day') next = addDays(d, 1);
    else if (g === 'week') next = addDays(d, 7 - ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
    else next = `${addMonths(d.slice(0, 7), 1)}-01`;
    const last = addDays(next, -1) < end ? addDays(next, -1) : end;
    out.push({ t: g === 'month' ? d.slice(0, 7) : d, start: d, end: last });
    d = next;
  }
  return out;
}

function emptyRoutes(): Record<RouteGroup, number> {
  return Object.fromEntries(ROUTE_GROUPS.map((g) => [g, 0])) as Record<RouteGroup, number>;
}
function emptySegments(): Record<SegmentGroup, number> {
  return Object.fromEntries(SEGMENT_GROUPS.map((g) => [g, 0])) as Record<SegmentGroup, number>;
}

export function routeGroupOf(refCode: string | null, isReferral: boolean): RouteGroup {
  if (isReferral) return '紹介';
  const r = (refCode ?? '').trim();
  if (!r) return '経路なし';
  if (r.startsWith('ad_')) return '広告';
  if (r.startsWith('org_')) return '運用（SEO・SNS）';
  if (r.startsWith('ext_')) return '拡張機能';
  return 'その他';
}

const SUBSCRIPTION_REASONS = new Set(['subscription_create', 'subscription_cycle', 'subscription_update']);
const SWITCH_WINDOW_MS = 7 * 86400_000;
const ms = (s19: string) => Date.parse(`${s19}+09:00`);
const jstOf = (unix: number) => new Date((unix + 9 * 3600) * 1000).toISOString().slice(0, 19);

/** Stripe のサブスク一覧を全件読む（status=all。書き込みはしない） */
export async function fetchStripeSubscriptions(secretKey: string): Promise<StripeSub[]> {
  const subs: StripeSub[] = [];
  let after = '';
  for (;;) {
    const res = await fetch(`https://api.stripe.com/v1/subscriptions?status=all&limit=100${after ? `&starting_after=${after}` : ''}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    if (!res.ok) throw new Error(`Stripe subscriptions ${res.status}`);
    const page = (await res.json()) as { data: StripeSub[]; has_more: boolean };
    subs.push(...page.data);
    if (!page.has_more || page.data.length === 0) return subs;
    after = page.data[page.data.length - 1].id;
  }
}

/**
 * サブスクごとの「有料で続いていた期間」[from, to)。試用の間は入れない。
 * Stripe の画面の有効な定期購読者（active・past_due）に合わせる。一度も有料にならなかったもの（incomplete・試用中の解約）と unpaid・paused は入らない
 */
export function paidSpans(subs: StripeSub[]): Span[] {
  const spans: Span[] = [];
  for (const s of subs) {
    if (!['active', 'past_due', 'trialing', 'canceled'].includes(s.status)) continue;
    const from = jstOf(Math.max(s.start_date, s.trial_end ?? 0));
    const to = s.ended_at ? jstOf(s.ended_at) : '9999';
    if (from < to) spans.push({ sub: s.id, customer: s.customer, from, to });
  }
  return spans;
}

/** 時点 at の月額会員（Stripe の顧客単位）と MRR（その会員のサブスクごとの、at までの直近の定期請求の割引後・税抜の合計） */
function membersAt(spans: Span[], invoicesBySub: Map<string, InvoiceRow[]>, at: string): { members: number; mrr: number } {
  const people = new Set<string>();
  let mrr = 0;
  for (const s of spans) {
    if (s.from > at || s.to <= at) continue;
    people.add(s.customer);
    let latest: InvoiceRow | undefined;
    for (const i of invoicesBySub.get(s.sub) ?? []) if (sec(i.paid_at) <= at && (!latest || sec(latest.paid_at) < sec(i.paid_at))) latest = i;
    mrr += Number(latest?.price_excl_tax ?? 0);
  }
  return { members: people.size, mrr };
}

/** start が 'all' なら全期間。end は今日より先にしない */
export async function buildMonthlyDashboard(
  db: D1Database,
  stripeSubs: StripeSub[],
  nowIso: string,
  range: { start: string; end: string },
): Promise<MonthlyDashboard> {
  const now19 = sec(nowIso);
  const today = now19.slice(0, 10);

  const [friendsRes, customersRes, paymentsRes, invoicesRes, unfollowRes, routesRes, affLinksRes, referralsRes] = await Promise.all([
    db.prepare('SELECT id, line_user_id, created_at, ref_code, is_following FROM friends').all<FriendRow>(),
    db
      .prepare(
        'SELECT line_user_id, key_code_issued, survey_answer, device_activated, device_code, mercari_url, free30_ticket, youtube_coupon, extend_keyword FROM furim_customers',
      )
      .all<CustomerRow & { key_code_issued: number }>(),
    db
      .prepare(
        `SELECT line_user_id, subscription_id, billing_reason, price_excl_tax, paid_at FROM furim_payments
         WHERE line_user_id IS NOT NULL AND actual_paid_amount > 0 AND billing_reason LIKE 'subscription_%'`,
      )
      .all<PaymentRow>(),
    db
      .prepare(
        `SELECT subscription_id, price_excl_tax, paid_at FROM furim_payments
         WHERE subscription_id IS NOT NULL AND billing_reason IN ('subscription_create', 'subscription_cycle')`,
      )
      .all<InvoiceRow>(),
    db
      .prepare(
        `SELECT l.friend_id, l.created_at FROM automation_logs l JOIN automations a ON a.id = l.automation_id
         WHERE a.event_type = 'unfollow'`,
      )
      .all<{ friend_id: string | null; created_at: string }>(),
    db.prepare('SELECT ref_code, name FROM entry_routes').all<{ ref_code: string; name: string }>(),
    db.prepare('SELECT ref_code FROM affiliate_links').all<{ ref_code: string }>(),
    db.prepare('SELECT introduced_friend_id FROM furim_referrals WHERE introduced_friend_id IS NOT NULL').all<{ introduced_friend_id: string }>(),
  ]);

  const friends = (friendsRes.results ?? []).filter((f) => !isExcluded(f.line_user_id));
  const friendById = new Map(friends.map((f) => [f.id, f]));
  const friendByLine = new Map<string, FriendRow>();
  for (const f of friends) if (f.line_user_id) friendByLine.set(f.line_user_id, f);
  const customers = new Map((customersRes.results ?? []).map((c) => [c.line_user_id, c]));
  const payments = (paymentsRes.results ?? []).filter((p) => !isExcluded(p.line_user_id) && SUBSCRIPTION_REASONS.has(p.billing_reason ?? ''));
  const invoicesBySub = new Map<string, InvoiceRow[]>();
  for (const i of invoicesRes.results ?? []) {
    const list = invoicesBySub.get(i.subscription_id) ?? [];
    list.push(i);
    invoicesBySub.set(i.subscription_id, list);
  }
  const spans = paidSpans(stripeSubs).filter((s) => s.from <= now19); // 試用中（有料の期間がまだ先）は入れない
  const unfollows = (unfollowRes.results ?? []).filter((u) => u.friend_id && friendById.has(u.friend_id));
  const routeName = new Map((routesRes.results ?? []).map((r) => [r.ref_code, r.name]));
  const affiliateCodes = new Set((affLinksRes.results ?? []).map((r) => r.ref_code));
  const referred = new Set((referralsRes.results ?? []).map((r) => r.introduced_friend_id));

  const routeOf = (f: FriendRow | undefined): { group: RouteGroup; label: string } => {
    if (!f) return { group: '経路なし', label: '(友だちの記録なし)' };
    const ref = (f.ref_code ?? '').trim();
    const isReferral = referred.has(f.id) || (ref !== '' && affiliateCodes.has(ref));
    const group = routeGroupOf(ref, isReferral);
    const label = isReferral ? '紹介' : ref ? (routeName.get(ref) ?? ref) : '(経路なし)';
    return { group, label };
  };

  // 初めて 0 円でない定期の請求があった日時（友だち追加月ごとの有料化・流入経路別の有料化の判定）
  const firstPaid = new Map<string, string>();
  for (const p of payments) {
    const id = p.line_user_id as string;
    const at = sec(p.paid_at);
    const cur = firstPaid.get(id);
    if (!cur || at < cur) firstPaid.set(id, at);
  }

  // 新規加入: Stripe の顧客が初めて有料の期間に入った日時
  const firstMember = new Map<string, string>();
  for (const s of spans) {
    const cur = firstMember.get(s.customer);
    if (!cur || s.from < cur) firstMember.set(s.customer, s.from);
  }
  const newPaidIn = (start: string, end: string) => [...firstMember.values()].filter((at) => at >= start && at < end).length;
  // 解約: 有料の期間が終わった顧客。前後 7 日に同じ顧客の別のサブスクが有料の期間にあればプランの切り替えなので数えない
  const churnEvents: Array<{ customer: string; at: string }> = [];
  for (const s of spans) {
    if (s.to === '9999') continue;
    const end = ms(s.to);
    const switched = spans.some(
      (o) => o.customer === s.customer && o.sub !== s.sub && ms(o.from) <= end + SWITCH_WINDOW_MS && (o.to === '9999' || ms(o.to) >= end - SWITCH_WINDOW_MS),
    );
    if (!switched) churnEvents.push({ customer: s.customer, at: s.to });
  }

  const dataStart = [...friends.map((f) => sec(f.created_at)), ...stripeSubs.map((s) => jstOf(s.start_date))].reduce(
    (min, at) => (at && at < min ? at : min),
    `${today}T00:00:00`,
  ).slice(0, 10);
  const all = range.start === 'all';
  const end = range.end < today ? range.end : today;
  const start = all ? dataStart : range.start <= end ? range.start : end;
  const granularity = granularityOf(start, end);
  const days = daysBetween(start, end) + 1;
  /** 区切りの終わり（日付の翌日 0 時）。いまより先はいまで切る */
  const cutOf = (lastDay: string) => {
    const c = `${addDays(lastDay, 1)}T00:00:00`;
    return c < now19 ? c : now19;
  };

  const blockedSince = unfollows.reduce<string | null>((min, u) => {
    const at = sec(u.created_at);
    return !min || at < min ? at : min;
  }, null);

  const countDistinct = <T>(rows: T[], keyOf: (r: T) => string, atOf: (r: T) => string, start: string, end: string) => {
    const s = new Set<string>();
    for (const r of rows) {
      const at = atOf(r);
      if (at >= start && at < end) s.add(keyOf(r));
    }
    return s.size;
  };

  const buckets: BucketRow[] = [];
  for (const b of bucketsOf(start, end, granularity)) {
    const bStart = `${b.start}T00:00:00`;
    const bEnd = cutOf(b.end);

    const cohort = friends.filter((f) => {
      const at = sec(f.created_at);
      return at >= bStart && at < bEnd;
    });
    const row: BucketRow = {
      ...b,
      friendsAdded: cohort.length,
      blocked: null,
      net: null,
      ...membersAt(spans, invoicesBySub, bEnd),
      newPaid: newPaidIn(bStart, bEnd),
      churned: countDistinct(churnEvents, (c) => c.customer, (c) => c.at, bStart, bEnd),
      trialStarted: 0,
      cohortPaid: 0,
      routesAdded: emptyRoutes(),
      routesPaid: emptyRoutes(),
      segments: emptySegments(),
    };
    if (blockedSince && blockedSince < bEnd) {
      row.blocked = countDistinct(unfollows, (u) => u.friend_id as string, (u) => sec(u.created_at), bStart, bEnd);
      row.net = row.friendsAdded - row.blocked;
    }

    for (const f of cohort) {
      row.routesAdded[routeOf(f).group] += 1;
      const c = f.line_user_id ? customers.get(f.line_user_id) : undefined;
      const paid = !!f.line_user_id && firstPaid.has(f.line_user_id);
      if (paid || c?.key_code_issued === 1) row.trialStarted += 1;
      if (paid) row.cohortPaid += 1;
      row.segments[segmentGroupOf(paid, f.is_following === 1, c)] += 1;
    }
    for (const [line, at] of firstPaid) {
      if (at >= bStart && at < bEnd) row.routesPaid[routeOf(friendByLine.get(line)).group] += 1;
    }
    buckets.push(row);
  }

  // 流入経路ごとの合計（期間内）
  const rangeStart = `${start}T00:00:00`;
  const rangeCut = cutOf(end);
  const detail = new Map<string, { route: string; group: RouteGroup; added: number; paid: number }>();
  const bump = (f: FriendRow | undefined, key: 'added' | 'paid') => {
    const r = routeOf(f);
    const e = detail.get(r.label) ?? { route: r.label, group: r.group, added: 0, paid: 0 };
    e[key] += 1;
    detail.set(r.label, e);
  };
  for (const f of friends) {
    const at = sec(f.created_at);
    if (at >= rangeStart && at < rangeCut) bump(f, 'added');
  }
  for (const [line, at] of firstPaid) if (at >= rangeStart && at < rangeCut) bump(friendByLine.get(line), 'paid');

  // カード: 期間内の合計と期間末の値。前の期間は同じ日数だけ前にずらす（今日を含むときは前の期間も同じ時刻まで）
  const prevStart = `${addDays(start, -days)}T00:00:00`;
  const prevCut = shiftDays(rangeCut, -days);
  const addedIn = (from: string, to: string) =>
    friends.filter((f) => {
      const at = sec(f.created_at);
      return at >= from && at < to;
    }).length;
  const blockedIn = (from: string, to: string) =>
    blockedSince && blockedSince < to ? countDistinct(unfollows, (u) => u.friend_id as string, (u) => sec(u.created_at), from, to) : null;
  const churnedIn = (from: string, to: string) => countDistinct(churnEvents, (c) => c.customer, (c) => c.at, from, to);
  const flow = (f: (from: string, to: string) => number | null): CardMetric => ({ value: f(rangeStart, rangeCut), prev: all ? null : f(prevStart, prevCut) });
  const netIn = (from: string, to: string) => {
    const b = blockedIn(from, to);
    return b === null ? null : addedIn(from, to) - b;
  };
  const cur = membersAt(spans, invoicesBySub, rangeCut);
  const prev = all ? null : membersAt(spans, invoicesBySub, prevCut);

  return {
    range: {
      start,
      end,
      all,
      granularity,
      prevStart: all ? null : prevStart.slice(0, 10),
      prevEnd: all ? null : addDays(start, -1),
      asOf: now19,
      dataStart,
      blockedSince,
    },
    buckets,
    cards: {
      friendsAdded: flow(addedIn),
      net: flow(netIn),
      members: { value: cur.members, prev: prev?.members ?? null },
      mrr: { value: cur.mrr, prev: prev?.mrr ?? null },
      newPaid: flow(newPaidIn),
      churned: flow(churnedIn),
    },
    routeDetail: [...detail.values()].sort((a, b) => b.added - a.added || b.paid - a.paid),
  };
}

function segmentGroupOf(paid: boolean, following: boolean, c: CustomerRow | undefined): SegmentGroup {
  if (paid) return '有料化';
  if (!following) return 'ブロック';
  if (!c) return 'セグメント1';
  const s = segmentOf(c);
  if (s === null) return '対象外';
  if (s >= 5) return 'セグメント5〜8';
  return `セグメント${s}` as SegmentGroup;
}
