import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_FIT_SLOT_ID, parseSeminarVoteData, recordSeminarVote, seminarSurveyFlex, slotLabel, voteReplyText, weekIdOf } from './seminar.js';

const NOW = Date.parse('2026-09-27T09:02:00+09:00'); // 日曜 9:02（アンケート送信の窓）

type Row = Record<string, unknown> | null;

/** first() が返す行を SQL ごとに差し替えられる最小の D1 スタブ */
function makeDb(opts: { slotRow?: Row; insertChanges?: number } = {}) {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        binds: [] as unknown[],
        bind(...b: unknown[]) { stmt.binds = b; return stmt; },
        async first() { return opts.slotRow ?? null; },
        async all() { return { results: [] }; },
        async run() { runs.push({ sql, binds: stmt.binds }); return { meta: { changes: opts.insertChanges ?? 1 } }; },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, runs };
}

beforeEach(() => vi.clearAllMocks());

describe('週 ID と表示（Capsec #331）', () => {
  it('週 ID はその週の日曜の JST 日付', () => {
    expect(weekIdOf(Date.parse('2026-09-27T09:00:00+09:00'))).toBe('2026-09-27'); // 日曜はその日
    expect(weekIdOf(Date.parse('2026-09-30T23:30:00+09:00'))).toBe('2026-09-27'); // 水曜は直前の日曜
    expect(weekIdOf(Date.parse('2026-09-27T00:30:00+09:00'))).toBe('2026-09-27'); // JST 未明を UTC 前日と間違えない
  });

  it('枠の表示は 9/27(日)18:00 の形', () => {
    expect(slotLabel('2026-09-27T18:00:00+09:00')).toBe('9/27(日)18:00');
    expect(slotLabel('2026-09-30T10:30:00+09:00')).toBe('9/30(水)10:30');
  });
});

describe('アンケートの Flex（Capsec #331）', () => {
  const slots = [
    { slot_id: 's1', starts_at: '2026-09-27T18:00:00+09:00' },
    { slot_id: 's2', starts_at: '2026-09-30T10:00:00+09:00' },
  ];

  it('候補ごとに postback ボタンを作り、最後に「どれも合わない」を置く', () => {
    const { contents } = seminarSurveyFlex('2026-09-27', slots, 'free');
    const buttons = (contents.footer as { contents: Array<{ action: { type: string; label: string; data: string } }> }).contents;
    expect(buttons).toHaveLength(3);
    expect(buttons[0].action).toMatchObject({ type: 'postback', label: '9/27(日)18:00', data: 'seminar_vote:2026-09-27:s1' });
    expect(buttons[1].action.data).toBe('seminar_vote:2026-09-27:s2');
    expect(buttons[2].action.data).toBe(`seminar_vote:2026-09-27:${NO_FIT_SLOT_ID}`);
  });

  it('当日（日曜）の枠があるときだけ 18 時開催の注記を出す', () => {
    const withSameDay = seminarSurveyFlex('2026-09-27', slots, 'free');
    const texts = (b: typeof withSameDay) => JSON.stringify(b.contents);
    expect(texts(withSameDay)).toContain('本日 18:00 開催になる場合があります');
    const laterOnly = seminarSurveyFlex('2026-09-27', [slots[1]], 'free');
    expect(texts(laterOnly)).not.toContain('本日 18:00 開催になる場合があります');
  });

  it('有料会員と未課金で文面が違う', () => {
    expect(JSON.stringify(seminarSurveyFlex('2026-09-27', slots, 'paid').contents)).toContain('会員さんの使い方の実例');
    expect(JSON.stringify(seminarSurveyFlex('2026-09-27', slots, 'free').contents)).toContain('くろ（FurimAuto 代表）が生配信');
  });
});

describe('postback の解釈（Capsec #331）', () => {
  it('seminar_vote: 以外は拾わない', () => {
    expect(parseSeminarVoteData('seminar_vote:2026-09-27:s1')).toEqual({ weekId: '2026-09-27', slotId: 's1' });
    expect(parseSeminarVoteData('【ボタン】アンケート回答:YouTube')).toBeNull();
    expect(parseSeminarVoteData('seminar_vote:2026-09-27')).toBeNull();
  });
});

describe('投票の記録（Capsec #331）', () => {
  it('候補にある枠なら 1 票入れて受付の文面を返す', async () => {
    const { db, runs } = makeDb({ slotRow: { slot_id: 's1', starts_at: '2026-09-27T18:00:00+09:00' } });
    const r = await recordSeminarVote(db, { weekId: '2026-09-27', slotId: 's1', friendId: 'f1', lineUserId: 'U1', nowMs: NOW });

    expect(r).toMatchObject({ status: 'counted', label: '9/27(日)18:00' });
    expect(runs[0].sql).toContain('INSERT OR IGNORE INTO furim_seminar_votes');
    expect(runs[0].binds.slice(1, 5)).toEqual(['2026-09-27', 's1', 'f1', 'U1']);
    expect(voteReplyText(r)).toContain('9/27(日)18:00 で受け付けました');
  });

  it('同じ枠の二重押しは 1 票のまま（changes 0 は duplicate）', async () => {
    const { db } = makeDb({ slotRow: { slot_id: 's1', starts_at: '2026-09-27T18:00:00+09:00' }, insertChanges: 0 });
    const r = await recordSeminarVote(db, { weekId: '2026-09-27', slotId: 's1', friendId: 'f1', nowMs: NOW });

    expect(r.status).toBe('duplicate');
    expect(voteReplyText(r)).toContain('すでに受け付けています');
  });

  it('「どれも合わない」は枠を引かずに数える', async () => {
    const { db, runs } = makeDb();
    const r = await recordSeminarVote(db, { weekId: '2026-09-27', slotId: NO_FIT_SLOT_ID, friendId: 'f1', nowMs: NOW });

    expect(r).toMatchObject({ status: 'counted', slotId: NO_FIT_SLOT_ID });
    expect(runs[0].binds[2]).toBe(NO_FIT_SLOT_ID);
    expect(voteReplyText(r)).toContain('どれも都合が合わない');
  });

  it('候補に無い枠（締め切り後の古いアンケート）は記録せず案内だけ返す', async () => {
    const { db, runs } = makeDb({ slotRow: null });
    const r = await recordSeminarVote(db, { weekId: '2026-09-20', slotId: 's9', friendId: 'f1', nowMs: NOW });

    expect(r.status).toBe('unknownSlot');
    expect(runs).toHaveLength(0);
    expect(voteReplyText(r)).toContain('締め切りました');
  });
});
