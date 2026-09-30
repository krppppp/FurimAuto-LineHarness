import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_FIT_SLOT_ID, parseSeminarVoteData, pickTopSlots, recordSeminarVote, remindSeminarSlots, seminarEntryUrl, seminarSurveyFlex, slotLabel, voteReplyText, weekIdOf } from './seminar.js';

vi.mock('../lib/link-base-url.js', () => ({ resolveTrackedLinkBaseUrl: async () => 'https://line-harness-prod.furimuato.workers.dev' }));

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
    expect(JSON.stringify(seminarSurveyFlex('2026-09-27', slots, 'paid').contents)).toContain('会員のみなさんの使い方の実例');
    expect(JSON.stringify(seminarSurveyFlex('2026-09-27', slots, 'free').contents)).toContain('FurimAuto を運営する法人代表の黒岩');
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
    expect(voteReplyText(r)).toContain('9/27(日)18:00 で承りました');
  });

  it('同じ枠の二重押しは 1 票のまま（changes 0 は duplicate）', async () => {
    const { db } = makeDb({ slotRow: { slot_id: 's1', starts_at: '2026-09-27T18:00:00+09:00' }, insertChanges: 0 });
    const r = await recordSeminarVote(db, { weekId: '2026-09-27', slotId: 's1', friendId: 'f1', nowMs: NOW });

    expect(r.status).toBe('duplicate');
    expect(voteReplyText(r)).toContain('すでに承っております');
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
    expect(voteReplyText(r)).toContain('締め切らせていただきました');
  });
});

describe('得票の集計と上位2枠（Capsec #332）', () => {
  const counts = [
    { slot_id: 's2', starts_at: '2026-09-29T10:00:00+09:00', votes: 5 },
    { slot_id: 's1', starts_at: '2026-09-27T18:00:00+09:00', votes: 5 },
    { slot_id: 's3', starts_at: '2026-09-30T21:00:00+09:00', votes: 2 },
    { slot_id: 's4', starts_at: '2026-10-01T10:00:00+09:00', votes: 0 },
  ];

  it('上位2枠を取る（並びは SQL 側で votes DESC, starts_at ASC）', () => {
    expect(pickTopSlots(counts).map((c) => c.slot_id)).toEqual(['s2', 's1']);
  });

  it('0 票の枠は開催しない', () => {
    expect(pickTopSlots([{ slot_id: 's4', starts_at: '2026-10-01T10:00:00+09:00', votes: 0 }])).toEqual([]);
  });

  it('得票のある枠が1つだけなら1枠で開催する', () => {
    expect(pickTopSlots(counts.slice(2)).map((c) => c.slot_id)).toEqual(['s3']);
  });
});

describe('入口 URL（Capsec #332）', () => {
  const stream = 'https://www.youtube.com/@FurimAuto/live';

  it('絶対 URL の base なら計測リンクを通す', () => {
    expect(seminarEntryUrl('https://line-harness-prod.furimuato.workers.dev', 'abc123', stream))
      .toBe('https://line-harness-prod.furimuato.workers.dev/t/abc123?openExternalBrowser=1');
  });

  it('base が空なら計測を捨てて配信 URL をそのまま使う（相対 URL は LINE が弾く）', () => {
    expect(seminarEntryUrl('', 'abc123', stream)).toBe(stream);
  });

  it('friendId を渡すと &f= を足す（TB-449）', () => {
    expect(seminarEntryUrl('https://line-harness-prod.furimuato.workers.dev', 'abc123', stream, 'fr-1'))
      .toBe('https://line-harness-prod.furimuato.workers.dev/t/abc123?openExternalBrowser=1&f=fr-1');
    expect(seminarEntryUrl('', 'abc123', stream, 'fr-1')).toBe(stream);
  });
});

describe('30 分前リマインド（TB-449）', () => {
  const REMIND_NOW = Date.parse('2026-10-04T19:35:00+09:00');
  const voters = [
    { friend_id: 'fr-1', line_user_id: 'U1' },
    { friend_id: 'fr-2', line_user_id: 'U2' },
  ];

  function makeReminderDb() {
    const runs: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const stmt = {
          binds: [] as unknown[],
          bind(...b: unknown[]) { stmt.binds = b; return stmt; },
          async first() {
            if (sql.includes('FROM furim_seminar_weeks')) return { week_id: '2026-10-04', stream_url: 'https://www.youtube.com/@FurimAuto/live', survey_sent_at: null };
            if (sql.includes('FROM tracked_links')) return { id: 'link-1', short_code: 'abc123' };
            return null;
          },
          async all() {
            if (sql.includes('FROM furim_seminar_slots')) return { results: [{ slot_id: 's3', starts_at: '2026-10-04T20:00:00+09:00' }] };
            if (sql.includes('FROM furim_seminar_votes')) return { results: voters };
            return { results: [] };
          },
          async run() { runs.push({ sql, binds: stmt.binds }); return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    };
    return { db: db as unknown as D1Database, runs };
  }

  const uriOf = (messages: unknown[]) =>
    (messages[0] as { contents: { footer: { contents: Array<{ action: { uri: string } }> } } }).contents.footer.contents[0].action.uri;

  it('multicast を使わず 1 人ずつ push し、入口 URL にその人の friend_id を載せる', async () => {
    const { db } = makeReminderDb();
    const pushMessage = vi.fn().mockResolvedValue(undefined);
    const multicast = vi.fn();
    const r = await remindSeminarSlots(db, { pushMessage, multicast }, { LINE_CHANNEL_ACCESS_TOKEN: 't' }, { nowMs: REMIND_NOW });
    expect(r.reminded).toEqual([{ slotId: 's3', recipients: 2 }]);
    expect(multicast).not.toHaveBeenCalled();
    expect(pushMessage).toHaveBeenCalledTimes(2);
    expect(pushMessage.mock.calls[0][0]).toBe('U1');
    expect(uriOf(pushMessage.mock.calls[0][1])).toBe('https://line-harness-prod.furimuato.workers.dev/t/abc123?openExternalBrowser=1&f=fr-1');
    expect(uriOf(pushMessage.mock.calls[1][1])).toBe('https://line-harness-prod.furimuato.workers.dev/t/abc123?openExternalBrowser=1&f=fr-2');
  });

  it('1 人の失敗で残りを止めない。枠取りは戻さない', async () => {
    const { db, runs } = makeReminderDb();
    const pushMessage = vi.fn().mockRejectedValueOnce(new Error('blocked')).mockResolvedValue(undefined);
    await remindSeminarSlots(db, { pushMessage }, { LINE_CHANNEL_ACCESS_TOKEN: 't' }, { nowMs: REMIND_NOW });
    expect(pushMessage).toHaveBeenCalledTimes(2);
    expect(runs.some((x) => x.sql.includes('reminded_at = NULL'))).toBe(false);
  });

  it('全員に失敗したら枠取りを戻して投げ直す（次の tick で再送できるように）', async () => {
    const { db, runs } = makeReminderDb();
    const pushMessage = vi.fn().mockRejectedValue(new Error('LINE down'));
    await expect(remindSeminarSlots(db, { pushMessage }, { LINE_CHANNEL_ACCESS_TOKEN: 't' }, { nowMs: REMIND_NOW })).rejects.toThrow('LINE down');
    expect(runs.some((x) => x.sql.includes('reminded_at = NULL'))).toBe(true);
  });
});
