'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { ApiTemplateMessage, ApiMessage, ApiTemplate } from '@/lib/api'
import Header from '@/components/layout/header'
import CreateTemplateModal, { TEMPLATE_CATEGORIES } from '@/components/templates/create-template-modal'

// ── 型 ────────────────────────────────────────────────────────────────────────

const typeLabel: Record<string, string> = { text: 'テキスト', image: '画像', flex: 'Flex', video: '動画' }
const typeBadge: Record<string, string> = {
  text: 'bg-gray-100 text-gray-600',
  image: 'bg-blue-100 text-blue-700',
  flex: 'bg-purple-100 text-purple-700',
  video: 'bg-red-100 text-red-700',
}

const categoryLabel: Record<string, string> = {
  scenario: 'シナリオ',
  broadcast: '一斉配信',
  automation: 'オートメーション',
}
const categoryBadge: Record<string, string> = {
  scenario: 'bg-green-100 text-green-700',
  broadcast: 'bg-blue-100 text-blue-700',
  automation: 'bg-orange-100 text-orange-700',
}

// ── メッセージプレビュー ───────────────────────────────────────────────────────

function MessagePreview({ m }: { m: Omit<ApiMessage, 'createdAt' | 'updatedAt'> }) {
  if (m.messageType === 'text') {
    const firstLine = m.content.split('\n')[0]
    const rest = m.content.length - firstLine.length
    return (
      <div className="text-xs text-gray-700 leading-relaxed">
        <p className="truncate">{firstLine}</p>
        {rest > 0 && <p className="text-gray-400">…他 {m.content.split('\n').length - 1} 行</p>}
      </div>
    )
  }
  if (m.messageType === 'image') {
    try {
      const parsed = JSON.parse(m.content) as { originalContentUrl?: string; previewImageUrl?: string }
      const url = parsed.previewImageUrl ?? parsed.originalContentUrl
      if (url) return <img src={url} alt="" className="w-full max-h-24 object-cover rounded" />
    } catch { /* ignore */ }
    return <p className="text-xs text-gray-400">画像 (プレビューなし)</p>
  }
  if (m.messageType === 'flex') {
    return (
      <div className="flex items-center gap-1.5">
        <div className="w-5 h-5 rounded bg-purple-100 flex items-center justify-center shrink-0">
          <span className="text-[9px] font-bold text-purple-600">F</span>
        </div>
        <p className="text-xs text-gray-600 truncate">{m.altText ?? m.label ?? 'Flex Message'}</p>
      </div>
    )
  }
  if (m.messageType === 'video') {
    try {
      const parsed = JSON.parse(m.content) as { previewImageUrl?: string }
      if (parsed.previewImageUrl) {
        return (
          <div className="relative">
            <img src={parsed.previewImageUrl} alt="" className="w-full max-h-20 object-cover rounded" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-7 h-7 bg-black/60 rounded-full flex items-center justify-center">
                <span className="text-white text-xs ml-0.5">▶</span>
              </div>
            </div>
          </div>
        )
      }
    } catch { /* ignore */ }
    return <p className="text-xs text-gray-400">動画</p>
  }
  return <p className="text-xs text-gray-400 truncate">{m.content.slice(0, 50)}</p>
}

// ── テンプレートカード ─────────────────────────────────────────────────────────

