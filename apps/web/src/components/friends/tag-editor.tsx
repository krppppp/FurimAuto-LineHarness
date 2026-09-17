'use client'

import { useState } from 'react'
import type { Tag } from '@line-crm/shared'
import { api } from '@/lib/api'
import TagBadge from './tag-badge'

// FurimAuto fork: タグの付け外し（Capsec #308）。友だち管理の行の展開と、個別チャットの顧客パネルで共用する。
// 付け外しの変更履歴は API 側（friends.ts → furim/person-audit.ts）で残る
interface Props {
  friendId: string
  tags: Tag[]
  allTags: Tag[]
  onChanged: () => void
  onError: (message: string) => void
}

export default function TagEditor({ friendId, tags, allTags, onChanged, onError }: Props) {
  const [isAdding, setIsAdding] = useState(false)
  const [selectedTagId, setSelectedTagId] = useState('')
  const [loading, setLoading] = useState(false)
  const availableTags = allTags.filter((t) => !tags.some((ft) => ft.id === t.id))

  const handleAddTag = async () => {
    if (!selectedTagId) return
    setLoading(true)
    onError('')
    try {
      await api.friends.addTag(friendId, selectedTagId)
      setIsAdding(false)
      setSelectedTagId('')
      onChanged()
    } catch {
      onError('タグの追加に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveTag = async (tagId: string) => {
    setLoading(true)
    onError('')
    try {
      await api.friends.removeTag(friendId, tagId)
      onChanged()
    } catch {
      onError('タグの削除に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {tags.map((tag) => (
          <TagBadge
            key={tag.id}
            tag={tag}
            onRemove={() => handleRemoveTag(tag.id)}
          />
        ))}
      </div>

      {isAdding ? (
        <div className="flex items-center gap-2 flex-wrap">
          <select
            className="text-sm border border-gray-300 rounded-md px-2 py-1 max-w-full focus:outline-none focus:ring-2 focus:ring-green-500"
            value={selectedTagId}
            onChange={(e) => setSelectedTagId(e.target.value)}
          >
            <option value="">タグを選択...</option>
            {availableTags.map((tag) => (
              <option key={tag.id} value={tag.id}>{tag.name}</option>
            ))}
          </select>
          <button
            onClick={handleAddTag}
            disabled={!selectedTagId || loading}
            className="px-3 py-1 text-xs font-medium rounded-md text-white disabled:opacity-50 transition-opacity"
            style={{ backgroundColor: '#06C755' }}
          >
            追加
          </button>
          <button
            onClick={() => { setIsAdding(false); setSelectedTagId('') }}
            className="px-3 py-1 text-xs font-medium rounded-md text-gray-600 bg-gray-200 hover:bg-gray-300 transition-colors"
          >
            キャンセル
          </button>
        </div>
      ) : (
        availableTags.length > 0 && (
          <button
            onClick={() => setIsAdding(true)}
            className="text-xs font-medium text-green-600 hover:text-green-700 flex items-center gap-1 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            タグを追加
          </button>
        )
      )}
    </>
  )
}
