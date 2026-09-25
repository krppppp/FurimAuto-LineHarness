// 週1セミナー（生配信）の日程アンケート（Capsec #331）。仕様: specs/weekly-seminar-funnel.md
//
// 週の流れ: 金曜に候補日時を登録 → 日曜 9:00 にアンケート（有料/未課金の2種）→ 17:00 に集計・告知（#332）。
// 票は Flex の postback ボタンで受け、(week_id, slot_id, friend_id) の UNIQUE で二重押しを 1 票にする。
//
// 二重送信について: cron は 5 分ごとで、毎時 0 分は 6 時間 cron と同時に発火する。時刻の一致だけでは
// 1 回きりにならないので、furim_seminar_weeks.survey_sent_at が NULL の行を条件付き UPDATE で
// 取れた実行だけが送る（kaisetsu-delivery と同じ枠取り）。
import { formatJstIso } from './customer-store.js';

/** 有料会員のタグ ID（月額会員）。既存のセグメント配信と同じ値 */
export const MEMBER_TAG_ID = 'b71d63843d84f894299895e415255ead';

export const SEMINAR_VOTE_PREFIX = 'seminar_vote:';
/** 「どれも都合が合わない」の slot_id */
export const NO_FIT_SLOT_ID = 'none';

export type SeminarSlot = { slot_id: string; starts_at: string; is_chosen?: number };
export type SeminarWeek = { week_id: string; stream_url: string | null; survey_sent_at: string | null };

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** その時刻を含む週の「日曜日」の JST 日付 'YYYY-MM-DD'。日曜はその日自身 */
export function weekIdOf(nowMs: number): string {
  const jst = new Date(nowMs + 9 * 60 * 60_000);
  const sunday = new Date(jst.getTime() - jst.getUTCDay() * 24 * 60 * 60_000);
  return sunday.toISOString().slice(0, 10);
}

/** JST の時（0〜23） */
export function jstHourOf(nowMs: number): number {
  return new Date(nowMs + 9 * 60 * 60_000).getUTCHours();
}

/** '9/27(日)10:00'（お客様向けの表示） */
export function slotLabel(startsAt: string): string {
  const ms = Date.parse(startsAt);
  if (Number.isNaN(ms)) return startsAt;
  const jst = new Date(ms + 9 * 60 * 60_000);
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()}(${WEEKDAY_JA[jst.getUTCDay()]})${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
}

export async function getSeminarWeek(db: D1Database, weekId: string): Promise<SeminarWeek | null> {
  return await db
    .prepare('SELECT week_id, stream_url, survey_sent_at FROM furim_seminar_weeks WHERE week_id = ?')
    .bind(weekId)
    .first<SeminarWeek>();
}

export async function listSeminarSlots(db: D1Database, weekId: string): Promise<SeminarSlot[]> {
  const r = await db
    .prepare('SELECT slot_id, starts_at, is_chosen FROM furim_seminar_slots WHERE week_id = ? ORDER BY starts_at')
    .bind(weekId)
    .all<SeminarSlot>();
  return r.results ?? [];
}

type FlexBubble = Record<string, unknown>;

/**
 * アンケートの Flex（1 枠 1 postback ボタン＋「どれも合わない」）。
 * 文面は仕様書の「文面ひな形」どおり。日曜（week_id と同じ日）の枠があるときだけ当日開催の注記を足す。
 */
