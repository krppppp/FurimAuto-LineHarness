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
    expect(await recordCancellationReason(db, 'U-1', { code: 'could_not_use' })).toBe(true);
    const update = calls.find((c) => /UPDATE furim_cancellations SET reason_code/.test(c.sql));
    expect(update?.args[0]).toBe('could_not_use');
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

// 旧アンケートの原本（本番 automation_actions dc2fc760 の 2026-09-29 撤去前・message 1）。
// Vault departments/engineering/FurimAuto-LineHarness/assets/2026-09-29-tb752-automation_actions-dc2fc760-params-BEFORE.json
// （sha256 858b8753…）からそのまま写した文字列。手で直さない
const OLD_SURVEY_ALT_TEXT = '【1タップ】解約理由アンケート';
const OLD_SURVEY_CONTENT = "{\"type\":\"bubble\",\"size\":\"mega\",\"body\":{\"type\":\"box\",\"layout\":\"vertical\",\"contents\":[{\"type\":\"text\",\"text\":\"最後に1つだけ教えてください🙇\",\"weight\":\"bold\",\"size\":\"lg\",\"wrap\":true},{\"type\":\"text\",\"text\":\"今回解約された1番の理由はどれですか？\\n（1タップで完了します）\",\"size\":\"md\",\"wrap\":true,\"margin\":\"md\"}]},\"footer\":{\"type\":\"box\",\"layout\":\"vertical\",\"spacing\":\"sm\",\"contents\":[{\"type\":\"button\",\"style\":\"primary\",\"height\":\"sm\",\"action\":{\"type\":\"message\",\"label\":\"料金が高かった\",\"text\":\"【ボタン】解約理由:料金が高い\"}},{\"type\":\"button\",\"style\":\"primary\",\"height\":\"sm\",\"action\":{\"type\":\"message\",\"label\":\"使いこなせなかった\",\"text\":\"【ボタン】解約理由:使いこなせなかった\"}},{\"type\":\"button\",\"style\":\"primary\",\"height\":\"sm\",\"action\":{\"type\":\"message\",\"label\":\"思うような成果が出なかった\",\"text\":\"【ボタン】解約理由:成果が出なかった\"}},{\"type\":\"button\",\"style\":\"primary\",\"height\":\"sm\",\"action\":{\"type\":\"message\",\"label\":\"物販をやめた・お休みする\",\"text\":\"【ボタン】解約理由:物販休止\"}},{\"type\":\"button\",\"style\":\"primary\",\"height\":\"sm\",\"action\":{\"type\":\"message\",\"label\":\"他のツールに乗り換えた\",\"text\":\"【ボタン】解約理由:他ツールへ乗り換え\"}},{\"type\":\"button\",\"style\":\"secondary\",\"height\":\"sm\",\"action\":{\"type\":\"message\",\"label\":\"その他\",\"text\":\"【ボタン】解約理由:その他\"}}]}}";

describe('cancellationSurveyMessages（TB-825 で旧アンケートの 6 択に戻した）', () => {
  test('旧 Flex の原本と 1 文字も違わない（altText・本文・ボタンの並び・色）', () => {
    const [msg] = cancellationSurveyMessages() as Array<{ type: string; altText: string; contents: unknown }>;
    expect(cancellationSurveyMessages()).toHaveLength(1);
    expect(msg.type).toBe('flex');
    expect(msg.altText).toBe(OLD_SURVEY_ALT_TEXT);
    expect(JSON.stringify(msg.contents)).toBe(OLD_SURVEY_CONTENT);
  });

  // action.type = message は押した文字列が本人の吹き出しとしてトークに残るので、英字コードは送らない
  test('6 択のボタンは日本語の送信値を送り、それぞれ reason_code に戻せる', () => {
    const json = JSON.stringify(cancellationSurveyMessages());
    expect(json).not.toMatch(/【ボタン】解約理由:[a-z_]+/);
    expect(Object.keys(CANCELLATION_REASONS)).toEqual(['price', 'could_not_use', 'no_results', 'paused_selling', 'switched_tool', 'other']);
    for (const code of Object.keys(CANCELLATION_REASONS) as Array<keyof typeof CANCELLATION_REASONS>) {
      const value = CANCELLATION_REASONS[code];
      expect(json).toContain(`${CANCELLATION_REASON_PREFIX}${value}`);
      expect(cancellationReasonCodeFromLabel(value)).toBe(code);
    }
  });

  test('price は本番に入っている行と同じコードのまま（料金が高い → price）', () => {
    expect(cancellationReasonCodeFromLabel('料金が高い')).toBe('price');
    expect(isCancellationReasonCode('price')).toBe(true);
  });

  test('旧 5 択（TB-746）の送信値はコードに戻らない（旧分岐でタグだけ）', () => {
    for (const old of ['値段', '動かない', '使い方が分からない', '売るものがない・稼げなかった', '副業をやめた']) {
      expect(cancellationReasonCodeFromLabel(old)).toBeNull();
    }
    expect(cancellationReasonCodeFromLabel('toString')).toBeNull();
  });

  test('2 通目に引き止め・再契約導線を置かない（決定A・D）', () => {
    expect(CANCELLATION_REASON_REPLY_TEXT).toContain('差し支えなければ');
    for (const ng of ['liff.line.me', '980', 'ビュッフェ', '申し訳']) {
      expect(CANCELLATION_REASON_REPLY_TEXT).not.toContain(ng);
    }
  });

  test('未知のコードは受け付けない', () => {
    expect(isCancellationReasonCode('物販休止')).toBe(false);
    expect(isCancellationReasonCode('not_working')).toBe(false);
    expect(isCancellationReasonCode('toString')).toBe(false);
  });
});
