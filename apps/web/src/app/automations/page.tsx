'use client'

import { useState, useEffect, useCallback } from 'react'
import type { AutomationActionItem } from '@line-crm/shared'
import { api } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import Header from '@/components/layout/header'
import CreateTemplateModal from '@/components/templates/create-template-modal'
import CcPromptButton from '@/components/cc-prompt-button'


interface TemplateOption { id: string; name: string; categories: string[] }

type AutomationEventType = "friend_add" | "tag_change" | "score_threshold" | "cv_fire" | "message_received" | "calendar_booked"

interface AutomationAction {
  type: string
  params: Record<string, unknown>
}

interface Automation {
  id: string
  name: string
  description: string | null
  eventType: AutomationEventType
  conditions: Record<string, unknown>
  actions: AutomationAction[]
  isActive: boolean
  priority: number
  createdAt: string
  updatedAt: string
}

// ── 定数 ────────────────────────────────────────────────────

const eventTypeOptions: { value: AutomationEventType; label: string }[] = [
  { value: 'friend_add', label: '友だち追加' },
  { value: 'tag_change', label: 'タグ変更' },
  { value: 'score_threshold', label: 'スコア閾値' },
  { value: 'cv_fire', label: 'CV発火' },
  { value: 'message_received', label: 'メッセージ受信' },
  { value: 'calendar_booked', label: 'カレンダー予約' },
]

const eventTypeLabelMap: Record<string, string> = {
  friend_add: '友だち追加',
  tag_change: 'タグ変更',
  score_threshold: 'スコア閾値',
  cv_fire: 'CV発火',
  message_received: 'メッセージ受信',
  calendar_booked: 'カレンダー予約',
}

const eventTypeBadgeColor: Record<string, string> = {
  friend_add: 'bg-green-100 text-green-700',
  tag_change: 'bg-blue-100 text-blue-700',
  score_threshold: 'bg-yellow-100 text-yellow-700',
  cv_fire: 'bg-red-100 text-red-700',
  message_received: 'bg-purple-100 text-purple-700',
  calendar_booked: 'bg-indigo-100 text-indigo-700',
}

interface ActionTypeConfig {
  label: string
  fields: Array<{
    key: string
    label: string
    type: 'text' | 'textarea' | 'select' | 'template_select'
    options?: string[]
    placeholder?: string
    required?: boolean
  }>
}