export function seminarSurveyFlex(
  weekId: string,
  slots: SeminarSlot[],
  variant: 'paid' | 'free',
): { altText: string; contents: FlexBubble } {
  const hasSameDay = slots.some((s) => s.starts_at.slice(0, 10) === weekId);
  const lead =
    variant === 'paid'
      ? 'いつも FurimAuto をご利用いただきありがとうございます。今週の生配信では、会員さんの使い方の実例と、売上をもう一段伸ばす設定をお見せします。'
      : '今週、くろ（FurimAuto 代表）が生配信で「メルカリ物販を自動化して、作業時間を減らしながら売上を伸ばすやり方」を実演します。';
  const title = variant === 'paid' ? '会員向け｜今週の生配信セミナー日程アンケート' : 'FurimAuto 無料セミナーの日程アンケート';
  const body: FlexBubble[] = [
    { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true },
    { type: 'text', text: lead, size: 'sm', wrap: true, margin: 'md' },
    { type: 'text', text: '見られそうな日時を押してください（いくつでも押せます）。票の多い 2 つの日時で開催します。', size: 'sm', wrap: true, margin: 'md' },
    { type: 'text', text: '本日 17:00 に締め切り、開催日時をこの LINE でお知らせします。', size: 'sm', wrap: true, margin: 'md' },
  ];
  if (hasSameDay) body.push({ type: 'text', text: '※本日 18:00 開催になる場合があります', size: 'xs', wrap: true, margin: 'md', color: '#888888' });

  const buttons = slots.map((s) => ({
    type: 'button',
    style: 'primary',
    action: { type: 'postback', label: slotLabel(s.starts_at), data: `${SEMINAR_VOTE_PREFIX}${weekId}:${s.slot_id}`, displayText: `${slotLabel(s.starts_at)} に参加できます` },
  }));
  buttons.push({
    type: 'button',
    style: 'secondary',
    action: { type: 'postback', label: 'どれも合わない', data: `${SEMINAR_VOTE_PREFIX}${weekId}:${NO_FIT_SLOT_ID}`, displayText: 'どれも都合が合いません' },
  });

  return {
    altText: `${title}（${slots.map((s) => slotLabel(s.starts_at)).join('・')}）`,
    contents: {
      type: 'bubble',
      size: 'mega',
      body: { type: 'box', layout: 'vertical', contents: body },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons },
    },
  };
}

export type VoteResult =
  | { status: 'counted' | 'duplicate'; slotId: string; label: string }
  | { status: 'unknownSlot' | 'notSurveyWeek' };

/**
 * 票を 1 行入れる。同じ (week, slot, friend) は UNIQUE で弾かれるので 2 回目は duplicate。
 * 受付返信の文面はここでは作らず、呼び出し側（webhook）が label を使って返す。
 */
export async function recordSeminarVote(
  db: D1Database,
  input: { weekId: string; slotId: string; friendId: string; lineUserId?: string | null; nowMs?: number },
): Promise<VoteResult> {
  const nowMs = input.nowMs ?? Date.now();
  let label = 'どれも都合が合わない';
  if (input.slotId !== NO_FIT_SLOT_ID) {
    const slot = await db
      .prepare('SELECT slot_id, starts_at FROM furim_seminar_slots WHERE week_id = ? AND slot_id = ?')
      .bind(input.weekId, input.slotId)
      .first<SeminarSlot>();
    if (!slot) return { status: 'unknownSlot' };
    label = slotLabel(slot.starts_at);
  }
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO furim_seminar_votes (id, week_id, slot_id, friend_id, line_user_id, voted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), input.weekId, input.slotId, input.friendId, input.lineUserId ?? null, formatJstIso(nowMs))
    .run();
  const counted = (res.meta?.changes ?? 0) > 0;
  return { status: counted ? 'counted' : 'duplicate', slotId: input.slotId, label };
}

/** postback の data から week_id・slot_id を取る。seminar_vote: 以外なら null */
export function parseSeminarVoteData(data: string): { weekId: string; slotId: string } | null {
  if (!data.startsWith(SEMINAR_VOTE_PREFIX)) return null;
  const [weekId, slotId] = data.slice(SEMINAR_VOTE_PREFIX.length).split(':');
  if (!weekId || !slotId) return null;
  return { weekId, slotId };
}

/** 受付返信の本文 */
export function voteReplyText(result: VoteResult): string {
  if (result.status !== 'counted' && result.status !== 'duplicate') {
    return 'このアンケートは締め切りました。次回の日程アンケートをお待ちください。';
  }
  if (result.slotId === NO_FIT_SLOT_ID) {
    return '「どれも都合が合わない」で受け付けました。次回の候補日程もお送りしますので、ぜひご参加ください。';
  }
  return result.status === 'counted'
    ? `${result.label} で受け付けました。ほかに見られる日時があれば、続けて押してください。`
    : `${result.label} はすでに受け付けています。`;
}

