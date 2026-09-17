import { describe, it, expect } from 'vitest';
import { applyAcks, furimDashboard, jstHoursAgo, parseGranularity, parsePeriod, rangeStart, type AnomalyItem } from './furim-dashboard.js';

type Canned = { match: RegExp; all?: unknown[]; first?: unknown; throws?: string };

function makeDb(canned: Canned[], captured: Array<{ sql: string; binds: unknown[] }> = []) {
  const find = (sql: string) => canned.find((c) => c.match.test(sql));
  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        binds: [] as unknown[],
        bind(...args: unknown[]) {
          stmt.binds = args;
          return stmt;
        },
        async all() {
          const c = find(sql);
          if (c?.throws) throw new Error(c.throws);
          captured.push({ sql, binds: stmt.binds });
          return { results: c?.all ?? [] };
        },
        async first() {
          const c = find(sql);
          if (c?.throws) throw new Error(c.throws);
          captured.push({ sql, binds: stmt.binds });
          return c?.first ?? null;
        },
        async run() {
          captured.push({ sql, binds: stmt.binds });
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    async batch(stmts: Array<{ sql: string; binds: unknown[] }>) {
      for (const s of stmts) captured.push({ sql: s.sql, binds: s.binds });
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  };
  return { db: db as unknown as D1Database, captured };
}

const baseCanned: Canned[] = [
  { match: /FROM friends\s+WHERE/, all: [{ t: '2026-08', route: 'ext_popup', n: 90 }, { t: '2026-08', route: 'lp', n: 10 }] },
  { match: /JOIN ref_tracking/, all: [{ t: '2026-08', n: 30 }] },
  { match: /FROM entry_routes/, all: [{ ref_code: 'ext_popup', name: '拡張ポップアップ' }] },
  { match: /is_following = 1/, first: { n: 812 } },
  { match: /is_following = 0/, first: { n: 40 } },
  { match: /FROM furim_payments\s+WHERE/, all: [{ t: '2026-08', invoices: 80, payers: 78, excl_tax: 500000, incl_tax: 550000, new_paid: 5 }] },
  { match: /WITH first_paid AS/, all: [{ t: '2026-08', n: 5 }] },
  { match: /FROM furim_customers[\s\S]*plan_label, ''\) <> ''/, first: { n: 82 } },
  { match: /FROM furim_cancellations/, all: [{ t: '2026-08', n: 3 }] },
  { match: /FROM furim_ad_spend WHERE date/, all: [{ t: '2026-08', cost: 90000, clicks: 300, impressions: 9000 }] },
  { match: /MAX\(imported_at\)/, first: { m: '2026-09-16T04:10:00.000+09:00' } },
  { match: /MAX\(date\) AS d/, first: { d: '2026-09-16' } },
  { match: /plan_label, ''\) = ''/, first: { active: 12, ending: 4 } },
  { match: /SELECT\s+\(SELECT COUNT\(DISTINCT line_user_id\)/, first: { payers: 100, created: 100 } },
  { match: /FROM furim_anomaly_acks/, all: [] },
];

const req = (q = '') => furimDashboard.request(`/api/furim/dashboard${q}`, {}, { DB: makeDb(baseCanned).db } as never);

