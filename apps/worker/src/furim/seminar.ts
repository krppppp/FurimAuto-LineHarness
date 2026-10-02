// 週1セミナー（生配信）の日程アンケート（Capsec #331）。仕様: specs/weekly-seminar-funnel.md
//
// 週の流れ（TB-821・2026-09-30 くろさん決定。生配信の配信はこの 3 通だけ）:
//   土曜 9:00  翌日曜からの週の日程アンケートを全員へ（有料/未課金の2種）
//   日曜 17:00 集計し、日程アンケートに答えた人だけへ上位 2 枠の告知＋聞きたい内容アンケート（6 択）
//   各枠の開始 5 分前 その枠に投票した人だけへ配信 URL
// 内容アンケートの集計は各枠の開始 1 時間前にくろさんへ送る（お客様への配信ではない）。
// 票は Flex の postback ボタンで受け、(week_id, slot_id, friend_id) の UNIQUE で二重押しを 1 票にする。
//
// 二重送信について: cron は 5 分ごとで、毎時 0 分は 6 時間 cron と同時に発火する。時刻の一致だけでは
// 1 回きりにならないので、furim_seminar_weeks.survey_sent_at が NULL の行を条件付き UPDATE で
// 取れた実行だけが送る（kaisetsu-delivery と同じ枠取り）。
import { formatJstIso } from './customer-store.js';

export const SEMINAR_VOTE_PREFIX = 'seminar_vote:';
/** 「どれも都合が合わない」の slot_id */
export const NO_FIT_SLOT_ID = 'none';

/** 初回開催の week_id。この週だけ「はじめます」の文面とバナーを使い、翌週から通常版に戻る */
export const FIRST_WEEK_ID = '2026-09-27';

/** アンケート（土曜 9:00）の Flex に載せるバナー。R2 に置いた固定画像を毎週使い回す */
const SURVEY_BANNER_FIRST = 'https://line-harness-prod.furimuato.workers.dev/images/f0fac4c6-6354-48af-89ad-68fbacc5721c.png';
const SURVEY_BANNER_WEEKLY = 'https://line-harness-prod.furimuato.workers.dev/images/1dacfb8b-4a7d-4b02-b085-314c035dd806.png';
/** 開催日程の告知（日曜 17:00）と 5 分前の URL 案内に載せるバナー */
const ANNOUNCE_BANNER_FIRST = 'https://line-harness-prod.furimuato.workers.dev/images/6d4d2fac-8304-4a5d-8bdc-f73d71680743.png';
const ANNOUNCE_BANNER_WEEKLY = 'https://line-harness-prod.furimuato.workers.dev/images/7dfd2b8d-d70c-40d8-b555-d8b050d71c29.png';

const BANNER_ASPECT_RATIO = '1040:585';

export function isFirstWeek(weekId: string): boolean {
  return weekId === FIRST_WEEK_ID;
}

function bannerHero(url: string): FlexBubble {
  return { type: 'image', url, size: 'full', aspectRatio: BANNER_ASPECT_RATIO, aspectMode: 'cover' };
}

export type SeminarSlot = { slot_id: string; starts_at: string; is_chosen?: number };
export type SeminarWeek = { week_id: string; stream_url: string | null; survey_sent_at: string | null };

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** その時刻を含む週の「日曜日」の JST 日付 'YYYY-MM-DD'。日曜はその日自身 */
export function weekIdOf(nowMs: number): string {
  const jst = new Date(nowMs + 9 * 60 * 60_000);
  const sunday = new Date(jst.getTime() - jst.getUTCDay() * 24 * 60 * 60_000);
  return sunday.toISOString().slice(0, 10);
}