const ACTION_TYPE_CONFIG: Record<string, ActionTypeConfig> = {
  add_tag: { label: 'タグ追加', fields: [{ key: 'tagId', label: 'タグID', type: 'text', required: true }] },
  remove_tag: { label: 'タグ削除', fields: [{ key: 'tagId', label: 'タグID', type: 'text', required: true }] },
  start_scenario: { label: 'シナリオ開始', fields: [{ key: 'scenarioId', label: 'シナリオID', type: 'text', required: true }] },
  send_message: {
    label: 'メッセージ送信',
    fields: [
      { key: 'messageType', label: 'タイプ', type: 'select', options: ['text', 'flex'] },
      { key: 'content', label: '内容', type: 'textarea', required: true },
      { key: 'altText', label: 'Alt テキスト (flex用)', type: 'text' },
    ],
  },
  send_webhook: { label: 'Webhook送信', fields: [{ key: 'url', label: 'URL', type: 'text', required: true, placeholder: 'https://...' }] },
  switch_rich_menu: { label: 'リッチメニュー切替', fields: [{ key: 'richMenuId', label: 'リッチメニューID', type: 'text', required: true }] },
  remove_rich_menu: { label: 'リッチメニュー解除', fields: [] },
  set_metadata: { label: 'メタデータ設定', fields: [{ key: 'data', label: 'データ (JSON)', type: 'textarea', placeholder: '{"key": "value"}', required: true }] },
  call_gas: {
    label: 'GAS呼び出し',
    fields: [
      { key: 'method', label: 'メソッド名', type: 'text', required: true },
      { key: 'http_method', label: 'HTTPメソッド', type: 'select', options: ['POST', 'GET'] },
      { key: 'args', label: '引数 (JSON)', type: 'textarea', placeholder: '{"key": "value"}' },
    ],
  },
  create_stripe_customer: {
    label: 'Stripe顧客作成',
    fields: [{ key: 'save_to_metadata', label: '保存先キー', type: 'text', placeholder: 'stripeCustomerId' }],
  },
  send_messages: {
    label: 'メッセージ送信 (複数)',
    fields: [
      { key: 'template_id', label: 'テンプレート', type: 'template_select', required: true },
    ],
  },
  call_gas_post: {
    label: 'GAS POST (送信)',
    fields: [
      { key: 'method', label: 'メソッド名', type: 'text', required: true },
      { key: 'args', label: '引数 (JSON)', type: 'textarea', placeholder: '{"key":"value"}' },
    ],
  },
  call_gas_get: {
    label: 'GAS GET (分岐)',
    fields: [
      { key: 'method', label: 'メソッド名', type: 'text', required: true },
      { key: 'args', label: '引数 (JSON)', type: 'textarea', placeholder: '{"lineUserId":"{{line_user_id}}"}' },
      { key: 'set_variable', label: '変数名 (分岐に使用)', type: 'text', required: true, placeholder: 'isReturningUser' },
      { key: 'response_field', label: 'レスポンスフィールド', type: 'text', placeholder: 'customer_stripe_id' },
      { key: 'operator', label: '評価方法', type: 'select', options: ['not_empty', 'empty', 'truthy', 'falsy', 'equals', 'not_equals'] },
      { key: 'compare_value', label: '比較値 (equals/not_equals時)', type: 'text' },
    ],
  },
  code_managed: {
    label: 'コード管理',
    fields: [{ key: 'description', label: '説明', type: 'textarea', placeholder: 'このアクションの内容を記述' }],
  },
}

const ACTION_TYPES = Object.keys(ACTION_TYPE_CONFIG)

function paramsToDisplay(actionType: string, params: Record<string, unknown>): string {
  if (actionType === 'call_gas_get') {
    return `${params.method ?? ''}() → {{${params.set_variable ?? '?'}}}`
  }
  if (actionType === 'call_gas_post' || actionType === 'call_gas') {
    return `${params.method ?? ''}()`
  }
  if (actionType === 'send_messages') {
    if (params.template_id) return `テンプレート: ${String(params.template_id).slice(0, 8)}...`
    const msgs = params.messages as unknown[]
    return `${Array.isArray(msgs) ? msgs.length : '?'}通 (旧形式)`
  }
  if (actionType === 'code_managed') {
    return String(params.description ?? '').slice(0, 60)
  }
  const cfg = ACTION_TYPE_CONFIG[actionType]
  if (!cfg) return JSON.stringify(params)
  return cfg.fields
    .filter((f) => params[f.key] !== undefined && params[f.key] !== '')
    .map((f) => `${f.label}: ${String(params[f.key]).slice(0, 40)}`)
    .join(' / ') || '(パラメータなし)'
}

// ── ActionCard ───────────────────────────────────────────────

interface ActionCardProps {
  action: AutomationActionItem
  index: number
  total: number
  onMove: (i: number, dir: 'up' | 'down') => void
  onEdit: (a: AutomationActionItem) => void
  onDelete: (id: string) => void
  branchLabel?: string
}

