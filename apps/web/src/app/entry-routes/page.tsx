'use client'

import { useState, useEffect, useCallback } from 'react'
import Header from '@/components/layout/header'
import { fetchApi } from '@/lib/api'
import type { EntryRouteItem } from '@/lib/api'
import type { ApiResponse } from '@line-crm/shared'

const WORKER_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787'

interface Tag { id: string; name: string }
interface Scenario { id: string; name: string }

const emptyForm = {
  refCode: '',
  name: '',
  tagId: '',
  scenarioId: '',
  redirectUrl: '',
  isActive: true,
}

export default function EntryRoutesPage() {
  const [items, setItems] = useState<EntryRouteItem[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const [copiedId, setCopiedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [routesRes, tagsRes, scenariosRes] = await Promise.all([
        fetchApi<ApiResponse<EntryRouteItem[]>>('/api/entry-routes'),
        fetchApi<ApiResponse<Tag[]>>('/api/tags'),
        fetchApi<ApiResponse<Scenario[]>>('/api/scenarios'),
      ])
      if (routesRes.success) setItems(routesRes.data)
      else setError('流入経路の読み込みに失敗しました')
      if (tagsRes.success) setTags(tagsRes.data)
      if (scenariosRes.success) setScenarios(scenariosRes.data)
    } catch {
      setError('データの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const openCreate = () => {
    setEditingId(null)
    setForm(emptyForm)
    setFormError('')
    setShowForm(true)
  }

  const openEdit = (item: EntryRouteItem) => {
    setEditingId(item.id)
    setForm({
      refCode: item.refCode,
      name: item.name,
      tagId: item.tagId || '',
      scenarioId: item.scenarioId || '',
      redirectUrl: item.redirectUrl || '',
      isActive: item.isActive,
    })
    setFormError('')
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!form.refCode.trim() || !form.name.trim()) {
      setFormError('refコードと経路名は必須です')
      return
    }
    setSaving(true)
    setFormError('')
    try {
      const payload = {
        refCode: form.refCode.trim(),
        name: form.name.trim(),
        tagId: form.tagId || null,
        scenarioId: form.scenarioId || null,
        redirectUrl: form.redirectUrl.trim() || null,
        isActive: form.isActive,
      }
      if (editingId) {
        await fetchApi<ApiResponse<EntryRouteItem>>(`/api/entry-routes/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        })
      } else {
        await fetchApi<ApiResponse<EntryRouteItem>>('/api/entry-routes', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
      }
      setShowForm(false)
      await load()
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('この流入経路を削除しますか？')) return
    try {
      await fetchApi<ApiResponse<null>>(`/api/entry-routes/${id}`, { method: 'DELETE' })
      await load()
    } catch {
      alert('削除に失敗しました')
    }
  }

  const handleCopy = async (refCode: string, id: string) => {
    const url = `${WORKER_BASE}/auth/line?ref=${encodeURIComponent(refCode)}`
    await navigator.clipboard.writeText(url)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const tagName = (id: string | null) => tags.find((t) => t.id === id)?.name || '—'
  const scenarioName = (id: string | null) => scenarios.find((s) => s.id === id)?.name || '—'

  return (
    <div>
      <Header
        title="流入経路設定"
        description="ref コードと タグ・シナリオ の紐付けを管理します"
      />

      <div className="mb-4 flex justify-end">
        <button
          onClick={openCreate}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
        >
          + 新規作成
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          読み込み中...
        </div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          まだ流入経路が登録されていません
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
          <table className="w-full min-w-[700px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">refコード</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">経路名</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">タグ</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">シナリオ</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">状態</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">URL</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {items.map((item) => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-mono text-blue-600">{item.refCode}</td>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">{item.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{tagName(item.tagId)}</td>
                  <td className="px-4 py-3 text-sm text-gray-600 max-w-[180px] truncate">{scenarioName(item.scenarioId)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${item.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {item.isActive ? '有効' : '無効'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400 truncate max-w-[160px]">
                        {WORKER_BASE}/auth/line?ref={item.refCode}
                      </span>
                      <button
                        onClick={() => handleCopy(item.refCode, item.id)}
                        className="text-xs text-blue-500 hover:text-blue-700 shrink-0"
                      >
                        {copiedId === item.id ? 'コピー済' : 'コピー'}
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => openEdit(item)}
                        className="text-xs text-gray-500 hover:text-gray-700"
                      >
                        編集
                      </button>
                      <button
                        onClick={() => handleDelete(item.id)}
                        className="text-xs text-red-500 hover:text-red-700"
                      >
                        削除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* フォームモーダル */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">
              {editingId ? '流入経路を編集' : '流入経路を作成'}
            </h2>

            {formError && (
              <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
                {formError}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">refコード *</label>
                <input
                  type="text"
                  value={form.refCode}
                  onChange={(e) => setForm({ ...form, refCode: e.target.value })}
                  placeholder="例: lp_instagram"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">経路名 *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="例: Instagram広告 LP"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">自動付与タグ</label>
                <select
                  value={form.tagId}
                  onChange={(e) => setForm({ ...form, tagId: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">— なし —</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">自動登録シナリオ</label>
                <select
                  value={form.scenarioId}
                  onChange={(e) => setForm({ ...form, scenarioId: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">— なし —</option>
                  {scenarios.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">リダイレクト先URL</label>
                <input
                  type="text"
                  value={form.redirectUrl}
                  onChange={(e) => setForm({ ...form, redirectUrl: e.target.value })}
                  placeholder="https://..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  className="rounded"
                />
                <label htmlFor="isActive" className="text-sm text-gray-700">有効</label>
              </div>
            </div>

            <div className="flex gap-3 mt-5">
              <button
                onClick={() => setShowForm(false)}
                className="flex-1 px-4 py-2 border border-gray-300 text-sm font-medium rounded-lg text-gray-700 hover:bg-gray-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
