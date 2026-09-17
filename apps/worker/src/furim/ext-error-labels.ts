/**
 * furim_ext_errors（認証エラーと監視の記録）の日本語ラベル（2026-09-17 くろさん OK・統括依頼）。
 * トップの異常区画と、データ区画の一覧の両方で使う。
 *
 * 呼び出し元（ChromeExtention main 8c21ad8 時点で秘書B が確認）:
 * - getKeyCodeSet: キーコード認証。ポップアップの認証ボタン・自動化を始める前の自動チェック（ensureValidKeyCodeForAutomation）・
 *   ページ内の移動ボタンの 3 か所から呼ばれ、どこで押したかは記録に残らない
 * - stackExecutionData: 認証ではなく、自動化の処理が始まったあとの処理履歴の送信
 * - updateCopyCredit: コピー出品チケットの消費の記録
 * - sheet: 旧 GAS のエラーシートからの取り込み（〜2026-09-14・呼び出し元不明）
 * - collectSkip / botHandler / aiChatHowto: Worker 側の監視の記録（2026-09-17〜）
 */

export const EXT_ERROR_METHOD_LABELS: Record<string, string> = {
  getKeyCodeSet: 'キーコード認証',
  stackExecutionData: '処理履歴の送信',
  updateCopyCredit: 'チケット消費の記録',
  sheet: 'シートからの取り込み（呼び出し元不明・〜9/14）',
  collectSkip: '巡回キューの取りこぼし（Worker）',
  botHandler: 'LINE bot の処理失敗（Worker）',
  aiChatHowto: 'AI チャットの説明書取得失敗（Worker）',
};

export const EXT_ERROR_REASON_LABELS: Record<string, string> = {
  該当レコードなし: 'キーコードが見つからない（打ち間違い・古いキーコード・解約で消えた）',
  端末判定文字列が一致しないので不正利用: '別の端末で使用中（キーコードリセットで解消）',
  キーコードが更新されました: '古いキーコード（プラン変更などで更新済み）',
  メルカリURL不一致: '登録と違うメルカリアカウント',
  メルカリURL重複: '同じメルカリアカウントを別のキーコードで使用',
  有効期限切れ: '有効期限切れ',
  無料期間終了: '無料期間終了',
  プランキャンセル済み: 'プランキャンセル済み',
};

/** 仕組みどおりに弾いているだけの理由。これだけのときはトップの異常区画に出さない（くろさん OK） */
export const EXT_ERROR_BY_DESIGN_REASONS: ReadonlySet<string> = new Set(['有効期限切れ', '無料期間終了', 'プランキャンセル済み']);

/** Worker 側の監視の記録（キーコードや端末判定文字列を持たない） */
export const WORKER_EXT_ERROR_METHODS: ReadonlySet<string> = new Set(['collectSkip', 'botHandler', 'aiChatHowto']);

export function extErrorReasonLabel(error: string): string {
  if (EXT_ERROR_REASON_LABELS[error]) return EXT_ERROR_REASON_LABELS[error];
  if (error.startsWith('Exception:')) return `シート側の例外（${error.slice(0, 40)}）`;
  return error;
}