function ActionCard({ action, index, total, onMove, onEdit, onDelete, branchLabel }: ActionCardProps) {
  const isCode = action.actionType === 'code_managed'
  const isBranchPoint = action.actionType === 'call_gas_get'
  return (
    <div className={`w-full border rounded-lg px-4 py-3 ${
      isCode
        ? 'bg-amber-50 border-amber-200 border-dashed'
        : isBranchPoint
          ? 'bg-blue-50 border-blue-300'
          : action.isActive
            ? 'bg-white border-gray-200'
            : 'bg-gray-50 border-gray-200 opacity-60'
    }`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-xs font-mono text-gray-400">{index + 1}</span>
            {isBranchPoint && <span className="text-xs font-bold text-blue-600">◆</span>}
            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
              isCode ? 'bg-amber-100 text-amber-700'
              : isBranchPoint ? 'bg-blue-100 text-blue-700'
              : 'bg-gray-100 text-gray-700'
            }`}>
              {ACTION_TYPE_CONFIG[action.actionType]?.label ?? action.actionType}
            </span>
            {isCode && <span className="text-xs bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded font-mono">code</span>}
            {branchLabel && <span className="text-xs bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded font-mono">{branchLabel}</span>}
            {action.label && <span className="text-xs text-gray-600 italic truncate max-w-[120px]">"{action.label}"</span>}
            {action.onError === 'abort' && <span className="text-xs bg-red-50 text-red-600 px-1.5 py-0.5 rounded">abort</span>}
          </div>
          <p className="text-xs text-gray-500 truncate">{paramsToDisplay(action.actionType, action.params)}</p>
          {action.conditionJson && Object.keys(action.conditionJson).length > 0 && (
            <p className="text-xs text-blue-500 mt-0.5">if {JSON.stringify(action.conditionJson)}</p>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={() => onMove(index, 'up')} disabled={index === 0} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs">↑</button>
          <button onClick={() => onMove(index, 'down')} disabled={index === total - 1} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs">↓</button>
          <button onClick={() => onEdit(action)} className="px-2 py-1 text-xs text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 rounded">編集</button>
          <button onClick={() => onDelete(action.id)} className="px-2 py-1 text-xs text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 rounded">削除</button>
        </div>
      </div>
    </div>
  )
}

const Arrow = () => (
  <div className="flex flex-col items-center my-1">
    <div className="w-px h-4 bg-gray-300" />
    <div className="w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-gray-300" />
  </div>
)

function detectBranchVar(actions: AutomationActionItem[]): string | null {
  const stats: Record<string, { t: number; f: number }> = {}
  for (const a of actions) {
    if (!a.conditionJson) continue
    for (const [k, v] of Object.entries(a.conditionJson)) {
      if (!stats[k]) stats[k] = { t: 0, f: 0 }
      if (v === true) stats[k].t++
      else if (v === false) stats[k].f++
    }
  }
  return Object.keys(stats).find((k) => stats[k].t > 0 && stats[k].f > 0) ?? null
}

interface ActionFlowProps {
  actions: AutomationActionItem[]
  onMoveAction: (i: number, dir: 'up' | 'down') => void
  onEditAction: (a: AutomationActionItem) => void
  onDeleteAction: (id: string) => void
  onAddAction: () => void
}

function ActionFlow({ actions, onMoveAction, onEditAction, onDeleteAction, onAddAction }: ActionFlowProps) {
  const branchVar = detectBranchVar(actions)
  const sorted = [...actions].sort((a, b) => a.stepOrder - b.stepOrder)

  const preActions = branchVar
    ? sorted.filter((a) => !a.conditionJson || !(branchVar in a.conditionJson))
    : sorted
  const trueActions = branchVar ? sorted.filter((a) => a.conditionJson?.[branchVar] === true) : []
  const falseActions = branchVar ? sorted.filter((a) => a.conditionJson?.[branchVar] === false) : []

  const renderCard = (action: AutomationActionItem, branchLabel?: string) => {
    const globalIdx = actions.indexOf(action)
    return (
      <ActionCard
        key={action.id}
        action={action}
        index={globalIdx}
        total={actions.length}
        onMove={onMoveAction}
        onEdit={onEditAction}
        onDelete={onDeleteAction}
        branchLabel={branchLabel}
      />
    )
  }

  return (
    <div className="flex flex-col items-center w-full">
      {/* 分岐なし or 分岐前の共通アクション */}
      {preActions.map((action) => (
        <div key={action.id} className="flex flex-col items-center w-full max-w-lg">
          <Arrow />
          {renderCard(action)}
        </div>
      ))}

      {branchVar && (
        <>
          <div className="flex flex-col items-center my-2">
            <div className="w-px h-3 bg-blue-300" />
            <div className="text-xs font-semibold text-blue-600 bg-blue-50 border border-blue-200 rounded-full px-3 py-1">
              ◆ 分岐: {branchVar}
            </div>
          </div>

          <div className="flex gap-4 items-start">
            {/* true */}
            <div className="flex flex-col w-[32rem]">
              <div className="text-center text-xs font-semibold text-green-700 bg-green-50 border border-green-200 rounded-t-lg px-2 py-1.5">
                {branchVar} = true
              </div>
              <div className="border-l border-r border-b border-green-200 rounded-b-lg p-2 space-y-2 min-h-[60px]">
                {trueActions.length === 0
                  ? <p className="text-xs text-gray-300 text-center py-3">なし</p>
                  : trueActions.map((a) => renderCard(a, 'true'))
                }
              </div>
            </div>

            {/* false */}
            <div className="flex flex-col w-[32rem]">
              <div className="text-center text-xs font-semibold text-orange-700 bg-orange-50 border border-orange-200 rounded-t-lg px-2 py-1.5">
                {branchVar} = false
              </div>
              <div className="border-l border-r border-b border-orange-200 rounded-b-lg p-2 space-y-2 min-h-[60px]">
                {falseActions.length === 0
                  ? <p className="text-xs text-gray-300 text-center py-3">なし</p>
                  : falseActions.map((a) => renderCard(a, 'false'))
                }
              </div>
            </div>
          </div>
        </>
      )}

      {/* Add action */}
      <div className="flex flex-col items-center w-full max-w-lg mt-2">
        {!branchVar && actions.length > 0 && <Arrow />}
        <button
          onClick={onAddAction}
          className="w-full border-2 border-dashed border-gray-300 rounded-lg px-4 py-3 text-sm text-gray-400 hover:border-green-400 hover:text-green-600 transition-colors mt-1"
        >
          + アクション追加
        </button>
      </div>
    </div>
  )
}

// ── ActionModal ──────────────────────────────────────────────

interface ActionModalProps {
  automationId: string
  initial?: AutomationActionItem | null
  onClose: () => void
  onSaved: () => void
}

function ActionModal({ automationId, initial, onClose, onSaved }: ActionModalProps) {
  const [actionType, setActionType] = useState(initial?.actionType ?? 'add_tag')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [onError, setOnError] = useState<'continue' | 'abort'>(initial?.onError ?? 'continue')
  const [params, setParams] = useState<Record<string, string>>(() => {
    if (!initial) return {}
    const p: Record<string, string> = {}
    for (const [k, v] of Object.entries(initial.params)) {
      p[k] = typeof v === 'string' ? v : JSON.stringify(v)
    }
    return p
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [templateOptions, setTemplateOptions] = useState<TemplateOption[]>([])
  const [showCreateTemplate, setShowCreateTemplate] = useState(false)

  useEffect(() => {
    const hasTmSelect = ACTION_TYPE_CONFIG[actionType]?.fields.some((f) => f.type === 'template_select')
    if (!hasTmSelect) return
    api.templates.list().then((res) => {
      if (res.success) setTemplateOptions(res.data.map((t) => ({ id: t.id, name: t.name, categories: t.categories })))
    }).catch(() => {})
  }, [actionType])

  const cfg = ACTION_TYPE_CONFIG[actionType] ?? { label: actionType, fields: [] }

  const handleTypeChange = (t: string) => {
    setActionType(t)
    setParams({})
  }

  const setParam = (key: string, value: string) => {
    setParams((prev) => ({ ...prev, [key]: value }))
  }

  const buildParams = (): Record<string, unknown> => {
    const result: Record<string, unknown> = {}
    for (const field of cfg.fields) {
      const raw = params[field.key] ?? ''
      if (!raw && !field.required) continue
      if (field.type === 'textarea' && (field.key === 'data' || field.key === 'args')) {
        try {
          result[field.key] = raw ? JSON.parse(raw) : {}
        } catch {
          throw new Error(`${field.label}のJSON形式が正しくありません`)
        }
      } else {
        result[field.key] = raw
      }
    }
    return result
  }

  const handleSave = async () => {
    setError('')
    let builtParams: Record<string, unknown>
    try {
      builtParams = buildParams()
    } catch (e) {
      setError((e as Error).message)
      return
    }
    setSaving(true)
    try {
      const data = {
        actionType,
        params: builtParams,
        onError,
        label: label.trim() || undefined,
      }
      let res
      if (initial) {
        res = await api.automations.actions.update(automationId, initial.id, data)
      } else {
        res = await api.automations.actions.create(automationId, data)
      }
      if (res.success) {
        onSaved()
      } else {
        setError(res.error)
      }
    } catch {
      setError('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">{initial ? 'アクション編集' : 'アクション追加'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">アクションタイプ</label>
            <select
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
              value={actionType}
              onChange={(e) => handleTypeChange(e.target.value)}
            >
              {ACTION_TYPES.map((t) => (
                <option key={t} value={t}>{ACTION_TYPE_CONFIG[t]?.label ?? t}</option>
              ))}
            </select>
          </div>

          {cfg.fields.map((field) => (
            <div key={field.key}>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {field.label} {field.required && <span className="text-red-500">*</span>}
              </label>
              {field.type === 'select' ? (
                <select
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
                  value={params[field.key] ?? field.options?.[0] ?? ''}
                  onChange={(e) => setParam(field.key, e.target.value)}
                >
                  {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : field.type === 'template_select' ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <select
                      className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
                      value={params[field.key] ?? ''}
                      onChange={(e) => setParam(field.key, e.target.value)}
                    >
                      <option value="">テンプレートを選択...</option>
                      {templateOptions.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}{t.categories.length > 0 ? ` [${t.categories.join('/')}]` : ''}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setShowCreateTemplate(true)}
                      className="px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 whitespace-nowrap"
                    >
                      + 新規作成
                    </button>
                  </div>
                </div>
              ) : field.type === 'textarea' ? (
                <textarea
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
                  rows={3}
                  placeholder={field.placeholder}
                  value={params[field.key] ?? ''}
                  onChange={(e) => setParam(field.key, e.target.value)}
                />
              ) : (
                <input
                  type="text"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  placeholder={field.placeholder}
                  value={params[field.key] ?? ''}
                  onChange={(e) => setParam(field.key, e.target.value)}
                />
              )}
            </div>
          ))}

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">ラベル (省略可)</label>
            <input
              type="text"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              placeholder="UIに表示する説明"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">エラー時</label>
            <select
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
              value={onError}
              onChange={(e) => setOnError(e.target.value as 'continue' | 'abort')}
            >
              <option value="continue">続行 (continue)</option>
              <option value="abort">中断 (abort)</option>
            </select>
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50"
              style={{ backgroundColor: '#06C755' }}
            >
              {saving ? '保存中...' : '保存'}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg"
            >
              キャンセル
            </button>
          </div>
        </div>
      </div>

      {showCreateTemplate && (
        <CreateTemplateModal
          defaultCategories={['automation']}
          onCreated={(t) => {
            setShowCreateTemplate(false)
            // テンプレートオプションに追加して自動選択
            setTemplateOptions((prev) => [...prev, { id: t.id, name: t.name, categories: t.categories }])
            const tmplField = ACTION_TYPE_CONFIG[actionType]?.fields.find((f) => f.type === 'template_select')
            if (tmplField) setParam(tmplField.key, t.id)
          }}
          onCancel={() => setShowCreateTemplate(false)}
        />
      )}
    </div>
  )
}

// ── DetailView ───────────────────────────────────────────────

interface DetailViewProps {
  automation: Automation
  onBack: () => void
  onRefreshList: () => void
}

function DetailView({ automation, onBack, onRefreshList }: DetailViewProps) {
  const [actions, setActions] = useState<AutomationActionItem[]>([])
  const [loadingActions, setLoadingActions] = useState(true)
  const [modal, setModal] = useState<{ open: boolean; editing: AutomationActionItem | null }>({ open: false, editing: null })
  const [error, setError] = useState('')
  const [toggling, setToggling] = useState(false)

  const loadActions = useCallback(async () => {
    setLoadingActions(true)
    try {
      const res = await api.automations.actions.list(automation.id)
      if (res.success) setActions(res.data)
    } catch {
      setError('アクションの読み込みに失敗しました')
    } finally {
      setLoadingActions(false)
    }
  }, [automation.id])

  useEffect(() => { loadActions() }, [loadActions])

  const handleToggleActive = async () => {
    setToggling(true)
    try {
      await api.automations.update(automation.id, { isActive: !automation.isActive })
      onRefreshList()
    } catch {
      setError('ステータスの変更に失敗しました')
    } finally {
      setToggling(false)
    }
  }

  const handleDeleteAction = async (actionId: string) => {
    if (!confirm('このアクションを削除しますか？')) return
    try {
      await api.automations.actions.delete(automation.id, actionId)
      loadActions()
    } catch {
      setError('削除に失敗しました')
    }
  }

  const handleMoveAction = async (index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= actions.length) return
    const a = actions[index]
    const b = actions[targetIndex]
    try {
      await Promise.all([
        api.automations.actions.update(automation.id, a.id, { stepOrder: b.stepOrder }),
        api.automations.actions.update(automation.id, b.id, { stepOrder: a.stepOrder }),
      ])
      loadActions()
    } catch {
      setError('並び替えに失敗しました')
    }
  }

  const handleModalSaved = () => {
    setModal({ open: false, editing: null })
    loadActions()
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={onBack}
          className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
        >
          ← 戻る
        </button>
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${eventTypeBadgeColor[automation.eventType] ?? 'bg-gray-100 text-gray-600'}`}>
          {eventTypeLabelMap[automation.eventType] ?? automation.eventType}
        </span>
        <h1 className="text-base font-semibold text-gray-900 flex-1">{automation.name}</h1>
        <button
          onClick={handleToggleActive}
          disabled={toggling}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
            automation.isActive ? 'bg-green-500' : 'bg-gray-300'
          } disabled:opacity-50`}
          title={automation.isActive ? '有効 → クリックで無効化' : '無効 → クリックで有効化'}
        >
          <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition duration-200 ${automation.isActive ? 'translate-x-4' : 'translate-x-0'}`} />
        </button>
      </div>

      {automation.description && (
        <p className="text-sm text-gray-500 mb-4">{automation.description}</p>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs">{error}</div>
      )}

      {/* Action flow */}
      <div className="mb-6">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">アクションフロー</h2>

        {/* Trigger */}
        <div className="flex flex-col items-center">
          <div className="w-full max-w-lg bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-800 font-medium text-center">
            トリガー: {eventTypeLabelMap[automation.eventType] ?? automation.eventType}
            {automation.conditions && Object.keys(automation.conditions).length > 0 && (
              <span className="ml-2 text-xs font-normal text-green-600">
                ({Object.entries(automation.conditions).map(([k, v]) => `${k}=${String(v)}`).join(', ')})
              </span>
            )}
          </div>

          {loadingActions ? (
            <div className="mt-4 text-xs text-gray-400">読み込み中...</div>
          ) : (
            <ActionFlow
              actions={actions}
              onMoveAction={handleMoveAction}
              onEditAction={(action) => setModal({ open: true, editing: action })}
              onDeleteAction={handleDeleteAction}
              onAddAction={() => setModal({ open: true, editing: null })}
            />
          )}
        </div>
      </div>

      {modal.open && (
        <ActionModal
          automationId={automation.id}
          initial={modal.editing}
          onClose={() => setModal({ open: false, editing: null })}
          onSaved={handleModalSaved}
        />
      )}
    </div>
  )
}

