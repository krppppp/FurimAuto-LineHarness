import { describe, expect, it } from 'vitest'
import { toDisplayDateTime, toStorageDateTime } from './datetime'

describe('データ区画の日時表示（Worker の admin-schema と同じ変換）', () => {
  it('保存値を表示形式にし、表示形式のまま保存すると元の値に戻る', () => {
    const originals = [
      '2026-09-13T23:45:43.193+09:00',
      '2026-09-13T19:54:32.847',
      '2026-12-31 20:44:41',
      '2026-09-13T14:45:43.123Z',
      '2026/09/14 08:07:35',
      'よくわからない値',
    ]
    expect(originals.map(toDisplayDateTime)).toEqual([
      '2026/09/13 23:45:43',
      '2026/09/13 19:54:32',
      '2026/12/31 20:44:41',
      '2026/09/13 23:45:43',
      '2026/09/14 08:07:35',
      'よくわからない値',
    ])
    for (const o of originals) expect(toStorageDateTime(toDisplayDateTime(o), o, 'jst')).toBe(o)
  })

  it('変更した時刻は元の保存形式で返す', () => {
    expect(toStorageDateTime('2026/09/14 00:10:00', '2026-09-13T23:45:43.193+09:00', 'jst')).toBe('2026-09-14T00:10:00.000+09:00')
    expect(toStorageDateTime('2027/01/07 20:44:41', '2026-12-31 20:44:41', 'jst')).toBe('2027-01-07 20:44:41')
    expect(toStorageDateTime('2026/09/14 00:10:00', '2026-09-13T14:45:43.000Z', 'jst')).toBe('2026-09-13T15:10:00.000Z')
    expect(toStorageDateTime('2026/09/13 23:45:43', null, 'space')).toBe('2026-09-13 23:45:43')
  })
})
