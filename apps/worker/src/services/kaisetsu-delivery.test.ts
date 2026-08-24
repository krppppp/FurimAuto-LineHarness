import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';

// closing_daily の発火だけ観測したいので event-bus をモックする
const fireEventMock = vi.fn();
vi.mock('./event-bus.js', () => ({ fireEvent: fireEventMock }));
// GAS 同期はテスト対象外（gasDeployId を渡さなければ呼ばれない）
vi.mock('../furim/gas-client.js', () => ({
  gasGet: vi.fn(),
  getGasErrorFromResponse: vi.fn(() => null),
}));

const { processKaisetsuDeliveries } = await import('./kaisetsu-delivery.js');

interface FriendRow {
  id: string;
  line_user_id: string;
  metadata: string;
}

/**
 * kaisetsu-delivery が発行するSQLだけを解釈する最小D1モック。
 * - SELECT ... FROM friends WHERE ... kaisetsu/closing → rows を返す
 * - claim UPDATE (kaisetsu_last_sent) → 条件を実際に評価して changes を返す
 * - closing_sent UPDATE → metadata に反映する
 */
function makeDb(rows: FriendRow[]) {
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async all() {
          if (/FROM friends/.test(sql) && /kaisetsu|closing/.test(sql)) {
            return { results: rows };
          }
          return { results: [] };
        },
        async first() {
          return null;
        },
        async run() {
          if (/kaisetsu_last_sent/.test(sql)) {
            const [today, id] = bound as [string, string];
            const row = rows.find((r) => r.id === id);
            if (!row) return { meta: { changes: 0 } };
            const meta = JSON.parse(row.metadata || '{}');
            if ((meta.kaisetsu_last_sent ?? '') === today) return { meta: { changes: 0 } };
            meta.kaisetsu_last_sent = today;
            row.metadata = JSON.stringify(meta);
            return { meta: { changes: 1 } };
          }
          if (/closing_sent/.test(sql)) {
            const [sentJson, id] = bound as [string, string];
            const row = rows.find((r) => r.id === id);
            if (row) {
              const meta = JSON.parse(row.metadata || '{}');
              meta.closing_sent = JSON.parse(sentJson);
              row.metadata = JSON.stringify(meta);
            }
            return { meta: { changes: row ? 1 : 0 } };
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return db;
}

/** JST 21時のある瞬間に固定する（cron の 21時ゲートを通すため） */
function freezeAt21JST() {
  // 2026-08-24 21:30 JST = 12:30 UTC
  vi.setSystemTime(new Date('2026-08-24T12:30:00Z'));
}

/** trial_end を「JST今日から remaining 日後」で作る */
function trialEndIn(days: number): string {
  const todayJst = new Date(Date.now() + 9 * 60 * 60_000).toISOString().slice(0, 10);
  const d = new Date(todayJst);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('processKaisetsuDeliveries closing_sent guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freezeAt21JST();
    fireEventMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('未発火の残日数なら closing_daily を発火し closing_sent に記録する', async () => {
    const rows: FriendRow[] = [
      { id: 'f1', line_user_id: 'U1', metadata: JSON.stringify({ closing: true, trial_end: trialEndIn(5) }) },
    ];
    await processKaisetsuDeliveries(makeDb(rows), 'token');
    expect(fireEventMock).toHaveBeenCalledTimes(1);
    expect(fireEventMock.mock.calls[0][1]).toBe('closing_daily');
    expect(fireEventMock.mock.calls[0][2].eventData.remaining_days).toBe(5);
    expect(JSON.parse(rows[0].metadata).closing_sent).toEqual(['5']);
  });

  test('発火済みの残日数（延長で巻き戻ったケース）はスキップする', async () => {
    const rows: FriendRow[] = [
      {
        id: 'f1',
        line_user_id: 'U1',
        // 「解説見た」延長後: 一度残5日を送った後に trial_end が伸び、再び残5日になった状態
        metadata: JSON.stringify({ closing: true, trial_end: trialEndIn(5), closing_sent: ['5'] }),
      },
    ];
    await processKaisetsuDeliveries(makeDb(rows), 'token');
    expect(fireEventMock).not.toHaveBeenCalled();
  });

  test('別の残日数なら発火し、記録が追記される', async () => {
    const rows: FriendRow[] = [
      {
        id: 'f1',
        line_user_id: 'U1',
        metadata: JSON.stringify({ closing: true, trial_end: trialEndIn(3), closing_sent: ['5'] }),
      },
    ];
    await processKaisetsuDeliveries(makeDb(rows), 'token');
    expect(fireEventMock).toHaveBeenCalledTimes(1);
    expect(fireEventMock.mock.calls[0][2].eventData.remaining_days).toBe(3);
    expect(JSON.parse(rows[0].metadata).closing_sent).toEqual(['5', '3']);
  });

  test('同日2回目の呼び出し（21時の二重cron）は claim で弾かれる', async () => {
    const rows: FriendRow[] = [
      { id: 'f1', line_user_id: 'U1', metadata: JSON.stringify({ closing: true, trial_end: trialEndIn(5) }) },
    ];
    const db = makeDb(rows);
    await processKaisetsuDeliveries(db, 'token');
    await processKaisetsuDeliveries(db, 'token');
    expect(fireEventMock).toHaveBeenCalledTimes(1);
  });

  test('21時以外は何もしない', async () => {
    vi.setSystemTime(new Date('2026-08-24T11:30:00Z')); // JST 20:30
    const rows: FriendRow[] = [
      { id: 'f1', line_user_id: 'U1', metadata: JSON.stringify({ closing: true, trial_end: trialEndIn(5) }) },
    ];
    await processKaisetsuDeliveries(makeDb(rows), 'token');
    expect(fireEventMock).not.toHaveBeenCalled();
  });
});
