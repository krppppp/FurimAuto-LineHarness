'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import Header from '@/components/layout/header'
import { fetchApi, getCsrfToken } from '@/lib/api'
import { DISPLAY_NAME_COLUMN, FRIEND_CREATED_AT_COLUMN, type AdminTableMeta } from '../types'

type Row = Record<string, unknown>

type ListResponse = {
  success: boolean
  error?: string
  data: Row[]
  meta: { table: AdminTableMeta; total: number; limit: number; cursor: string; nextCursor: string | null }
}

type RowResponse = { success: boolean; error?: string; data: Row; meta?: { changed?: string[] } }

type AuditRow = {
  id: string
  staff_name: string
  column_name: string
  old_value: string | null
  new_value: string | null
  created_at: string
}

type Identity = {
  line_user_id: string | null
  friend_id: string | null
  display_name: string | null
  stripe_customer_id: string | null
  key_code: string | null
}

type RelatedEntry = { table: AdminTableMeta; total: number; rows: Row[]; q: string }

type RelatedResponse = { success: boolean; error?: string; data: { identity: Identity; related: RelatedEntry[] } }

const LIMIT = 50

// fetchApi は 4xx を例外にして本文を捨てるので、PATCH のエラー文（列の型違い・UNIQUE 制約など）を出すために本文を読む
async function patchRow(path: string, changes: Record<string, string>): Promise<RowResponse> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
    body: JSON.stringify({ changes }),
  })
  return res.json() as Promise<RowResponse>
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : String(v)
}

function tableHref(name: string, params: Record<string, string>): string {
  const sp = new URLSearchParams({ name, ...params })
  return `/data/table?${sp.toString()}`
}

function friendCreatedAt(row: Row): string {
  return cell(row[FRIEND_CREATED_AT_COLUMN]).replace('T', ' ').slice(0, 19)
}

function DisplayName({ row }: { row: Row }) {
  const v = cell(row[DISPLAY_NAME_COLUMN])
  return v ? <span className="font-medium text-gray-900">{v}</span> : <span className="text-gray-300">—</span>
}

