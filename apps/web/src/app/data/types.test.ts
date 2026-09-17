import { describe, expect, it } from 'vitest'
import { listCellText, type AdminTableMeta } from './types'

const table = {
  valueLabels: { method: { getKeyCodeSet: 'キーコード認証' } },
  emptyLabels: {
    discrimination_code: { dependsOn: 'method', byValue: { getKeyCodeSet: '（拡張から届いていない）' }, default: '—（キーコード認証の行だけに入る）' },
  },
} as unknown as AdminTableMeta

describe('データ区画の一覧のセル（認証エラーと監視の記録・2026-09-17）', () => {
  it('値は日本語ラベルで出し、title に元の値を残す', () => {
    expect(listCellText(table, {}, 'method', 'getKeyCodeSet')).toEqual({ text: 'キーコード認証', empty: false, title: 'キーコード認証（getKeyCodeSet）' })
  })

  it('ラベルの無い値はそのまま', () => {
    expect(listCellText(table, {}, 'method', 'someNewMethod').text).toBe('someNewMethod')
  })

  it('空欄は、記録の種類に応じて意味を出し分ける', () => {
    expect(listCellText(table, { method: 'getKeyCodeSet' }, 'discrimination_code', '')).toMatchObject({ text: '（拡張から届いていない）', empty: true })
    expect(listCellText(table, { method: 'stackExecutionData' }, 'discrimination_code', '')).toMatchObject({ text: '—（キーコード認証の行だけに入る）', empty: true })
    expect(listCellText(table, {}, 'key_code', '')).toMatchObject({ text: '—', empty: true })
  })
})
