import type { UnansweredRow } from '../services/unanswered-inbox.js';

/**
 * 管理画面トップの「未返信が N 時間」（Capsec #295・2026-09-17）。
 *
 * 判定は既存の unanswered-inbox（サイドバーの未読バッジ・チャット画面の「未対応のみ」と同じ定義）を使う。
 * ここで足すのは 2 つだけ: しきい値（3 時間で黄・12 時間で赤）と、会話の締めを赤にしない判定。
 *
 * きっかけは、もちをさんの問い合わせが 18 時間放置されたこと（2026-09-16）。
 * 夜間は除かない。除くと夜に来た問い合わせが朝まで静かになり、同じ放置を招く。
 */

export const UNANSWERED_YELLOW_HOURS = 3;
export const UNANSWERED_RED_HOURS = 12;
const SHORT_CHARS = 40;
const TOP_N = 5;

/** 締めの語。文字数と依頼の印の条件と組み合わせて使う（単独では判定しない） */
const CLOSING_WORDS = [
  '了解', '承知', 'ありがとう', 'かしこまりました', '助かりました', '検討します',
  'わかりました', '分かりました', '大丈夫です', 'よろしくお願いします',
  '確認しました', '確認できました',
];

/**
 * 依頼・質問の印。1 つでもあれば締めにしない。
 * 「確認」は単独では印にしない（「確認しました」は締め）。依頼の形だけを拾う。
 */
const REQUEST_MARKERS: RegExp[] = [
  /[？?]/, /ですか/, /でしょうか/, /ください/, /教えて/, /お願いできますか/,
  /ご確認/, /確認してください/, /確認お願い/, /確認をお願い/,
];

const MEDIA_TYPES = ['image', 'video', 'file', 'audio'];

export type ClosingInput = {
  type: string;
  content: string;
  /** これより前に人の返信（source=manual）があるか */
  hadHumanReply: boolean;
  /** 人の返信のあとに画像・動画・ファイルが届いているか */
  mediaSinceReply: boolean;
};

/**
 * 会話の締めか。締めなら赤にせず、除外件数に数える（黙って消さない）。
 * 画像・ファイル付きは報告の可能性があるので締めにしない。
 * スタンプ単体は、人の返信のあとなら締め（LINE の締めはスタンプで来ることが多い）。
 */
export function isClosingMessage(input: ClosingInput): boolean {
  if (input.mediaSinceReply) return false;
  if (input.type === 'sticker') return input.hadHumanReply;
  if (input.type !== 'text') return false;
  const text = String(input.content ?? '').trim();
  if (text.length === 0 || text.length > SHORT_CHARS) return false;
  if (!CLOSING_WORDS.some((w) => text.includes(w))) return false;
  if (REQUEST_MARKERS.some((re) => re.test(text))) return false;
  return true;
}

export type UnansweredAlert = {
  count: number;
  oldestHours: number;
  severity: 'red' | 'yellow';
  /** しきい値（3 時間）を初めて超えた時刻。#289 の「今日のできごと」判定に使う */
  since: string;
  excludedClosing: number;
  top: Array<{ friendId: string; name: string; hours: number; preview: string }>;
};

const toMs = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const s = String(v).replace(' ', 'T');
  const ms = /[+-]\d{2}:\d{2}$|Z$/.test(s) ? Date.parse(s) : Date.parse(`${s.slice(0, 19)}+09:00`);
  return Number.isNaN(ms) ? null : ms;
};

/** JST の ISO 文字列（+09:00） */
const toJstIso = (ms: number): string => {
  const d = new Date(ms + 9 * 3600_000);
  return `${d.toISOString().slice(0, 19)}.000+09:00`;
};

export function buildUnansweredAlert(
  rows: UnansweredRow[],
  mediaSinceReplyFriendIds: Set<string>,
  nowMs: number,
): UnansweredAlert | null {
  const targets: Array<{ row: UnansweredRow; hours: number; atMs: number }> = [];
  let excludedClosing = 0;

  for (const row of rows) {
    const atMs = toMs(row.lastIncomingAt);
    if (atMs === null) continue;
    const hours = (nowMs - atMs) / 3600_000;
    if (hours < UNANSWERED_YELLOW_HOURS) continue;
    const closing = isClosingMessage({
      type: row.lastIncomingType,
      content: row.lastIncomingContent,
      hadHumanReply: Boolean(row.lastManualAt),
      mediaSinceReply: mediaSinceReplyFriendIds.has(row.friendId),
    });
    if (closing) {
      excludedClosing++;
      continue;
    }
    targets.push({ row, hours, atMs });
  }

  if (targets.length === 0) return null;
  targets.sort((a, b) => a.atMs - b.atMs);
  const oldest = targets[0];
  const oldestHours = Math.floor(oldest.hours);

  return {
    count: targets.length,
    oldestHours,
    severity: oldest.hours >= UNANSWERED_RED_HOURS ? 'red' : 'yellow',
    since: toJstIso(oldest.atMs + UNANSWERED_YELLOW_HOURS * 3600_000),
    excludedClosing,
    top: targets.slice(0, TOP_N).map((t) => ({
      friendId: t.row.friendId,
      name: t.row.displayName ?? '(名前なし)',
      hours: Math.floor(t.hours),
      preview: t.row.lastIncomingType === 'text' ? String(t.row.lastIncomingContent ?? '').slice(0, 30) : `（${t.row.lastIncomingType}）`,
    })),
  };
}

/**
 * 人の返信のあとに画像・動画・ファイルが届いている友だち。
 * D1 の bind 変数上限（100）に当たらないよう 90 件ずつ引く（unanswered-inbox の 2026-05-08 事故と同じ理由）。
 */
export async function findMediaSinceReply(db: D1Database, rows: UnansweredRow[]): Promise<Set<string>> {
  const out = new Set<string>();
  const lastManual = new Map(rows.map((r) => [r.friendId, toMs(r.lastManualAt)]));
  const ids = rows.map((r) => r.friendId);
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const res = await db
      .prepare(
        `SELECT friend_id, MAX(created_at) AS last_media FROM messages_log
         WHERE direction = 'incoming' AND message_type IN (${MEDIA_TYPES.map(() => '?').join(',')})
           AND friend_id IN (${part.map(() => '?').join(',')})
         GROUP BY friend_id`,
      )
      .bind(...MEDIA_TYPES, ...part)
      .all<{ friend_id: string; last_media: string }>();
    for (const r of res.results ?? []) {
      const mediaMs = toMs(r.last_media);
      const manualMs = lastManual.get(r.friend_id) ?? null;
      if (mediaMs !== null && (manualMs === null || mediaMs > manualMs)) out.add(r.friend_id);
    }
  }
  return out;
}