function RelatedPanel({ table, row }: { table: AdminTableMeta; row: Row }) {
  const id = cell(row[table.pk])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [related, setRelated] = useState<RelatedEntry[]>([])

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      setError('')
      try {
        const res = await fetchApi<RelatedResponse>(`/api/furim/admin/${table.name}/${encodeURIComponent(id)}/related`)
        if (!alive) return
        if (res.success) {
          setIdentity(res.data.identity)
          setRelated(res.data.related)
        } else {
          setError(res.error ?? '関連データの取得に失敗しました')
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : '関連データの取得に失敗しました')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [table.name, id])

  if (loading) return <div className="px-5 py-4 text-sm text-gray-400">読み込み中...</div>
  if (error) return <div className="m-5 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>

  const idEntries: Array<[string, string | null]> = identity
    ? [
        ['LINE 表示名', identity.display_name],
        ['line_user_id', identity.line_user_id],
        ['friend_id', identity.friend_id],
        ['stripe_customer_id', identity.stripe_customer_id],
        ['key_code', identity.key_code],
      ]
    : []
  const nonEmpty = related.filter((r) => r.total > 0)
  const empty = related.filter((r) => r.total === 0)

  return (
    <div className="px-5 py-4 space-y-5">
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">本人</div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {idEntries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-gray-500">{k}</dt>
              <dd className="break-all text-gray-800">{v ? v : <span className="text-gray-300">—</span>}</dd>
            </div>
          ))}
        </dl>
        {identity && !identity.line_user_id && (
          <div className="mt-2 text-xs text-gray-500">この行から LINE ユーザーを特定できませんでした</div>
        )}
      </div>

      {nonEmpty.length === 0 && <div className="text-sm text-gray-400">紐づくデータはありません</div>}

      {nonEmpty.map((r) => (
        <div key={r.table.name}>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-sm font-semibold text-gray-900">
              {r.table.label}
              <span className="ml-2 text-xs font-normal text-gray-500">{r.total} 件</span>
              <span className="ml-2 text-xs font-mono font-normal text-gray-400">{r.table.name}</span>
            </div>
            <Link href={tableHref(r.table.name, { q: r.q })} className="text-xs text-green-700 hover:underline">
              もっと見る →
            </Link>
          </div>
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-2 py-1.5 text-left font-semibold text-gray-500 whitespace-nowrap">LINE 表示名</th>
                  {r.table.columns.map((c) => (
                    <th key={c.name} className="px-2 py-1.5 text-left font-semibold text-gray-500 whitespace-nowrap font-mono">
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {r.rows.map((x) => {
                  const pk = cell(x[r.table.pk])
                  return (
                    <tr key={pk} className="hover:bg-green-50">
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <Link href={tableHref(r.table.name, { open: pk })} className="hover:underline">
                          <DisplayName row={x} />
                        </Link>
                      </td>
                      {r.table.columns.map((c) => {
                        const v = cell(x[c.name])
                        return (
                          <td key={c.name} className="px-2 py-1.5 whitespace-nowrap max-w-[16rem] truncate text-gray-800" title={v}>
                            {c.name === r.table.pk ? (
                              <Link href={tableHref(r.table.name, { open: pk })} className="font-mono text-green-700 hover:underline">
                                {v}
                              </Link>
                            ) : v === '' ? (
                              <span className="text-gray-300">—</span>
                            ) : (
                              v
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {r.total > r.rows.length && (
            <div className="mt-1 text-xs text-gray-400">最新 {r.rows.length} 件を表示。残りは「もっと見る」で</div>
          )}
        </div>
      ))}

      {empty.length > 0 && (
        <div className="text-xs text-gray-400">
          0 件: {empty.map((r) => r.table.label).join('・')}
        </div>
      )}
    </div>
  )
}

function RowEditor({
  table,
  row,
  onClose,
  onSaved,
}: {
  table: AdminTableMeta
  row: Row
  onClose: () => void
  onSaved: (row: Row) => void
}) {
  const id = cell(row[table.pk])
  const [tab, setTab] = useState<'edit' | 'related'>('edit')
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(table.columns.map((c) => [c.name, cell(row[c.name])])),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [audit, setAudit] = useState<AuditRow[]>([])

  const loadAudit = useCallback(async () => {
    try {
      const res = await fetchApi<{ success: boolean; data: AuditRow[] }>(
        `/api/furim/admin/${table.name}/${encodeURIComponent(id)}/audit`,
      )
      if (res.success) setAudit(res.data)
    } catch {
      /* 監査ログが取れなくても編集は続けられる */
    }
  }, [table.name, id])

  useEffect(() => {
    loadAudit()
  }, [loadAudit])

  const changes: Record<string, string> = {}
  for (const c of table.columns) {
    if (!c.editable) continue
    if (draft[c.name] !== cell(row[c.name])) changes[c.name] = draft[c.name]
  }
  const changedCount = Object.keys(changes).length
  const editable = table.columns.some((c) => c.editable)

  const handleSave = async () => {
    if (changedCount === 0) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const res = await patchRow(`/api/furim/admin/${table.name}/${encodeURIComponent(id)}`, changes)
      if (res.success) {
        setNotice(`保存しました（${(res.meta?.changed ?? []).join(', ') || '変更なし'}）`)
        onSaved({ ...res.data, [DISPLAY_NAME_COLUMN]: row[DISPLAY_NAME_COLUMN], [FRIEND_CREATED_AT_COLUMN]: row[FRIEND_CREATED_AT_COLUMN] })
        setDraft(Object.fromEntries(table.columns.map((c) => [c.name, cell(res.data[c.name])])))
        await loadAudit()
      } else {
        setError(res.error ?? '保存に失敗しました')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const displayName = cell(row[DISPLAY_NAME_COLUMN])

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
                {displayName ? `${displayName} ・ ` : ''}{table.label}
              </div>
              <div className="text-xs font-mono text-gray-500 break-all">{table.pk} = {id}</div>
            </div>
            <div className="flex items-center gap-2">
              {tab === 'edit' && editable && (
                <button
                  onClick={handleSave}
                  disabled={saving || changedCount === 0}
                  className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity hover:opacity-90"
                  style={{ backgroundColor: '#06C755' }}
                >
                  {saving ? '保存中...' : `保存${changedCount ? `（${changedCount}）` : ''}`}
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
              [
                ['edit', editable ? '編集' : '内容'],
                ['related', '関連データ'],
              ] as const
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
        ) : (
          <>
            <div className="px-5 py-4 space-y-3">
              {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
              {notice && <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-800 text-sm">{notice}</div>}
              {table.columns.map((c) => {
                const changed = c.editable && draft[c.name] !== cell(row[c.name])
                return (
                  <div key={c.name}>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      <span className="font-mono">{c.name}</span>
                      <span className="ml-2 text-gray-400">{c.type}{c.editable ? '' : '・読み取り専用'}</span>
                    </label>
                    <input
                      type="text"
                      value={draft[c.name] ?? ''}
                      readOnly={!c.editable}
                      onChange={(e) => setDraft((d) => ({ ...d, [c.name]: e.target.value }))}
                      className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 ${
                        c.editable
                          ? changed
                            ? 'border-yellow-400 bg-yellow-50'
                            : 'border-gray-300'
                          : 'border-gray-200 bg-gray-50 text-gray-500'
                      }`}
                    />
                  </div>
                )
              })}
            </div>

            <div className="border-t border-gray-200 px-5 py-4">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">変更履歴</div>
              {audit.length === 0 ? (
                <div className="text-xs text-gray-400">まだ変更はありません</div>
              ) : (
                <ul className="space-y-1.5 text-xs text-gray-700">
                  {audit.map((a) => (
                    <li key={a.id} className="flex flex-wrap gap-x-2">
                      <span className="text-gray-400">{a.created_at.replace('T', ' ').slice(0, 19)}</span>
                      <span>{a.staff_name}</span>
                      <span className="font-mono">{a.column_name}</span>
                      <span className="text-gray-400 line-through break-all">{a.old_value ?? '(空)'}</span>
                      <span className="break-all">→ {a.new_value ?? '(空)'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
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

  return (
    <div>
      <Header
        title={table ? `${table.label}` : name}
        description={
          table
            ? `${table.name}・主キー ${table.pk}・行をクリックで開く${table.allRows ? '・全件 1 ページ（友だち登録の新しい順）' : ''}`
            : undefined
        }
        action={
          <Link href="/data" className="text-sm text-gray-500 hover:text-gray-700">
            ← テーブル一覧
          </Link>
        }
      />

      <form onSubmit={handleSearch} className="mb-4 flex items-center gap-2">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={
            table ? `検索: ${table.columns.filter((c) => c.searchable).map((c) => c.name).join(' / ')}` : '検索'
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
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 whitespace-nowrap sticky left-0 bg-gray-50" title="friends.display_name">
                  LINE 表示名
                </th>
                {table.joinFriends && (
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 whitespace-nowrap" title="friends.created_at">
                    友だち登録日時
                  </th>
                )}
                {table.columns.map((c) => (
                  <th
                    key={c.name}
                    className="px-3 py-2 text-left text-xs font-semibold text-gray-500 whitespace-nowrap font-mono"
                    title={c.editable ? '編集可' : '読み取り専用'}
                  >
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={table.columns.length + (table.joinFriends ? 2 : 1)} className="px-4 py-8 text-center text-gray-400">
                    行がありません
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={cell(r[table.pk])}
                    onClick={() => setEditing(r)}
                    className="cursor-pointer hover:bg-green-50 transition-colors group"
                  >
                    <td className="px-3 py-2 whitespace-nowrap max-w-xs truncate sticky left-0 bg-white group-hover:bg-green-50">
                      <DisplayName row={r} />
                    </td>
                    {table.joinFriends && (
                      <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                        {friendCreatedAt(r) || <span className="text-gray-300">—</span>}
                      </td>
                    )}
                    {table.columns.map((c) => {
                      const v = cell(r[c.name])
                      return (
                        <td key={c.name} className="px-3 py-2 whitespace-nowrap max-w-xs truncate text-gray-800" title={v}>
                          {v === '' ? <span className="text-gray-300">—</span> : v}
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
            setRows((rs) => rs.map((r) => (cell(r[table.pk]) === cell(updated[table.pk]) ? updated : r)))
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
