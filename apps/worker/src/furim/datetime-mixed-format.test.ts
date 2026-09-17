import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/push-notify.js', () => ({ sendPushToAll: vi.fn(async () => undefined) }));
vi.mock('../routes/plan-builder.js', () => ({ stripeCall: vi.fn(), resolvePlanSelection: vi.fn(), buildItemsFromSelection: vi.fn(() => []) }));

import { watchPlanChangeIntents } from './plan-change-watch.js';
import { retryMissedAdConversions } from '../services/ad-conversion.js';
import { formatJstDateTime, formatJstIso, parseJstDateTime } from './customer-store.js';
import { formatExpiredDate } from './ext-auth.js';
import { toEpoch } from './gas-retry-queue.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const key = (v: string) => v.replace(' ', 'T').slice(0, 19);
const spaceOf = (ms: number) => formatJstDateTime(ms);
const isoOf = (ms: number) => formatJstIso(ms);
const naiveOf = (ms: number) => formatJstIso(ms).slice(0, 23);

function sqlEvalDb(rows: Array<Record<string, string>>, column: string, ops: Array<'<' | '>' | '>='>) {
  const seen: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        binds: [] as unknown[],
        bind(...a: unknown[]) { stmt.binds = a; return stmt; },
        async all() {
          seen.push({ sql, binds: stmt.binds });
          if (!sql.includes(`substr(replace(`)) return { results: [] };
          const results = rows.filter((r) => ops.every((op, i) => {
            const a = key(r[column]);
            const b = String(stmt.binds[i]);
            return op === '<' ? a < b : op === '>' ? a > b : a >= b;
          }));
          return { results };
        },
        async first() { return null; },
        async run() { return { meta: { changes: 1 } }; },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, seen };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('plan-change-watch: created_at の形式が混ざっても 30 分・3 日の判定は同じ（Capsec #260）', () => {
  const NOW = Date.parse('2026-09-14T13:40:00+09:00');
  const offsets = [5 * 60_000, 29 * 60_000, 31 * 60_000, 2 * HOUR, 14 * HOUR, 2 * DAY, 3 * DAY - 60_000, 3 * DAY + 60_000, 4 * DAY];

  it('旧 SQL（スペース区切りどうしの比較）と新 SQL（先頭 19 文字の比較）で、スペース区切り・ISO+09:00・オフセット無しの結果が一致', async () => {
    vi.setSystemTime(NOW);
    const oldJudge = (createdMs: number) => {
      const c = spaceOf(createdMs);
      return c < spaceOf(NOW - 30 * 60_000) && c > spaceOf(NOW - 3 * DAY);
    };
    for (const fmt of [spaceOf, isoOf, naiveOf]) {
      const rows = offsets.map((o, i) => ({ id: `PB-${i}`, created_at: fmt(NOW - o) }));
      const { db, seen } = sqlEvalDb(rows, 'created_at', ['<', '>']);
      const picked: string[] = [];
      const wrapped = {
        prepare: (sql: string) => {
          const s = db.prepare(sql) as unknown as { all: () => Promise<{ results: Array<{ id: string }> }> };
          const orig = s.all.bind(s);
          s.all = async () => { const r = await orig(); if (sql.includes('plan_builder_intents i')) picked.push(...r.results.map((x) => x.id)); return { results: [] } as never; };
          return s;
        },
      } as unknown as D1Database;
      await watchPlanChangeIntents(wrapped, { pushMessage: vi.fn() } as never, {} as never);
      const expected = offsets.map((o, i) => (oldJudge(NOW - o) ? `PB-${i}` : null)).filter(Boolean);
      expect(picked, fmt.name).toEqual(expected);
      // 先頭の「開いている警告の見直し」（clearSupersededAlerts）の後に、取得の SQL が来る
      const intentsQuery = seen.find((x) => x.sql.includes('plan_builder_intents i'))!;
      expect(intentsQuery.sql).toContain("substr(replace(i.created_at, ' ', 'T'), 1, 19) < ?");
      expect(intentsQuery.binds).toEqual(['2026-09-14T13:10:00', '2026-09-11T13:40:00']);
    }
  });
});