function TemplateCard({ template, messages, onClick }: { template: ApiTemplate; messages: ApiTemplateMessage[]; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-left bg-white border border-gray-200 rounded-xl overflow-hidden hover:border-green-400 hover:shadow-md transition-all group"
    >
      <div className="px-4 py-3 border-b border-gray-100">
        <p className="text-sm font-semibold text-gray-900 leading-tight line-clamp-2">{template.name}</p>
        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
          {(template.categories ?? []).length > 0
            ? (template.categories ?? []).map((cat) => (
                <span key={cat} className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${categoryBadge[cat] ?? 'bg-gray-100 text-gray-500'}`}>
                  {categoryLabel[cat] ?? cat}
                </span>
              ))
            : <span className="text-[10px] text-gray-300">未分類</span>
          }
          <span className="text-[10px] text-gray-400 ml-auto">{messages.length}通</span>
        </div>
      </div>

      <div className="px-4 py-3 space-y-2 min-h-[80px]">
        {messages.length === 0 ? (
          <p className="text-xs text-gray-300 text-center py-3">メッセージなし</p>
        ) : (
          messages.slice(0, 5).map((tm, idx) => (
            <div key={tm.id} className="flex items-start gap-2">
              <span className="text-[10px] font-mono text-gray-300 mt-0.5 shrink-0 w-3">{idx + 1}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1 mb-0.5">
                  <span className={`text-[9px] font-semibold px-1 py-0.5 rounded ${typeBadge[tm.message.messageType] ?? 'bg-gray-100 text-gray-600'}`}>
                    {typeLabel[tm.message.messageType] ?? tm.message.messageType}
                  </span>
                  {tm.message.label && <span className="text-[10px] text-gray-400 truncate">{tm.message.label}</span>}
                </div>
                <MessagePreview m={tm.message} />
              </div>
            </div>
          ))
        )}
      </div>

      <div className="px-4 py-2 border-t border-gray-50 text-right">
        <span className="text-[10px] text-green-600 opacity-0 group-hover:opacity-100 transition-opacity">詳細・編集 →</span>
      </div>
    </button>
  )
}

// ── メッセージ編集フォーム ────────────────────────────────────────────────────

const MSG_TYPES = ['text', 'image', 'flex', 'video'] as const
type MsgType = typeof MSG_TYPES[number]

interface MsgFormState {
  messageType: MsgType
  content: string
  altText: string
  label: string
  tags: string
}
const defaultMsgForm: MsgFormState = { messageType: 'text', content: '', altText: '', label: '', tags: '' }

// ── テンプレート詳細モーダル ───────────────────────────────────────────────────

interface DetailModalProps {
  template: ApiTemplate
  onClose: () => void
  onUpdated: () => void
}

function DetailModal({ template, onClose, onUpdated }: DetailModalProps) {
  const [messages, setMessages] = useState<ApiTemplateMessage[]>([])
  const [loadingMsgs, setLoadingMsgs] = useState(true)
  const [showMsgForm, setShowMsgForm] = useState(false)
  const [msgForm, setMsgForm] = useState<MsgFormState>(defaultMsgForm)
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null)
  const [savingMsg, setSavingMsg] = useState(false)
  const [msgError, setMsgError] = useState('')

  const [editingName, setEditingName] = useState(false)
  const [nameVal, setNameVal] = useState(template.name)
  const [savingName, setSavingName] = useState(false)

  const [editingCats, setEditingCats] = useState(false)
  const [catsVal, setCatsVal] = useState<string[]>(template.categories ?? [])
  const [savingCats, setSavingCats] = useState(false)

  const loadMessages = useCallback(async () => {
    setLoadingMsgs(true)
    try {
      const res = await api.templates.getMessages(template.id)
      if (res.success) setMessages(res.data)
    } finally {
      setLoadingMsgs(false)
    }
  }, [template.id])

  useEffect(() => { void loadMessages() }, [loadMessages])

  const openAddMsg = () => {
    setEditingMsgId(null)
    setMsgForm(defaultMsgForm)
    setMsgError('')
    setShowMsgForm(true)
  }

  const openEditMsg = (tm: ApiTemplateMessage) => {
    setEditingMsgId(tm.message.id)
    setMsgForm({
      messageType: tm.message.messageType as MsgType,
      content: tm.message.content,
      altText: tm.message.altText ?? '',
      label: tm.message.label ?? '',
      tags: tm.message.tags.join(', '),
    })
    setMsgError('')
    setShowMsgForm(true)
  }

  const handleSaveMsg = async () => {
    if (!msgForm.content.trim()) { setMsgError('内容を入力してください'); return }
    setSavingMsg(true)
    setMsgError('')
    try {
      const tags = msgForm.tags.split(',').map((t) => t.trim()).filter(Boolean)
      const payload = {
        messageType: msgForm.messageType,
        content: msgForm.content,
        altText: msgForm.altText || null,
        label: msgForm.label || null,
        tags,
      }
      if (editingMsgId) {
        await api.messages.update(editingMsgId, payload)
      } else {
        const res = await api.messages.create(payload)
        if (!res.success) { setMsgError('メッセージ作成に失敗しました'); return }
        await api.templates.addMessage(template.id, {
          messageId: res.data.id,
          stepOrder: messages.length,
        })
      }
      setShowMsgForm(false)
      await loadMessages()
      onUpdated()
    } catch (e) {
      setMsgError(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSavingMsg(false)
    }
  }

  const handleRemoveMsg = async (tm: ApiTemplateMessage) => {
    if (!confirm('このメッセージをテンプレートから削除しますか？')) return
    await api.templates.removeMessage(template.id, tm.message.id)
    await loadMessages()
    onUpdated()
  }

  const handleSaveName = async () => {
    if (!nameVal.trim()) return
    setSavingName(true)
    try {
      await api.templates.update(template.id, { name: nameVal.trim() })
      setEditingName(false)
      onUpdated()
    } finally {
      setSavingName(false)
    }
  }

  const handleSaveCats = async () => {
    setSavingCats(true)
    try {
      await api.templates.update(template.id, { categories: catsVal })
      setEditingCats(false)
      onUpdated()
    } finally {
      setSavingCats(false)
    }
  }

  const toggleCat = (val: string) => {
    setCatsVal((prev) => prev.includes(val) ? prev.filter((c) => c !== val) : [...prev, val])
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="px-5 py-4 border-b border-gray-200 flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={nameVal}
                  onChange={(e) => setNameVal(e.target.value)}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-400"
                  autoFocus
                />
                <button onClick={() => void handleSaveName()} disabled={savingName} className="px-3 py-1.5 text-xs text-white bg-green-500 rounded-lg disabled:opacity-50">
                  {savingName ? '...' : '保存'}
                </button>
                <button onClick={() => { setEditingName(false); setNameVal(template.name) }} className="px-3 py-1.5 text-xs text-gray-500 bg-gray-100 rounded-lg">キャンセル</button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-gray-900 truncate">{nameVal}</h2>
                <button onClick={() => setEditingName(true)} className="text-xs text-gray-400 hover:text-gray-600 shrink-0">編集</button>
              </div>
            )}

            {/* カテゴリ */}
            {editingCats ? (
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                {TEMPLATE_CATEGORIES.map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => toggleCat(value)}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-full border transition-colors ${
                      catsVal.includes(value)
                        ? 'bg-green-500 border-green-500 text-white'
                        : 'bg-white border-gray-300 text-gray-600'
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <button onClick={() => void handleSaveCats()} disabled={savingCats} className="px-2.5 py-1 text-[11px] text-white bg-green-500 rounded-full disabled:opacity-50">保存</button>
                <button onClick={() => { setEditingCats(false); setCatsVal(template.categories ?? []) }} className="px-2.5 py-1 text-[11px] text-gray-500 bg-gray-100 rounded-full">×</button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                {catsVal.length > 0
                  ? catsVal.map((cat) => (
                      <span key={cat} className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${categoryBadge[cat] ?? 'bg-gray-100 text-gray-500'}`}>
                        {categoryLabel[cat] ?? cat}
                      </span>
                    ))
                  : <span className="text-[10px] text-gray-300">未分類</span>
                }
                <button onClick={() => setEditingCats(true)} className="text-[10px] text-gray-400 hover:text-gray-600 ml-1">編集</button>
                <span className="text-[10px] text-gray-400 ml-auto">{messages.length}通</span>
              </div>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none shrink-0">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loadingMsgs ? (
            <p className="text-sm text-gray-400 text-center py-8">読み込み中...</p>
          ) : (
            <div className="space-y-3">
              {messages.map((tm, idx) => (
                <div key={tm.id} className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-100">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-gray-400">{idx + 1}</span>
                      <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${typeBadge[tm.message.messageType] ?? ''}`}>
                        {typeLabel[tm.message.messageType] ?? tm.message.messageType}
                      </span>
                      {tm.message.label && <span className="text-xs text-gray-500 italic">{tm.message.label}</span>}
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => openEditMsg(tm)} className="text-xs text-blue-600 hover:text-blue-800 px-2 py-1 rounded hover:bg-blue-50">編集</button>
                      <button onClick={() => void handleRemoveMsg(tm)} className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50">削除</button>
                    </div>
                  </div>
                  <div className="px-3 py-3">
                    {tm.message.messageType === 'text' ? (
                      <pre className="text-sm text-gray-700 whitespace-pre-wrap break-words font-sans">{tm.message.content}</pre>
                    ) : tm.message.messageType === 'image' ? (
                      (() => {
                        try {
                          const p = JSON.parse(tm.message.content) as { originalContentUrl?: string; previewImageUrl?: string }
                          const url = p.previewImageUrl ?? p.originalContentUrl
                          return url ? <img src={url} alt="" className="max-h-40 rounded object-contain" /> : <p className="text-xs text-gray-400">画像URL: {tm.message.content.slice(0, 80)}</p>
                        } catch { return <p className="text-xs text-gray-500 font-mono break-all">{tm.message.content.slice(0, 100)}</p> }
                      })()
                    ) : tm.message.messageType === 'flex' ? (
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <div className="w-5 h-5 rounded bg-purple-100 flex items-center justify-center"><span className="text-[9px] font-bold text-purple-600">F</span></div>
                          <span className="text-xs text-gray-500">{tm.message.altText ?? 'Flex Message'}</span>
                        </div>
                        <pre className="text-[10px] text-gray-400 bg-gray-50 rounded p-2 max-h-24 overflow-auto font-mono">{tm.message.content.slice(0, 200)}{tm.message.content.length > 200 ? '...' : ''}</pre>
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500 font-mono break-all">{tm.message.content.slice(0, 100)}</p>
                    )}
                  </div>
                </div>
              ))}

              {messages.length < 5 && !showMsgForm && (
                <button
                  onClick={openAddMsg}
                  className="w-full border-2 border-dashed border-gray-300 rounded-lg py-3 text-sm text-gray-400 hover:border-green-400 hover:text-green-600 transition-colors"
                >
                  + メッセージを追加 ({messages.length}/5)
                </button>
              )}
            </div>
          )}

          {showMsgForm && (
            <div className="mt-4 border border-green-200 bg-green-50 rounded-lg p-4 space-y-3">
              <h4 className="text-sm font-semibold text-green-800">{editingMsgId ? 'メッセージ編集' : 'メッセージ追加'}</h4>
              {msgError && <p className="text-xs text-red-500">{msgError}</p>}

              <div>
                <label className="text-xs font-medium text-gray-700 block mb-1">タイプ</label>
                <select
                  value={msgForm.messageType}
                  onChange={(e) => setMsgForm((f) => ({ ...f, messageType: e.target.value as MsgType }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-400"
                >
                  {MSG_TYPES.map((t) => <option key={t} value={t}>{typeLabel[t]}</option>)}
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-700 block mb-1">ラベル <span className="text-gray-400 font-normal">(任意)</span></label>
                <input type="text" value={msgForm.label} onChange={(e) => setMsgForm((f) => ({ ...f, label: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-400" placeholder="例: ウェルカム1通目" />
              </div>

              <div>
                <label className="text-xs font-medium text-gray-700 block mb-1">
                  内容
                  {msgForm.messageType === 'image' && ' (JSON: {"originalContentUrl":"...","previewImageUrl":"..."})'}
                  {msgForm.messageType === 'flex' && ' (Flex Message JSON)'}
                </label>
                <textarea
                  value={msgForm.content}
                  onChange={(e) => setMsgForm((f) => ({ ...f, content: e.target.value }))}
                  rows={msgForm.messageType === 'text' ? 4 : 6}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-400 resize-y"
                  placeholder={msgForm.messageType === 'text' ? 'メッセージ本文' : msgForm.messageType === 'flex' ? '{"type":"bubble","body":{...}}' : '{"originalContentUrl":"https://...","previewImageUrl":"https://..."}'}
                />
              </div>

              {(msgForm.messageType === 'flex' || msgForm.messageType === 'video') && (
                <div>
                  <label className="text-xs font-medium text-gray-700 block mb-1">Alt テキスト</label>
                  <input type="text" value={msgForm.altText} onChange={(e) => setMsgForm((f) => ({ ...f, altText: e.target.value }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-400" />
                </div>
              )}

              <div>
                <label className="text-xs font-medium text-gray-700 block mb-1">タグ <span className="text-gray-400 font-normal">(カンマ区切り)</span></label>
                <input type="text" value={msgForm.tags} onChange={(e) => setMsgForm((f) => ({ ...f, tags: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-400" placeholder="ウェルカム, campaign" />
              </div>

              <div className="flex gap-2">
                <button onClick={() => void handleSaveMsg()} disabled={savingMsg || !msgForm.content}
                  className="px-4 py-2 text-sm text-white bg-green-500 rounded-lg font-medium disabled:opacity-50">
                  {savingMsg ? '保存中...' : '保存'}
                </button>
                <button onClick={() => { setShowMsgForm(false); setEditingMsgId(null) }}
                  className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-lg">
                  キャンセル
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── メインページ ───────────────────────────────────────────────────────────────

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<ApiTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [templateMessages, setTemplateMessages] = useState<Record<string, ApiTemplateMessage[]>>({})
  const [selectedTemplate, setSelectedTemplate] = useState<ApiTemplate | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.templates.list()
      if (!res.success) return
      setTemplates(res.data)
      const allMsgs = await Promise.all(
        res.data.map(async (t) => {
          const r = await api.templates.getMessages(t.id)
          return { id: t.id, messages: r.success ? r.data : [] }
        })
      )
      const map: Record<string, ApiTemplateMessage[]> = {}
      for (const { id, messages } of allMsgs) map[id] = messages
      setTemplateMessages(map)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const toggleCategory = (cat: string) => {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    )
  }

  const filtered = templates.filter((t) => {
    if (search && !t.name.toLowerCase().includes(search.toLowerCase())) return false
    if (selectedCategories.length > 0) {
      return selectedCategories.some((cat) => (t.categories ?? []).includes(cat))
    }
    return true
  })

  return (
    <div className="flex flex-col min-h-screen bg-gray-50">
      <Header
        title="テンプレート管理"
        action={
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + 新規テンプレート
          </button>
        }
      />
      <main className="flex-1 p-4 lg:p-6 max-w-7xl mx-auto w-full">
        <div className="flex flex-wrap gap-2 mb-4 items-center">
          <input
            type="text"
            placeholder="テンプレート名で検索..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm flex-1 min-w-[160px] focus:outline-none focus:ring-2 focus:ring-green-400"
          />
          <div className="flex gap-1 flex-wrap">
            {TEMPLATE_CATEGORIES.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => toggleCategory(value)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors border ${
                  selectedCategories.includes(value)
                    ? 'text-white border-transparent'
                    : 'text-gray-600 bg-white border-gray-300 hover:border-green-400'
                }`}
                style={selectedCategories.includes(value) ? { backgroundColor: '#06C755', borderColor: '#06C755' } : undefined}
              >
                {label}
              </button>
            ))}
            {selectedCategories.length > 0 && (
              <button onClick={() => setSelectedCategories([])} className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-600">
                クリア
              </button>
            )}
          </div>
        </div>

        <p className="text-xs text-gray-400 mb-3">{filtered.length}件</p>

        {loading ? (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="bg-white rounded-xl border border-gray-200 p-4 animate-pulse space-y-3">
                <div className="h-4 bg-gray-200 rounded w-3/4" />
                <div className="h-3 bg-gray-100 rounded w-1/2" />
                <div className="space-y-2 mt-3">
                  <div className="h-3 bg-gray-100 rounded" />
                  <div className="h-3 bg-gray-100 rounded w-5/6" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-16">テンプレートがありません</p>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                messages={templateMessages[t.id] ?? []}
                onClick={() => setSelectedTemplate(t)}
              />
            ))}
          </div>
        )}
      </main>

      {selectedTemplate && (
        <DetailModal
          template={selectedTemplate}
          onClose={() => setSelectedTemplate(null)}
          onUpdated={() => { void load() }}
        />
      )}

      {showCreate && (
        <CreateTemplateModal
          onCreated={(t) => {
            setShowCreate(false)
            void load().then(() => setSelectedTemplate(t))
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}
    </div>
  )
}