/** 土曜に送る日程アンケートが対象にする週（翌日の日曜）。土曜以外でも「明日を含む週」を返す */
export function surveyWeekIdOf(nowMs: number): string {
  return weekIdOf(nowMs + 24 * 60 * 60_000);
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
 * アンケートの Flex（1 枠 1 postback ボタン＋「どれも合わない」）。全員共通の 1 種（2026-09-30 くろさん: 会員と非会員を分けない）。
 * 文面は TB-822 をもとに、20 字ごとの手動改行を外した（くろさん: Flex の不自然な改行をやめる）。折り返しは LINE に任せる。
 * 送るのは前日の土曜なので「明日（日）17:00 締め切り」。翌日＝日曜の枠が候補にあるときだけ注記を足す。
 */
export function seminarSurveyFlex(weekId: string, slots: SeminarSlot[]): { altText: string; contents: FlexBubble } {
  const hasSameDay = slots.some((s) => s.starts_at.slice(0, 10) === weekId);
  const body: FlexBubble[] = [
    { type: 'text', text: 'FurimAuto 生配信の日程アンケート', weight: 'bold', size: 'lg', wrap: true },
    { type: 'text', text: 'FurimAuto を運営する法人代表の黒岩です。', size: 'sm', wrap: true, margin: 'md' },
    { type: 'text', text: 'いつもありがとうございます。次回の生配信でも、メルカリ物販を自動化して、作業時間を減らすやり方を実演する予定です。ご参加は無料です。', size: 'sm', wrap: true, margin: 'md' },
    { type: 'text', text: 'アンケートに答えてくださった方にだけ、開催日時をお知らせします。', size: 'sm', weight: 'bold', wrap: true, margin: 'md' },
    { type: 'text', text: 'ご覧になれそうな日時を、下のボタンからいくつでも押してください。票の多い 2 つの日時で開催します。締め切りは明日（日）の 17:00 です。', size: 'sm', wrap: true, margin: 'md' },
  ];
  if (hasSameDay) body.push({ type: 'text', text: '※明日（日）の開催になる場合があります', size: 'xs', wrap: true, margin: 'md', color: '#888888' });

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
    altText: `生配信の日程アンケート（${slots.map((s) => slotLabel(s.starts_at)).join('・')}）`,
    contents: {
      type: 'bubble',
      size: 'mega',
      hero: bannerHero(isFirstWeek(weekId) ? SURVEY_BANNER_FIRST : SURVEY_BANNER_WEEKLY),
      body: { type: 'box', layout: 'vertical', contents: body },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons },
    },
  };
}

export type VoteResult =
  | { status: 'counted' | 'duplicate'; slotId: string; label: string; announceDay: string }
  | { status: 'unknownSlot' | 'notSurveyWeek' };

/** 告知が届く日の言い方。票は土曜に来る前提の文面だが、日曜に押した人には「本日」と返す */
function announceDayOf(nowMs: number): string {
  return new Date(nowMs + 9 * 60 * 60_000).getUTCDay() === 0 ? '本日' : '明日（日）';
}

/**
 * 票を 1 行入れる。同じ (week, slot, friend) は UNIQUE で弾かれるので 2 回目は duplicate。
 * 日曜 17:00 の告知（announced_at）が済んだ週は締め切り（notSurveyWeek）。告知の後に入った票は
 * 告知が届かないまま 5 分前 URL だけ届くことになるため受けない（TB-821）。
 * 受付返信の文面はここでは作らず、呼び出し側（webhook）が label を使って返す。
 */
export async function recordSeminarVote(
  db: D1Database,
  input: { weekId: string; slotId: string; friendId: string; lineUserId?: string | null; nowMs?: number },
): Promise<VoteResult> {
  const nowMs = input.nowMs ?? Date.now();
  const week = await db
    .prepare('SELECT announced_at FROM furim_seminar_weeks WHERE week_id = ?')
    .bind(input.weekId)
    .first<{ announced_at: string | null }>();
  if (week?.announced_at) return { status: 'notSurveyWeek' };
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
  return { status: counted ? 'counted' : 'duplicate', slotId: input.slotId, label, announceDay: announceDayOf(nowMs) };
}

/** postback の data から week_id・slot_id を取る。seminar_vote: 以外なら null */
export function parseSeminarVoteData(data: string): { weekId: string; slotId: string } | null {
  if (!data.startsWith(SEMINAR_VOTE_PREFIX)) return null;
  const [weekId, slotId] = data.slice(SEMINAR_VOTE_PREFIX.length).split(':');
  if (!weekId || !slotId) return null;
  return { weekId, slotId };
}

