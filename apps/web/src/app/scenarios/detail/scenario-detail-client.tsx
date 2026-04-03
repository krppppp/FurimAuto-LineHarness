'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import type { Scenario, ScenarioStep, ScenarioTriggerType } from '@line-crm/shared'
import { api } from '@/lib/api'
import type { ApiTemplateMessage, ApiTemplate } from '@/lib/api'
import Header from '@/components/layout/header'
import FlexPreviewComponent from '@/components/flex-preview'
import CreateTemplateModal from '@/components/templates/create-template-modal'

type ScenarioWithSteps = Scenario & { steps: (ScenarioStep & { templateId?: string | null })[] }

const typeLabel: Record<string, string> = { text: 'テキスト', image: '画像', flex: 'Flex', video: '動画' }
const typeBadge: Record<string, string> = {
  text: 'bg-blue-50 text-blue-600',
  image: 'bg-purple-50 text-purple-600',
  flex: 'bg-orange-50 text-orange-600',
  video: 'bg-red-50 text-red-600',
}

const triggerOptions: { value: ScenarioTriggerType; label: string }[] = [
  { value: 'friend_add', label: '友だち追加時' },
  { value: 'tag_added', label: 'タグ付与時' },
  { value: 'manual', label: '手動' },
]

function formatDelay(minutes: number): string {
  if (minutes === 0) return '即時'
  if (minutes < 60) return `${minutes}分後`
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return m === 0 ? `${h}時間後` : `${h}時間${m}分後`
  }
  const d = Math.floor(minutes / 1440)
  const remaining = minutes % 1440
  if (remaining === 0) return `${d}日後`
  const h = Math.floor(remaining / 60)
  return h > 0 ? `${d}日${h}時間後` : `${d}日${remaining}分後`
}

function FlexPreview({ content }: { content: string }) {
  return <FlexPreviewComponent content={content} maxWidth={300} />
}

function ImagePreview({ content }: { content: string }) {
  try {
    const parsed = JSON.parse(content) as { previewImageUrl?: string; originalContentUrl?: string }
    const url = parsed.previewImageUrl || parsed.originalContentUrl
    return (
      <div>
        <span className="text-xs font-medium text-purple-600 bg-purple-50 px-2 py-0.5 rounded mb-2 inline-block">画像</span>
        {url ? (
          <img src={url} alt="preview" className="max-w-[200px] rounded-lg border border-gray-200 mt-1" />
        ) : (
          <p className="text-xs text-gray-400">プレビューなし</p>
        )}
      </div>
    )
  } catch {
    return <p className="text-xs text-red-500">画像 JSON パースエラー</p>
  }
}

// ── ステップ追加/編集フォーム ────────────────────────────────────────────────

interface StepFormProps {
  scenarioId: string
  step?: ScenarioStep & { templateId?: string | null }
  nextOrder: number
  allTemplates: ApiTemplate[]
  onSaved: () => void
  onCancel: () => void
}

