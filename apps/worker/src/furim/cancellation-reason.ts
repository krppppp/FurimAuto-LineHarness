import { jstNow } from '@line-crm/db';

// 解約理由の 5 択（TB-740）。コードは英字で固定し、表示文言だけをここで持つ。
// 文言を変えても furim_cancellations.reason_code の集計が壊れないようにするため、
// D1 には必ずコードを入れる（日本語のラベルを列に入れない）。
export const CANCELLATION_REASONS = {
  not_working: '動かない',
  too_hard: '使い方が分からない',
  no_items: '売るものがない・稼げなかった',
  price: '値段',
  quit_side_job: '副業をやめた',
} as const;

export type CancellationReasonCode = keyof typeof CANCELLATION_REASONS;

// アンケートのボタンが送る文言。handleButtonAction に入るよう【ボタン】を付ける
export const CANCELLATION_REASON_PREFIX = '【ボタン】解約理由:';

// 5 択を押してから自由記述を拾う期限（この時間を過ぎたテキストは別の用件とみなす）
const FREE_TEXT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isCancellationReasonCode(value: string): value is CancellationReasonCode {
  return Object.prototype.hasOwnProperty.call(CANCELLATION_REASONS, value);
}

type CancellationRow = {
  id: string;
  reason_text: string | null;
  reason_answered_at: string | null;
};

async function latestCancellation(db: D1Database, lineUserId: string): Promise<CancellationRow | null> {
  return await db
    .prepare(
      `SELECT id, reason_text, reason_answered_at FROM furim_cancellations
       WHERE line_user_id = ? ORDER BY canceled_at DESC LIMIT 1`,
    )
    .bind(lineUserId)
    .first<CancellationRow>();
}

/**
 * 5 択の回答を、その人の最新の解約行に書く。押し直しは最後の答えを正とする（上書き）。
 * 解約行が無い人には何もしない。
 */
export async function recordCancellationReason(
  db: D1Database,
  lineUserId: string,
  { code }: { code: CancellationReasonCode },
): Promise<boolean> {
  const row = await latestCancellation(db, lineUserId);
  if (!row) return false;
  await db
    .prepare('UPDATE furim_cancellations SET reason_code = ?, reason_answered_at = ? WHERE id = ?')
    .bind(code, jstNow(), row.id)
    .run();
  return true;
}

/**
 * 5 択を押した直後の自由記述を、その人の最新の解約行に書く。
 * 「reason_answered_at が 24 時間以内 かつ reason_text が未記入」のときだけ入れる（最初の 1 通のみ）。
 * 状態テーブルを足さずに済ませるため、判定は最新行の 2 列だけを見る。
 */
export async function recordCancellationReasonText(
  db: D1Database,
  lineUserId: string,
  text: string,
): Promise<boolean> {
  const body = text.trim();
  if (!body) return false;
  const row = await latestCancellation(db, lineUserId);
  if (!row || row.reason_text !== null || !row.reason_answered_at) return false;
  const answeredAt = new Date(row.reason_answered_at).getTime();
  if (!Number.isFinite(answeredAt)) return false;
  if (new Date(jstNow()).getTime() - answeredAt > FREE_TEXT_WINDOW_MS) return false;
  await db
    .prepare('UPDATE furim_cancellations SET reason_text = ? WHERE id = ?')
    .bind(body, row.id)
    .run();
  return true;
}

// 1 通目の altText（トーク一覧・通知に出る 1 行）
export const CANCELLATION_SURVEY_ALT_TEXT = '解約のお手続きは完了しました（よろしければ理由を1つ教えてください）';

// 2 通目（5 択を押した人にだけ返す）。押していない人には何も送らない＝催促しない
export const CANCELLATION_REASON_REPLY_TEXT =
  'ご回答ありがとうございます。\n\n差し支えなければ、もう少し詳しく一言お聞かせください。\n（不要でしたら、何も送らずに閉じていただいて大丈夫です）';

// 自由記述を受け取ったときの締め。ここで終わりにして AI チャットへ流さない
export const CANCELLATION_FREE_TEXT_REPLY = 'ありがとうございます。いただいたご意見は今後の改善に活用させていただきます。';

/**
 * 解約直後に push する 1 問アンケート。
 *
 * 文面は F事業のリーダーの決定（TB-748）に従う:
 *   - 先頭で「完了した」と言い切る。アンケートはその後
 *   - 謝らない（「ご迷惑をおかけし」「申し訳ございません」を入れない）
 *   - 引き止め文・再契約導線・クーポンを置かない（解約はこの時点で成立済み）
 *   - 答えずに閉じられることが文面から分かる（「よろしければ」「任意」）
 *   - 5 択の表示文言は CANCELLATION_REASONS のまま。言い換えない（集計の意味が変わる）
 * ボタンが送る text は `CANCELLATION_REASON_PREFIX + <コード>`（表示文言は送らない）
 */
export function cancellationSurveyMessages(): Array<Record<string, unknown>> {
  return [
    {
      type: 'flex',
      altText: CANCELLATION_SURVEY_ALT_TEXT,
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '解約のお手続きは完了しました', weight: 'bold', size: 'md', wrap: true },
            {
              type: 'text',
              text: 'ご利用いただきありがとうございました。',
              size: 'sm',
              color: '#666666',
              margin: 'md',
              wrap: true,
            },
            {
              type: 'text',
              text: 'よろしければ、解約の理由を1つだけ選んでください（任意です）。\nこのまま閉じていただいても、お手続きに影響はありません。',
              size: 'sm',
              color: '#666666',
              margin: 'md',
              wrap: true,
            },
            {
              type: 'box',
              layout: 'vertical',
              margin: 'lg',
              spacing: 'sm',
              contents: (Object.keys(CANCELLATION_REASONS) as CancellationReasonCode[]).map((code) => ({
                type: 'button',
                style: 'secondary',
                height: 'sm',
                action: {
                  type: 'message',
                  label: CANCELLATION_REASONS[code],
                  text: `${CANCELLATION_REASON_PREFIX}${code}`,
                },
              })),
            },
          ],
        },
      },
    },
  ];
}