/** 受付返信の本文（TB-822 の返信文。手動改行は外した） */
export function voteReplyText(result: VoteResult): string {
  if (result.status !== 'counted' && result.status !== 'duplicate') {
    return '申し訳ありません、このアンケートは締め切りました。次回の日程アンケートもお送りしますので、お待ちいただけると嬉しいです。';
  }
  if (result.slotId === NO_FIT_SLOT_ID) {
    return `ご回答ありがとうございます。${result.announceDay} 17:00 に開催日時をお知らせします。`;
  }
  return result.status === 'counted'
    ? `${result.label} で承りました。ほかにも見られる日時があれば、続けて押してください。${result.announceDay} 17:00 に開催日時をお知らせします。`
    : `${result.label} はすでに承っております。ありがとうございます。`;
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
/** 計測リンクの入口を作るのに使う環境変数。本番 cron の env には WORKER_URL が無く WORKER_PUBLIC_URL が入っている */
type LinkEnv = { WORKER_URL?: string; WORKER_PUBLIC_URL?: string };

/**
 * 告知・リマインドのボタンに載せる入口 URL。計測リンク /t/<code> を通してから配信 URL へ飛ばす。
 * base が絶対 URL にならないときは計測を捨てて配信 URL をそのまま返す。相対 URL の入った flex は
 * LINE が弾くため、1 通も届かないまま cron が再送を繰り返す（2026-09-27 の初回告知がこれで 0 件）
 *
 * friendId を渡すと &f= を足す。/t/ は f があれば LIFF を通らずに link_clicks.friend_id へ入れるので、
 * openExternalBrowser=1 で外部ブラウザに出ても誰が押したかが残る（TB-449）。個人 push のときだけ渡す
 */
export function seminarEntryUrl(base: string, code: string, streamUrl: string, friendId?: string | null): string {
  const trimmed = (base ?? '').replace(/\/$/, '');
  if (!/^https:\/\//i.test(trimmed)) return streamUrl;
  const f = friendId ? `&f=${encodeURIComponent(friendId)}` : '';
  return `${trimmed}/t/${code}?openExternalBrowser=1${f}`;
}

async function resolveSeminarLinkBase(db: D1Database, env: LinkEnv): Promise<string> {
  const { resolveTrackedLinkBaseUrl } = await import('../lib/link-base-url.js');
  return await resolveTrackedLinkBaseUrl(db, env.WORKER_PUBLIC_URL ?? env.WORKER_URL ?? '');
}
type LineClientLike = {
  pushMessage(to: string, messages: unknown[]): Promise<unknown>;
  multicast?(to: string[], messages: unknown[]): Promise<unknown>;
};

export type SurveySendResult =
  | { sent: false; reason: 'notSaturday' | 'notNineOclock' | 'alreadySent' | 'noSlots' | 'quota'; note?: string }
  | { sent: true; weekId: string; slots: number; broadcastIds: string[] };

/**
 * 土曜 9:00 のアンケート送信（翌日曜からの週が対象）。5 分 cron から呼ぶ。
 * 日曜 9:00 には送らない（旧い流れ。TB-821 で廃止）。
 * 送信そのものは既存の broadcasts キュー（segment_conditions）に乗せる。フォロー中の全員へ 1 本。
 */
export async function sendSeminarSurvey(
  db: D1Database,
  lineClient: LineClientLike | null,
  env: SendEnv,
  opts: { nowMs?: number; targetLineUserId?: string } = {},
): Promise<SurveySendResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const weekId = surveyWeekIdOf(nowMs);
  const isTestSend = !!opts.targetLineUserId;

  if (!isTestSend) {
    const jst = new Date(nowMs + 9 * 60 * 60_000);
    if (jst.getUTCDay() !== 6) return { sent: false, reason: 'notSaturday' };
    if (jstHourOf(nowMs) !== 9) return { sent: false, reason: 'notNineOclock' };
  }

  const slots = await listSeminarSlots(db, weekId);
  if (slots.length === 0) return { sent: false, reason: 'noSlots' };

  const flex = seminarSurveyFlex(weekId, slots);

  // テスト送信（あじゃぱー）は push で 1 通だけ。枠取りもしない
  if (isTestSend) {
    if (lineClient) await lineClient.pushMessage(opts.targetLineUserId!, [{ type: 'flex', altText: flex.altText, contents: flex.contents }]);
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
  const created = await createBroadcast(db, {
    title: `[SEMINAR] ${weekId} 日程アンケート`,
    messageType: 'flex',
    messageContent: JSON.stringify(flex.contents),
    targetType: 'all',
    trackLinks: false, // postback だけなので URL の自動短縮は不要
  });
  await db
    .prepare('UPDATE broadcasts SET status = ?, batch_offset = 0, alt_text = ?, segment_conditions = ? WHERE id = ?')
    .bind('sending', flex.altText, JSON.stringify({ operator: 'AND', rules: [{ type: 'is_following', value: true }] }), created.id)
    .run();
  const broadcastIds = [created.id];
  return { sent: true, weekId, slots: slots.length, broadcastIds };
}

// ここから下は日曜 17:00 以降ぶん（Capsec #332 → TB-821）: 集計 → 上位2枠の決定 → 回答者へ告知＋内容アンケート → 5分前 URL

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


/**
 * 聞きたい内容アンケートの選択肢。text はくろさんの 6 択そのまま（言い換えると集計の意味が変わる）。
 * label は postback の label（上限 20 字）で、画面には出ない
 */
export const SEMINAR_TOPICS = [
  { id: 't1', text: '1 メルカリ年商1千万越えアカウントのリアルタイム分析方法', label: '1 年商1千万の分析方法' },
  { id: 't2', text: '2 全自動化運用のリアルタイム講義', label: '2 全自動化運用の講義' },
  { id: 't3', text: '3 サービス１自動化サービスの各機能簡単解説', label: '3 自動化サービス解説' },
  { id: 't4', text: '4 サービス２コピー出品機能簡単解説', label: '4 コピー出品機能解説' },
  { id: 't5', text: '5 サービス３自動併売在庫管理機能簡単解説', label: '5 併売在庫管理解説' },
  { id: 't6', text: '6 その他 なんでもリクエスト', label: '6 その他リクエスト' },
] as const;
export const OTHER_TOPIC_ID = 't6';
export const SEMINAR_TOPIC_PREFIX = 'seminar_topic:';
/** 「6 その他」を押してから自由文を受け取る時間 */
const TOPIC_NOTE_WINDOW_MS = 60 * 60_000;

type FlexMessage = { type: 'flex'; altText: string; contents: FlexBubble };

/**
 * 日曜 17:00 に回答者へ送る 2 つの吹き出し（A 開催日時の告知／B 聞きたい内容アンケート）。
 * 1 回の push に入れるので LINE の通数は 1 人 1 通のまま。文面は TB-822 から手動改行を外したもの。
 * A はボタン無し（2026-09-30 くろさん「決定告知Flexにはボタンいらない」）。配信 URL は開始 5 分前の案内で送る。
 * B の選択肢は文言が長くボタンの label（20 字）に入らないため、枠（box）ごと postback にしている
 */
export function seminarAnnounceMessages(weekId: string, chosen: Array<{ starts_at: string }>): FlexMessage[] {
  const banner = bannerHero(isFirstWeek(weekId) ? ANNOUNCE_BANNER_FIRST : ANNOUNCE_BANNER_WEEKLY);
  const announce: FlexMessage = {
    type: 'flex',
    altText: `生配信の日時（${chosen.map((c) => slotLabel(c.starts_at)).join('・')}）`,
    contents: {
      type: 'bubble',
      size: 'mega',
      hero: banner,
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '生配信の日時が決まりました', weight: 'bold', size: 'lg', wrap: true },
          { type: 'text', text: 'アンケートにお答えいただき、ありがとうございました。', size: 'sm', wrap: true, margin: 'md' },
          ...chosen.map((c, i) => ({ type: 'text', text: `${i === 0 ? '①' : '②'} ${slotLabel(c.starts_at)}〜`, size: 'md', weight: 'bold', margin: 'md', wrap: true })),
          { type: 'text', text: '投票いただいた回は、開始 5 分前にこの LINE で配信の URL をお送りします。途中の参加・退出も自由です。', size: 'sm', wrap: true, margin: 'lg' },
        ],
      },
    },
  };
  const topics: FlexMessage = {
    type: 'flex',
    altText: '当日、聞きたい内容を教えてください',
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '当日、聞きたい内容を教えてください', weight: 'bold', size: 'lg', wrap: true },
          { type: 'text', text: 'いただいた声をもとに、当日お話しする内容を決めます。いくつでも押してください。', size: 'sm', wrap: true, margin: 'md' },
          ...SEMINAR_TOPICS.map((t) => ({
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            paddingAll: '12px',
            cornerRadius: '8px',
            borderWidth: '1px',
            borderColor: t.id === OTHER_TOPIC_ID ? '#AAAAAA' : '#06C755',
            action: { type: 'postback', label: t.label, data: `${SEMINAR_TOPIC_PREFIX}${weekId}:${t.id}`, displayText: t.text },
            contents: [{ type: 'text', text: t.text, size: 'sm', wrap: true, color: t.id === OTHER_TOPIC_ID ? '#555555' : '#06C755', weight: 'bold' }],
          })),
          { type: 'text', text: '各回の開始 1 時間前までに届いた声を、その回の内容に反映します。', size: 'xs', wrap: true, margin: 'lg', color: '#888888' },
        ],
      },
    },
  };
  return [announce, topics];
}

