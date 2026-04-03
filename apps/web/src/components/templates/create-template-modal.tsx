'use client'

import { useState } from 'react'
import { api, type ApiTemplate } from '@/lib/api'

export const TEMPLATE_CATEGORIES = [
  { value: 'scenario', label: 'シナリオ配信' },
  { value: 'broadcast', label: '一斉配信' },
  { value: 'automation', label: 'オートメーション' },
] as const

interface Props {
  defaultCategories?: string[]
  onCreated: (template: ApiTemplate) => void
  onCancel: () => void
}

export default function CreateTemplateModal({ defaultCategories = [], onCreated, onCancel }: Props) {
  const [name, setName] = useState('')
  const [categories, setCategories] = useState<string[]>(defaultCategories)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const toggle = (val: string) => {
    setCategories((prev) =>
      prev.includes(val) ? prev.filter((c) => c !== val) : [...prev, val],
    )
  }

  const handleCreate = async () => {
    if (!name.trim()) { setError('テンプレート名を入力してください'); return }
    setSaving(true)
    setError('')
    try {
      const res = await api.templates.create({ name: name.trim(), categories })
      if (!res.success) { setError(res.error); return }
      onCreated(res.data)
    } catch {
      setError('作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900 text-sm">新規テンプレート</h2>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">テンプレート名 <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate() }}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-400"
              placeholder="例: ウェルカムメッセージセット"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-2">カテゴリ <span className="text-gray-400 font-normal">(複数選択可)</span></label>
            <div className="flex gap-2 flex-wrap">
              {TEMPLATE_CATEGORIES.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => toggle(value)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                    categories.includes(value)
                      ? 'bg-green-500 border-green-500 text-white'
                      : 'bg-white border-gray-300 text-gray-600 hover:border-green-400'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg"
          >
            キャンセル
          </button>
          <button
            onClick={() => void handleCreate()}
            disabled={saving || !name.trim()}
            className="px-4 py-2 text-sm text-white rounded-lg font-medium disabled:opacity-50 transition-opacity"
            style={{ backgroundColor: '#06C755' }}
          >
            {saving ? '作成中...' : '作成'}
          </button>
        </div>
      </div>
    </div>
  )
}