describe('GET /api/furim/dashboard', () => {
  it('既定は 月 × 1年。6 区画をまとめて返す', async () => {
    const res = await req();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { range: { granularity: string; period: string }; sections: Record<string, { ok: boolean }> };
    expect(body.range.granularity).toBe('month');
    expect(body.range.period).toBe('1y');
    expect(Object.keys(body.sections).sort()).toEqual(['adSpend', 'anomalies', 'automation', 'churn', 'friends', 'revenue', 'trial']);
    for (const [name, s] of Object.entries(body.sections)) expect(s.ok, name).toBe(true);
  });

  it('流入コードは entry_routes の名前に置き換え、広告経由の件数を別に持つ', async () => {
    const res = await req('?granularity=month&period=1y');
    const body = (await res.json()) as { sections: { friends: { series: Array<{ t: string; total: number; fromAds: number; byRoute: Record<string, number> }> } } };
    const aug = body.sections.friends.series.find((s) => s.t === '2026-08')!;
    expect(aug.total).toBe(100);
    expect(aug.fromAds).toBe(30);
    expect(aug.byRoute).toEqual({ 拡張ポップアップ: 90, lp: 10 });
  });

  it('1 区画が落ちても他の区画は返り、落ちた区画だけ ok:false になる', async () => {
    const canned = baseCanned.map((c) => (/FROM furim_cancellations/.test(String(c.match)) ? { ...c, throws: 'no such table' } : c));
    const res = await furimDashboard.request('/api/furim/dashboard', {}, { DB: makeDb(canned).db } as never);
    const body = (await res.json()) as { sections: { churn: { ok: boolean; error?: string }; friends: { ok: boolean } } };
    expect(body.sections.churn.ok).toBe(false);
    expect(body.sections.churn.error).toContain('no such table');
    expect(body.sections.friends.ok).toBe(true);
  });

  it('社内・検証用アカウントを除く条件が friends の集計に入っている', async () => {
    const { db, captured } = makeDb(baseCanned);
    await furimDashboard.request('/api/furim/dashboard', {}, { DB: db } as never);
    const q = captured.find((x) => /FROM friends\s+WHERE/.test(x.sql))!;
    expect(q.sql).toContain('NOT IN');
    expect(q.binds.length).toBeGreaterThan(50);
    // 検証用アカウント（TEST_LINE_IDS・あじゃぱー）も集計から除く（Capsec #301）
    expect(q.binds).toContain('Ue4941a030cb2ec8758095fb0fffff344');
    const conv = captured.find((x) => /WITH first_paid AS/.test(x.sql))!;
    expect(conv.binds).toContain('Ue4941a030cb2ec8758095fb0fffff344');
  });

  it('有料転換は最初の入金で数え、試用から始めた人（最初が subscription_cycle）も入れる。送信を諦めた広告 CV は数えない（Capsec #289）', async () => {
    const { db, captured } = makeDb(baseCanned);
    const res = await furimDashboard.request('/api/furim/dashboard', {}, { DB: db } as never);
    const conv = captured.find((x) => /WITH first_paid AS/.test(x.sql))!;
    expect(conv.sql).toContain("billing_reason IN ('subscription_create', 'subscription_cycle', 'subscription_update')");
    expect(conv.sql).not.toContain("billing_reason = 'subscription_create'");
    const cv = captured.find((x) => /FROM ad_conversion_logs/.test(x.sql))!;
    expect(cv.sql).toContain("status IN ('failed', 'pending')");
    const body = (await res.json()) as { sections: { anomalies: { items: Array<{ kind: string }> } } };
    expect(body.sections.anomalies.items.some((i) => i.kind === 'first_paid_gap')).toBe(false);
  });

  it('日時は T 区切りにそろえてから切り出す（datetime(now) は使わない）', async () => {
    const { db, captured } = makeDb(baseCanned);
    await furimDashboard.request('/api/furim/dashboard', {}, { DB: db } as never);
    const all = captured.map((x) => x.sql).join('\n');
    expect(all).toContain("replace(created_at, ' ', 'T')");
    expect(all).not.toContain("datetime('now'");
  });
});

describe('異常の確認済み（Capsec #289）', () => {
  const item = (): AnomalyItem => ({ kind: 'gas_retry_pending', label: '同期の保留ジョブ', count: 2, since: '2026-08-20T04:10:00.000+09:00', href: '/x', severity: 'red' as const, acked: null, isNew: false });

  it('確認済みがあれば acked が付く', async () => {
    const { db } = makeDb([{ match: /FROM furim_anomaly_acks/, all: [{ kind: 'gas_retry_pending', ack_key: '', acked_at: '2026-09-16T10:00:00.000+09:00', acked_by: 'くろ', count_at_ack: 2, first_seen_at_ack: '2026-08-20T04:10:00', note: null }] }]);
    const items: AnomalyItem[] = [item()];
    await applyAcks(db, items, '2026-09-16T22:00:00.000+09:00');
    expect(items[0].acked?.by).toBe('くろ');
  });

  it('件数が増えていたら確認済みを外してまた出す', async () => {
    const { db } = makeDb([{ match: /FROM furim_anomaly_acks/, all: [{ kind: 'gas_retry_pending', ack_key: '', acked_at: '2026-09-16T10:00:00.000+09:00', acked_by: 'くろ', count_at_ack: 1, first_seen_at_ack: '2026-08-20T04:10:00', note: null }] }]);
    const items: AnomalyItem[] = [item()];
    await applyAcks(db, items, '2026-09-16T22:00:00.000+09:00');
    expect(items[0].acked).toBeNull();
  });

  it('解消してから再発した（初回検知が確認時より新しい）ら確認済みを外す', async () => {
    const { db } = makeDb([{ match: /FROM furim_anomaly_acks/, all: [{ kind: 'gas_retry_pending', ack_key: '', acked_at: '2026-09-16T10:00:00.000+09:00', acked_by: 'くろ', count_at_ack: 5, first_seen_at_ack: '2026-08-20T04:10:00', note: null }] }]);
    const items: AnomalyItem[] = [{ ...item(), since: '2026-09-16T20:00:00.000+09:00' }];
    await applyAcks(db, items, '2026-09-16T22:00:00.000+09:00');
    expect(items[0].acked).toBeNull();
  });

  it('直近 24 時間に初めて出たものは isNew になる', async () => {
    const { db } = makeDb([{ match: /FROM furim_anomaly_acks/, all: [] }]);
    const items: AnomalyItem[] = [item(), { ...item(), kind: 'x', since: '2026-09-16T20:00:00.000+09:00' }];
    await applyAcks(db, items, '2026-09-16T22:00:00.000+09:00');
    expect(items[0].isNew).toBe(false);
    expect(items[1].isNew).toBe(true);
  });
});

