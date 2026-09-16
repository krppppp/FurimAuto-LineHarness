import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextAlertLevel, parseJst, watchPatrolHeartbeat, PATROL_ALERT_STEPS } from './patrol-watch.js';

function makeDb(row: Record<string, unknown> | null) {
  const updates: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        binds: [] as unknown[],
        bind(...args: unknown[]) { stmt.binds = args; return stmt; },
        async first() { return row; },
        async run() { updates.push({ sql, binds: stmt.binds }); return { meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, updates };
}

const push = vi.fn(async () => undefined);
const lineClient = { pushMessage: push } as never;
const NOW = Date.parse('2026-09-17T12:00:00+09:00');

beforeEach(() => vi.clearAllMocks());

describe('巡回の心拍の見張り（Capsec #292）', () => {
  it('心拍が 1 行も無ければ鳴らさない（作った直後の誤報を出さない）', async () => {
    const { db, updates } = makeDb(null);
    await watchPatrolHeartbeat(db, lineClient, { nowMs: NOW });
    expect(push).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('3 時間未満なら鳴らさない', async () => {
    const { db } = makeDb({ id: 'patrol', last_run_at: '2026-09-17T10:30:00.000+09:00', alert_level: 0 });
    await watchPatrolHeartbeat(db, lineClient, { nowMs: NOW });
    expect(push).not.toHaveBeenCalled();
  });

  it('3 時間で 1 通鳴らし、段階を記録する', async () => {
    const { db, updates } = makeDb({ id: 'patrol', last_run_at: '2026-09-17T08:00:00.000+09:00', alert_level: 0 });
    await watchPatrolHeartbeat(db, lineClient, { nowMs: NOW });
    expect(push).toHaveBeenCalledTimes(1);
    const text = (push.mock.calls[0] as unknown as [string, Array<{ text: string }>])[1][0].text;
    expect(text).toContain('動いていません');
    expect(updates.some((u) => u.binds[0] === 1)).toBe(true);
  });

  it('同じ段階では二度と鳴らさない', async () => {
    const { db } = makeDb({ id: 'patrol', last_run_at: '2026-09-17T08:00:00.000+09:00', alert_level: 1 });
    await watchPatrolHeartbeat(db, lineClient, { nowMs: NOW });
    expect(push).not.toHaveBeenCalled();
  });

  it('48 時間では証拠が消える旨を入れて鳴らす', async () => {
    const { db } = makeDb({ id: 'patrol', last_run_at: '2026-09-15T10:00:00.000+09:00', alert_level: 2 });
    await watchPatrolHeartbeat(db, lineClient, { nowMs: NOW });
    expect(push).toHaveBeenCalledTimes(1);
    const text = (push.mock.calls[0] as unknown as [string, Array<{ text: string }>])[1][0].text;
    expect(text).toContain('3 日で消えます');
  });

  it('巡回が戻ったら段階を 0 に戻す', async () => {
    const { db, updates } = makeDb({ id: 'patrol', last_run_at: '2026-09-17T11:30:00.000+09:00', alert_level: 3 });
    await watchPatrolHeartbeat(db, lineClient, { nowMs: NOW });
    expect(push).not.toHaveBeenCalled();
    expect(updates.some((u) => u.sql.includes('alert_level = 0'))).toBe(true);
  });
});

describe('段階の判定', () => {
  it('しきい値は 3 / 24 / 48 時間', () => {
    expect(PATROL_ALERT_STEPS.map((s) => s.hours)).toEqual([3, 24, 48]);
  });

  it('経過時間から段階を決め、上がっていなければ null', () => {
    expect(nextAlertLevel(2, 0)).toBeNull();
    expect(nextAlertLevel(3, 0)?.level).toBe(1);
    expect(nextAlertLevel(25, 1)?.level).toBe(2);
    expect(nextAlertLevel(49, 2)?.level).toBe(3);
    expect(nextAlertLevel(49, 3)).toBeNull();
  });

  it('JST の 2 形式をどちらも読む', () => {
    expect(parseJst('2026-09-17T08:00:00.000+09:00')).toBe(Date.parse('2026-09-17T08:00:00+09:00'));
    expect(parseJst('2026-09-17 08:00:00')).toBe(Date.parse('2026-09-17T08:00:00+09:00'));
    expect(parseJst('こわれた値')).toBeNull();
  });
});
