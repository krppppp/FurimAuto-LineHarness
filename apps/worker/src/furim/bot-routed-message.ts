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

export function isBotRoutedText(text: string): boolean {
  if (HUMAN_FOLLOWUP_BUTTONS.some((b) => text.includes(b))) return false;
  const trimmed = text.trim();
  if (text.startsWith('【プラン変更】') || text.startsWith('【プラン申し込み】')) return true;
  if (text.includes('【ボタン】')) return true;
  if (text.startsWith(RICHMENU_MESSAGE_PREFIX)) return true;
  if (text.includes('【キーワード】') || text.includes('キーコードリセット')) return true;
  if (text.includes('furimanです') || text.includes('Furimanです')) return true;
  if (trimmed === '解説見た' || trimmed === '解説みた') return true;
  if (AUTO_KEYWORDS.includes(text)) return true;
  if (TIME_COMMAND_PATTERN.test(text)) return true;
  return false;
}

export function isBotRoutedIncoming(messageType: string, content: string | null | undefined): boolean {
  return messageType === 'text' && isBotRoutedText(String(content ?? ''));
}