function StepForm({ scenarioId, step, nextOrder, allTemplates, onSaved, onCancel }: StepFormProps) {
  const [stepOrder, setStepOrder] = useState(step?.stepOrder ?? nextOrder)
  const [delayMinutes, setDelayMinutes] = useState(step?.delayMinutes ?? 0)
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(step?.templateId ?? '')
  const [showCreateTemplate, setShowCreateTemplate] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const scenarioTemplates = allTemplates.filter((t) => (t.categories ?? []).includes('scenario') || (t.categories ?? []).length === 0)

  const handleSave = async () => {
    if (!selectedTemplateId) { setError('テンプレートを選択してください'); return }
    setSaving(true)
    setError('')
    try {
      if (step) {
        const res = await api.scenarios.updateStep(scenarioId, step.id, {
          stepOrder,
          delayMinutes,
          templateId: selectedTemplateId,
        })
        if (!res.success) { setError(res.error); return }
      } else {
        const res = await api.scenarios.addStep(scenarioId, {
          stepOrder,
          delayMinutes,
          templateId: selectedTemplateId,
        })
        if (!res.success) { setError(res.error); return }
      }
      onSaved()
    } catch {
      setError('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
      <h4 className="text-sm font-medium text-gray-700 mb-3">
        {step ? 'ステップを編集' : '新しいステップを追加'}
      </h4>
      <div className="space-y-3 max-w-lg">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">ステップ順序</label>
            <input
              type="number"
              min={1}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              value={stepOrder}
              onChange={(e) => setStepOrder(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">遅延 (分)</label>
            <input
              type="number"
              min={0}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              value={delayMinutes}
              onChange={(e) => setDelayMinutes(Number(e.target.value))}
            />
            <p className="text-xs text-gray-400 mt-0.5">{formatDelay(delayMinutes)}</p>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">テンプレート <span className="text-red-500">*</span></label>
          <div className="flex gap-2">
            <select
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
            >
              <option value="">テンプレートを選択...</option>
              {scenarioTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
              {allTemplates.filter((t) => !(t.categories ?? []).includes('scenario') && (t.categories ?? []).length > 0).length > 0 && (
                <optgroup label="その他">
                  {allTemplates
                    .filter((t) => !(t.categories ?? []).includes('scenario') && (t.categories ?? []).length > 0)
                    .map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))
                  }
                </optgroup>
              )}
            </select>
            <button
              type="button"
              onClick={() => setShowCreateTemplate(true)}
              className="px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 whitespace-nowrap"
            >
              + 新規作成
            </button>
          </div>
          {selectedTemplateId && (
            <p className="text-xs text-green-600 mt-1">
              選択中: {allTemplates.find((t) => t.id === selectedTemplateId)?.name}
            </p>
          )}
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex gap-2">
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
            style={{ backgroundColor: '#06C755' }}
          >
            {saving ? '保存中...' : step ? '更新' : '追加'}
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
          >
            キャンセル
          </button>
        </div>
      </div>

      {showCreateTemplate && (
        <CreateTemplateModal
          defaultCategories={['scenario']}
          onCreated={(t) => {
            setShowCreateTemplate(false)
            setSelectedTemplateId(t.id)
          }}
          onCancel={() => setShowCreateTemplate(false)}
        />
      )}
    </div>
  )
}

// ── テンプレートメッセージ表示 ───────────────────────────────────────────────

function TemplateMessages({ templateId, templateData }: { templateId: string; templateData: { name: string; messages: ApiTemplateMessage[] } | undefined }) {
  if (!templateData) return <p className="text-xs text-gray-400">テンプレートを読み込み中...</p>

  return (
    <div className="space-y-2">
      {templateData.messages.length === 0 ? (
        <p className="text-xs text-gray-400">メッセージなし（テンプレート管理で追加してください）</p>
      ) : (
        templateData.messages.map((tm, idx) => (
          <div key={tm.id} className="bg-gray-50 rounded-md px-3 py-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-mono text-gray-400">{idx + 1}</span>
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${typeBadge[tm.message.messageType] ?? 'bg-gray-100 text-gray-600'}`}>
                {typeLabel[tm.message.messageType] ?? tm.message.messageType}
              </span>
              {tm.message.label && <span className="text-[10px] text-gray-500 italic">{tm.message.label}</span>}
            </div>
            <div className="text-sm text-gray-700">
              {tm.message.messageType === 'text' ? (
                <p className="whitespace-pre-wrap break-words">{tm.message.content}</p>
              ) : tm.message.messageType === 'flex' ? (
                <FlexPreview content={tm.message.content} />
              ) : tm.message.messageType === 'image' ? (
                <ImagePreview content={tm.message.content} />
              ) : (
                <p className="text-xs text-gray-500 truncate">{tm.message.content}</p>
              )}
            </div>
          </div>
        ))
      )}
      <div className="pt-1">
        <a
          href="/templates"
          className="text-xs text-green-600 hover:underline"
        >
          テンプレート管理で編集 →
        </a>
      </div>
    </div>
  )
}

// ── メインコンポーネント ─────────────────────────────────────────────────────

export default function ScenarioDetailClient({ scenarioId }: { scenarioId: string }) {
  const id = scenarioId

  const [scenario, setScenario] = useState<ScenarioWithSteps | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [allTemplates, setAllTemplates] = useState<ApiTemplate[]>([])
  const [templateMessages, setTemplateMessages] = useState<Record<string, { name: string; messages: ApiTemplateMessage[] }>>({})

  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState({ name: '', description: '', triggerType: 'friend_add' as ScenarioTriggerType, isActive: true })
  const [saving, setSaving] = useState(false)

  const [editingStep, setEditingStep] = useState<(ScenarioStep & { templateId?: string | null }) | null>(null)
  const [showAddStep, setShowAddStep] = useState(false)

  const loadScenario = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [res, tmplRes] = await Promise.all([
        api.scenarios.get(id),
        api.templates.list(),
      ])
      if (tmplRes.success) setAllTemplates(tmplRes.data)
      if (!res.success) { setError(res.error); return }

      setScenario(res.data as ScenarioWithSteps)
      setEditForm({
        name: res.data.name,
        description: res.data.description ?? '',
        triggerType: res.data.triggerType,
        isActive: res.data.isActive,
      })

      const tids = [...new Set((res.data.steps as (ScenarioStep & { templateId?: string | null })[]).map((s) => s.templateId).filter(Boolean) as string[])]
      if (tids.length > 0) {
        const results = await Promise.all(
          tids.map(async (tid) => {
            const [tmRes, tRes] = await Promise.all([
              api.templates.getMessages(tid),
              api.templates.get(tid),
            ])
            return {
              id: tid,
              name: tRes.success ? tRes.data.name : tid,
              messages: tmRes.success ? tmRes.data : [],
            }
          }),
        )
        const tmMap: Record<string, { name: string; messages: ApiTemplateMessage[] }> = {}
        for (const r of results) tmMap[r.id] = { name: r.name, messages: r.messages }
        setTemplateMessages(tmMap)
      }
    } catch {
      setError('シナリオの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { void loadScenario() }, [loadScenario])

  const handleSaveScenario = async () => {
    if (!editForm.name.trim()) return
    setSaving(true)
    try {
      const res = await api.scenarios.update(id, {
        name: editForm.name,
        description: editForm.description || null,
        triggerType: editForm.triggerType,
        isActive: editForm.isActive,
      })
      if (res.success) {
        setEditing(false)
        void loadScenario()
      } else {
        setError(res.error)
      }
    } catch {
      setError('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteStep = async (stepId: string) => {
    if (!confirm('このステップを削除してもよいですか？')) return
    try {
      await api.scenarios.deleteStep(id, stepId)
      void loadScenario()
    } catch {
      setError('ステップの削除に失敗しました')
    }
  }

  if (loading) {
    return (
      <div>
        <Header title="シナリオ詳細" />
        <div className="bg-white rounded-lg border border-gray-200 p-8 animate-pulse space-y-4">
          <div className="h-6 bg-gray-200 rounded w-1/3" />
          <div className="h-4 bg-gray-100 rounded w-2/3" />
        </div>
      </div>
    )
  }

  if (!scenario) {
    return (
      <div>
        <Header title="シナリオ詳細" />
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
          <p className="text-gray-500">{error || 'シナリオが見つかりません'}</p>
          <Link href="/scenarios" className="text-sm text-green-600 hover:text-green-700 mt-4 inline-block">← シナリオ一覧に戻る</Link>
        </div>
      </div>
    )
  }

  const nextOrder = scenario.steps.length > 0 ? Math.max(...scenario.steps.map((s) => s.stepOrder)) + 1 : 1

  return (
    <div>
      <Header
        title="シナリオ詳細"
        action={
          <Link
            href="/scenarios"
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors inline-flex items-center"
          >
            ← シナリオ一覧
          </Link>
        }
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      {/* シナリオ情報 */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
        {editing ? (
          <div className="space-y-4 max-w-lg">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">シナリオ名 <span className="text-red-500">*</span></label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">説明</label>
              <textarea
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
                rows={2}
                value={editForm.description}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">トリガー</label>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                value={editForm.triggerType}
                onChange={(e) => setEditForm({ ...editForm, triggerType: e.target.value as ScenarioTriggerType })}
              >
                {triggerOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="editIsActive"
                checked={editForm.isActive}
                onChange={(e) => setEditForm({ ...editForm, isActive: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
              />
              <label htmlFor="editIsActive" className="text-sm text-gray-600">有効</label>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => void handleSaveScenario()}
                disabled={saving}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
                style={{ backgroundColor: '#06C755' }}
              >
                {saving ? '保存中...' : '保存'}
              </button>
              <button
                onClick={() => {
                  setEditing(false)
                  setEditForm({ name: scenario.name, description: scenario.description ?? '', triggerType: scenario.triggerType, isActive: scenario.isActive })
                }}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                キャンセル
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-start justify-between gap-4 mb-3">
              <h2 className="text-lg font-semibold text-gray-900">{scenario.name}</h2>
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${scenario.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                  {scenario.isActive ? '有効' : '無効'}
                </span>
                <button onClick={() => setEditing(true)} className="text-xs font-medium text-green-600 hover:text-green-700 px-3 py-1.5 rounded-md hover:bg-green-50 transition-colors">
                  編集
                </button>
              </div>
            </div>
            {scenario.description && <p className="text-sm text-gray-500 mb-3">{scenario.description}</p>}
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span>トリガー: {triggerOptions.find((o) => o.value === scenario.triggerType)?.label ?? scenario.triggerType}</span>
              <span>ステップ数: {scenario.steps.length}</span>
              <span>作成日: {new Date(scenario.createdAt).toLocaleDateString('ja-JP')}</span>
            </div>
          </div>
        )}
      </div>

      {/* ステップ一覧 */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-800">ステップ一覧</h3>
          <button
            onClick={() => { setShowAddStep(true); setEditingStep(null) }}
            className="px-3 py-1.5 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + ステップ追加
          </button>
        </div>

        {(showAddStep && !editingStep) && (
          <StepForm
            scenarioId={id}
            nextOrder={nextOrder}
            allTemplates={allTemplates}
            onSaved={() => { setShowAddStep(false); void loadScenario() }}
            onCancel={() => setShowAddStep(false)}
          />
        )}

        {scenario.steps.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm">
            ステップがありません。「+ ステップ追加」から追加してください。
          </div>
        ) : (
          <div className="space-y-3">
            {scenario.steps
              .sort((a, b) => a.stepOrder - b.stepOrder)
              .map((step) => {
                const typedStep = step as ScenarioStep & { templateId?: string | null }
                const isEditing = editingStep?.id === step.id
                return (
                  <div key={step.id} className="border border-gray-200 rounded-lg overflow-hidden">
                    {/* ステップヘッダー */}
                    <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-100">
                      <div className="flex items-center gap-3">
                        <span
                          className="inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold text-white shrink-0"
                          style={{ backgroundColor: '#06C755' }}
                        >
                          {step.stepOrder}
                        </span>
                        <span className="text-xs text-gray-500">{formatDelay(step.delayMinutes)}</span>
                        {typedStep.templateId ? (
                          <span className="text-xs font-medium text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded">
                            {templateMessages[typedStep.templateId]?.name ?? 'テンプレート'}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded">テンプレート未設定</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => {
                            if (isEditing) {
                              setEditingStep(null)
                            } else {
                              setShowAddStep(false)
                              setEditingStep(typedStep)
                            }
                          }}
                          className="text-xs text-green-600 hover:text-green-700 px-2 py-1 rounded hover:bg-green-50 transition-colors min-h-[44px] flex items-center"
                        >
                          {isEditing ? 'キャンセル' : '編集'}
                        </button>
                        <button
                          onClick={() => void handleDeleteStep(step.id)}
                          className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors min-h-[44px] flex items-center"
                        >
                          削除
                        </button>
                      </div>
                    </div>

                    {/* 編集フォーム */}
                    {isEditing && (
                      <div className="p-4 bg-blue-50 border-b border-blue-100">
                        <StepForm
                          scenarioId={id}
                          step={typedStep}
                          nextOrder={nextOrder}
                          allTemplates={allTemplates}
                          onSaved={() => { setEditingStep(null); void loadScenario() }}
                          onCancel={() => setEditingStep(null)}
                        />
                      </div>
                    )}

                    {/* メッセージプレビュー */}
                    {!isEditing && (
                      <div className="px-4 py-3">
                        {typedStep.templateId ? (
                          <TemplateMessages
                            templateId={typedStep.templateId}
                            templateData={templateMessages[typedStep.templateId]}
                          />
                        ) : (
                          <div className="text-sm text-gray-700 bg-gray-50 rounded-md px-3 py-2">
                            <p className="text-xs text-gray-400">テンプレートが未設定です。「編集」からテンプレートを選択してください。</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
        )}
      </div>
    </div>
  )
}