type QuotaResult = { ok: boolean; limit: number | null; used: number | null; note: string };

/**
 * LINE の月間送信上限の残り。type='none'（上限なし）ならそのまま送ってよい。
 * 判定できないとき（API エラー）は ok=false にして送信を止める。上限に当てて配信が
 * 途中で切れるより、送らずにくろさんへ上げる方が実害が小さい。
 */
export async function checkMessageQuota(channelAccessToken: string, needed: number): Promise<QuotaResult> {
  const headers = { Authorization: `Bearer ${channelAccessToken}` };
  try {
    const [quotaRes, usedRes] = await Promise.all([
      fetch('https://api.line.me/v2/bot/message/quota', { headers }),
      fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers }),
    ]);
    if (!quotaRes.ok || !usedRes.ok) return { ok: false, limit: null, used: null, note: `quota API ${quotaRes.status}/${usedRes.status}` };
    const quota = (await quotaRes.json()) as { type: string; value?: number };
    const used = (await usedRes.json()) as { totalUsage?: number };
    if (quota.type === 'none') return { ok: true, limit: null, used: used.totalUsage ?? null, note: '上限なし' };
    const limit = quota.value ?? 0;
    const totalUsage = used.totalUsage ?? 0;
    const remaining = limit - totalUsage;
    return { ok: remaining >= needed, limit, used: totalUsage, note: `残り ${remaining} 通／必要 ${needed} 通` };
  } catch (err) {
    return { ok: false, limit: null, used: null, note: `quota API 例外: ${String(err)}` };
  }
}

type SendEnv = { LINE_CHANNEL_ACCESS_TOKEN: string };
type LineClientLike = {
  pushMessage(to: string, messages: unknown[]): Promise<unknown>;
  multicast?(to: string[], messages: unknown[]): Promise<unknown>;
};

export type SurveySendResult =
  | { sent: false; reason: 'notSunday' | 'notNineOclock' | 'alreadySent' | 'noSlots' | 'quota'; note?: string }
  | { sent: true; weekId: string; slots: number; broadcastIds: string[] };

/**
 * 日曜 9:00 のアンケート送信。5 分 cron から呼ぶ。
 * 送信そのものは既存の broadcasts キュー（segment_conditions）に乗せる。有料/未課金の分けは
 * 「月額会員」タグで、既存のセグメント配信（v4.3.x のお知らせ）と同じ切り方にしている。
 */
