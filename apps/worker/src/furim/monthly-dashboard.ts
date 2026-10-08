// 月次ダッシュボード（TB-1189）。今年 1 月〜今月を月ごとに、友だち追加・ブロック・月額会員・MRR・新規加入・解約・
// 友だち追加月ごとのファネル（試用開始・有料化）・流入経路別・セグメント別を出す。読み取りだけ。
// 行数が少ない（友だち・請求とも数千）ので、生の行を読んで JS で数える。定義を 1 か所に置いてテストで固めるため。
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

export type MonthRow = {
  t: string;
  friendsAdded: number;
  /** ブロックの記録（ブロック時フローの実行ログ）が無い月は null */
  blocked: number | null;
  net: number | null;
  members: number;
  mrr: number;
  newPaid: number;
  churned: number;
  /** 以下はこの月に友だち追加した人の、いま時点の到達（コホート） */
  trialStarted: number;
  cohortPaid: number;
  routesAdded: Record<RouteGroup, number>;
  routesPaid: Record<RouteGroup, number>;
  segments: Record<SegmentGroup, number>;
};

export type CardMetric = { value: number | null; prev: number | null };

export type MonthlyDashboard = {
  range: { from: string; to: string; asOf: string; blockedSince: string | null };
  months: MonthRow[];
  /** 今月の値と比べる先。流れ（追加・加入・解約）は前月の同じ日まで、在庫（会員・MRR）は前月末 */
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
type CancelRow = { line_user_id: string | null; subscription_id: string | null; canceled_at: string };

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM' の n か月後 */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** 'YYYY-MM-DDTHH:MM:SS' の 1 か月前（月末は丸める。10/31 → 9/30） */
export function oneMonthBefore(s19: string): string {
  const ym = addMonths(s19.slice(0, 7), -1);
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = Math.min(Number(s19.slice(8, 10)), last);
  return `${ym}-${pad(day)}${s19.slice(10)}`;
}

/** その日時までの同じ日・時刻を前月に置いた値（前月同日比の境目） */
const sameTimePrevMonth = oneMonthBefore;

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
const RECURRING_REASONS = new Set(['subscription_create', 'subscription_cycle']);
const SWITCH_WINDOW_MS = 7 * 86400_000;
const ms = (s19: string) => Date.parse(`${s19}+09:00`);

/**
 * 月額会員と MRR（区間 [start, end) に 0 円でない定期の請求があった人）。
 * 月額なので、月内に払った人は月末時点で払った期間の中にいる。今月は「いまから 1 か月前〜いま」で数える
 */
function membersIn(payments: PaymentRow[], start: string, end: string): { members: number; mrr: number } {
  const people = new Set<string>();
  const latestBySub = new Map<string, PaymentRow>();
  for (const p of payments) {
    const at = sec(p.paid_at);
    if (at < start || at >= end) continue;
    people.add(p.line_user_id ?? '');
    if (!RECURRING_REASONS.has(p.billing_reason ?? '')) continue;
    const key = p.subscription_id ?? `${p.line_user_id}`;
    const cur = latestBySub.get(key);
    if (!cur || sec(cur.paid_at) < at) latestBySub.set(key, p);
  }
  let mrr = 0;
  for (const p of latestBySub.values()) mrr += Number(p.price_excl_tax ?? 0);
  return { members: people.size, mrr };
}

export async function buildMonthlyDashboard(db: D1Database, nowIso: string, fromMonth: string): Promise<MonthlyDashboard> {
  const now19 = sec(nowIso);
  const toMonth = now19.slice(0, 7);

  const [friendsRes, customersRes, paymentsRes, cancelsRes, unfollowRes, routesRes, affLinksRes, referralsRes] = await Promise.all([
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
    db.prepare('SELECT line_user_id, subscription_id, canceled_at FROM furim_cancellations').all<CancelRow>(),
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
  const cancels = (cancelsRes.results ?? []).filter((c) => !isExcluded(c.line_user_id));
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

  // 初めて 0 円でない定期の請求があった日時（新規加入・有料化の判定）
  const firstPaid = new Map<string, string>();
  for (const p of payments) {
    const id = p.line_user_id as string;
    const at = sec(p.paid_at);
    const cur = firstPaid.get(id);
    if (!cur || at < cur) firstPaid.set(id, at);
  }

  // 解約: サブスクが終わった人。前後 7 日に別のサブスクで請求があった人はプランの切り替えなので数えない
  const paymentsByLine = new Map<string, PaymentRow[]>();
  for (const p of payments) {
    const list = paymentsByLine.get(p.line_user_id as string) ?? [];
    list.push(p);
    paymentsByLine.set(p.line_user_id as string, list);
  }
  const churnEvents: Array<{ line: string; at: string }> = [];
  for (const c of cancels) {
    if (!c.line_user_id) continue;
    const at = sec(c.canceled_at);
    const switched = (paymentsByLine.get(c.line_user_id) ?? []).some(
      (p) => (p.subscription_id ?? '') !== (c.subscription_id ?? '#') && Math.abs(ms(sec(p.paid_at)) - ms(at)) <= SWITCH_WINDOW_MS,
    );
    if (!switched) churnEvents.push({ line: c.line_user_id, at });
  }

  const blockedSince = unfollows.reduce<string | null>((min, u) => {
    const at = sec(u.created_at);
    return !min || at < min ? at : min;
  }, null);
  const blockedSinceMonth = blockedSince?.slice(0, 7) ?? null;

  const countDistinct = <T>(rows: T[], keyOf: (r: T) => string, atOf: (r: T) => string, start: string, end: string) => {
    const s = new Set<string>();
    for (const r of rows) {
      const at = atOf(r);
      if (at >= start && at < end) s.add(keyOf(r));
    }
    return s.size;
  };

  const months: MonthRow[] = [];
  for (let t = fromMonth; t <= toMonth; t = addMonths(t, 1)) {
    const start = `${t}-01T00:00:00`;
    const end = t === toMonth ? '9999' : `${addMonths(t, 1)}-01T00:00:00`;
    const memberStart = t === toMonth ? oneMonthBefore(now19) : start;

    const cohort = friends.filter((f) => monthOf(f.created_at) === t);
    const row: MonthRow = {
      t,
      friendsAdded: cohort.length,
      blocked: null,
      net: null,
      ...membersIn(payments, memberStart, end),
      newPaid: [...firstPaid.values()].filter((at) => at >= start && at < end).length,
      churned: countDistinct(churnEvents, (c) => c.line, (c) => c.at, start, end),
      trialStarted: 0,
      cohortPaid: 0,
      routesAdded: emptyRoutes(),
      routesPaid: emptyRoutes(),
      segments: emptySegments(),
    };
    if (blockedSinceMonth && t >= blockedSinceMonth) {
      row.blocked = countDistinct(unfollows, (u) => u.friend_id as string, (u) => sec(u.created_at), start, end);
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
      if (at >= start && at < end) row.routesPaid[routeOf(friendByLine.get(line)).group] += 1;
    }
    months.push(row);
  }

  // 流入経路ごとの合計（期間内）
  const detail = new Map<string, { route: string; group: RouteGroup; added: number; paid: number }>();
  const rangeStart = `${fromMonth}-01T00:00:00`;
  const bump = (f: FriendRow | undefined, key: 'added' | 'paid') => {
    const r = routeOf(f);
    const e = detail.get(r.label) ?? { route: r.label, group: r.group, added: 0, paid: 0 };
    e[key] += 1;
    detail.set(r.label, e);
  };
  for (const f of friends) if (sec(f.created_at) >= rangeStart) bump(f, 'added');
  for (const [line, at] of firstPaid) if (at >= rangeStart) bump(friendByLine.get(line), 'paid');

  // カード: 流れは前月の同じ日時まで、在庫は前月末と比べる
  const prevCut = sameTimePrevMonth(now19);
  const prevMonthStart = `${addMonths(toMonth, -1)}-01T00:00:00`;
  const thisMonthStart = `${toMonth}-01T00:00:00`;
  const cur = months[months.length - 1];
  const prev = months.length >= 2 ? months[months.length - 2] : null;
  const addedPrev = friends.filter((f) => {
    const at = sec(f.created_at);
    return at >= prevMonthStart && at < prevCut;
  }).length;
  const blockedPrev =
    blockedSinceMonth && addMonths(toMonth, -1) >= blockedSinceMonth
      ? countDistinct(unfollows, (u) => u.friend_id as string, (u) => sec(u.created_at), prevMonthStart, prevCut)
      : null;
  const prevMembers = membersIn(payments, prevMonthStart, thisMonthStart);

  return {
    range: { from: fromMonth, to: toMonth, asOf: now19, blockedSince },
    months,
    cards: {
      friendsAdded: { value: cur.friendsAdded, prev: addedPrev },
      net: { value: cur.net, prev: blockedPrev === null ? null : addedPrev - blockedPrev },
      members: { value: cur.members, prev: prev ? prevMembers.members : null },
      mrr: { value: cur.mrr, prev: prev ? prevMembers.mrr : null },
      newPaid: { value: cur.newPaid, prev: [...firstPaid.values()].filter((at) => at >= prevMonthStart && at < prevCut).length },
      churned: { value: cur.churned, prev: countDistinct(churnEvents, (c) => c.line, (c) => c.at, prevMonthStart, prevCut) },
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
