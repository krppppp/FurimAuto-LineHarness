import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';

// セグメントは D1 furim_customers から算出する（段階2.5・Capsec #250）。ここでは算出結果を差し替え、同期ロジックだけを見る
const listMock = vi.fn();
vi.mock('../furim/segments.js', () => ({ listSegmentsFromD1: listMock }));

const applyMock = vi.fn(async () => ({ httpStatus: 200, payload: { success: true } }));
vi.mock('../routes/furim.js', () => ({
  applyScenarioSwitch: applyMock,
  UNIFIED_SCENARIO_NAME: 'FurimAuto ステップ配信 統合版',
  UNIFIED_CUTOVER_AT: new Date('2026-08-24T23:00:00+09:00').getTime(),
}));

const { syncSegments } = await import('./segment-sync.js');

interface FriendFixture {
  id: string;
  line_user_id: string;
  created_at: string;
  segTags: string[];
  enrolled: boolean;
}

/** segment-sync が発行する2種のバルクSELECTだけを解釈する最小D1モック */
function makeDb(friends: FriendFixture[], scenarioExists = true) {
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first() {
          if (/FROM scenarios/.test(sql)) {
            return scenarioExists ? { id: 'scenario-1' } : null;
          }
          return null;
        },
        async all() {
          if (/FROM friends f/.test(sql)) {
            const lineIds = bound as string[];
            const results: unknown[] = [];
            for (const f of friends) {
              if (!lineIds.includes(f.line_user_id)) continue;
              if (f.segTags.length === 0) {
                results.push({ id: f.id, line_user_id: f.line_user_id, created_at: f.created_at, seg_tag: null });
              } else {
                for (const t of f.segTags) {
                  results.push({ id: f.id, line_user_id: f.line_user_id, created_at: f.created_at, seg_tag: t });
                }
              }
            }
            return { results };
          }
          if (/FROM friend_scenarios/.test(sql)) {
            const [, ...friendIds] = bound as string[];
            return {
              results: friends
                .filter((f) => f.enrolled && friendIds.includes(f.id))
                .map((f) => ({ friend_id: f.id })),
            };
          }
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return db;
}

const AFTER_CUTOVER = '2026-08-25T10:00:00.000+09:00';
const BEFORE_CUTOVER = '2026-08-10T10:00:00.000+09:00';

function freezeAtHourTop() {
  // JST 10:01 (= 01:01 UTC) — 毎時:00ゲートを通る分
  vi.setSystemTime(new Date('2026-08-25T01:01:00Z'));
}

describe('syncSegments', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freezeAtHourTop();
    listMock.mockReset();
    applyMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('タグが食い違う人だけ applyScenarioSwitch に流す', async () => {
    listMock.mockResolvedValue([
        { lineUserId: 'U1', segment: 3, isReferral: false }, // タグはセグメント2のまま → 対象
        { lineUserId: 'U2', segment: 4, isReferral: false }, // 一致＋enroll済み → skip
      ]);
    const db = makeDb([
      { id: 'f1', line_user_id: 'U1', created_at: AFTER_CUTOVER, segTags: ['セグメント2'], enrolled: true },
      { id: 'f2', line_user_id: 'U2', created_at: AFTER_CUTOVER, segTags: ['セグメント4'], enrolled: true },
    ]);
    await syncSegments(db);
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledWith(db, 'U1', 3, false);
  });

  test('タグ一致でもカットオーバー後登録でenroll無しなら安全網として流す', async () => {
    listMock.mockResolvedValue([{ lineUserId: 'U1', segment: 2, isReferral: false }]);
    const db = makeDb([
      { id: 'f1', line_user_id: 'U1', created_at: AFTER_CUTOVER, segTags: ['セグメント2'], enrolled: false },
    ]);
    await syncSegments(db);
    expect(applyMock).toHaveBeenCalledTimes(1);
  });

  test('カットオーバー前登録はタグ一致なら流さない（enroll無しでも）', async () => {
    listMock.mockResolvedValue([{ lineUserId: 'U1', segment: 2, isReferral: false }]);
    const db = makeDb([
      { id: 'f1', line_user_id: 'U1', created_at: BEFORE_CUTOVER, segTags: ['セグメント2'], enrolled: false },
    ]);
    await syncSegments(db);
    expect(applyMock).not.toHaveBeenCalled();
  });

  test('D1に居ない人はスキップする', async () => {
    listMock.mockResolvedValue([{ lineUserId: 'U-unknown', segment: 1, isReferral: false }]);
    const db = makeDb([]);
    await syncSegments(db);
    expect(applyMock).not.toHaveBeenCalled();
  });

  test('毎時:00以外のtickでは何もしない', async () => {
    vi.setSystemTime(new Date('2026-08-25T01:25:00Z')); // JST 10:25
    listMock.mockResolvedValue([{ lineUserId: 'U1', segment: 1, isReferral: false }]);
    const db = makeDb([]);
    await syncSegments(db);
    expect(listMock).not.toHaveBeenCalled();
  });

  test('セグメントタグが未付与の人は対象になる', async () => {
    listMock.mockResolvedValue([{ lineUserId: 'U1', segment: 1, isReferral: true }]);
    const db = makeDb([
      { id: 'f1', line_user_id: 'U1', created_at: BEFORE_CUTOVER, segTags: [], enrolled: false },
    ]);
    await syncSegments(db);
    expect(applyMock).toHaveBeenCalledWith(db, 'U1', 1, true);
  });
});

describe('syncSegments: タグのセグメントが算出値より進んでいれば下げない（Capsec #243）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freezeAtHourTop();
    listMock.mockReset();
    applyMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('算出が 2 でもタグが 3（enroll 済み）なら流さない', async () => {
    listMock.mockResolvedValue([{ lineUserId: 'U1', segment: 2, isReferral: false }]);
    const db = makeDb([{ id: 'f1', line_user_id: 'U1', created_at: AFTER_CUTOVER, segTags: ['セグメント3'], enrolled: true }]);
    await syncSegments(db);
    expect(applyMock).not.toHaveBeenCalled();
  });

  test('enroll 漏れがあれば算出の番号ではなくタグの番号で流す', async () => {
    listMock.mockResolvedValue([{ lineUserId: 'U1', segment: 2, isReferral: false }]);
    const db = makeDb([{ id: 'f1', line_user_id: 'U1', created_at: AFTER_CUTOVER, segTags: ['セグメント3'], enrolled: false }]);
    await syncSegments(db);
    expect(applyMock).toHaveBeenCalledWith(db, 'U1', 3, false);
  });
});