export async function sendSeminarSurvey(
  db: D1Database,
  lineClient: LineClientLike | null,
  env: SendEnv,
  opts: { nowMs?: number; targetLineUserId?: string } = {},
): Promise<SurveySendResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const weekId = weekIdOf(nowMs);
  const isTestSend = !!opts.targetLineUserId;

  if (!isTestSend) {
    const jst = new Date(nowMs + 9 * 60 * 60_000);
    if (jst.getUTCDay() !== 0) return { sent: false, reason: 'notSunday' };
    if (jstHourOf(nowMs) !== 9) return { sent: false, reason: 'notNineOclock' };
  }

  const slots = await listSeminarSlots(db, weekId);
  if (slots.length === 0) return { sent: false, reason: 'noSlots' };

  const paid = seminarSurveyFlex(weekId, slots, 'paid');
  const free = seminarSurveyFlex(weekId, slots, 'free');

  // テスト送信（あじゃぱー）は push で 1 通だけ。枠取りもしない
  if (isTestSend) {
    if (lineClient) await lineClient.pushMessage(opts.targetLineUserId!, [{ type: 'flex', altText: free.altText, contents: free.contents }]);
    return { sent: true, weekId, slots: slots.length, broadcastIds: [] };
  }

  // 枠取り: survey_sent_at が NULL の行を取れた実行だけが送る（cron の二重発火対策）
  await db
    .prepare('INSERT OR IGNORE INTO furim_seminar_weeks (week_id, created_at) VALUES (?, ?)')
    .bind(weekId, formatJstIso(nowMs))
    .run();
  const claim = await db
    .prepare('UPDATE furim_seminar_weeks SET survey_sent_at = ? WHERE week_id = ? AND survey_sent_at IS NULL')
    .bind(formatJstIso(nowMs), weekId)
    .run();
  if ((claim.meta?.changes ?? 0) === 0) return { sent: false, reason: 'alreadySent' };

  // 送信量の確認。足りない・確かめられないときは送らずに枠取りを戻し、くろさんに上げる
  const following = await db.prepare('SELECT COUNT(*) AS n FROM friends WHERE is_following = 1').first<{ n: number }>();
  const quota = await checkMessageQuota(env.LINE_CHANNEL_ACCESS_TOKEN, following?.n ?? 0);
  if (!quota.ok) {
    await db.prepare('UPDATE furim_seminar_weeks SET survey_sent_at = NULL WHERE week_id = ?').bind(weekId).run();
    return { sent: false, reason: 'quota', note: quota.note };
  }

  const { createBroadcast } = await import('@line-crm/db');
  const broadcastIds: string[] = [];
  for (const [variant, flex] of [['paid', paid], ['free', free]] as const) {
    const segment = {
      operator: 'AND' as const,
      rules: [
        { type: 'is_following' as const, value: true },
        variant === 'paid'
          ? { type: 'tag_exists' as const, value: MEMBER_TAG_ID }
          : { type: 'tag_not_exists' as const, value: MEMBER_TAG_ID },
      ],
    };
    const created = await createBroadcast(db, {
      title: `[SEMINAR] ${weekId} 日程アンケート（${variant === 'paid' ? '月額会員' : '未課金'}）`,
      messageType: 'flex',
      messageContent: JSON.stringify(flex.contents),
      targetType: 'all',
      trackLinks: false, // postback だけなので URL の自動短縮は不要
    });
    await db
      .prepare('UPDATE broadcasts SET status = ?, batch_offset = 0, alt_text = ?, segment_conditions = ? WHERE id = ?')
      .bind('sending', flex.altText, JSON.stringify(segment), created.id)
      .run();
    broadcastIds.push(created.id);
  }
  return { sent: true, weekId, slots: slots.length, broadcastIds };
}

// ここから下は日曜 17:00 以降ぶん（Capsec #332）: 集計 → 上位2枠の決定 → 告知 → 30分前リマインド

export type VoteCount = { slot_id: string; starts_at: string; votes: number };

/** 枠ごとの得票（「どれも合わない」は除く）。多い順・同数なら早い日時が先 */
export async function countSeminarVotes(db: D1Database, weekId: string): Promise<VoteCount[]> {
  const r = await db
    .prepare(
      `SELECT s.slot_id AS slot_id, s.starts_at AS starts_at, COUNT(v.id) AS votes
         FROM furim_seminar_slots s
         LEFT JOIN furim_seminar_votes v ON v.week_id = s.week_id AND v.slot_id = s.slot_id
        WHERE s.week_id = ?
        GROUP BY s.slot_id, s.starts_at
        ORDER BY votes DESC, s.starts_at ASC`,
    )
    .bind(weekId)
    .all<VoteCount>();
  return (r.results ?? []).map((row) => ({ ...row, votes: Number(row.votes ?? 0) }));
}