describe('ad-conversion: friends.created_at の形式が混ざっても 7 日窓の判定は同じ（Capsec #260）', () => {
  const NOW = Date.parse('2026-09-14T13:40:00+09:00');
  const offsets = [HOUR, 3 * DAY, 7 * DAY - 60_000, 7 * DAY + 60_000, 8 * DAY + HOUR, 30 * DAY];

  it('スペース区切り・ISO+09:00・オフセット無しで同じ友だちが選ばれ、epoch で見た 7 日以内と一致する', async () => {
    vi.setSystemTime(NOW);
    const results: string[][] = [];
    for (const fmt of [spaceOf, isoOf, naiveOf]) {
      const rows = offsets.map((o, i) => ({ friend_id: `f${i}`, created_at: fmt(NOW - o) }));
      const { db, seen } = sqlEvalDb(rows, 'created_at', ['>=']);
      const picked: string[] = [];
      const wrapped = {
        prepare: (sql: string) => {
          const s = db.prepare(sql) as unknown as { all: () => Promise<{ results: Array<{ friend_id: string }> }> };
          const orig = s.all.bind(s);
          s.all = async () => { const r = await orig(); if (sql.includes('FROM ref_tracking rt')) picked.push(...r.results.map((x) => x.friend_id)); return { results: [] } as never; };
          return s;
        },
      } as unknown as D1Database;
      await retryMissedAdConversions(wrapped);
      results.push(picked);
      expect(seen[0].binds).toEqual(['2026-09-07T13:40:00']);
    }
    const truth = offsets.map((o, i) => (NOW - o >= NOW - 7 * DAY ? `f${i}` : null)).filter(Boolean);
    expect(results[0]).toEqual(truth);
    expect(results[1]).toEqual(truth);
    expect(results[2]).toEqual(truth);
  });
});

describe('サブスク期限の読み手: 形式が混ざっても同じ時刻・同じ判定（Capsec #260）', () => {
  const cases = [
    ['2026-09-24 10:00:00', '2026-09-24T10:00:00.000+09:00', '2026-09-24T10:00:00.000', '2026-09-24T01:00:00.000Z'],
    ['2026-10-15 13:40:05', '2026-10-15T13:40:05.000+09:00', '2026-10-15T13:40:05', '2026-10-15T04:40:05Z'],
  ];

  it('parseJstDateTime（拡張の有効判定・試用一覧・セグメント・trial-promo・解説見た・紹介 +7 日）', () => {
    for (const vs of cases) {
      const ms = vs.map((v) => parseJstDateTime(v));
      expect(new Set(ms).size, vs.join(' / ')).toBe(1);
      expect(ms[0]).not.toBeNull();
    }
  });

  it('期限切れ判定（expiresMs < nowMs）が形式で変わらない', () => {
    const now = Date.parse('2026-09-24T10:00:00+09:00');
    for (const [delta, expired] of [[-1000, true], [0, false], [1000, false]] as const) {
      for (const v of [spaceOf(now + delta), isoOf(now + delta), naiveOf(now + delta)]) {
        expect((parseJstDateTime(v) ?? 0) < now, v).toBe(expired);
      }
    }
  });

  it('拡張へ返す expiredDate は保存形式によらず同じ文字列', () => {
    for (const vs of cases) expect(new Set(vs.map((v) => formatExpiredDate(v))).size).toBe(1);
  });

  it('GAS 再実行の突き合わせ（toEpoch）でシートのスペース区切りと D1 の ISO が同じ時刻', () => {
    const ms = Date.parse('2026-10-15T13:40:05+09:00');
    expect(toEpoch(formatJstDateTime(ms))).toBe(toEpoch(formatJstIso(ms)));
  });

  it('stripe-processor の D1 値（formatJstIso）とシート値（formatJstDateTime）は同じ時刻', () => {
    const ms = 1757828405000;
    expect(parseJstDateTime(formatJstIso(ms))).toBe(ms);
    expect(parseJstDateTime(formatJstDateTime(ms))).toBe(ms);
    expect(formatJstIso(ms)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+09:00$/);
    expect(formatJstDateTime(ms)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
