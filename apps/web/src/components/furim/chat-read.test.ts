import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MARK_READ_STATUS, canMarkRead } from './chat-read'

const page = readFileSync(resolve(__dirname, '../../app/chats/page.tsx'), 'utf8')

function block(src: string, start: string, end: string): string {
  const i = src.indexOf(start)
  expect(i).toBeGreaterThanOrEqual(0)
  const j = src.indexOf(end, i + start.length)
  expect(j).toBeGreaterThan(i)
  return src.slice(i, j)
}

describe('TB-3105 開いただけでは未読から外さない', () => {
  it('未読のときだけ「既読にする」を出し、押すと対応中にする', () => {
    expect(canMarkRead('unread')).toBe(true)
    expect(canMarkRead('in_progress')).toBe(false)
    expect(canMarkRead('resolved')).toBe(false)
    expect(MARK_READ_STATUS).toBe('in_progress')
  })

  it('チャットを選んだときに status を更新しない', () => {
    const body = block(page, 'const handleSelectChat = ', '\n  }\n')
    expect(body).not.toMatch(/markChatRead|api\.chats\.update/)
  })

  it('開いている会話のポーリングで status を更新しない', () => {
    const body = block(page, 'const id = window.setInterval(tick, CHAT_DETAIL_POLL_MS)', '}, [selectedChatId')
    const tick = block(page, 'const tick = async () => {', 'const id = window.setInterval(tick, CHAT_DETAIL_POLL_MS)')
    expect(tick + body).not.toMatch(/markChatRead|api\.chats\.update/)
  })

  it('開いた・見ているだけで既読にする関数が残っていない', () => {
    expect(page).not.toMatch(/markChatRead/)
  })

  it('「既読にする」ボタンはステータス変更と同じ経路（handleStatusUpdate）で外す', () => {
    expect(page).toMatch(/handleStatusUpdate\(MARK_READ_STATUS\)/)
  })
})