describe('JST の N 時間前（2026-09-17 の窓のずれの修正）', () => {
  it('JST のまま N 時間前を返す（UTC にしない）', () => {
    expect(jstHoursAgo('2026-09-17T12:00:00.000+09:00', 24)).toBe('2026-09-16T12:00:00');
    expect(jstHoursAgo('2026-09-17T08:00:00.000+09:00', 9)).toBe('2026-09-16T23:00:00');
  });

  it('「今日のできごと」は直近 24 時間ちょうどで区切る（23 時間前は含み、25 時間前は含まない）', async () => {
    const { db } = makeDb([{ match: /FROM furim_anomaly_acks/, all: [] }]);
    const base = { label: 'x', count: 1, href: '/x', severity: 'red' as const, acked: null, isNew: false };
    const items: AnomalyItem[] = [
      { ...base, kind: 'a', since: '2026-09-16T13:00:00.000+09:00' },
      { ...base, kind: 'b', since: '2026-09-16T11:00:00.000+09:00' },
    ];
    await applyAcks(db, items, '2026-09-17T12:00:00.000+09:00');
    expect(items[0].isNew).toBe(true);
    expect(items[1].isNew).toBe(false);
  });
});

describe('期間と粒度の解釈', () => {
  it('不正な値は既定に落とす', () => {
    expect(parseGranularity(undefined)).toBe('month');
    expect(parseGranularity('week')).toBe('month');
    expect(parseGranularity('day')).toBe('day');
    expect(parsePeriod('zzz')).toBe('1y');
    expect(parsePeriod('3m')).toBe('3m');
  });

  it('期間の下限を JST の日付で出す', () => {
    expect(rangeStart('3m', '2026-09-16')).toBe('2026-06-16');
    expect(rangeStart('6m', '2026-09-16')).toBe('2026-03-16');
    expect(rangeStart('1y', '2026-09-16')).toBe('2025-09-16');
    expect(rangeStart('all', '2026-09-16')).toBe('2000-01-01');
  });
});

describe('POST /api/furim/ad-spend/import', () => {
  const post = (body: unknown, db?: D1Database) =>
    furimDashboard.request(
      '/api/furim/ad-spend/import',
      { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
      { DB: db ?? makeDb([]).db } as never,
    );

  it('日付とキャンペーンIDで upsert する', async () => {
    const { db, captured } = makeDb([]);
    const res = await post({ rows: [{ date: '2026-09-15', source: 'google', campaign_id: '123', campaign_name: 'PMAX', cost_yen: 240, clicks: 3, impressions: 91 }] }, db);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, upserted: 1 });
    expect(captured[0].sql).toContain('ON CONFLICT(date, source, campaign_id) DO UPDATE');
  });

  it('rows が空なら 400', async () => {
    expect((await post({ rows: [] })).status).toBe(400);
  });

  it('日付の形が違えば 400', async () => {
    expect((await post({ rows: [{ date: '9/15', campaign_id: '1', cost_yen: 1 }] })).status).toBe(400);
  });
});
