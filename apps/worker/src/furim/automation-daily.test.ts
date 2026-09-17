import { describe, expect, it } from 'vitest';
import {
  addDays,
  judgeAutomationDrop,
  judgeTargetDay,
  median,
  sheetSyncStaleHours,
  summarizeAutomationDaily,
  SHEET_SYNC_HEARTBEAT_ID,
} from './automation-daily.js';
import { recordSheetSyncHeartbeat } from './sheet-execution-sync.js';

function makeDb(opts: { daily?: unknown[]; services?: unknown[]; sameTime?: unknown[]; heartbeat?: unknown }) {
  const captured: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        binds: [] as unknown[],
        bind(...a: unknown[]) {
          stmt.binds = a;
          return stmt;
        },
        async all() {
          captured.push({ sql, binds: stmt.binds });
          if (sql.includes('GROUP BY service')) return { results: opts.services ?? [] };
          if (sql.includes(', 12, 8)')) return { results: opts.sameTime ?? [] };
          return { results: opts.daily ?? [] };
        },
        async first() {
          captured.push({ sql, binds: stmt.binds });
          return opts.heartbeat ?? null;
        },
        async run() {
          captured.push({ sql, binds: stmt.binds });
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, captured };
}

describe('自動化の日別件数と人数（Capsec #296）', () => {
  it('判定日は 03:10 以降なら前日、それより前は前々日', () => {
    expect(judgeTargetDay('2026-09-17T03:10:00.000+09:00')).toBe('2026-09-16');
    expect(judgeTargetDay('2026-09-17T03:09:59.000+09:00')).toBe('2026-09-15');
    expect(addDays('2026-09-01', -1)).toBe('2026-08-31');
  });

  it('中央値', () => {
    expect(median([366, 376, 371, 352, 331, 362, 340])).toBe(362);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('中央値の 85% 未満で黄・70% 未満で赤。件数と人数の悪い方で決める', () => {
    expect(judgeAutomationDrop({ runs: 320, people: 100 }, 362, 108)).toBeNull();
    expect(judgeAutomationDrop({ runs: 269, people: 102 }, 362, 106)?.severity).toBe('yellow');
    expect(judgeAutomationDrop({ runs: 350, people: 70 }, 362, 108)?.severity).toBe('red');
    expect(judgeAutomationDrop({ runs: 0, people: 0 }, null, null)).toBeNull();
  });

  it('LINE ID の無い行は人数に入れず別に数え、社内 ID を除き、今日は系列に入れない', async () => {
    const { db, captured } = makeDb({
      daily: [
        { t: '2026-09-16', runs: 379, people: 100, unidentified: 16 },
        { t: '2026-09-17', runs: 176, people: 75, unidentified: 0 },
      ],
      services: [{ service: 'メルカリ', runs: 356, people: 97 }],
      sameTime: [{ t: '2026-09-16', runs: 200 }, { t: '2026-09-15', runs: 180 }],
      heartbeat: { last_run_at: '2026-09-17T15:00:02.000+09:00', note: '{}' },
    });
    const s = await summarizeAutomationDaily(db, '2026-09-17T15:13:00.000+09:00');
    expect(s.series).toHaveLength(14);
    expect(s.series.at(-1)).toEqual({ t: '2026-09-16', runs: 379, people: 100, unidentified: 16 });
    expect(s.series.some((d) => d.t === '2026-09-17')).toBe(false);
    expect(s.target.byService[0].service).toBe('メルカリ');
    expect(s.today).toMatchObject({ t: '2026-09-17', asOf: '15:13', runs: 176, people: 75, sameTimeAvg: 54 });
    expect(s.sheetSync.lastRunAt).toBe('2026-09-17T15:00:02.000+09:00');
    const q = captured.find((x) => x.sql.includes('unidentified'))!;
    expect(q.sql).toContain("NULLIF(line_user_id, '')");
    expect(q.sql).toContain('NOT IN');
    expect(q.binds.length).toBeGreaterThan(50);
    const t = captured.find((x) => x.sql.includes(', 12, 8)'))!;
    expect(t.binds.slice(0, 3)).toEqual(['2026-09-10', '2026-09-16', '15:13:00']);
  });

  it('シート取り込みの停止時間。心拍がまだ無ければ判定しない', () => {
    expect(sheetSyncStaleHours('2026-09-17T03:00:05.000+09:00', '2026-09-17T10:30:00.000+09:00')).toBe(7);
    expect(sheetSyncStaleHours(null, '2026-09-17T10:30:00.000+09:00')).toBeNull();
  });

  it('取り込みの心拍は、画面が読むのと同じ id で書く', async () => {
    const { db, captured } = makeDb({});
    await recordSheetSyncHeartbeat(db, { stopped: true, reason: 'x', legacyMembers: 0 }, '2026-09-17T15:00:00.000+09:00');
    expect(captured[0].sql).toContain('furim_health_heartbeat');
    expect(captured[0].binds.slice(0, 3)).toEqual([SHEET_SYNC_HEARTBEAT_ID, '2026-09-17T15:00:00.000+09:00', 'stopped']);
  });
});
