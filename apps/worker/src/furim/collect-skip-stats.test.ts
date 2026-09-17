import { describe, it, expect } from 'vitest';
import { NO_OWNER_PERSIST_MIN, reasonOf, summarizeCollectSkipRows } from './collect-skip-stats.js';

const r = (reason: string, key = 'pb_a', at = '2026-09-17T10:00:00.000+09:00') => ({
  key_code: key,
  error: `collect / ${reason} / メルカリ / where=collect_mercari owner=mercari head=rakuma remaining=2 source=tab`,
  created_at: at,
});

describe('巡回キューの記録を理由ごとに数える（Capsec #294）', () => {
  it('error 列から理由を取り出す', () => {
    expect(reasonOf('collect / timeout_skipped / メルカリ / where=x')).toBe('timeout_skipped');
    expect(reasonOf('delete / not_mine / (販路不明)')).toBe('not_mine');
    expect(reasonOf(null)).toBe('');
  });

  it('timeout_skipped は本当の取りこぼしとして数える', () => {
    const st = summarizeCollectSkipRows([r('timeout_skipped'), r('timeout_skipped')]);
    expect(st.timeoutSkipped).toBe(2);
  });

  it('not_mine は異常に数えず、効いた回数として別に数える', () => {
    const st = summarizeCollectSkipRows([r('not_mine'), r('not_mine'), r('not_mine')]);
    expect(st.timeoutSkipped + st.noOwnerPersistent).toBe(0);
    expect(st.notMine).toBe(3);
    expect(st.since).toBeNull();
  });

  it(`no_owner は同じキーコードで ${NO_OWNER_PERSIST_MIN} 回以上続いた時だけ数える`, () => {
    const once = summarizeCollectSkipRows([r('no_owner', 'pb_a'), r('no_owner', 'pb_a'), r('no_owner', 'pb_b')]);
    expect(once.noOwnerPersistent).toBe(0);
    const persistent = summarizeCollectSkipRows([r('no_owner', 'pb_a'), r('no_owner', 'pb_a'), r('no_owner', 'pb_a'), r('no_owner', 'pb_b')]);
    expect(persistent.noOwnerPersistent).toBe(3);
    expect(persistent.noOwnerPersistentUsers).toBe(1);
  });

  it('empty は数えない', () => {
    const st = summarizeCollectSkipRows([r('empty'), r('empty')]);
    expect(st.timeoutSkipped + st.noOwnerPersistent + st.notMine).toBe(0);
  });

  it('since は数えた記録の中で一番古い時刻（not_mine は含めない）', () => {
    const st = summarizeCollectSkipRows([
      r('not_mine', 'pb_a', '2026-09-17T06:00:00.000+09:00'),
      r('timeout_skipped', 'pb_a', '2026-09-17T09:00:00.000+09:00'),
      r('timeout_skipped', 'pb_a', '2026-09-17T08:00:00.000+09:00'),
    ]);
    expect(st.since).toBe('2026-09-17T08:00:00.000+09:00');
  });
});
