import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_FIT_SLOT_ID, OTHER_TOPIC_ID, SEMINAR_TOPICS, announceSeminar, collectSeminarTopicReports, parseSeminarTopicData, parseSeminarVoteData, pickTopSlots, recordSeminarTopicNote, recordSeminarTopicVote, recordSeminarVote, remindSeminarSlots, sendSeminarSurvey, seminarAnnounceMessages, seminarEntryUrl, seminarSurveyFlex, slotLabel, surveyWeekIdOf, topicReplyText, topicReportText, voteReplyText, weekIdOf } from './seminar.js';

vi.mock('@line-crm/db', () => ({ createBroadcast: vi.fn(async () => ({ id: 'bc-1' })), createTrackedLink: vi.fn() }));
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
    const { contents } = seminarSurveyFlex('2026-09-27', slots);
    const buttons = (contents.footer as { contents: Array<{ action: { type: string; label: string; data: string } }> }).contents;
    expect(buttons).toHaveLength(3);
    expect(buttons[0].action).toMatchObject({ type: 'postback', label: '9/27(日)18:00', data: 'seminar_vote:2026-09-27:s1' });
    expect(buttons[1].action.data).toBe('seminar_vote:2026-09-27:s2');
    expect(buttons[2].action.data).toBe(`seminar_vote:2026-09-27:${NO_FIT_SLOT_ID}`);
  });

  it('日曜の枠があるときだけ「明日（日）18:00 開催」の注記を出す（アンケートは前日の土曜に届く）', () => {
    const withSameDay = seminarSurveyFlex('2026-09-27', slots);
    const texts = (b: typeof withSameDay) => JSON.stringify(b.contents);
    expect(texts(withSameDay)).toContain('※明日（日）の開催になる');
    const laterOnly = seminarSurveyFlex('2026-09-27', [slots[1]]);
    expect(texts(laterOnly)).not.toContain('※明日（日）の開催になる');
  });

  it('答えた人にだけ開催日時を知らせる旨を入れる（TB-821）', () => {
    expect(JSON.stringify(seminarSurveyFlex('2026-10-04', slots).contents)).toContain('アンケートに答えてくださった方にだけ、開催日時をお知らせします。');
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
    expect(voteReplyText(r)).toContain('本日 17:00 に'); // 日曜に押した人には「本日」
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
    expect(voteReplyText(r)).toContain('ご回答ありがとうございます');
  });

  it('候補に無い枠（締め切り後の古いアンケート）は記録せず案内だけ返す', async () => {
    const { db, runs } = makeDb({ slotRow: null });
    const r = await recordSeminarVote(db, { weekId: '2026-09-20', slotId: 's9', friendId: 'f1', nowMs: NOW });

    expect(r.status).toBe('unknownSlot');
    expect(runs).toHaveLength(0);
    expect(voteReplyText(r)).toContain('締め切りました');
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

describe('5 分前の URL 案内（TB-449 → TB-821）', () => {
  const REMIND_NOW = Date.parse('2026-10-04T19:55:00+09:00');
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

/** SQL の断片ごとに first/all の返り値を決められる D1 スタブ */
function makeScriptedDb(script: { first?: Array<[string, Row]>; all?: Array<[string, unknown[]]>; changes?: number }) {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        binds: [] as unknown[],
        bind(...b: unknown[]) { stmt.binds = b; return stmt; },
        async first() { return script.first?.find(([k]) => sql.includes(k))?.[1] ?? null; },
        async all() { return { results: script.all?.find(([k]) => sql.includes(k))?.[1] ?? [] }; },
        async run() { runs.push({ sql, binds: stmt.binds }); return { meta: { changes: script.changes ?? 1 } }; },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, runs };
}

describe('送る曜日と時刻（TB-821）', () => {
  it('日曜 9:00 には日程アンケートを送らない（旧い流れの停止）', async () => {
    const { db, runs } = makeScriptedDb({ all: [['FROM furim_seminar_slots', [{ slot_id: 's1', starts_at: '2026-10-04T18:00:00+09:00' }]]] });
    const r = await sendSeminarSurvey(db, null, { LINE_CHANNEL_ACCESS_TOKEN: 't' }, { nowMs: Date.parse('2026-10-04T09:00:00+09:00') });
    expect(r).toEqual({ sent: false, reason: 'notSaturday' });
    expect(runs).toHaveLength(0);
  });

  it('土曜のアンケートは翌日曜からの週が対象', () => {
    expect(surveyWeekIdOf(Date.parse('2026-10-03T09:00:00+09:00'))).toBe('2026-10-04');
    expect(surveyWeekIdOf(Date.parse('2026-10-10T09:05:00+09:00'))).toBe('2026-10-11');
  });

  it('土曜 9:00 は全員共通の 1 本だけ一斉配信を積む（会員／未課金で分けない）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ type: 'none', totalUsage: 0 }))));
    const { db, runs } = makeScriptedDb({
      first: [['COUNT(*) AS n FROM friends', { n: 500 }]],
      all: [['FROM furim_seminar_slots', [{ slot_id: 's1', starts_at: '2026-10-04T18:00:00+09:00' }]]],
    });
    const r = await sendSeminarSurvey(db, null, { LINE_CHANNEL_ACCESS_TOKEN: 't' }, { nowMs: Date.parse('2026-10-03T09:00:00+09:00') });
    vi.unstubAllGlobals();
    expect(r).toMatchObject({ sent: true, weekId: '2026-10-04', broadcastIds: ['bc-1'] });
    const updates = runs.filter((x) => x.sql.startsWith('UPDATE broadcasts'));
    expect(updates).toHaveLength(1);
    expect(updates[0].binds[2]).toBe(JSON.stringify({ operator: 'AND', rules: [{ type: 'is_following', value: true }] }));
  });

  it('土曜 9 時台以外は送らない', async () => {
    const { db } = makeScriptedDb({});
    const r = await sendSeminarSurvey(db, null, { LINE_CHANNEL_ACCESS_TOKEN: 't' }, { nowMs: Date.parse('2026-10-03T10:00:00+09:00') });
    expect(r).toEqual({ sent: false, reason: 'notNineOclock' });
  });
});

describe('日曜 17:00 の告知（TB-821）', () => {
  const NOW17 = Date.parse('2026-10-04T17:00:00+09:00');
  const script = {
    first: [['FROM furim_seminar_weeks', { week_id: '2026-10-04', stream_url: 'https://www.youtube.com/@FurimAuto/live', survey_sent_at: 'x' }]] as Array<[string, Row]>,
    all: [
      ['COUNT(v.id)', [{ slot_id: 's3', starts_at: '2026-10-05T20:00:00+09:00', votes: 4 }, { slot_id: 's1', starts_at: '2026-10-04T18:00:00+09:00', votes: 2 }]],
      ['FROM furim_seminar_votes v JOIN friends', [{ friend_id: 'fr-1', line_user_id: 'U1' }, { friend_id: 'fr-2', line_user_id: 'U2' }]],
    ] as Array<[string, unknown[]]>,
  };
  script.first.push(['FROM tracked_links', { id: 'link-1', short_code: 'abc123' }]);

  it('日程アンケートの回答者だけへ 1 人ずつ push する（一斉配信を作らない）', async () => {
    const { db, runs } = makeScriptedDb(script);
    const pushMessage = vi.fn().mockResolvedValue(undefined);
    const r = await announceSeminar(db, { pushMessage }, { LINE_CHANNEL_ACCESS_TOKEN: 't' }, { nowMs: NOW17 });
    expect(r).toMatchObject({ sent: true, recipients: 2, delivered: 2 });
    expect(pushMessage.mock.calls.map((c) => c[0])).toEqual(['U1', 'U2']);
    expect(runs.some((x) => x.sql.includes('broadcasts'))).toBe(false);
    expect(pushMessage.mock.calls[0][1]).toHaveLength(2); // 吹き出し 2 つを 1 回の push で
    expect(runs.filter((x) => x.sql.includes('INSERT INTO messages_log'))).toHaveLength(4);
  });

  it('吹き出し A に日時と視聴ボタン（f 付き）、B に内容アンケート 6 択（枠ごと postback）を入れる', () => {
    const [announce, topics] = seminarAnnounceMessages('2026-10-04', [{ starts_at: '2026-10-05T20:00:00+09:00' }], 'https://x.example/t/abc?openExternalBrowser=1&f=fr-1');
    expect(JSON.stringify(announce.contents)).toContain('① 10/5(月)20:00〜');
    expect(JSON.stringify(announce.contents)).toContain('&f=fr-1');
    const boxes = ((topics.contents.body as { contents: Array<{ action?: { type: string; label: string; data: string; displayText: string } }> }).contents).filter((c) => c.action);
    expect(boxes.map((b) => b.action!.data)).toEqual(SEMINAR_TOPICS.map((t) => `seminar_topic:2026-10-04:${t.id}`));
    for (const b of boxes) expect(b.action!.label.length).toBeLessThanOrEqual(20);
    expect(boxes[0].action!.displayText).toBe('1 メルカリ年商1千万越えアカウントのリアルタイム分析方法');
  });

  it('Flex の本文に手動の改行を入れない（くろさん 2026-09-30）', () => {
    const msgs = [...seminarAnnounceMessages('2026-10-04', [{ starts_at: '2026-10-05T20:00:00+09:00' }, { starts_at: '2026-10-07T20:00:00+09:00' }], 'https://x'), seminarSurveyFlex('2026-10-04', [{ slot_id: 's1', starts_at: '2026-10-04T18:00:00+09:00' }])];
    const texts: string[] = [];
    const walk = (n: unknown) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { const o = n as Record<string, unknown>; if (o.type === 'text' && typeof o.text === 'string') texts.push(o.text); Object.values(o).forEach(walk); } };
    msgs.forEach((m) => walk(m.contents));
    expect(texts.filter((t) => t.includes('\n'))).toEqual([]);
  });

  it('日曜 17 時以外は送らない', async () => {
    const { db } = makeScriptedDb(script);
    const r = await announceSeminar(db, null, { LINE_CHANNEL_ACCESS_TOKEN: 't' }, { nowMs: Date.parse('2026-10-04T09:00:00+09:00') });
    expect(r).toMatchObject({ sent: false, reason: 'notFiveOclock' });
  });
});

describe('5 分前の窓（TB-821）', () => {
  const script = {
    first: [
      ['FROM furim_seminar_weeks', { week_id: '2026-10-04', stream_url: 'https://www.youtube.com/@FurimAuto/live', survey_sent_at: null }],
      ['FROM tracked_links', { id: 'link-1', short_code: 'abc123' }],
    ] as Array<[string, Row]>,
    all: [
      ['FROM furim_seminar_slots', [{ slot_id: 's3', starts_at: '2026-10-04T20:00:00+09:00' }]],
      ['FROM furim_seminar_votes', [{ friend_id: 'fr-1', line_user_id: 'U1' }]],
    ] as Array<[string, unknown[]]>,
  };

  it('30 分前には送らない', async () => {
    const { db } = makeScriptedDb(script);
    const pushMessage = vi.fn();
    const r = await remindSeminarSlots(db, { pushMessage }, { LINE_CHANNEL_ACCESS_TOKEN: 't' }, { nowMs: Date.parse('2026-10-04T19:30:00+09:00') });
    expect(r.reminded).toEqual([]);
    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('5 分前の tick で送る', async () => {
    const { db } = makeScriptedDb(script);
    const pushMessage = vi.fn().mockResolvedValue(undefined);
    await remindSeminarSlots(db, { pushMessage }, { LINE_CHANNEL_ACCESS_TOKEN: 't' }, { nowMs: Date.parse('2026-10-04T19:55:00+09:00') });
    expect(pushMessage).toHaveBeenCalledTimes(1);
  });
});

describe('聞きたい内容アンケート（TB-821）', () => {
  it('postback を解釈し、6 択の外は数えない', async () => {
    expect(parseSeminarTopicData('seminar_topic:2026-10-04:t2')).toEqual({ weekId: '2026-10-04', topicId: 't2' });
    expect(parseSeminarTopicData('seminar_vote:2026-10-04:s1')).toBeNull();
    const { db, runs } = makeScriptedDb({});
    expect(await recordSeminarTopicVote(db, { weekId: '2026-10-04', topicId: 't9', friendId: 'f1' })).toMatchObject({ status: 'unknownTopic' });
    expect(runs).toHaveLength(0);
  });

  it('複数選択できる（別の選択肢はそれぞれ 1 票）。同じ選択肢の二重押しは duplicate', async () => {
    const last: Array<[string, Row]> = [['MAX(starts_at)', { last_starts_at: '2026-10-07T20:00:00+09:00' }]];
    const at = Date.parse('2026-10-04T17:10:00+09:00');
    const a = makeScriptedDb({ first: last });
    expect(await recordSeminarTopicVote(a.db, { weekId: '2026-10-04', topicId: 't1', friendId: 'f1', nowMs: at })).toMatchObject({ status: 'counted' });
    expect(a.runs[0].sql).toContain('INSERT OR IGNORE INTO furim_seminar_topic_votes');
    const b = makeScriptedDb({ first: last, changes: 0 });
    const dup = await recordSeminarTopicVote(b.db, { weekId: '2026-10-04', topicId: 't1', friendId: 'f1', nowMs: at });
    expect(topicReplyText(dup)).toContain('すでに承っております');
  });

  it('最後の枠の開始 1 時間前を過ぎたら締め切り。開催枠の無い週も締め切り', async () => {
    const last: Array<[string, Row]> = [['MAX(starts_at)', { last_starts_at: '2026-10-07T20:00:00+09:00' }]];
    const late = makeScriptedDb({ first: last });
    const r = await recordSeminarTopicVote(late.db, { weekId: '2026-10-04', topicId: 't2', friendId: 'f1', nowMs: Date.parse('2026-10-07T19:00:00+09:00') });
    expect(r.status).toBe('closed');
    expect(late.runs).toHaveLength(0);
    expect(topicReplyText(r)).toContain('受付を締め切りました');
    const none = makeScriptedDb({});
    expect((await recordSeminarTopicVote(none.db, { weekId: 'test', topicId: 't2', friendId: 'f1' })).status).toBe('closed');
  });

  it('「6 その他」を押すと自由記入を促し、1 時間以内の最初の文を控える', async () => {
    expect(topicReplyText({ status: 'counted', topicId: OTHER_TOPIC_ID })).toContain('このトークにそのまま送ってください');
    const now = Date.parse('2026-10-04T17:20:00+09:00');
    const fresh = makeScriptedDb({ first: [['FROM furim_seminar_topic_votes', { id: 'v1', voted_at: '2026-10-04T17:05:00.000+09:00' }]] });
    expect(await recordSeminarTopicNote(fresh.db, 'f1', ' 仕入れの基準が知りたい ', now)).toBe(true);
    expect(fresh.runs[0].binds).toEqual(['仕入れの基準が知りたい', 'v1']);
    const stale = makeScriptedDb({ first: [['FROM furim_seminar_topic_votes', { id: 'v1', voted_at: '2026-10-04T15:00:00.000+09:00' }]] });
    expect(await recordSeminarTopicNote(stale.db, 'f1', '別の問い合わせ', now)).toBe(false);
    expect(stale.runs).toHaveLength(0);
  });

  it('くろさん宛の集計に票数とその他の本文が入る', () => {
    const text = topicReportText('2026-10-04', '2026-10-05T20:00:00+09:00', [{ topic_id: 't1', n: 3 }, { topic_id: 't6', n: 1 }], ['仕入れの基準']);
    expect(text).toContain('10/5(月)20:00');
    expect(text).toContain('1 メルカリ年商1千万越えアカウントのリアルタイム分析方法 … 3 票');
    expect(text).toContain('2 全自動化運用のリアルタイム講義 … 0 票');
    expect(text).toContain('・仕入れの基準');
  });

  it('集計は開始 1 時間前。日曜 18:00 の枠は告知から 30 分待って 17:30 に送る', async () => {
    const mk = () => makeScriptedDb({
      first: [['SELECT announced_at FROM furim_seminar_weeks', { announced_at: '2026-10-04T17:00:31.000+09:00' }]],
      all: [['FROM furim_seminar_slots', [{ slot_id: 's1', starts_at: '2026-10-04T18:00:00+09:00' }]]],
    });
    expect((await collectSeminarTopicReports(mk().db, { nowMs: Date.parse('2026-10-04T17:05:00+09:00') })).reported).toEqual([]);
    const r = await collectSeminarTopicReports(mk().db, { nowMs: Date.parse('2026-10-04T17:35:00+09:00') });
    expect(r.reported.map((x) => x.slotId)).toEqual(['s1']);
  });
});
