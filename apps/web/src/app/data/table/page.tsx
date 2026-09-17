'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import Header from '@/components/layout/header'
import { fetchApi } from '@/lib/api'
import {
  DISPLAY_NAME_COLUMN,
  ROW_ID_COLUMN,
  listCellText,
  listColumnsOf,
  rowId,
  type AdminColumn,
  type AdminTableMeta,
  type DateTimeStorage,
} from '../types'
import { toDisplayDateTime } from '../datetime'
import {
  DATETIME_PLACEHOLDER,
  cell,
  mutate,
  saveRowChanges,
  shown,
  tableHref,
  type AuditRow,
  type Row,
  type RowResponse,
} from '@/components/data/admin-client'
import { canEditColumn, collectChanges, isAutoId, isFieldChanged, needsConfirm } from '@/components/data/row-fields'
import DisplayName from '@/components/data/display-name'
import RelatedPanel from '@/components/data/related-panel'
import FeaturePanel from '@/components/data/feature-panel'

type ListResponse = {
  success: boolean
  error?: string
  data: Row[]
  meta: { table: AdminTableMeta; total: number; limit: number; cursor: string; nextCursor: string | null }
}

const LIMIT = 1000

// CSV 書き出し: Cookie 認証付きで取得して blob をダウンロードする（<a href> だと Pages プロキシ経由の Cookie が付かない）
async function downloadCsv(tableName: string, q: string): Promise<void> {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/furim/admin/${encodeURIComponent(tableName)}/export.csv?${params.toString()}`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`CSV の取得に失敗しました（${res.status}）`)
  const blob = await res.blob()
  const disposition = res.headers.get('content-disposition') ?? ''
  const m = disposition.match(/filename="([^"]+)"/)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = m?.[1] ?? `${tableName}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function pkIsInternal(table: AdminTableMeta): boolean {
  return table.pkColumns.some((n) => table.columns.find((c) => c.name === n)?.internal)
}

function RowEditor({
  table,
  row,
  mode = 'edit',
  onClose,
  onSaved,
  onDeleted,
}: {
  table: AdminTableMeta
  row: Row
  /** insert: 空のフォームで新規行を作る（主キーと全列を入力可） */
  mode?: 'edit' | 'insert'
  onClose: () => void
  onSaved: (row: Row) => void
  onDeleted?: (id: string) => void
}) {
  const insert = mode === 'insert'
  const id = insert ? '' : rowId(row, table)
  const [tab, setTab] = useState<'edit' | 'features' | 'related'>('edit')
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(table.columns.map((c) => [c.name, shown(row[c.name], c.datetime)])),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [audit, setAudit] = useState<AuditRow[]>([])
  // 追加モードでは主キー（id が自動採番のものを除く）と全列を入力できる
  const autoId = isAutoId(table, insert)
  const canEdit = (c: { name: string; editable: boolean }) => canEditColumn(table, c, insert)

  const loadAudit = useCallback(async () => {
    if (insert) return
    try {
      const res = await fetchApi<{ success: boolean; data: AuditRow[] }>(
        `/api/furim/admin/${table.name}/${encodeURIComponent(id)}/audit`,
      )
      if (res.success) setAudit(res.data)
    } catch {
      /* 監査ログが取れなくても編集は続けられる */
    }
  }, [table.name, id, insert])

  useEffect(() => {
    loadAudit()
  }, [loadAudit])

  // 日時列は表示形式で入力し、送るときにその列の現在の保存形式へ戻す。編集できる列・送る値・変更の判定は row-fields（個別チャットの顧客パネルと共用・#308）
  const isChanged = (c: AdminColumn): boolean => isFieldChanged(table, c, draft[c.name] ?? '', row, insert)
  const changes = collectChanges(table, row, draft, insert)
  const changedCount = Object.keys(changes).length
  const editable = insert || table.columns.some((c) => c.editable)

  const handleSave = async () => {
    if (changedCount === 0) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const res = insert
        ? await mutate('POST', `/api/furim/admin/${table.name}`, { values: changes })
        : await saveRowChanges(table, id, row, changes)
      if (!res) return
      if (res.success) {
        if (insert) {
          onSaved(res.data)
          return
        }
        const changedLabels = (res.meta?.changed ?? []).map((n) => table.columns.find((c) => c.name === n)?.label ?? n)
        setNotice(`保存しました（${changedLabels.join('、') || '変更なし'}）`)
        const attached = Object.fromEntries(Object.entries(row).filter(([k]) => k.startsWith('_') && k !== ROW_ID_COLUMN))
        onSaved({ ...res.data, ...attached })
        setDraft(Object.fromEntries(table.columns.map((c) => [c.name, shown(res.data[c.name], c.datetime)])))
        await loadAudit()
      } else {
        setError(res.error ?? (insert ? '追加に失敗しました' : '保存に失敗しました'))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const displayName = cell(row[DISPLAY_NAME_COLUMN])
  const internalPk = pkIsInternal(table)
  const pkLabels = table.pkColumns.map((n) => table.columns.find((c) => c.name === n)?.label ?? n).join('・')
  const timeText = table.timeColumn ? toDisplayDateTime(row[table.timeColumn]) : ''
  const rowSummary = internalPk
    ? [displayName, timeText ? `${table.timeColumnLabel} ${timeText}` : ''].filter(Boolean).join(' ・ ')
    : `${pkLabels} = ${id}`

  const handleDelete = async () => {
    if (!window.confirm(`${table.label} の行（${rowSummary || id}）を削除します。元に戻せません。よろしいですか？`)) return
    setSaving(true)
    setError('')
    try {
      const res = await mutate('DELETE', `/api/furim/admin/${table.name}/${encodeURIComponent(id)}`)
      if (res.success) {
        onDeleted?.(id)
      } else {
        setError(res.error ?? '削除に失敗しました')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '削除に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const columnByName = new Map(table.columns.map((c) => [c.name, c]))
  const internalColumns = table.columns.filter((c) => c.internal)
  const internalVirtualColumns = insert ? [] : (table.virtualColumns ?? []).filter((v) => v.internal && !v.featureKey)
  const internalCount = internalColumns.length + internalVirtualColumns.length
  const listColumns = listColumnsOf(table).filter((lc) => !lc.featureKey)

  const renderReadOnly = (lc: { name: string; label: string; datetime: DateTimeStorage | null }) => (
    <div key={lc.name}>
      <label className="block text-xs font-medium text-gray-700 mb-1" title={lc.name}>
        <span>{lc.label}</span>
        <span className="ml-2 text-gray-400">読み取り専用</span>
      </label>
      <input
        type="text"
        value={shown(row[lc.name], lc.datetime)}
        readOnly
        className="w-full px-3 py-2 text-sm border rounded-lg border-gray-200 bg-gray-50 text-gray-500"
      />
    </div>
  )

  const renderField = (c: AdminColumn) => {
    const editableHere = canEdit(c)
    const changed = isChanged(c)
    return (
      <div key={c.name}>
        <label className="block text-xs font-medium text-gray-700 mb-1" title={c.name}>
          <span>{c.label}</span>
          <span className="ml-2 text-gray-400">
            {insert && table.pkColumns.includes(c.name) ? (autoId ? '自動採番' : '主キー（必須）') : editableHere ? '' : '読み取り専用'}
          </span>
          {!insert && editableHere && needsConfirm(table, c.name) && (
            <span className="ml-2 px-1 rounded bg-amber-50 text-amber-700" title="保存の前に確認が出ます">確認あり</span>
          )}
        </label>
        <input
          type="text"
          value={draft[c.name] ?? ''}
          readOnly={!editableHere}
          placeholder={c.datetime && editableHere ? DATETIME_PLACEHOLDER : undefined}
          onChange={(e) => setDraft((d) => ({ ...d, [c.name]: e.target.value }))}
          className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 ${
            editableHere
              ? changed
                ? 'border-yellow-400 bg-yellow-50'
                : 'border-gray-300'
              : 'border-gray-200 bg-gray-50 text-gray-500'
          }`}
        />
      </div>
    )
  }

  const labelOf = (name: string) => columnByName.get(name)?.label ?? name

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="h-full w-full max-w-3xl overflow-y-auto bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 border-b border-gray-200 bg-white">
          <div className="flex items-center justify-between px-5 py-3">
            <div>
              <div className="text-sm font-semibold text-gray-900">
                {insert ? `${table.label} に行を追加` : `${displayName ? `${displayName} ・ ` : ''}${table.label}`}
              </div>
              <div className="text-xs text-gray-500 break-all">
                {insert ? `主キー: ${pkLabels}${autoId ? '（自動採番）' : ''}` : internalPk ? (timeText ? `${table.timeColumnLabel} ${timeText}` : '') : `${pkLabels} = ${id}`}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {tab === 'edit' && !insert && table.deletable && onDeleted && (
                <button
                  onClick={handleDelete}
                  disabled={saving}
                  className="px-3 py-2 text-sm font-medium text-red-700 bg-white border border-red-300 rounded-lg hover:bg-red-50 disabled:opacity-50"
                >
                  削除
                </button>
              )}
              {tab === 'edit' && editable && (
                <button
                  onClick={handleSave}
                  disabled={saving || changedCount === 0}
                  className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity hover:opacity-90"
                  style={{ backgroundColor: '#06C755' }}
                >
                  {saving ? (insert ? '追加中...' : '保存中...') : insert ? `追加${changedCount ? `（${changedCount} 列）` : ''}` : `保存${changedCount ? `（${changedCount}）` : ''}`}
                </button>
              )}
              <button
                onClick={onClose}
                className="px-3 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                閉じる
              </button>
            </div>
          </div>
          <div className="flex gap-1 px-5">
            {(
              insert
                ? ([['edit', '入力']] as const)
                : ([
                    ['edit', editable ? '編集' : '内容'],
                    ...(table.featureFlags ? ([['features', '機能']] as const) : []),
                    ['related', '関連データ'],
                  ] as const)
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                  tab === key ? 'border-green-500 text-gray-900 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {tab === 'related' ? (
          <RelatedPanel table={table} row={row} />
        ) : tab === 'features' ? (
          <FeaturePanel lineUserId={id} displayName={displayName} />
        ) : (
          <>
            <div className="px-5 py-4 space-y-3">
              {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
              {notice && <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-800 text-sm">{notice}</div>}
              {listColumns.map((lc) => {
                const col = columnByName.get(lc.name)
                if (col) return renderField(col)
                if (insert) return null
                return renderReadOnly(lc)
              })}
            </div>

            {!insert && (
            <div className="border-t border-gray-200 px-5 py-4">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">変更履歴</div>
              {audit.length === 0 ? (
                <div className="text-xs text-gray-400">まだ変更はありません</div>
              ) : (
                <ul className="space-y-1.5 text-xs text-gray-700">
                  {audit.map((a) => {
                    const col = columnByName.get(a.column_name)
                    const val = (v: string | null) => (v === null ? '(空)' : col?.datetime ? toDisplayDateTime(v) : v)
                    return (
                      <li key={a.id} className="flex flex-wrap gap-x-2">
                        <span className="text-gray-400">{toDisplayDateTime(a.created_at)}</span>
                        <span>{a.staff_name}</span>
                        <span title={a.column_name}>{labelOf(a.column_name)}</span>
                        <span className="text-gray-400 line-through break-all">{val(a.old_value)}</span>
                        <span className="break-all">→ {val(a.new_value)}</span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
            )}

            {internalCount > 0 && (
              <details open={insert} className="border-t border-gray-200 px-5 py-4">
                <summary className="cursor-pointer text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  内部情報（{internalCount}）
                </summary>
                <div className="mt-3 space-y-3">
                  {internalColumns.map(renderField)}
                  {internalVirtualColumns.map((v) => renderReadOnly({ name: v.name, label: v.label, datetime: null }))}
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function DataTableInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const name = searchParams.get('name') ?? ''
  const initialQ = searchParams.get('q') ?? ''
  const openId = searchParams.get('open') ?? ''

  const [table, setTable] = useState<AdminTableMeta | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [cursor, setCursor] = useState('0')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [q, setQ] = useState(initialQ)
  const [query, setQuery] = useState(initialQ)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Row | null>(null)
  const [adding, setAdding] = useState(false)
  const [exporting, setExporting] = useState(false)
  const load = useCallback(async (cur: string, search: string) => {
    if (!name) return
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ limit: String(LIMIT), cursor: cur })
      if (search) params.set('q', search)
      const res = await fetchApi<ListResponse>(`/api/furim/admin/${encodeURIComponent(name)}?${params.toString()}`)
      if (res.success) {
        setTable(res.meta.table)
        setRows(res.data)
        setTotal(res.meta.total)
        setCursor(res.meta.cursor)
        setNextCursor(res.meta.nextCursor)
      } else {
        setError(res.error ?? '読み込みに失敗しました')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [name])

  useEffect(() => {
    setQ(initialQ)
    setQuery(initialQ)
    load('0', initialQ)
  }, [load, initialQ])

  // ?open=<主キー> で来たら（関連データからの遷移）その行を取ってドロワーを開く
  useEffect(() => {
    if (!name || !openId) return
    let alive = true
    ;(async () => {
      try {
        const res = await fetchApi<RowResponse & { meta?: { table?: AdminTableMeta } }>(
          `/api/furim/admin/${encodeURIComponent(name)}/${encodeURIComponent(openId)}`,
        )
        if (!alive) return
        if (res.success) {
          if (res.meta?.table) setTable((t) => t ?? res.meta!.table!)
          setEditing(res.data)
        } else {
          setError(res.error ?? '行が見つかりません')
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : '行が見つかりません')
      }
    })()
    return () => {
      alive = false
    }
  }, [name, openId])

  const closeEditor = () => {
    setEditing(null)
    if (openId) router.replace(tableHref(name, query ? { q: query } : {}))
  }

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    const s = q.trim()
    setQuery(s)
    load('0', s)
  }

  const offset = Number(cursor) || 0
  const prevCursor = offset > 0 ? String(Math.max(0, offset - LIMIT)) : null

  if (!name) {
    return <div className="p-8 text-center text-sm text-gray-500">テーブル名が指定されていません</div>
  }

  const cols = table ? listColumnsOf(table) : []

  return (
    <div>
      <Header
        title={table ? `${table.label}` : name}
        description={
          table
            ? `${table.name}・行をクリックで開く${table.allRows ? '・全件 1 ページ（友だち登録の新しい順）' : ''}`
            : undefined
        }
        action={
          <div className="flex items-center gap-2">
            {table?.insertable && (
              <button
                onClick={() => setAdding(true)}
                className="px-3 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
                style={{ backgroundColor: '#06C755' }}
              >
                ＋ 行を追加
              </button>
            )}
            <button
              onClick={async () => {
                setExporting(true)
                setError('')
                try {
                  await downloadCsv(name, query)
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'CSV の取得に失敗しました')
                } finally {
                  setExporting(false)
                }
              }}
              disabled={exporting || !table}
              className="px-3 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              title={query ? `「${query}」で絞り込んだ行を CSV に書き出す` : '全行を CSV に書き出す'}
            >
              {exporting ? '書き出し中...' : 'CSV 書き出し'}
            </button>
            <Link href="/data" className="text-sm text-gray-500 hover:text-gray-700">
              ← テーブル一覧
            </Link>
          </div>
        }
      />

      <form onSubmit={handleSearch} className="mb-4 flex items-center gap-2">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={
            table ? `検索: ${table.columns.filter((c) => c.searchable).map((c) => c.label).join(' / ')}` : '検索'
          }
          className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
        />
        <button
          type="submit"
          className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
          style={{ backgroundColor: '#06C755' }}
        >
          検索
        </button>
        {query && (
          <button
            type="button"
            onClick={() => { setQ(''); setQuery(''); load('0', '') }}
            className="px-3 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            解除
          </button>
        )}
      </form>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
        <span>
          {total} 件{query ? `（「${query}」で絞り込み）` : ''}
          {table?.allRows ? '・全件表示' : `・${offset + 1}〜${Math.min(offset + rows.length, total)} 件目`}
        </span>
        <span className={`flex items-center gap-2 ${table?.allRows ? 'hidden' : ''}`}>
          <button
            disabled={!prevCursor && offset === 0}
            onClick={() => load(prevCursor ?? '0', query)}
            className="px-2.5 py-1 font-medium text-gray-600 bg-white border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50"
          >
            前へ
          </button>
          <button
            disabled={!nextCursor}
            onClick={() => nextCursor && load(nextCursor, query)}
            className="px-2.5 py-1 font-medium text-gray-600 bg-white border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50"
          >
            次へ
          </button>
        </span>
      </div>

      {loading && !table ? (
        <div className="text-sm text-gray-400">読み込み中...</div>
      ) : table ? (
        // 見出しを固定するため、縦横ともこの枠の中でスクロールさせる
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-auto max-h-[calc(100vh-12rem)]">
          <table className="min-w-full text-sm border-separate border-spacing-0">
            <thead>
              <tr>
                <th
                  className="px-3 py-2 text-left text-xs font-semibold text-gray-500 whitespace-nowrap sticky top-0 left-0 z-30 bg-gray-50 border-b border-r border-gray-200"
                  title="_display_name（friends.display_name）"
                >
                  {table.displayNameLabel ?? 'LINE表示名'}
                </th>
                {cols.map((c) => (
                  <th
                    key={c.name}
                    className="px-3 py-2 text-left text-xs font-semibold text-gray-500 whitespace-nowrap sticky top-0 z-20 bg-gray-50 border-b border-gray-200"
                    title={c.featureKey ?? c.name}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={cols.length + 1} className="px-4 py-8 text-center text-gray-400">
                    行がありません
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={rowId(r, table)}
                    onClick={() => setEditing(r)}
                    className="cursor-pointer hover:bg-green-50 transition-colors group"
                  >
                    <td className="px-3 py-2 whitespace-nowrap max-w-xs truncate sticky left-0 z-10 bg-white group-hover:bg-green-50 border-b border-r border-gray-100">
                      <DisplayName row={r} />
                    </td>
                    {cols.map((c) => {
                      const v = shown(r[c.name], c.datetime)
                      const t = listCellText(table, r, c.name, v)
                      return (
                        <td
                          key={c.name}
                          className={`px-3 py-2 whitespace-nowrap max-w-xs truncate border-b border-gray-100 ${c.datetime ? 'text-gray-600' : 'text-gray-800'}`}
                          title={t.title}
                        >
                          {t.empty ? <span className="text-gray-300">{t.text}</span> : t.text}
                        </td>
                      )
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}

      {editing && table && (
        <RowEditor
          table={table}
          row={editing}
          onClose={closeEditor}
          onSaved={(updated) => {
            setEditing(updated)
            setRows((rs) => rs.map((r) => (rowId(r, table) === rowId(updated, table) ? updated : r)))
          }}
          onDeleted={(deletedId) => {
            setEditing(null)
            setRows((rs) => rs.filter((r) => rowId(r, table) !== deletedId))
            setTotal((t) => Math.max(0, t - 1))
            if (openId) router.replace(tableHref(name, query ? { q: query } : {}))
          }}
        />
      )}

      {adding && table && (
        <RowEditor
          table={table}
          row={Object.fromEntries(table.columns.map((c) => [c.name, '']))}
          mode="insert"
          onClose={() => setAdding(false)}
          onSaved={(created) => {
            setAdding(false)
            setRows((rs) => [created, ...rs])
            setTotal((t) => t + 1)
            setEditing({ ...created, [ROW_ID_COLUMN]: rowId(created, table) })
          }}
        />
      )}
    </div>
  )
}

export default function DataTablePage() {
  return (
    <Suspense fallback={<div className="p-8 text-gray-400">読み込み中...</div>}>
      <DataTableInner />
    </Suspense>
  )
}
