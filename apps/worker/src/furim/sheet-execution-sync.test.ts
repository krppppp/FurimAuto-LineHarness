import { describe, it, expect, vi } from 'vitest';

vi.mock('./sheet-backfill.js', async (orig) => {
  const actual = await orig<typeof import('./sheet-backfill.js')>();
  return { ...actual, fetchSheetRows: vi.fn(async () => []), loadResolveContext: vi.fn(async () => ({})) };
});

import { countLegacyMembers, filterRecentRows, syncExecutionLogsFromSheet, syncSince, SYNC_LOOKBACK_DAYS } from './sheet-execution-sync.js';
import { fetchSheetRows } from './sheet-backfill.js';

const NOW = Date.parse('2026-09-17T12:00:00+09:00');

function makeDb(legacy: number) {
  const batches: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind() { return stmt; },
        async first() { return /FROM furim_customers/.test(sql) ? { n: legacy } : null; },
        async all() { return { results: [] }; },
      };
      return stmt;
    },
    async batch(s: unknown[]) { batches.push(s); return []; },
  };
  return { db: db as unknown as D1Database, batches };
}

describe('シート→D1 の自動化処理履歴の差分取り込み（Capsec #296）', () => {
  it('旧経路の会員が 0 人なら何もしない（終わりの条件）', async () => {
    const { db } = makeDb(0);
    const r = await syncExecutionLogsFromSheet(db, 'gas', { dryRun: false, nowMs: NOW });
    expect(r.stopped).toBe(true);
    expect(fetchSheetRows).not.toHaveBeenCalled();
  });

  it('旧経路の会員を数える', async () => {
    const { db } = makeDb(36);
    expect(await countLegacyMembers(db, NOW)).toBe(36);
  });

  it(`処理日時が下限以降の行だけ取り込み対象にする（日時が読めない行は残す）`, () => {
    const rows = [
      { 処理日時: '2026/09/17 10:00:00', サービス: 'メルカリ' },
      { 処理日時: '2026/09/16 09:00:00', サービス: 'メルカリ' },
      { 処理日時: '2026/09/10 09:00:00', サービス: 'メルカリ' },
      { 処理日時: '', サービス: 'メルカリ' },
    ];
    const kept = filterRecentRows(rows, syncSince(NOW, null));
    expect(kept.map((r) => r['処理日時'])).toEqual(['2026/09/17 10:00:00', '2026/09/16 09:00:00', '']);
  });

  it(`下限は「直近 ${SYNC_LOOKBACK_DAYS} 日」と「取り込み済みの最新 − 24 時間」の古い方（止まっていた間の抜けを埋める）`, () => {
    // 取り込みが 9/14 08:52 で止まっていた本番の状態。直近 2 日（9/15 12:00）より古い 9/13 08:52 から取る
    expect(syncSince(NOW, '2026-09-14T08:52:14')).toBe('2026-09-13T08:52:14');
    // 取り込みが追いついていれば直近 2 日
    expect(syncSince(NOW, '2026-09-17T11:00:00')).toBe('2026-09-15T12:00:00');
    // 取り込み済みが無ければ直近 2 日
    expect(syncSince(NOW, null)).toBe('2026-09-15T12:00:00');
  });

  it('dryRun では書き込まない', async () => {
    const { db, batches } = makeDb(36);
    const r = await syncExecutionLogsFromSheet(db, 'gas', { dryRun: true, nowMs: NOW });
    expect(r.stopped).toBe(false);
    expect(batches).toHaveLength(0);
  });
});
