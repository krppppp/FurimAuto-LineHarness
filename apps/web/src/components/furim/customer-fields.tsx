'use client'

import { useState } from 'react'
import { listColumnsOf, rowId, ROW_ID_COLUMN, type AdminColumn, type AdminTableMeta } from '@/app/data/types'
import { DATETIME_PLACEHOLDER, saveRowChanges, shown, type Row } from '@/components/data/admin-client'
import { canEditColumn, fieldText, isFieldChanged, needsConfirm, valueToSend } from '@/components/data/row-fields'

// 個別チャットの顧客パネルの「顧客データの全項目」（Capsec #308）。
// 顧客DB の行ドロワーと同じ決まり（row-fields: 編集できる列・送る値・保存前の確認）で、項目ごとに「編集」→「保存」する。
// 保存は既存の管理 API（PATCH /api/furim/admin/furim_customers/:id）で、変更履歴は API 側で残る

interface Props {
  table: AdminTableMeta
  row: Row
  onSaved: (row: Row) => void
}

export default function CustomerFields({ table, row, onSaved }: Props) {
  const [editing, setEditing] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const id = rowId(row, table)
  const columnByName = new Map(table.columns.map((c) => [c.name, c]))
  const fields = listColumnsOf(table).filter((lc) => !lc.featureKey)

  const startEdit = (c: AdminColumn) => {
    setEditing(c.name)
    setInput(fieldText(c, row[c.name]))
    setError('')
    setNotice('')
  }

  const save = async (c: AdminColumn) => {
    if (!isFieldChanged(table, c, input, row)) {
      setEditing(null)
      return
    }
    setSaving(true)
    setError('')
    try {
      const res = await saveRowChanges(table, id, row, { [c.name]: valueToSend(c, input, row[c.name]) })
      if (!res) return
      if (res.success) {
        const attached = Object.fromEntries(Object.entries(row).filter(([k]) => k.startsWith('_') && k !== ROW_ID_COLUMN))
        onSaved({ ...res.data, ...attached })
        setEditing(null)
        setNotice(`「${c.label}」を保存しました`)
      } else {
        setError(res.error ?? '保存に失敗しました')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="py-2 space-y-2">
      {error && <div className="p-2 bg-red-50 border border-red-200 rounded text-red-700 text-xs">{error}</div>}
      {notice && <div className="p-2 bg-green-50 border border-green-200 rounded text-green-800 text-xs">{notice}</div>}
      <dl className="divide-y divide-gray-100">
        {fields.map((lc) => {
          const col = columnByName.get(lc.name)
          const editable = col ? canEditColumn(table, col) : false
          const value = col ? fieldText(col, row[lc.name]) : shown(row[lc.name], lc.datetime)
          const isEditing = col && editing === col.name
          return (
            <div key={lc.name} className="py-1.5">
              <dt className="flex items-center gap-1.5 text-[11px] text-gray-500" title={lc.name}>
                <span>{lc.label}</span>
                {!editable && <span className="text-gray-300">読み取り専用</span>}
                {editable && needsConfirm(table, lc.name) && (
                  <span className="px-1 rounded bg-amber-50 text-amber-700" title="保存の前に確認が出ます">確認あり</span>
                )}
                {editable && col && !isEditing && (
                  <button
                    type="button"
                    onClick={() => startEdit(col)}
                    disabled={saving}
                    className="ml-auto text-[11px] text-green-700 hover:underline disabled:opacity-50"
                  >
                    編集
                  </button>
                )}
              </dt>
              {isEditing && col ? (
                <dd className="mt-1 space-y-1.5">
                  <input
                    type="text"
                    value={input}
                    autoFocus
                    placeholder={col.datetime ? DATETIME_PLACEHOLDER : undefined}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) save(col)
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    className={`w-full px-2 py-1.5 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-green-500 ${
                      isFieldChanged(table, col, input, row) ? 'border-yellow-400 bg-yellow-50' : 'border-gray-300'
                    }`}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => save(col)}
                      disabled={saving || !isFieldChanged(table, col, input, row)}
                      className="px-3 py-1 min-h-[36px] lg:min-h-0 text-xs font-medium rounded text-white disabled:opacity-50"
                      style={{ backgroundColor: '#06C755' }}
                    >
                      {saving ? '保存中...' : '保存'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      disabled={saving}
                      className="px-3 py-1 min-h-[36px] lg:min-h-0 text-xs font-medium rounded text-gray-600 bg-gray-200 hover:bg-gray-300"
                    >
                      取消
                    </button>
                  </div>
                </dd>
              ) : (
                <dd className="mt-0.5 text-xs text-gray-800 break-all whitespace-pre-wrap">
                  {value === '' ? <span className="text-gray-300">—</span> : value}
                </dd>
              )}
            </div>
          )
        })}
      </dl>
    </div>
  )
}