/** 「どれも都合が合わない」の数 */
export async function countNoFitVotes(db: D1Database, weekId: string): Promise<number> {
  const r = await db
    .prepare('SELECT COUNT(*) AS n FROM furim_seminar_votes WHERE week_id = ? AND slot_id = ?')
    .bind(weekId, NO_FIT_SLOT_ID)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/** 上位2枠を選ぶ。0 票の枠は開催しない（同数は早い日時が先＝countSeminarVotes の並び） */
export function pickTopSlots(counts: VoteCount[], take = 2): VoteCount[] {
  return counts.filter((c) => c.votes > 0).slice(0, take);
}

export type AnnounceResult =
  | { sent: false; reason: 'notSunday' | 'notFiveOclock' | 'alreadyAnnounced' | 'noVotes' | 'noStreamUrl'; weekId: string; note?: string }
  | { sent: true; weekId: string; chosen: VoteCount[]; broadcastId: string; trackedLinkId: string };

/**
 * 日曜 17:00 の集計と告知。5 分 cron から呼ぶ。
 * 入口は週ごとの計測リンク（/t/<short_code>）を通してから配信 URL へ飛ばす。押した人は link_clicks に残る。
 */
export async function announceSeminar(
  db: D1Database,
  lineClient: LineClientLike | null,
  env: SendEnv & { WORKER_URL?: string },
  opts: { nowMs?: number } = {},
): Promise<AnnounceResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const weekId = weekIdOf(nowMs);
  const jst = new Date(nowMs + 9 * 60 * 60_000);
  if (jst.getUTCDay() !== 0) return { sent: false, reason: 'notSunday', weekId };
  if (jstHourOf(nowMs) !== 17) return { sent: false, reason: 'notFiveOclock', weekId };

  const week = await getSeminarWeek(db, weekId);
  if (!week?.stream_url) return { sent: false, reason: 'noStreamUrl', weekId };

  // 枠取り（cron の二重発火対策）。集計結果が空でも announced_at は立てたままにして、
  // 「0 票だったのに 5 分後にまた集計して告知する」を防ぐ
  const claim = await db
    .prepare('UPDATE furim_seminar_weeks SET announced_at = ? WHERE week_id = ? AND announced_at IS NULL')
    .bind(formatJstIso(nowMs), weekId)
    .run();
  if ((claim.meta?.changes ?? 0) === 0) return { sent: false, reason: 'alreadyAnnounced', weekId };

  const counts = await countSeminarVotes(db, weekId);
  const chosen = pickTopSlots(counts);
  await db.prepare('UPDATE furim_seminar_weeks SET decided_at = ? WHERE week_id = ?').bind(formatJstIso(nowMs), weekId).run();
  if (chosen.length === 0) return { sent: false, reason: 'noVotes', weekId, note: `候補 ${counts.length} 枠すべて 0 票` };

  for (const c of chosen) {
    await db.prepare('UPDATE furim_seminar_slots SET is_chosen = 1 WHERE week_id = ? AND slot_id = ?').bind(weekId, c.slot_id).run();
  }

  // 週ごとに 1 本だけ計測リンクを作る（クリック＝参加見込みとして link_clicks で数える）
  const { createTrackedLink } = await import('@line-crm/db');
  const { resolveTrackedLinkBaseUrl } = await import('../lib/link-base-url.js');
  const link = await createTrackedLink(db, { name: `seminar_${weekId}`, originalUrl: week.stream_url });
  const linkBase = await resolveTrackedLinkBaseUrl(db, env.WORKER_URL ?? '');
  const entryUrl = `${linkBase}/t/${link.short_code ?? link.id}?openExternalBrowser=1`;

  const flex = {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: '今週のセミナー日程が決まりました', weight: 'bold', size: 'lg', wrap: true },
        ...chosen.map((c, i) => ({ type: 'text', text: `${i === 0 ? '①' : '②'} ${slotLabel(c.starts_at)}〜`, size: 'md', margin: 'md', wrap: true })),
        { type: 'text', text: '開始時間になったら、下のボタンからそのまま見られます。途中からの参加・途中退出も自由です。', size: 'sm', wrap: true, margin: 'lg' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [{ type: 'button', style: 'primary', action: { type: 'uri', label: 'セミナーを見る', uri: entryUrl } }],
    },
  };
  const altText = `今週のセミナー日程（${chosen.map((c) => slotLabel(c.starts_at)).join('・')}）`;

  const { createBroadcast } = await import('@line-crm/db');
  const created = await createBroadcast(db, {
    title: `[SEMINAR] ${weekId} 開催日程の告知`,
    messageType: 'flex',
    messageContent: JSON.stringify(flex),
    targetType: 'all',
    trackLinks: false, // 計測リンクは自分で作って入れてあるので、自動短縮に二重に包ませない
  });
  await db
    .prepare('UPDATE broadcasts SET status = ?, batch_offset = 0, alt_text = ?, segment_conditions = ? WHERE id = ?')
    .bind('sending', altText, JSON.stringify({ operator: 'AND', rules: [{ type: 'is_following', value: true }] }), created.id)
    .run();

  return { sent: true, weekId, chosen, broadcastId: created.id, trackedLinkId: link.id };
}

