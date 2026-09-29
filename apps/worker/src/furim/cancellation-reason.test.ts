import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@line-crm/db', () => ({
  jstNow: vi.fn(() => '2026-09-29T12:00:00.000+09:00'),
}));

import { jstNow } from '@line-crm/db';
import { recordCancellationReason, recordCancellationReasonText, isCancellationReasonCode, cancellationSurveyMessages, CANCELLATION_REASON_PREFIX } from './cancellation-reason.js';

type Row = { id: string; reason_text: string | null; reason_answered_at: string | null } | null;

function makeDb(row: Row) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      const entry = { sql, args: [] as unknown[] };
      calls.push(entry);
      const stmt = {
        bind: (...args: unknown[]) => { entry.args = args; return stmt; },
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        first: vi.fn().mockResolvedValue(row),
      };
      return stmt;
    }),
  } as unknown as D1Database;
  return { db, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(jstNow).mockReturnValue('2026-09-29T12:00:00.000+09:00');
});

describe('recordCancellationReason', () => {
  test('canceled_at が最新の 1 行だけを更新する', async () => {
    const { db, calls } = makeDb({ id: 'c1', reason_text: null, reason_answered_at: null });
    expect(await recordCancellationReason(db, 'U-1', { code: 'price' })).toBe(true);
    const select = calls.find((c) => /SELECT id, reason_text/.test(c.sql));
    expect(select?.sql).toMatch(/ORDER BY canceled_at DESC LIMIT 1/);
    const update = calls.find((c) => /UPDATE furim_cancellations SET reason_code/.test(c.sql));
    expect(update?.args).toEqual(['price', '2026-09-29T12:00:00.000+09:00', 'c1']);
    expect(update?.sql).toMatch(/WHERE id = \?/);
  });

  test('押し直しは最後の答えを正とする（reason_code が入っていても上書きする）', async () => {
    const { db, calls } = makeDb({ id: 'c1', reason_text: null, reason_answered_at: '2026-09-29T11:00:00.000+09:00' });
    expect(await recordCancellationReason(db, 'U-1', { code: 'too_hard' })).toBe(true);
    const update = calls.find((c) => /UPDATE furim_cancellations SET reason_code/.test(c.sql));
    expect(update?.args[0]).toBe('too_hard');
  });

  test('解約行が無い人には何もしない', async () => {
    const { db, calls } = makeDb(null);
    expect(await recordCancellationReason(db, 'U-none', { code: 'price' })).toBe(false);
    expect(calls.some((c) => /UPDATE/.test(c.sql))).toBe(false);
  });
});

describe('recordCancellationReasonText', () => {
  test('5択の回答から 24 時間以内・未記入なら入れる', async () => {
    const { db, calls } = makeDb({ id: 'c1', reason_text: null, reason_answered_at: '2026-09-29T11:00:00.000+09:00' });
    expect(await recordCancellationReasonText(db, 'U-1', '  高すぎた  ')).toBe(true);
    const update = calls.find((c) => /UPDATE furim_cancellations SET reason_text/.test(c.sql));
    expect(update?.args).toEqual(['高すぎた', 'c1']);
  });

  test('24 時間を過ぎていたら拾わない', async () => {
    const { db, calls } = makeDb({ id: 'c1', reason_text: null, reason_answered_at: '2026-09-28T11:00:00.000+09:00' });
    expect(await recordCancellationReasonText(db, 'U-1', '別件の問い合わせです')).toBe(false);
    expect(calls.some((c) => /UPDATE/.test(c.sql))).toBe(false);
  });

  test('すでに自由記述が入っていれば 2 通目は拾わない', async () => {
    const { db, calls } = makeDb({ id: 'c1', reason_text: '既に一言', reason_answered_at: '2026-09-29T11:00:00.000+09:00' });
    expect(await recordCancellationReasonText(db, 'U-1', '2通目')).toBe(false);
    expect(calls.some((c) => /UPDATE/.test(c.sql))).toBe(false);
  });

  test('5択に未回答（reason_answered_at が NULL）なら拾わない', async () => {
    const { db, calls } = makeDb({ id: 'c1', reason_text: null, reason_answered_at: null });
    expect(await recordCancellationReasonText(db, 'U-1', 'ただの問い合わせ')).toBe(false);
    expect(calls.some((c) => /UPDATE/.test(c.sql))).toBe(false);
  });

  test('解約行が無い人には何もしない', async () => {
    const { db, calls } = makeDb(null);
    expect(await recordCancellationReasonText(db, 'U-none', 'こんにちは')).toBe(false);
    expect(calls.some((c) => /UPDATE/.test(c.sql))).toBe(false);
  });

  test('空白だけのテキストは拾わない（D1 も読まない）', async () => {
    const { db, calls } = makeDb({ id: 'c1', reason_text: null, reason_answered_at: '2026-09-29T11:00:00.000+09:00' });
    expect(await recordCancellationReasonText(db, 'U-1', '   ')).toBe(false);
    expect(calls.length).toBe(0);
  });
});

describe('cancellationSurveyMessages（文面は LINE導線担当が差し替える）', () => {
  test('5 択のボタンが英字コードを送る', async () => {
    const [flex] = cancellationSurveyMessages() as Array<Record<string, never>>;
    const texts = JSON.stringify(flex).match(/【ボタン】解約理由:[a-z_]+/g) ?? [];
    expect(texts).toHaveLength(5);
    for (const t of texts) {
      const code = t.slice(CANCELLATION_REASON_PREFIX.length);
      expect(isCancellationReasonCode(code)).toBe(true);
    }
  });

  test('未知のコードは受け付けない', () => {
    expect(isCancellationReasonCode('物販休止')).toBe(false);
    expect(isCancellationReasonCode('toString')).toBe(false);
  });
});
