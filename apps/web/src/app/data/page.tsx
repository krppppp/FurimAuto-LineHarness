'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { fetchApi } from '@/lib/api'
import type { ApiResponse } from '@line-crm/shared'

import type { AdminTableMeta } from './types'

export default function DataIndexPage() {
  const [tables, setTables] = useState<AdminTableMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        const res = await fetchApi<ApiResponse<AdminTableMeta[]>>('/api/furim/admin/tables')
        if (res.success) setTables(res.data)
        else setError(res.error ?? 'テーブル一覧の取得に失敗しました')
      } catch {
        setError('テーブル一覧の取得に失敗しました')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  return (
    <div>
      <Header title="データ" description="D1 の FurimAuto テーブルを直接見て直す（スプレッドシートの代わり）" />
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}
      <Link
        href="/data/masters"
        className="mb-4 block p-5 bg-white border border-green-300 rounded-lg shadow-sm hover:border-green-500 hover:shadow transition-colors"
      >
        <div className="text-base font-semibold text-gray-900">マスタ編集（機能・パッケージ・プラン一覧・チケット単価）</div>
        <div className="mt-1 text-xs text-gray-500">項目ごとに入力して直す。スプレッドシートのマスタは凍結（編集しても反映されません）</div>
      </Link>
      {loading ? (
        <div className="text-sm text-gray-400">読み込み中...</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tables.map((t) => (
            <Link
              key={t.name}
              href={`/data/table?name=${encodeURIComponent(t.name)}`}
              className="block p-5 bg-white border border-gray-200 rounded-lg shadow-sm hover:border-green-400 hover:shadow transition-colors"
            >
              <div className="text-base font-semibold text-gray-900">{t.label}</div>
              <div className="mt-1 text-xs font-mono text-gray-500">{t.name}</div>
              <div className="mt-3 text-xs text-gray-500">
                {t.columns.length} 列（編集可 {t.columns.filter((c) => c.editable).length}）・主キー {t.pk}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