/** 開始 5 分前に、その枠に投票した人へ送る 1 通（文面は TB-822） */
export function seminarUrlFlex(weekId: string, startsAt: string, entryUrl: string): FlexMessage {
  return {
    type: 'flex',
    altText: `まもなく ${slotLabel(startsAt)} から生配信を始めます`,
    contents: {
      type: 'bubble',
      hero: bannerHero(isFirstWeek(weekId) ? ANNOUNCE_BANNER_FIRST : ANNOUNCE_BANNER_WEEKLY),
      body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: `まもなく ${slotLabel(startsAt)} から生配信を始めます。下のボタンからそのまま入れます。お待ちしています。`, wrap: true, size: 'md' }] },
      footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'primary', action: { type: 'uri', label: '生配信を見る', uri: entryUrl } }] },
    },
  };
}

export type AnnounceResult =
  | { sent: false; reason: 'notSunday' | 'notFiveOclock' | 'alreadyAnnounced' | 'noVotes' | 'noStreamUrl'; weekId: string; note?: string }
  | { sent: true; weekId: string; chosen: VoteCount[]; recipients: number; delivered: number };

/**
 * 日曜 17:00 の集計と告知。5 分 cron から呼ぶ。
 * 送り先は日程アンケートに答えた人（「どれも合わない」を含む）だけ。全員への一斉配信はしない（TB-821）。
 * 1 人ずつ push し、messages_log に残す。
 */
