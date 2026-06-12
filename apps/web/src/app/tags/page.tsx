'use client'

import { useEffect, useState } from 'react'
import type { Tag } from '@line-crm/shared'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import { getTagTiming } from '@/components/furim/tag-timing'

const PRESET_COLORS = [
  '#22C55E', '#6366F1', '#3B82F6', '#F59E0B',
  '#EC4899', '#EF4444', '#F97316', '#6B7280',
]

export default function TagsPage() {
  const [tags, setTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [color, setColor] = useState(PRESET_COLORS[0])
  const [creating, setCreating] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.tags.list()
      if (res.success) {
        setTags([...res.data].sort((a, b) => a.name.localeCompare(b.name, 'ja')))
      } else {
        setError('タグの取得に失敗しました')
      }
    } catch {
      setError('タグの取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setCreating(true)
    setError('')
    try {
      const res = await api.tags.create({ name: name.trim(), color })
      if (res.success) {
        setName('')
        await load()
      } else {
        setError('タグの作成に失敗しました（同名タグが既にある可能性）')
      }
    } catch {
      setError('タグの作成に失敗しました')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (tag: Tag) => {
    if (!confirm(`タグ「${tag.name}」を削除しますか？\n友だちに付与済みの場合、その関連も外れます。`)) return
    setDeletingId(tag.id)
    setError('')
    try {
      const res = await api.tags.delete(tag.id)
      if (res.success) {
        await load()
      } else {
        setError('タグの削除に失敗しました')
      }
    } catch {
      setError('タグの削除に失敗しました')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div>
      <Header
        title="タグ管理"
        description="タグの一覧・新規追加・削除。各タグにカーソルを乗せると付与タイミングが表示されます。"
      />

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {/* 新規追加 */}
      <form
        onSubmit={handleCreate}
        className="mb-6 p-4 bg-white border border-gray-200 rounded-lg flex flex-wrap items-end gap-3"
      >
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-gray-500 mb-1">タグ名</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="新しいタグ名"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">色</label>
          <div className="flex items-center gap-2">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={c}
                className={`w-6 h-6 rounded-full border-2 ${color === c ? 'border-gray-900' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
              />
            ))}
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-8 h-8 p-0 border border-gray-300 rounded cursor-pointer"
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={creating || !name.trim()}
          className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50"
          style={{ backgroundColor: '#06C755' }}
        >
          {creating ? '追加中...' : '+ タグを追加'}
        </button>
      </form>

      {/* 一覧 */}
      {loading ? (
        <div className="text-sm text-gray-500">読み込み中...</div>
      ) : tags.length === 0 ? (
        <div className="p-6 text-center text-sm text-gray-500 bg-white border border-gray-200 rounded-lg">
          タグがありません。上のフォームから追加してください。
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          <div className="px-4 py-2 text-xs font-medium text-gray-500">
            全 {tags.length} 件
          </div>
          {tags.map((tag) => {
            const timing = getTagTiming(tag.name)
            return (
              <div key={tag.id} className="px-4 py-3 flex items-center gap-3 hover:bg-gray-50">
                {/* タグチップ + ホバーツールチップ */}
                <div className="relative group">
                  <span
                    className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium text-white cursor-help"
                    style={{ backgroundColor: tag.color }}
                  >
                    {tag.name}
                  </span>
                  {/* ツールチップ */}
                  <div className="pointer-events-none absolute left-0 top-full z-10 mt-2 hidden w-72 rounded-lg bg-gray-900 p-3 text-xs text-white shadow-lg group-hover:block">
                    {timing.category && (
                      <div className="mb-1 font-semibold text-gray-300">
                        {timing.category}
                      </div>
                    )}
                    <div className="mb-1">
                      <span className="text-green-300">付与:</span> {timing.assign}
                    </div>
                    {timing.remove && (
                      <div>
                        <span className="text-red-300">削除:</span> {timing.remove}
                      </div>
                    )}
                  </div>
                </div>

                <span className="text-xs text-gray-400 font-mono">{tag.color}</span>

                <div className="ml-auto">
                  <button
                    onClick={() => handleDelete(tag)}
                    disabled={deletingId === tag.id}
                    className="px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50"
                  >
                    {deletingId === tag.id ? '削除中...' : '削除'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
