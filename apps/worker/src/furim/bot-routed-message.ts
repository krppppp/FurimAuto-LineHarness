import { jstNow } from '@line-crm/db';

// webhook.ts が bot のハンドラーに回して返す受信テキストの判定（Capsec #295・2026-09-17）。
//
// 未対応の判定（services/unanswered-inbox.ts）は auto_replies テーブルの証拠しか見ないため、
// リッチメニュー・ボタンの押下が「人の返事待ち」として積み上がっていた（164 件中 141 件）。
// webhook の振り分けと同じ条件をここに置き、両方から使う。
//
// 人が見るべきものは除外しない:
//   - AI チャットモードの自動返答（解約・更新停止の相談にも返しているため）
//   - 【ボタン】追加サポート（bot が「担当者からサポートします」と返すもの）

export const RICHMENU_MESSAGE_PREFIX = '【リッチメニュー】';

/** webhook でチャットを未読にしない、ボタンタップ等の完全一致キーワード */
export const AUTO_KEYWORDS: readonly string[] = [
  '料金', '機能', 'API', 'フォーム', 'ヘルプ', 'UUID', 'UUID連携について教えて', 'UUID連携を確認',
  '配信時間', '導入支援を希望します', 'アカウント連携を見る', '体験を完了する', 'BAN対策を見る', '連携確認',
];

/** 配信時間の設定コマンド（「配信時間は9時」「9時に届けて」など） */
export const TIME_COMMAND_PATTERN = /(?:配信時間|配信|届けて|通知)[はを]?\s*(\d{1,2})\s*時/;

const HUMAN_FOLLOWUP_BUTTONS = ['【ボタン】追加サポート'];

/**
 * リッチメニューが送る「【リッチメニュー】<名前>」の名前。
 * rich-menu.ts の handleRichMenuSwitch（tab）と actions.ts の handleFurimAction（case）が受け付けるもの。
 * 足し忘れは bot-routed-message.test.ts が両ファイルとの突き合わせで検知する
 */
export const RICHMENU_COMMANDS: readonly string[] = [
  'ホームタブ', 'ガイドタブ', 'Q&Aタブ', 'AIチャットボットを終了する',
  'キーコード発行', 'チケット注文', '月額会員ページ', '限定特典GET', '利用方法説明書', 'アンバサダー制度',
  'Meet予約', '簡単解説1分動画', 'Youtube動画講座', 'クーポンGET', 'ホームページ', 'メルカリ物販Lab',
  'バグ・エラー報告', '開発者について', 'プラン診断', 'プラン確認', 'アップデート情報',
];

const KEYCODE_RESET = 'キーコードリセット';

/** 「キーコードリセット」を含む文をリセットの依頼とみなす長さの上限（統括決定 2026-09-17） */
export const KEYCODE_RESET_MAX_CHARS = 30;
const BUG_REPORT_PREFIX = '【バグ・エラー報告フォーマット】';

/**
 * 「キーコードリセット」を含む文を、リセットの依頼として扱ってよいか（Capsec #298）。
 * 以前は含むだけでリセットしていたため、拡張の認証エラー文の貼り付け（8/4・198 字）や
 * バグ報告のひな形（9/13）でも、本人の意図と関係なく端末の紐付けが外れていた。
 * - 30 字以下に限る
 * - 【バグ・エラー報告フォーマット】で始まる文は長さに関係なく除く
 * 外れた文はリセットせず、bot にも回さないので未返信に残り、人が判断する
 */
export function isKeycodeResetRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.includes(KEYCODE_RESET)) return false;
  if (trimmed.startsWith(BUG_REPORT_PREFIX)) return false;
  return trimmed.length <= KEYCODE_RESET_MAX_CHARS;
}
const KEYWORD_MESSAGE_PREFIX = '【キーワード】';

/**
 * 手入力の表記ゆれを、bot が受け付ける形にそろえる（Capsec #298・2026-09-17）。
 * 本番で「キーコード発行」（接頭辞なし・改行付き）や「キーコード　リセット」（全角スペース）に返信が出ていなかった。
 *
 * - 空白（半角・全角・改行）とかぎ括弧を除いた結果がメニュー名と一致すれば「【リッチメニュー】<名前>」にする
 * - 空白とかぎ括弧・【キーワード】を除いた結果が「キーコードリセット」と完全一致するときだけ「キーコードリセット」にする。
 *   「キーコード リセットしたのに入れません」のような質問を、空白を詰めてリセットに回すと、本人の意図と関係なく
 *   端末の紐付けが外れる（統括指摘 2026-09-17）。自由文はそのまま AI チャットか人の対応に残す
 * - それ以外は受け取ったまま返す（自由文には触らない）
 */
export function normalizeBotCommand(text: string): string {
  const compact = text.replace(/[\s　]/g, '');
  const unquoted = compact.replace(/^[「『"“]+/, '').replace(/[」』"”]+$/, '');
  let name = unquoted;
  for (const prefix of [RICHMENU_MESSAGE_PREFIX, KEYWORD_MESSAGE_PREFIX]) {
    if (name.startsWith(prefix)) name = name.slice(prefix.length);
  }
  if (RICHMENU_COMMANDS.includes(name)) return `${RICHMENU_MESSAGE_PREFIX}${name}`;
  if (name === KEYCODE_RESET && !text.includes(KEYCODE_RESET)) return KEYCODE_RESET;
  return text;
}