export async function announceSeminar(
  db: D1Database,
  lineClient: LineClientLike | null,
  env: SendEnv & LinkEnv,
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

  const answerers = await db
    .prepare(
      `SELECT DISTINCT f.id AS friend_id, f.line_user_id AS line_user_id
         FROM furim_seminar_votes v JOIN friends f ON f.id = v.friend_id
        WHERE v.week_id = ? AND f.is_following = 1`,
    )
    .bind(weekId)
    .all<{ friend_id: string; line_user_id: string }>();
  const recipients = (answerers.results ?? []).filter((r) => r.line_user_id);
  const messages = seminarAnnounceMessages(weekId, chosen);

  let delivered = 0;
  let lastErr: unknown = null;
  if (lineClient) {
    for (const r of recipients) {
      try {
        await lineClient.pushMessage(r.line_user_id, messages);
        delivered++;
        for (const m of messages) await logSeminarPush(db, r.friend_id, m);
      } catch (err) {
        lastErr = err;
        console.error('[furim/seminar] announce push failed', r.friend_id, err);
      }
    }
  }
  // 全員に失敗したときだけ枠取りを戻して投げ直す（次の tick＝同じ 17 時台で再送できるように）
  if (delivered === 0 && lastErr) {
    await db.prepare('UPDATE furim_seminar_weeks SET announced_at = NULL WHERE week_id = ?').bind(weekId).run();
    throw lastErr;
  }
  return { sent: true, weekId, chosen, recipients: recipients.length, delivered };
}

