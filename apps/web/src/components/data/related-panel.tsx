'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { fetchApi } from '@/lib/api'
import {
  DISPLAY_NAME_COLUMN,
  listCellText,
  listColumnsOf,
  rowId,
  type AdminTableMeta,
} from '@/app/data/types'
import { shown, tableHref, type Row } from './admin-client'
import DisplayName from './display-name'

// 顧客DB の行ドロワーの「関連データ」と、個別チャットの顧客パネルで共用（Capsec #253・#308）

type Identity = {
  line_user_id: string | null
  friend_id: string | null
  display_name: string | null
  stripe_customer_id: string | null
  key_code: string | null
}

type RelatedEntry = { table: AdminTableMeta; total: number; rows: Row[]; q: string }

type RelatedResponse = { success: boolean; error?: string; data: { identity: Identity; related: RelatedEntry[] } }

export default function RelatedPanel({ table, row, compact = false }: { table: AdminTableMeta; row: Row; compact?: boolean }) {
  const id = rowId(row, table)
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

  if (loading) return <div className={`${compact ? 'py-2' : 'px-5 py-4'} text-sm text-gray-400`}>読み込み中...</div>
  if (error) return <div className={`${compact ? 'my-2' : 'm-5'} p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm`}>{error}</div>

  const idEntries: Array<[string, string, string | null]> = identity
    ? [
        ['LINE表示名', 'display_name', identity.display_name],
        ['LINEユーザーID', 'line_user_id', identity.line_user_id],
        ['Stripe顧客ID', 'stripe_customer_id', identity.stripe_customer_id],
        ['キーコード', 'key_code', identity.key_code],
      ]
    : []
  const nonEmpty = related.filter((r) => r.total > 0)
  const empty = related.filter((r) => r.total === 0)

  return (
    <div className={compact ? 'py-2 space-y-5' : 'px-5 py-4 space-y-5'}>
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">本人</div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {idEntries.map(([label, name, v]) => (
            <div key={name} className="contents">
              <dt className="text-gray-500" title={name}>{label}</dt>
              <dd className="break-all text-gray-800">{v ? v : <span className="text-gray-300">—</span>}</dd>
            </div>
          ))}
        </dl>
        {identity && !identity.line_user_id && (
          <div className="mt-2 text-xs text-gray-500">この行から LINE ユーザーを特定できませんでした</div>
        )}
      </div>

      {nonEmpty.length === 0 && <div className="text-sm text-gray-400">紐づくデータはありません</div>}

      {nonEmpty.map((r) => {
        const cols = listColumnsOf(r.table)
        return (
          <div key={r.table.name}>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-sm font-semibold text-gray-900" title={r.table.name}>
                {r.table.label}
                <span className="ml-2 text-xs font-normal text-gray-500">{r.total} 件</span>
              </div>
              <Link href={tableHref(r.table.name, { q: r.q })} className="text-xs text-green-700 hover:underline">
                もっと見る →
              </Link>
            </div>
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-2 py-1.5 text-left font-semibold text-gray-500 whitespace-nowrap" title={DISPLAY_NAME_COLUMN}>
                      {r.table.displayNameLabel ?? 'LINE表示名'}
                    </th>
                    {cols.map((c) => (
                      <th key={c.name} className="px-2 py-1.5 text-left font-semibold text-gray-500 whitespace-nowrap" title={c.name}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {r.rows.map((x) => {
                    const pk = rowId(x, r.table)
                    return (
                      <tr key={pk} className="hover:bg-green-50">
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          <Link href={tableHref(r.table.name, { open: pk })} className="hover:underline">
                            <DisplayName row={x} />
                          </Link>
                        </td>
                        {cols.map((c) => {
                          const v = shown(x[c.name], c.datetime)
                          const t = listCellText(r.table, x, c.name, v)
                          const linked = c.name === r.table.timeColumn || r.table.pkColumns.includes(c.name)
                          return (
                            <td key={c.name} className="px-2 py-1.5 whitespace-nowrap max-w-[16rem] truncate text-gray-800" title={t.title}>
                              {linked ? (
                                <Link href={tableHref(r.table.name, { open: pk })} className="text-green-700 hover:underline">
                                  {v === '' ? '—' : v}
                                </Link>
                              ) : t.empty ? (
                                <span className="text-gray-300">{t.text}</span>
                              ) : (
                                t.text
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
        )
      })}

      {empty.length > 0 && (
        <div className="text-xs text-gray-400">
          0 件: {empty.map((r) => r.table.label).join('・')}
        </div>
      )}
    </div>
  )
}
