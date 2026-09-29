import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@line-crm/db', () => ({
  jstNow: vi.fn(() => '2026-09-29T12:00:00.000+09:00'),
}));

import { jstNow } from '@line-crm/db';
import { recordCancellationReason, recordCancellationReasonText, isCancellationReasonCode, cancellationReasonCodeFromLabel, cancellationSurveyMessages, CANCELLATION_REASONS, CANCELLATION_REASON_PREFIX, CANCELLATION_REASON_REPLY_TEXT } from './cancellation-reason.js';

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

describe('cancellationSurveyMessages（文面は TB-748 決定A〜D）', () => {
  // action.type = message は押した文字列が本人の吹き出しとしてトークに残る。
  // 顧客の画面に not_working と出さないため、送るのは日本語ラベル（TB-747 CTO レビュー）
  test('5 択のボタンは日本語ラベルを送り、英字コードをトークに出さない', () => {
    const json = JSON.stringify(cancellationSurveyMessages());
    expect(json).not.toMatch(/【ボタン】解約理由:[a-z_]+/);
    for (const code of Object.keys(CANCELLATION_REASONS) as Array<keyof typeof CANCELLATION_REASONS>) {
      const label = CANCELLATION_REASONS[code];
      expect(json).toContain(`${CANCELLATION_REASON_PREFIX}${label}`);
      expect(cancellationReasonCodeFromLabel(label)).toBe(code);
    }
  });

  test('ボタンが送る text から reason_code に戻せる（5択以外は null）', () => {
    expect(cancellationReasonCodeFromLabel('値段')).toBe('price');
    // 旧アンケートのラベルとは 1 つも重ならない
    for (const old of ['料金が高い', '使いこなせなかった', '成果が出なかった', '物販休止', '他ツールへ乗り換え', 'その他']) {
      expect(cancellationReasonCodeFromLabel(old)).toBeNull();
    }
    expect(cancellationReasonCodeFromLabel('toString')).toBeNull();
    expect(isCancellationReasonCode('price')).toBe(true);
  });

  test('ボタンのラベルは 5 択の表示文言のまま（言い換えない）', () => {
    const json = JSON.stringify(cancellationSurveyMessages());
    for (const label of ['動かない', '使い方が分からない', '売るものがない・稼げなかった', '値段', '副業をやめた']) {
      expect(json).toContain(`"label":"${label}"`);
    }
  });

  test('完了を先に言い切り、任意だと分かり、謝らない・引き止めない（決定C）', () => {
    const json = JSON.stringify(cancellationSurveyMessages());
    expect(json).toContain('解約のお手続きは完了しました');
    expect(json).toContain('よろしければ');
    expect(json).toContain('任意');
    for (const ng of ['申し訳', 'ご迷惑', 'liff.line.me', 'クーポン', '再開', '割引']) {
      expect(json).not.toContain(ng);
    }
  });

  test('2 通目に引き止め・再契約導線を置かない（決定A・D）', () => {
    expect(CANCELLATION_REASON_REPLY_TEXT).toContain('差し支えなければ');
    for (const ng of ['liff.line.me', '980', 'ビュッフェ', '申し訳']) {
      expect(CANCELLATION_REASON_REPLY_TEXT).not.toContain(ng);
    }
  });

  test('未知のコードは受け付けない', () => {
    expect(isCancellationReasonCode('物販休止')).toBe(false);
    expect(isCancellationReasonCode('toString')).toBe(false);
  });
});
