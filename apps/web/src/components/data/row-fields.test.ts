import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AdminColumn, AdminTableMeta } from '../../app/data/types'
import { canEditColumn, collectChanges, confirmMessage, isFieldChanged, needsConfirm } from './row-fields'

const col = (name: string, editable: boolean, extra: Partial<AdminColumn> = {}): AdminColumn => ({
  name,
  type: 'text',
  editable,
  searchable: false,
  label: { key_code: 'キーコード', stripe_customer_id: 'Stripe顧客ID', mercari_url: 'メルカリURL', device_code: '端末判定文字列' }[name] ?? name,
  internal: false,
  datetime: null,
  ...extra,
})

// 本番の furim_customers のメタ（/api/furim/admin/tables）の該当部分
const customers = {
  name: 'furim_customers',
  pkColumns: ['line_user_id'],
  columns: [
    col('line_user_id', false),
    col('stripe_customer_id', true),
    col('key_code', true),
    col('mercari_url', true),
    col('device_code', false),
    col('subscription_end_at', true, { datetime: 'jst' }),
  ],
  confirmColumns: ['stripe_customer_id', 'subscription_id', 'key_code'],
} as unknown as AdminTableMeta

const row = { line_user_id: 'U1', stripe_customer_id: 'cus_1', key_code: 'AAA', mercari_url: 'https://jp.mercari.com/user/profile/1', device_code: 'x', subscription_end_at: '2026-10-12T00:00:00.000+09:00' }

describe('行の編集の決まり（顧客DB の行ドロワーと個別チャットの顧客パネルで共通・#308）', () => {
  it('読み取り専用の列は編集できず、変更にも数えない', () => {
    const device = customers.columns.find((c) => c.name === 'device_code')!
    expect(canEditColumn(customers, device)).toBe(false)
    expect(isFieldChanged(customers, device, 'changed', row)).toBe(false)
    const draft = { ...row, subscription_end_at: '2026/10/12 00:00:00', device_code: 'changed', line_user_id: 'U2' }
    expect(collectChanges(customers, row, draft)).toEqual({})
    expect(collectChanges(customers, row, { ...draft, key_code: 'BBB' })).toEqual({ key_code: 'BBB' })
  })

  it('日時列は表示形式で入力しても、元と同じ時刻なら変更にならない', () => {
    const end = customers.columns.find((c) => c.name === 'subscription_end_at')!
    expect(isFieldChanged(customers, end, '2026/10/12 00:00:00', row)).toBe(false)
  })

  it('キーコード・Stripe 顧客 ID は保存前に確認し、メルカリ URL だけの変更では確認しない', () => {
    expect(needsConfirm(customers, 'key_code')).toBe(true)
    expect(needsConfirm(customers, 'stripe_customer_id')).toBe(true)
    expect(needsConfirm(customers, 'mercari_url')).toBe(false)
    expect(confirmMessage(customers, row, { mercari_url: 'https://jp.mercari.com/user/profile/2' })).toBeNull()
    const msg = confirmMessage(customers, row, { key_code: 'BBB', mercari_url: 'x' })
    expect(msg).toContain('・キーコード: AAA → BBB')
    expect(msg).not.toContain('メルカリURL')
  })

  it('確認の列を持たないテーブルは確認しない', () => {
    const plain = { ...customers, confirmColumns: undefined } as AdminTableMeta
    expect(confirmMessage(plain, row, { key_code: 'BBB' })).toBeNull()
  })

  it('行ドロワーと顧客パネルは、同じ決まりと同じ保存（saveRowChanges）を通り、PATCH を直接書かない', () => {
    const src = (p: string) => readFileSync(join(__dirname, p), 'utf8')
    const drawer = src('../../app/data/table/page.tsx')
    const panel = src('../furim/customer-fields.tsx')
    for (const s of [drawer, panel]) {
      expect(s).toMatch(/from '@\/components\/data\/row-fields'/)
      expect(s).toContain('saveRowChanges(')
      expect(s).not.toMatch(/mutate\('PATCH'/)
      // 確認する列を画面側で決め打ちしない（confirmColumns だけが決める）
      expect(s).not.toMatch(/'key_code'|'stripe_customer_id'|'subscription_id'/)
    }
    for (const s of [drawer, panel]) {
      expect(s).toContain('canEditColumn(')
      expect(s).toContain('needsConfirm(table, ')
    }
  })
})