export function isBotRoutedText(raw: string): boolean {
  const text = normalizeBotCommand(raw);
  if (HUMAN_FOLLOWUP_BUTTONS.some((b) => text.includes(b))) return false;
  const trimmed = text.trim();
  if (text.startsWith('【プラン変更】') || text.startsWith('【プラン申し込み】')) return true;
  if (text.includes('【ボタン】')) return true;
  if (text.startsWith(RICHMENU_MESSAGE_PREFIX)) return true;
  if (text.includes('【キーワード】') && !text.includes(KEYCODE_RESET)) return true;
  if (isKeycodeResetRequest(text)) return true;
  if (text.includes('furimanです') || text.includes('Furimanです')) return true;
  if (trimmed === '解説見た' || trimmed === '解説みた') return true;
  if (AUTO_KEYWORDS.includes(text)) return true;
  if (TIME_COMMAND_PATTERN.test(text)) return true;
  return false;
}

export function isBotRoutedIncoming(messageType: string, content: string | null | undefined): boolean {
  return messageType === 'text' && isBotRoutedText(String(content ?? ''));
}

/**
 * bot が返信しない押下（リッチメニューのタブ切り替えだけ）と、返信の有無が決まっていない旧キーワード。
 * これらは送信記録が無くても「bot が処理した」とみなす（Capsec #300）
 */
const NO_REPLY_RICHMENU_TABS = ['ホームタブ', 'ガイドタブ'];

function botReplyExpected(raw: string): boolean {
  const text = normalizeBotCommand(raw);
  if (text.startsWith(RICHMENU_MESSAGE_PREFIX) && NO_REPLY_RICHMENU_TABS.includes(text.slice(RICHMENU_MESSAGE_PREFIX.length))) return false;
  if (AUTO_KEYWORDS.includes(text) || TIME_COMMAND_PATTERN.test(text)) return false;
  return true;
}

/** 押下から bot の送信記録までの許容時間。当時の無返信は 15 秒の打ち切りで起きていた（#300） */
export const BOT_REPLY_EVIDENCE_WINDOW_MS = 60_000;

/**
 * 候補の友だちの「最後の手動返信より後」の bot 送信（furim ハンドラーは source を付けずに記録する）。
 * unanswered-inbox の RECENT_* と同じく bind 変数を使わない
 */
export const BOT_OUTGOINGS_SQL = `
  WITH last_manual AS (
    SELECT friend_id, MAX(created_at) AS lm
    FROM messages_log
    WHERE direction='outgoing' AND source='manual'
    GROUP BY friend_id
  )
  SELECT ml.friend_id, ml.created_at, ml.content
  FROM messages_log ml
  LEFT JOIN last_manual lm ON lm.friend_id = ml.friend_id
  WHERE ml.direction='outgoing'
    AND ml.source IS NULL
    AND (lm.lm IS NULL OR ml.created_at > lm.lm)
  ORDER BY ml.friend_id, ml.created_at ASC
`;

export type BotOutgoing = { created_at: string; content: string | null };

const toMs = (v: string): number => {
  const s = String(v).replace(' ', 'T');
  return /[+-]\d{2}:\d{2}$|Z$/.test(s) ? Date.parse(s) : Date.parse(`${s.slice(0, 19)}+09:00`);
};

/** 「エラーが発生しました」等の失敗の案内は、bot が処理した証拠にしない */
const isBotErrorNotice = (content: string | null): boolean => /エラーが発生しました/.test(String(content ?? ''));

/**
 * 人の返事待ちから外してよい押下か（Capsec #295 / #300）。
 * bot に回る押下でも、返信するはずの操作は、押下から 60 秒以内に bot の送信記録（失敗の案内を除く）があるときだけ外す。
 * bot が落ちて何も返さなかった押下は未返信に残り、人が気づける（#300 の 8/17〜9/13 の無返信 20 回の型）
 */
export function isBotHandledIncoming(
  messageType: string,
  content: string | null | undefined,
  createdAt: string,
  botOutgoings: BotOutgoing[],
): boolean {
  if (!isBotRoutedIncoming(messageType, content)) return false;
  if (!botReplyExpected(String(content ?? ''))) return true;
  const inMs = toMs(createdAt);
  if (Number.isNaN(inMs)) return false;
  return botOutgoings.some((o) => {
    const d = toMs(o.created_at) - inMs;
    return d >= 0 && d <= BOT_REPLY_EVIDENCE_WINDOW_MS && !isBotErrorNotice(o.content);
  });
}

/**
 * bot のハンドラーが落ちた・返信も push も失敗したことを furim_ext_errors に 1 行残す（method=botHandler・Capsec #300）。
 * トップの「拡張のエラー（直近 24 時間）」に出る。記録の失敗で本処理を止めない
 */
export async function recordBotHandlerError(
  db: D1Database | undefined,
  lineUserId: string,
  label: string,
  stage: 'handler' | 'fallback_push',
  err: unknown,
): Promise<void> {
  if (!db) return;
  try {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .prepare(
        `INSERT INTO furim_ext_errors (id, line_user_id, key_code, method, error, mercari_url, discrimination_code, client, created_at)
         VALUES (?, ?, NULL, 'botHandler', ?, NULL, NULL, 'webhook', ?)`,
      )
      .bind(crypto.randomUUID(), lineUserId, `${label} / ${stage} / ${message}`.slice(0, 500), jstNow())
      .run();
  } catch (e) {
    console.error('[bot-handler] error record failed:', e);
  }
}
