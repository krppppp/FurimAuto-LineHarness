// FurimAuto独自（TB-3105）: チャットを開いた・見ているだけでは未読から外さない。
// 未読から外すのは手動送信（Worker 側で in_progress）・「既読にする」ボタン・ステータス変更だけ。

export type ChatStatus = 'unread' | 'in_progress' | 'resolved'

export const MARK_READ_STATUS: ChatStatus = 'in_progress'

export function canMarkRead(status: ChatStatus): boolean {
  return status === 'unread'
}