// ── CreateForm ───────────────────────────────────────────────

interface CreateFormState {
  name: string
  description: string
  eventType: AutomationEventType
  conditionsJson: string
  priority: number
}

const initialForm: CreateFormState = {
  name: '',
  description: '',
  eventType: 'friend_add',
  conditionsJson: '{}',
  priority: 0,
}

// ── Main Page ────────────────────────────────────────────────

const ccPrompts = [
  {
    title: 'オートメーションルール作成',
    prompt: `新しいオートメーションルールを作成するサポートをしてください。
1. 利用可能なイベントタイプ（友だち追加、タグ変更、スコア閾値等）の説明
2. アクション設定の各タイプの説明
3. 条件設定と優先度の推奨値を提案
手順を示してください。`,
  },
  {
    title: 'オートメーション効果分析',
    prompt: `現在のオートメーションルールの効果を分析してください。
1. 各ルールの発火回数と成功率を確認
2. イベントタイプ別の自動化カバレッジを評価
3. 効果の低いルールの改善提案と新規ルールの推奨
結果をレポートしてください。`,
  },
]

export default function AutomationsPage() {
  const { selectedAccountId } = useAccount()
  const [automations, setAutomations] = useState<Automation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [view, setView] = useState<'list' | 'detail'>('list')
  const [selectedAutomation, setSelectedAutomation] = useState<Automation | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState<CreateFormState>({ ...initialForm })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const loadAutomations = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.automations.list({ accountId: selectedAccountId || undefined })
      if (res.success) {
        setAutomations(res.data)
        // Refresh selectedAutomation if in detail view
        if (selectedAutomation) {
          const updated = res.data.find((a) => a.id === selectedAutomation.id)
          if (updated) setSelectedAutomation(updated)
        }
      } else {
        setError(res.error)
      }
    } catch {
      setError('オートメーションの読み込みに失敗しました。もう一度お試しください。')
    } finally {
      setLoading(false)
    }
  }, [selectedAccountId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadAutomations() }, [loadAutomations])

  const handleCreate = async () => {
    if (!form.name.trim()) { setFormError('ルール名を入力してください'); return }
    let parsedConditions: Record<string, unknown>
    try {
      parsedConditions = JSON.parse(form.conditionsJson)
    } catch {
      setFormError('条件のJSON形式が正しくありません'); return
    }
    setSaving(true)
    setFormError('')
    try {
      const res = await api.automations.create({
        name: form.name,
        description: form.description || null,
        eventType: form.eventType,
        actions: [],
        conditions: parsedConditions,
        priority: form.priority,
      })
      if (res.success) {
        setShowCreate(false)
        setForm({ ...initialForm })
        await loadAutomations()
        // Open detail view for new automation
        setSelectedAutomation(res.data)
        setView('detail')
      } else {
        setFormError(res.error)
      }
    } catch {
      setFormError('作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleToggleActive = async (id: string, current: boolean) => {
    try {
      await api.automations.update(id, { isActive: !current })
      loadAutomations()
    } catch {
      setError('ステータスの変更に失敗しました')
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('このオートメーションを削除してもよいですか？')) return
    try {
      await api.automations.delete(id)
      loadAutomations()
    } catch {
      setError('削除に失敗しました')
    }
  }

  const openDetail = (automation: Automation) => {
    setSelectedAutomation(automation)
    setView('detail')
  }

  const handleBack = () => {
    setView('list')
    setSelectedAutomation(null)
    loadAutomations()
  }

  // ── Detail view ──
  if (view === 'detail' && selectedAutomation) {
    return (
      <div>
        <Header title="オートメーション" />
        <DetailView
          automation={selectedAutomation}
          onBack={handleBack}
          onRefreshList={loadAutomations}
        />
      </div>
    )
  }

  // ── List view ──
  return (
    <div>
      <Header
        title="オートメーション"
        action={
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + 新規ルール
          </button>
        }
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      {/* Create form - 最小入力でアクションフロー画面へ */}
      {showCreate && (
        <div className="mb-6 bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-800 mb-3">新規オートメーション</h2>
          <div className="flex flex-wrap gap-3 items-end max-w-2xl">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs font-medium text-gray-600 mb-1">ルール名 <span className="text-red-500">*</span></label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="例: 友だち追加時ウェルカム"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate() }}
                autoFocus
              />
            </div>
            <div className="min-w-[160px]">
              <label className="block text-xs font-medium text-gray-600 mb-1">イベント</label>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                value={form.eventType}
                onChange={(e) => setForm({ ...form, eventType: e.target.value as AutomationEventType })}
              >
                {eventTypeOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => void handleCreate()}
                disabled={saving}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50"
                style={{ backgroundColor: '#06C755' }}
              >
                {saving ? '作成中...' : '作成 →'}
              </button>
              <button
                onClick={() => { setShowCreate(false); setFormError('') }}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg"
              >
                キャンセル
              </button>
            </div>
          </div>
          {formError && <p className="text-xs text-red-600 mt-2">{formError}</p>}
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="bg-white rounded-lg border border-gray-200 p-5 animate-pulse space-y-3">
              <div className="h-4 bg-gray-200 rounded w-3/4" />
              <div className="h-3 bg-gray-100 rounded w-full" />
              <div className="flex gap-4">
                <div className="h-3 bg-gray-100 rounded w-24" />
                <div className="h-3 bg-gray-100 rounded w-16" />
              </div>
            </div>
          ))}
        </div>
      ) : automations.length === 0 && !showCreate ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <p className="text-gray-500">オートメーションがありません。「新規ルール」から作成してください。</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {automations.map((automation) => (
            <div
              key={automation.id}
              className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 hover:shadow-md transition-shadow cursor-pointer"
              onClick={() => openDetail(automation)}
            >
              <div className="flex items-start justify-between mb-2">
                <h3 className="text-sm font-semibold text-gray-900 leading-tight">{automation.name}</h3>
                <button
                  onClick={(e) => { e.stopPropagation(); handleToggleActive(automation.id, automation.isActive) }}
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    automation.isActive ? 'bg-green-500' : 'bg-gray-300'
                  }`}
                  title={automation.isActive ? '有効 - クリックで無効化' : '無効 - クリックで有効化'}
                >
                  <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${automation.isActive ? 'translate-x-4' : 'translate-x-0'}`} />
                </button>
              </div>

              {automation.description && (
                <p className="text-xs text-gray-500 mb-3 line-clamp-2">{automation.description}</p>
              )}

              <div className="flex items-center gap-2 mb-3">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${eventTypeBadgeColor[automation.eventType] ?? 'bg-gray-100 text-gray-600'}`}>
                  {eventTypeLabelMap[automation.eventType] ?? automation.eventType}
                </span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${automation.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                  {automation.isActive ? '有効' : '無効'}
                </span>
              </div>

              <div className="flex items-center gap-4 text-xs text-gray-400 mb-3">
                <span>優先度: {automation.priority}</span>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                <span className="text-xs text-green-600 hover:text-green-800">アクション管理 →</span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(automation.id) }}
                  className="px-3 py-1 min-h-[36px] text-xs font-medium text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                >
                  削除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <CcPromptButton prompts={ccPrompts} />
    </div>
  )
}
