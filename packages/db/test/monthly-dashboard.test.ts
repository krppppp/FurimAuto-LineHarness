import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { addDays, addMonths, bucketsOf, buildMonthlyDashboard, granularityOf, routeGroupOf, type StripeSub } from '../../../apps/worker/src/furim/monthly-dashboard.js';

const TEST_LINE = 'Ue4941a030cb2ec8758095fb0fffff344';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE friends (id TEXT PRIMARY KEY, line_user_id TEXT, created_at TEXT, ref_code TEXT, is_following INTEGER DEFAULT 1);
    CREATE TABLE furim_customers (line_user_id TEXT PRIMARY KEY, key_code_issued INTEGER DEFAULT 0, survey_answer TEXT, device_activated INTEGER DEFAULT 0,
      device_code TEXT, mercari_url TEXT, free30_ticket INTEGER DEFAULT 0, youtube_coupon TEXT, extend_keyword TEXT);
    CREATE TABLE furim_payments (invoice_id TEXT PRIMARY KEY, line_user_id TEXT, subscription_id TEXT, billing_reason TEXT, price_excl_tax INTEGER, actual_paid_amount INTEGER, paid_at TEXT);
    CREATE TABLE furim_cancellations (id TEXT PRIMARY KEY, line_user_id TEXT, subscription_id TEXT, canceled_at TEXT);
    CREATE TABLE automations (id TEXT PRIMARY KEY, event_type TEXT);
    CREATE TABLE automation_logs (id TEXT PRIMARY KEY, automation_id TEXT, friend_id TEXT, created_at TEXT);
    CREATE TABLE entry_routes (ref_code TEXT, name TEXT);
    CREATE TABLE affiliate_links (ref_code TEXT);
    CREATE TABLE furim_referrals (introduced_friend_id TEXT);
  `);
  return db;
}

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      return {
        async all<T>() {
          return { results: sqlite.prepare(query).all() as T[], success: true, meta: {} };
        },
      };
    },
  } as unknown as D1Database;
}

const unix = (jst: string) => Date.parse(`${jst}+09:00`) / 1000;
const sub = (id: string, customer: string, status: string, start: string, trialEnd: string | null, ended: string | null): StripeSub => ({
  id,
  customer,
  status,
  start_date: unix(start),
  trial_end: trialEnd ? unix(trialEnd) : null,
  ended_at: ended ? unix(ended) : null,
});

// Stripe のサブスク一覧（会員数・新規加入・解約はこちらで数える）
const SUBS: StripeSub[] = [
  sub('sub1', 'cus1', 'active', '2026-08-10T10:00:00', '2026-09-10T10:00:00', null), // 試用 1 か月のあと有料
  sub('sub6', 'cus6', 'active', '2025-03-01T09:00:00', null, null),
  sub('sub7', 'cus7', 'canceled', '2025-04-15T08:00:00', null, '2026-10-05T08:00:00'),
  sub('sub8a', 'cus8', 'canceled', '2025-05-20T08:00:00', null, '2026-09-20T08:05:00'), // 同じ日に sub8b へ切り替え
  sub('sub8b', 'cus8', 'active', '2026-09-20T08:00:00', null, null),
  sub('sub9', 'cus9', 'past_due', '2026-07-01T09:00:00', null, null), // 支払い遅れも Stripe の画面では有効
  sub('sub10', 'cus10', 'trialing', '2026-10-03T09:00:00', '2026-10-10T09:00:00', null), // 試用中は数えない
  sub('sub11', 'cus11', 'incomplete_expired', '2026-09-01T09:00:00', null, null), // 初回の支払いが通らなかった
  sub('sub12', 'cus12', 'canceled', '2026-09-02T09:00:00', '2026-09-09T09:00:00', '2026-09-05T09:00:00'), // 試用中に解約
];

function seed(db: Database.Database) {
  const friend = db.prepare('INSERT INTO friends VALUES (?, ?, ?, ?, ?)');
  friend.run('f1', 'U1', '2026-08-03T10:00:00.000+09:00', 'ad_google_search', 1); // 8 月追加 → 9 月に有料
  friend.run('f2', 'U2', '2026-08-20 12:00:00', 'org_seo', 0); // 8 月追加・ブロック
  friend.run('f3', 'U3', '2026-09-05T09:00:00.000+09:00', null, 1); // 9 月追加・紹介
  friend.run('f4', 'U4', '2026-09-28T09:00:00.000+09:00', 'ext_popup', 1); // 9 月追加・キーコード発行だけ
  friend.run('f5', 'U5', '2026-10-02T09:00:00.000+09:00', 'Ab12Cd', 1); // 10 月追加・紹介リンク
  friend.run('f6', 'U6', '2025-03-01T09:00:00.000+09:00', null, 1); // 古い会員
  friend.run('f7', 'U7', '2025-04-01T09:00:00.000+09:00', null, 1); // 古い会員・9 月に解約
  friend.run('f8', 'U8', '2025-05-01T09:00:00.000+09:00', null, 1); // 古い会員・プラン切り替え
  friend.run('ft', TEST_LINE, '2026-09-10T09:00:00.000+09:00', 'ad_google_search', 1); // 検証用は数えない

  const cust = db.prepare('INSERT INTO furim_customers (line_user_id, key_code_issued, survey_answer, device_code, mercari_url) VALUES (?, ?, ?, ?, ?)');
  cust.run('U1', 1, 'a', 'dev', 'https://jp.mercari.com/user/1');
  cust.run('U2', 1, 'a', null, null);
  cust.run('U3', 0, 'a', null, null);
  cust.run('U4', 1, 'a', null, null);
  cust.run('U5', 0, null, null, null);

  const pay = db.prepare('INSERT INTO furim_payments VALUES (?, ?, ?, ?, ?, ?, ?)');
  pay.run('i1', 'U1', 'sub1', 'subscription_create', 0, 0, '2026-08-10T10:00:00+09:00'); // Stripe 試用の 0 円は数えない
  pay.run('i2', 'U1', 'sub1', 'subscription_cycle', 8980, 9878, '2026-09-10T10:00:00+09:00');
  pay.run('i3', 'U1', 'sub1', 'subscription_cycle', 8980, 9878, '2026-10-07T10:00:00+09:00');
  for (const [i, m] of ['2026-08', '2026-09', '2026-10'].entries()) pay.run(`u6-${i}`, 'U6', 'sub6', 'subscription_cycle', 3980, 4378, `${m}-01T08:00:00+09:00`);
  pay.run('u7-8', 'U7', 'sub7', 'subscription_cycle', 5980, 6578, '2026-08-15T08:00:00+09:00');
  pay.run('u7-9', 'U7', 'sub7', 'subscription_cycle', 5980, 6578, '2026-09-15T08:00:00+09:00');
  pay.run('u8-8', 'U8', 'sub8a', 'subscription_cycle', 1980, 2178, '2026-08-20T08:00:00+09:00');
  pay.run('u8-9', 'U8', 'sub8b', 'subscription_create', 5980, 6578, '2026-09-20T08:00:00+09:00');
  pay.run('u8-9u', 'U8', 'sub8b', 'subscription_update', 1000, 1100, '2026-09-25T08:00:00+09:00');
  pay.run('ut', TEST_LINE, 'subt', 'subscription_create', 8980, 9878, '2026-09-11T08:00:00+09:00');
  pay.run('tk', 'U4', null, 'manual', 980, 1078, '2026-10-01T08:00:00+09:00'); // チケットは定期ではない
  pay.run('u9', null, 'sub9', 'subscription_cycle', 2980, 3278, '2026-09-25T08:00:00+09:00'); // LINE と紐づいていない請求も MRR には入れる

  const cancel = db.prepare('INSERT INTO furim_cancellations VALUES (?, ?, ?, ?)');
  cancel.run('c7', 'U7', 'sub7', '2026-10-05T08:00:00.000+09:00'); // 10 月にサブスク終了
  cancel.run('c8', 'U8', 'sub8a', '2026-09-20T08:05:00.000+09:00'); // 同じ日に別サブスクで請求 → 切り替え

  db.prepare("INSERT INTO automations VALUES ('a-unf', 'unfollow'), ('a-add', 'friend_add')").run();
  const log = db.prepare('INSERT INTO automation_logs VALUES (?, ?, ?, ?)');
  log.run('l1', 'a-unf', 'f2', '2026-08-25T10:00:00.000+09:00');
  log.run('l2', 'a-unf', 'f6', '2026-10-03T10:00:00.000+09:00');
  log.run('l3', 'a-add', 'f1', '2026-08-03T10:00:00.000+09:00');

  db.prepare("INSERT INTO entry_routes VALUES ('ad_google_search', '広告_Google検索'), ('org_seo', '運用_SEO'), ('ext_popup', '拡張_ポップアップ')").run();
  db.prepare("INSERT INTO affiliate_links VALUES ('Ab12Cd')").run();
  db.prepare("INSERT INTO furim_referrals VALUES ('f3')").run();
}

describe('月次ダッシュボード（TB-1189）', () => {
  test('月ごとの友だち追加・ブロック・会員・MRR・新規加入・解約・ファネル', async () => {
    const sqlite = setupDb();
    seed(sqlite);
    const r = await buildMonthlyDashboard(asD1(sqlite), SUBS, '2026-10-08T09:00:00.000+09:00', { start: '2026-01-01', end: '2026-10-08' });

    expect(r.range).toMatchObject({ start: '2026-01-01', end: '2026-10-08', granularity: 'month', blockedSince: '2026-08-25T10:00:00' });
    expect(r.buckets.map((m) => m.t)).toEqual(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'].map((m) => `2026-${m}`));
    const [jul, aug, sep, oct] = r.buckets.slice(6);

    // ブロックの記録が始まる前の月は null
    expect(jul).toMatchObject({ friendsAdded: 0, blocked: null, net: null });
    expect(aug).toMatchObject({ friendsAdded: 2, blocked: 1, net: 1 });
    expect(sep).toMatchObject({ friendsAdded: 2, blocked: 0, net: 2 });
    expect(oct).toMatchObject({ friendsAdded: 1, blocked: 1, net: 0 });

    // 会員: 月末時点で Stripe のサブスクが有料の期間（active・past_due）にある顧客。試用中・incomplete・試用中の解約は入らない
    // MRR: その会員のサブスクごとの、月末までの直近の定期請求（create・cycle。割引後・税抜）。請求が無ければ 0
    expect(jul).toMatchObject({ members: 4, mrr: 0 }); // 4 人とも 7 月末までの請求が D1 に無い（sub6 の初回は 8/1）
    expect(aug).toMatchObject({ members: 4, mrr: 3980 + 5980 + 1980 + 0 }); // sub9 の請求は 9/25
    expect(sep).toMatchObject({ members: 5, mrr: 8980 + 3980 + 5980 + 5980 + 2980 });
    // 今月はいまの時点。sub7 は 10/5 に終わったので入らない
    expect(oct).toMatchObject({ members: 4, mrr: 8980 + 3980 + 5980 + 2980 });

    // 新規加入: Stripe の顧客が初めて有料の期間に入った月。cus1 は試用が終わった 9 月
    expect(jul.newPaid).toBe(1); // cus9
    expect(aug.newPaid).toBe(0);
    expect(sep.newPaid).toBe(1);
    expect(oct.newPaid).toBe(0);
    // 解約: cus7 は 10 月。cus8 は同じ日に別のサブスクが始まっているので切り替えとして数えない。cus12 は有料にならずに終わった
    expect(sep.churned).toBe(0);
    expect(oct.churned).toBe(1);

    // コホート: 8 月追加の 2 人とも試用開始、U1 だけ有料化
    expect(aug).toMatchObject({ trialStarted: 2, cohortPaid: 1 });
    expect(sep).toMatchObject({ trialStarted: 1, cohortPaid: 0 });
    expect(aug.segments).toMatchObject({ 有料化: 1, ブロック: 1 });
    expect(sep.segments).toMatchObject({ セグメント2: 1, セグメント3: 1 });
    expect(oct.segments).toMatchObject({ セグメント1: 1 });

    expect(aug.routesAdded).toMatchObject({ 広告: 1, '運用（SEO・SNS）': 1 });
    expect(sep.routesAdded).toMatchObject({ 紹介: 1, 拡張機能: 1 });
    expect(oct.routesAdded).toMatchObject({ 紹介: 1 });
    expect(sep.routesPaid).toMatchObject({ 広告: 1 });
    expect(aug.routesPaid).toMatchObject({ 経路なし: 3 });
  });

  test('カードは期間内の合計・期間末の値を、ひとつ前の同じ長さの期間と比べる', async () => {
    const sqlite = setupDb();
    seed(sqlite);
    // 今月（現在まで）= 10/1〜10/8 09:00 の 8 日間。前の期間は 9/23〜9/30 09:00
    const r = await buildMonthlyDashboard(asD1(sqlite), SUBS, '2026-10-08T09:00:00.000+09:00', { start: '2026-10-01', end: '2026-10-08' });
    expect(r.range).toMatchObject({ granularity: 'day', prevStart: '2026-09-23', prevEnd: '2026-09-30', asOf: '2026-10-08T09:00:00' });
    expect(r.buckets).toHaveLength(8);
    expect(r.cards.friendsAdded).toEqual({ value: 1, prev: 1 }); // 前の期間は U4（9/28）
    expect(r.cards.members).toEqual({ value: 4, prev: 5 }); // 9/30 09:00 時点
    expect(r.cards.mrr).toEqual({ value: 8980 + 3980 + 5980 + 2980, prev: 8980 + 3980 + 5980 + 5980 + 2980 });
    expect(r.cards.newPaid).toEqual({ value: 0, prev: 0 });
    expect(r.cards.churned).toEqual({ value: 1, prev: 0 });
    expect(r.cards.net).toEqual({ value: 0, prev: 1 });
  });

  test('過去の範囲は期間の終わりの日の 24 時までで数え、前の期間は始まりの直前まで', async () => {
    const sqlite = setupDb();
    seed(sqlite);
    // 9/1〜9/30 の 30 日 → 日ごと。前の期間は 8/2〜8/31
    const r = await buildMonthlyDashboard(asD1(sqlite), SUBS, '2026-10-08T09:00:00.000+09:00', { start: '2026-09-01', end: '2026-09-30' });
    expect(r.range).toMatchObject({ granularity: 'day', prevStart: '2026-08-02', prevEnd: '2026-08-31' });
    expect(r.cards.friendsAdded).toEqual({ value: 2, prev: 2 });
    expect(r.cards.members).toEqual({ value: 5, prev: 4 }); // 10/1 0:00 と 9/1 0:00
    expect(r.cards.newPaid).toEqual({ value: 1, prev: 0 });
    const d10 = r.buckets.find((b) => b.t === '2026-09-10');
    expect(d10).toMatchObject({ newPaid: 1, members: 5 }); // cus1 の試用が 9/10 10:00 に終わる
    expect(r.buckets.find((b) => b.t === '2026-09-09')).toMatchObject({ members: 4 });
  });

  test('週ごと（月曜はじまり・端は範囲で切る）', async () => {
    const sqlite = setupDb();
    seed(sqlite);
    // 8/5（水）〜10/8 の 65 日 → 週ごと
    const r = await buildMonthlyDashboard(asD1(sqlite), SUBS, '2026-10-08T09:00:00.000+09:00', { start: '2026-08-05', end: '2026-10-08' });
    expect(r.range.granularity).toBe('week');
    expect(r.buckets[0]).toMatchObject({ t: '2026-08-05', start: '2026-08-05', end: '2026-08-09' });
    expect(r.buckets[1]).toMatchObject({ t: '2026-08-10', end: '2026-08-16' });
    expect(r.buckets[r.buckets.length - 1]).toMatchObject({ t: '2026-10-05', end: '2026-10-08' });
    expect(r.buckets.reduce((a, b) => a + b.friendsAdded, 0)).toBe(4); // f1（8/3）は範囲外
    expect(r.buckets.find((b) => b.t === '2026-09-07')).toMatchObject({ newPaid: 1 });
  });

  test('全期間はデータのある最初の日（友だち・Stripe の古い方）から。前の期間は無い', async () => {
    const sqlite = setupDb();
    seed(sqlite);
    const r = await buildMonthlyDashboard(asD1(sqlite), SUBS, '2026-10-08T09:00:00.000+09:00', { start: 'all', end: '2026-10-08' });
    expect(r.range).toMatchObject({ start: '2025-03-01', end: '2026-10-08', granularity: 'month', all: true, prevStart: null, prevEnd: null, dataStart: '2025-03-01' });
    expect(r.buckets[0].t).toBe('2025-03');
    expect(r.cards.friendsAdded).toEqual({ value: 8, prev: null });
    expect(r.cards.members).toEqual({ value: 4, prev: null });
  });

  test('流入経路ごとの合計（検証用アカウントは入らない）', async () => {
    const sqlite = setupDb();
    seed(sqlite);
    const r = await buildMonthlyDashboard(asD1(sqlite), SUBS, '2026-10-08T09:00:00.000+09:00', { start: '2026-01-01', end: '2026-10-08' });
    expect(r.routeDetail).toEqual(
      expect.arrayContaining([
        { route: '広告_Google検索', group: '広告', added: 1, paid: 1 },
        { route: '紹介', group: '紹介', added: 2, paid: 0 },
        { route: '運用_SEO', group: '運用（SEO・SNS）', added: 1, paid: 0 },
        { route: '拡張_ポップアップ', group: '拡張機能', added: 1, paid: 0 },
        { route: '(経路なし)', group: '経路なし', added: 0, paid: 3 },
      ]),
    );
    expect(r.routeDetail).toHaveLength(5);
  });

  test('日付のずらし', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(granularityOf('2026-10-01', '2026-10-31')).toBe('day');
    expect(granularityOf('2026-04-09', '2026-10-08')).toBe('week'); // 過去 6 か月
    expect(granularityOf('2025-10-09', '2026-10-08')).toBe('month');
    expect(bucketsOf('2026-09-29', '2026-10-02', 'month').map((b) => [b.t, b.start, b.end])).toEqual([
      ['2026-09', '2026-09-29', '2026-09-30'],
      ['2026-10', '2026-10-01', '2026-10-02'],
    ]);
    expect(routeGroupOf('org_x', false)).toBe('運用（SEO・SNS）');
    expect(routeGroupOf('', false)).toBe('経路なし');
    expect(routeGroupOf('ad_meta', true)).toBe('紹介');
  });
});
