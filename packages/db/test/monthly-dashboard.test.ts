import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { addMonths, buildMonthlyDashboard, oneMonthBefore, routeGroupOf } from '../../../apps/worker/src/furim/monthly-dashboard.js';

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
    const r = await buildMonthlyDashboard(asD1(sqlite), '2026-10-08T09:00:00.000+09:00', '2026-07');

    expect(r.range).toMatchObject({ from: '2026-07', to: '2026-10', blockedSince: '2026-08-25T10:00:00' });
    const [jul, aug, sep, oct] = r.months;
    expect(r.months.map((m) => m.t)).toEqual(['2026-07', '2026-08', '2026-09', '2026-10']);

    // ブロックの記録が始まる前の月は null
    expect(jul).toMatchObject({ friendsAdded: 0, blocked: null, net: null });
    expect(aug).toMatchObject({ friendsAdded: 2, blocked: 1, net: 1 });
    expect(sep).toMatchObject({ friendsAdded: 2, blocked: 0, net: 2 });
    expect(oct).toMatchObject({ friendsAdded: 1, blocked: 1, net: 0 });

    // 会員: 月内に 0 円でない定期の請求があった人。MRR はサブスクごとの直近の定期請求（税抜）
    expect(aug).toMatchObject({ members: 3, mrr: 3980 + 5980 + 1980 });
    expect(sep).toMatchObject({ members: 4, mrr: 8980 + 3980 + 5980 + 5980 });
    // 今月は「いまから 1 か月前〜いま」（9/8 09:00 以降）。U7 は 9/15、U8 は 9/20 に払っているので入る
    expect(oct).toMatchObject({ members: 4, mrr: 8980 + 3980 + 5980 + 5980 });

    // 新規加入: 初めての 0 円でない定期の請求。U1 は 0 円の 8 月ではなく 9 月
    expect(aug.newPaid).toBe(3); // U6・U7・U8（データ上の初回が 8 月）
    expect(sep.newPaid).toBe(1);
    expect(oct.newPaid).toBe(0);
    // 解約: U7 は 10 月。U8 は前後 7 日に別サブスクの請求があるので切り替えとして数えない
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

  test('カードは流れを前月の同じ日時まで、在庫を前月末と比べる', async () => {
    const sqlite = setupDb();
    seed(sqlite);
    const r = await buildMonthlyDashboard(asD1(sqlite), '2026-10-08T09:00:00.000+09:00', '2026-01');
    expect(r.cards.friendsAdded).toEqual({ value: 1, prev: 1 }); // 9/1〜9/8 09:00 は U3 だけ
    expect(r.cards.members).toEqual({ value: 4, prev: 4 });
    expect(r.cards.newPaid).toEqual({ value: 0, prev: 0 });
    expect(r.cards.churned).toEqual({ value: 1, prev: 0 });
    expect(r.cards.net).toEqual({ value: 0, prev: 1 });
  });

  test('流入経路ごとの合計（検証用アカウントは入らない）', async () => {
    const sqlite = setupDb();
    seed(sqlite);
    const r = await buildMonthlyDashboard(asD1(sqlite), '2026-10-08T09:00:00.000+09:00', '2026-01');
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
    expect(oneMonthBefore('2026-10-31T10:00:00')).toBe('2026-09-30T10:00:00');
    expect(oneMonthBefore('2026-03-08T09:00:00')).toBe('2026-02-08T09:00:00');
    expect(routeGroupOf('org_x', false)).toBe('運用（SEO・SNS）');
    expect(routeGroupOf('', false)).toBe('経路なし');
    expect(routeGroupOf('ad_meta', true)).toBe('紹介');
  });
});