export type ReminderResult = { reminded: Array<{ slotId: string; recipients: number }> };

/**
 * 開催 30 分前のリマインド（その枠に投票した人だけ）。5 分 cron から呼ぶ。
 * reminded_at の条件付き UPDATE で枠を取った実行だけが送る。
 */
export async function remindSeminarSlots(
  db: D1Database,
  lineClient: LineClientLike | null,
  env: SendEnv & { WORKER_URL?: string },
  opts: { nowMs?: number } = {},
): Promise<ReminderResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const weekId = weekIdOf(nowMs);
  const week = await getSeminarWeek(db, weekId);
  const reminded: Array<{ slotId: string; recipients: number }> = [];
  if (!week?.stream_url) return { reminded };

  const due = await db
    .prepare('SELECT slot_id, starts_at FROM furim_seminar_slots WHERE week_id = ? AND is_chosen = 1 AND reminded_at IS NULL')
    .bind(weekId)
    .all<SeminarSlot>();
  for (const slot of due.results ?? []) {
    const startsMs = Date.parse(slot.starts_at);
    if (Number.isNaN(startsMs)) continue;
    // 30 分前〜開始までの間だけ送る（過ぎた枠に後から送らない）
    if (!(nowMs >= startsMs - 30 * 60_000 && nowMs < startsMs)) continue;
    const claim = await db
      .prepare('UPDATE furim_seminar_slots SET reminded_at = ? WHERE week_id = ? AND slot_id = ? AND reminded_at IS NULL')
      .bind(formatJstIso(nowMs), weekId, slot.slot_id)
      .run();
    if ((claim.meta?.changes ?? 0) === 0) continue;

    const voters = await db
      .prepare(
        `SELECT f.line_user_id AS line_user_id
           FROM furim_seminar_votes v JOIN friends f ON f.id = v.friend_id
          WHERE v.week_id = ? AND v.slot_id = ? AND f.is_following = 1`,
      )
      .bind(weekId, slot.slot_id)
      .all<{ line_user_id: string }>();
    const ids = (voters.results ?? []).map((v) => v.line_user_id).filter(Boolean);
    reminded.push({ slotId: slot.slot_id, recipients: ids.length });
    if (ids.length === 0 || !lineClient) continue;

    const { resolveTrackedLinkBaseUrl } = await import('../lib/link-base-url.js');
    const linkBase = await resolveTrackedLinkBaseUrl(db, env.WORKER_URL ?? '');
    const existing = await db
      .prepare('SELECT id, short_code FROM tracked_links WHERE name = ? ORDER BY created_at DESC LIMIT 1')
      .bind(`seminar_${weekId}`)
      .first<{ id: string; short_code: string | null }>();
    const entryUrl = existing ? `${linkBase}/t/${existing.short_code ?? existing.id}?openExternalBrowser=1` : week.stream_url;
    const messages = [
      {
        type: 'flex',
        altText: `まもなく ${slotLabel(slot.starts_at)} からセミナーを始めます`,
        contents: {
          type: 'bubble',
          body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: `まもなく ${slotLabel(slot.starts_at)} からセミナーを始めます。下のボタンから見られます。`, wrap: true, size: 'md' }] },
          footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'primary', action: { type: 'uri', label: 'セミナーを見る', uri: entryUrl } }] },
        },
      },
    ];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      if (lineClient.multicast) await lineClient.multicast(chunk, messages);
      else for (const id of chunk) await lineClient.pushMessage(id, messages);
    }
  }
  return { reminded };
}
