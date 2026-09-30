import { jstNow } from '@line-crm/db';

// 解約理由の 6 択（TB-740。TB-825 でくろさんが旧アンケートの 6 択に戻した）。コードは英字で固定し、
// 値はボタンが送る文言（旧アンケートの送信値そのまま・過去のタグ「解約理由:<値>」と同じ）。
// 文言を変えても furim_cancellations.reason_code の集計が壊れないようにするため、
// D1 には必ずコードを入れる（日本語のラベルを列に入れない）。
// price は旧 5 択の「値段」で本番に 1 行入っているので、コードを変えない
export const CANCELLATION_REASONS = {
  price: '料金が高い',
  too_hard: '使いこなせなかった',
  no_result: '成果が出なかった',
  pause_selling: '物販休止',
  switched_tool: '他ツールへ乗り換え',
  other: 'その他',
} as const;

export type CancellationReasonCode = keyof typeof CANCELLATION_REASONS;

// ボタンの表示ラベル（旧 Flex のまま。送信値とは別の文言）
const CANCELLATION_REASON_BUTTON_LABELS: Record<CancellationReasonCode, string> = {
  price: '料金が高かった',
  too_hard: '使いこなせなかった',
  no_result: '思うような成果が出なかった',
  pause_selling: '物販をやめた・お休みする',
  switched_tool: '他のツールに乗り換えた',
  other: 'その他',
};

// アンケートのボタンが送る文言。handleButtonAction に入るよう【ボタン】を付ける。
// action.type = message は押した文字列が本人の吹き出しとしてトークに残るので、
// 送るのは英字コードではなく日本語のラベル（顧客の画面に not_working と出さない・TB-747 CTO レビュー）。
// D1 に入れるのは今までどおり reason_code で、日本語 → コードの変換はここで解決する
export const CANCELLATION_REASON_PREFIX = '【ボタン】解約理由:';

// 6 択を押してから自由記述を拾う期限（この時間を過ぎたテキストは別の用件とみなす）
const FREE_TEXT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isCancellationReasonCode(value: string): value is CancellationReasonCode {
  return Object.prototype.hasOwnProperty.call(CANCELLATION_REASONS, value);
}

/**
 * ボタンが送ってきた日本語の送信値を reason_code に戻す。6 択のどれでもなければ null。
 * 旧 5 択（TB-746）の送信値（動かない／値段 など）は null になり、button-actions の旧分岐（タグだけ）へ落ちる。
 */
export function cancellationReasonCodeFromLabel(label: string): CancellationReasonCode | null {
  const hit = (Object.keys(CANCELLATION_REASONS) as CancellationReasonCode[]).find(
    (code) => CANCELLATION_REASONS[code] === label,
  );
  return hit ?? null;
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
 * 6 択の回答を、その人の最新の解約行に書く。押し直しは最後の答えを正とする（上書き）。
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
 * 6 択を押した直後の自由記述を、その人の最新の解約行に書く。
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

// 1 通目の altText（トーク一覧・通知に出る 1 行。旧 Flex のまま）
export const CANCELLATION_SURVEY_ALT_TEXT = '【1タップ】解約理由アンケート';

// 2 通目（6 択を押した人にだけ返す）。押していない人には何も送らない＝催促しない
export const CANCELLATION_REASON_REPLY_TEXT =
  'ご回答ありがとうございます。\n\n差し支えなければ、もう少し詳しく一言お聞かせください。\n（不要でしたら、何も送らずに閉じていただいて大丈夫です）';

// 自由記述を受け取ったときの締め。ここで終わりにして AI チャットへ流さない
export const CANCELLATION_FREE_TEXT_REPLY = 'ありがとうございます。いただいたご意見は今後の改善に活用させていただきます。';

/**
 * 解約直後に push する 1 問アンケート（解約完了の通知の後に届く）。
 *
 * 見た目は旧アンケート（本番 automation_actions dc2fc760 に 2026-09-29 まで入っていた Flex・
 * Vault departments/engineering/FurimAuto-LineHarness/assets/2026-09-29-tb752-automation_actions-dc2fc760-params-BEFORE.json
 * の message 1）の写し。TB-825 でくろさんが旧 6 択に戻すと決めた。直すときは TB-748 で承認を取り直すこと。
 * ボタンが送る text は `CANCELLATION_REASON_PREFIX + <送信値>`。
 * D1 に入るのは reason_code で、変換は cancellationReasonCodeFromLabel が行う
 */
export function cancellationSurveyMessages(): Array<Record<string, unknown>> {
  const codes = Object.keys(CANCELLATION_REASONS) as CancellationReasonCode[];
  return [
    {
      type: 'flex',
      altText: CANCELLATION_SURVEY_ALT_TEXT,
      contents: {
        type: 'bubble',
        size: 'mega',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '最後に1つだけ教えてください🙇', weight: 'bold', size: 'lg', wrap: true },
            { type: 'text', text: '今回解約された1番の理由はどれですか？\n（1タップで完了します）', size: 'md', wrap: true, margin: 'md' },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: codes.map((code) => ({
            type: 'button',
            style: code === 'other' ? 'secondary' : 'primary',
            height: 'sm',
            action: {
              type: 'message',
              label: CANCELLATION_REASON_BUTTON_LABELS[code],
              text: `${CANCELLATION_REASON_PREFIX}${CANCELLATION_REASONS[code]}`,
            },
          })),
        },
      },
    },
  ];
}
