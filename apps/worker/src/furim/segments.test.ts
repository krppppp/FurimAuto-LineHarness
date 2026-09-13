import { describe, it, expect } from 'vitest';
import { segmentOf, listSegmentsFromD1, listActiveTrialsFromD1, EXCLUDED_LINE_IDS } from './segments.js';

function makeDb(rows: Array<Record<string, unknown>>) {
  return {
    prepare() {
      return { all: async () => ({ results: rows }), bind() { return this; } };
    },
  } as unknown as D1Database;
}

const base = { survey_answer: null, key_code_issued: 0, device_activated: 0, device_code: null, mercari_url: null, free30_ticket: 0, youtube_coupon: null, extend_keyword: null };

describe('segmentOf（GAS getSegment と同じ判定）', () => {
  it('1〜8 とサブアカウント', () => {
    expect(segmentOf({ ...base })).toBe(1);
    expect(segmentOf({ ...base, survey_answer: '紹介' })).toBe(2);
    expect(segmentOf({ ...base, survey_answer: '紹介', key_code_issued: 1 })).toBe(3);
    expect(segmentOf({ ...base, key_code_issued: 1 })).toBe(3);
    expect(segmentOf({ ...base, key_code_issued: 1, device_code: 'abc' })).toBe(4);
    expect(segmentOf({ ...base, key_code_issued: 1, device_activated: 1, mercari_url: 'https://jp.mercari.com/user/profile/1' })).toBe(5);
    expect(segmentOf({ ...base, key_code_issued: 1, device_code: 'abc', mercari_url: 'u', free30_ticket: 1 })).toBe(6);
    expect(segmentOf({ ...base, key_code_issued: 1, device_code: 'abc', mercari_url: 'u', free30_ticket: 1, youtube_coupon: 'Youtube半額' })).toBe(7);
    expect(segmentOf({ ...base, key_code_issued: 1, device_code: 'abc', mercari_url: 'u', free30_ticket: 1, youtube_coupon: 'Youtube半額', extend_keyword: '1w' })).toBe(8);
    expect(segmentOf({ ...base, survey_answer: 'サブアカウント', key_code_issued: 1 })).toBeNull();
  });
});

describe('listSegmentsFromD1', () => {
  const now = Date.parse('2026-09-14T12:00:00+09:00');
  it('登録 0〜21 日・非会員だけを返し、紹介（終了−開始 ≥ 21 日）を isReferral にする', async () => {
    const rows = [
      { ...base, line_user_id: 'U1', subscription_start_at: '2026-09-10 10:00:00', subscription_end_at: '2026-09-24 10:00:00', plan_label: null },
      { ...base, line_user_id: 'U2', subscription_start_at: '2026-09-01 10:00:00', subscription_end_at: '2026-09-22 10:00:00', plan_label: '', survey_answer: '物販' },
      { ...base, line_user_id: 'U3', subscription_start_at: '2026-08-01 10:00:00', subscription_end_at: '2026-08-15 10:00:00', plan_label: null },
      { ...base, line_user_id: 'U4', subscription_start_at: '2026-09-12 10:00:00', subscription_end_at: '2027-09-12 10:00:00', plan_label: 'PBプラン:メルカリ 全自動化プラン' },
      { ...base, line_user_id: 'U5', subscription_start_at: '2026-09-12 10:00:00', subscription_end_at: '2026-09-26 10:00:00', plan_label: 'キャンセル済み', survey_answer: 'サブアカウント' },
    ];
    const users = await listSegmentsFromD1(makeDb(rows), now);
    expect(users).toEqual([
      { lineUserId: 'U1', segment: 1, isReferral: false },
      { lineUserId: 'U2', segment: 2, isReferral: true },
    ]);
  });
});

describe('listActiveTrialsFromD1', () => {
  const now = Date.parse('2026-09-14T21:00:00+09:00');
  it('プラン名が空で終了が今日〜8 日後の人。社内アカウントは除外。日付は JST', async () => {
    const excluded = [...EXCLUDED_LINE_IDS][0];
    const rows = [
      { line_user_id: 'U1', plan_label: null, subscription_end_at: '2026-09-14 23:59:00' },
      { line_user_id: 'U2', plan_label: '', subscription_end_at: '2026-09-22 00:30:00' },
      { line_user_id: 'U3', plan_label: null, subscription_end_at: '2026-09-23 00:30:00' },
      { line_user_id: 'U4', plan_label: null, subscription_end_at: '2026-09-13 23:00:00' },
      { line_user_id: excluded, plan_label: null, subscription_end_at: '2026-09-15 10:00:00' },
    ];
    const trials = await listActiveTrialsFromD1(makeDb(rows), { nowMs: now });
    expect(trials).toEqual([
      { lineUserId: 'U1', trialEnd: '2026-09-14', remainingDays: 0 },
      { lineUserId: 'U2', trialEnd: '2026-09-22', remainingDays: 8 },
    ]);
  });
});