/** cron が 1 人ずつ push した分を messages_log に残す（配信数を後から数えられるように） */
async function logSeminarPush(db: D1Database, friendId: string, message: { type: string; contents: unknown }): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, created_at)
         VALUES (?, ?, 'outgoing', 'flex', ?, NULL, NULL, 'push', 'seminar', ?)`,
      )
      .bind(crypto.randomUUID(), friendId, JSON.stringify(message.contents), formatJstIso(Date.now()))
      .run();
  } catch (err) {
    console.error('[furim/seminar] messages_log insert failed', friendId, err);
  }
}

/** 週ごとの計測リンク（seminar_<week_id>）。無ければ作る */
async function ensureWeekTrackedLink(db: D1Database, weekId: string, streamUrl: string): Promise<{ id: string; short_code: string | null }> {
  const existing = await db
    .prepare('SELECT id, short_code FROM tracked_links WHERE name = ? ORDER BY created_at DESC LIMIT 1')
    .bind(`seminar_${weekId}`)
    .first<{ id: string; short_code: string | null }>();
  if (existing) return existing;
  const { createTrackedLink } = await import('@line-crm/db');
  const link = await createTrackedLink(db, { name: `seminar_${weekId}`, originalUrl: streamUrl });
  return { id: link.id, short_code: link.short_code ?? null };
}

export type ReminderResult = { reminded: Array<{ slotId: string; recipients: number }> };

/** 開始の何分前から URL を送るか。cron は 5 分刻みなので :55 の tick が拾う */
const URL_LEAD_MS = 5 * 60_000;
/** 開始後も 1 tick だけ再送を許す（:55 の全員失敗で枠取りを戻したときに :00 で送り直せるように） */
const URL_GRACE_MS = 5 * 60_000;

/**
 * 開始 5 分前の配信 URL（その枠に投票した人だけ）。5 分 cron から呼ぶ。
 * reminded_at の条件付き UPDATE で枠を取った実行だけが送る。
 */
export async function remindSeminarSlots(
  db: D1Database,
  lineClient: LineClientLike | null,
  env: SendEnv & LinkEnv,
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
    if (!(nowMs >= startsMs - URL_LEAD_MS && nowMs < startsMs + URL_GRACE_MS)) continue;
    const claim = await db
      .prepare('UPDATE furim_seminar_slots SET reminded_at = ? WHERE week_id = ? AND slot_id = ? AND reminded_at IS NULL')
      .bind(formatJstIso(nowMs), weekId, slot.slot_id)
      .run();
    if ((claim.meta?.changes ?? 0) === 0) continue;

    const voters = await db
      .prepare(
        `SELECT DISTINCT f.id AS friend_id, f.line_user_id AS line_user_id
           FROM furim_seminar_votes v JOIN friends f ON f.id = v.friend_id
          WHERE v.week_id = ? AND v.slot_id = ? AND f.is_following = 1`,
      )
      .bind(weekId, slot.slot_id)
      .all<{ friend_id: string; line_user_id: string }>();
    const recipients = (voters.results ?? []).filter((v) => v.line_user_id);
    reminded.push({ slotId: slot.slot_id, recipients: recipients.length });
    if (recipients.length === 0 || !lineClient) continue;

    const linkBase = await resolveSeminarLinkBase(db, env);
    const link = await ensureWeekTrackedLink(db, weekId, week.stream_url);
    const streamUrl = week.stream_url;
    // 入口 URL に ?f=<friend_id> を入れるため、multicast をやめて 1 人ずつ push する（TB-449）。
    // 1 人の失敗（ブロック直後など）で残りを止めない。全員に失敗したときだけ枠取りを戻して投げ直す
    let sent = 0;
    let lastErr: unknown = null;
    for (const r of recipients) {
      const message = seminarUrlFlex(weekId, slot.starts_at, seminarEntryUrl(linkBase, link.short_code ?? link.id, streamUrl, r.friend_id));
      try {
        await lineClient.pushMessage(r.line_user_id, [message]);
        sent++;
        await logSeminarPush(db, r.friend_id, message);
      } catch (err) {
        lastErr = err;
        console.error('[furim/seminar] url push failed', r.friend_id, err);
      }
    }
    if (sent === 0 && lastErr) {
      await db.prepare('UPDATE furim_seminar_slots SET reminded_at = NULL WHERE week_id = ? AND slot_id = ?').bind(weekId, slot.slot_id).run();
      throw lastErr;
    }
  }
  return { reminded };
}

// ここから下は聞きたい内容アンケート（TB-821）

export function parseSeminarTopicData(data: string): { weekId: string; topicId: string } | null {
  if (!data.startsWith(SEMINAR_TOPIC_PREFIX)) return null;
  const [weekId, topicId] = data.slice(SEMINAR_TOPIC_PREFIX.length).split(':');
  if (!weekId || !topicId) return null;
  return { weekId, topicId };
}

export type TopicVoteResult = { status: 'counted' | 'duplicate' | 'unknownTopic' | 'closed'; topicId: string };

/**
 * 内容アンケートの票を 1 行入れる。締め切りは開催が決まった枠のうち最後の枠の開始 1 時間前
 * （その時刻の集計が最後の報告になるため）。開催枠が無い週（テスト・古い週）も締め切り扱い
 */
export async function recordSeminarTopicVote(
  db: D1Database,
  input: { weekId: string; topicId: string; friendId: string; lineUserId?: string | null; nowMs?: number },
): Promise<TopicVoteResult> {
  if (!SEMINAR_TOPICS.some((t) => t.id === input.topicId)) return { status: 'unknownTopic', topicId: input.topicId };
  const nowMs = input.nowMs ?? Date.now();
  const last = await db
    .prepare('SELECT MAX(starts_at) AS last_starts_at FROM furim_seminar_slots WHERE week_id = ? AND is_chosen = 1')
    .bind(input.weekId)
    .first<{ last_starts_at: string | null }>();
  const lastMs = last?.last_starts_at ? Date.parse(last.last_starts_at) : NaN;
  if (!Number.isFinite(lastMs) || nowMs >= lastMs - 60 * 60_000) return { status: 'closed', topicId: input.topicId };
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO furim_seminar_topic_votes (id, week_id, topic_id, friend_id, line_user_id, voted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), input.weekId, input.topicId, input.friendId, input.lineUserId ?? null, formatJstIso(nowMs))
    .run();
  return { status: (res.meta?.changes ?? 0) > 0 ? 'counted' : 'duplicate', topicId: input.topicId };
}

/** 押したあとの返信（TB-822 の返信文） */
export function topicReplyText(result: TopicVoteResult): string {
  if (result.status === 'unknownTopic' || result.status === 'closed') return '受付を締め切りました。次回のアンケートでお待ちしています。';
  if (result.status === 'duplicate') return 'すでに承っております。ありがとうございます。';
  if (result.topicId === OTHER_TOPIC_ID) return '聞きたいことを、このトークにそのまま送ってください。';
  return '承りました。ほかにも聞きたい内容があれば、続けて押してください。';
}

export const TOPIC_NOTE_REPLY = 'リクエストを承りました。ありがとうございます。当日の内容の参考にさせていただきます。';

/**
 * 「6 その他」を押してから 1 時間以内の最初の自由文を note に控える。控えたら true。
 * 呼び出し側（webhook）は定型コマンド・ボタン文を先に捌き、ここには自由文だけを渡す
 */
export async function recordSeminarTopicNote(db: D1Database, friendId: string, text: string, nowMs = Date.now()): Promise<boolean> {
  const body = text.trim();
  if (!body) return false;
  const row = await db
    .prepare(
      `SELECT id, voted_at FROM furim_seminar_topic_votes
        WHERE friend_id = ? AND topic_id = ? AND note IS NULL
        ORDER BY voted_at DESC LIMIT 1`,
    )
    .bind(friendId, OTHER_TOPIC_ID)
    .first<{ id: string; voted_at: string }>();
  if (!row) return false;
  const votedMs = Date.parse(row.voted_at);
  if (!Number.isFinite(votedMs) || nowMs - votedMs > TOPIC_NOTE_WINDOW_MS) return false;
  const res = await db
    .prepare('UPDATE furim_seminar_topic_votes SET note = ? WHERE id = ? AND note IS NULL')
    .bind(body.slice(0, 1000), row.id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** くろさん宛の集計の本文（票数＋その他の本文） */
export function topicReportText(
  weekId: string,
  startsAt: string,
  counts: Array<{ topic_id: string; n: number }>,
  notes: string[],
): string {
  const byId = new Map(counts.map((c) => [c.topic_id, Number(c.n)]));
  const lines = SEMINAR_TOPICS.map((t) => `${t.text} … ${byId.get(t.id) ?? 0} 票`);
  const noteLines = notes.length > 0 ? notes.map((n) => `・${n}`) : ['（なし）'];
  const text = [`生配信 ${slotLabel(startsAt)} の 1 時間前です（${weekId} 週）`, '聞きたい内容アンケートの結果', ...lines, '', '「その他」の内容', ...noteLines].join('\n');
  return text.length > 4900 ? `${text.slice(0, 4900)}\n…（以下略）` : text;
}

export type TopicReportResult = { reported: Array<{ slotId: string; text: string }> };

/** 告知から集計までに最低これだけ空ける（日曜 18:00 の枠は 1 時間前＝告知と同時刻になるため） */
const REPORT_AFTER_ANNOUNCE_MS = 30 * 60_000;

/**
 * 各枠の開始 1 時間前に、内容アンケートの集計をくろさんへ送る本文を作る。5 分 cron から呼ぶ。
 * 送信は呼び出し側（notifyStaff）。topic_reported_at の条件付き UPDATE で枠を取った実行だけが返す。
 * 告知から 30 分経っていなければ待つ（日曜 18:00 の枠は 17:30 に送る）
 */
export async function collectSeminarTopicReports(db: D1Database, opts: { nowMs?: number } = {}): Promise<TopicReportResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const weekId = weekIdOf(nowMs);
  const reported: Array<{ slotId: string; text: string }> = [];
  const week = await db
    .prepare('SELECT announced_at FROM furim_seminar_weeks WHERE week_id = ?')
    .bind(weekId)
    .first<{ announced_at: string | null }>();
  const announcedMs = week?.announced_at ? Date.parse(week.announced_at) : NaN;
  if (!Number.isFinite(announcedMs) || nowMs - announcedMs < REPORT_AFTER_ANNOUNCE_MS) return { reported };

  const due = await db
    .prepare('SELECT slot_id, starts_at FROM furim_seminar_slots WHERE week_id = ? AND is_chosen = 1 AND topic_reported_at IS NULL')
    .bind(weekId)
    .all<SeminarSlot>();
  for (const slot of due.results ?? []) {
    const startsMs = Date.parse(slot.starts_at);
    if (Number.isNaN(startsMs)) continue;
    if (!(nowMs >= startsMs - 60 * 60_000 && nowMs < startsMs)) continue;
    const claim = await db
      .prepare('UPDATE furim_seminar_slots SET topic_reported_at = ? WHERE week_id = ? AND slot_id = ? AND topic_reported_at IS NULL')
      .bind(formatJstIso(nowMs), weekId, slot.slot_id)
      .run();
    if ((claim.meta?.changes ?? 0) === 0) continue;
    const counts = await db
      .prepare('SELECT topic_id, COUNT(*) AS n FROM furim_seminar_topic_votes WHERE week_id = ? GROUP BY topic_id')
      .bind(weekId)
      .all<{ topic_id: string; n: number }>();
    const notes = await db
      .prepare('SELECT note FROM furim_seminar_topic_votes WHERE week_id = ? AND topic_id = ? AND note IS NOT NULL ORDER BY voted_at')
      .bind(weekId, OTHER_TOPIC_ID)
      .all<{ note: string }>();
    reported.push({ slotId: slot.slot_id, text: topicReportText(weekId, slot.starts_at, counts.results ?? [], (notes.results ?? []).map((n) => n.note)) });
  }
  return { reported };
}
