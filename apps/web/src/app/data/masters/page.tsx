'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import Header from '@/components/layout/header'
import { fetchApi, getCsrfToken } from '@/lib/api'
import { toDisplayDateTime } from '../datetime'

type FieldType = 'text' | 'integer' | 'money' | 'bool' | 'select' | 'feature_keys' | 'plan_features'

type MasterField = {
  name: string
  label: string
  type: FieldType
  required?: boolean
  options?: Array<{ value: string; label: string }>
  list?: boolean
  help?: string
}

type MasterKindDef = { kind: string; label: string; sheet: string; keyField: string; hasActive: boolean; fields: MasterField[]; count?: number }

type Values = Record<string, unknown>

type Item = { key: string; id: string; active: number; updated_at: string | null; values: Values }

type AuditRow = { id: string; staff_name: string; column_name: string; old_value: string | null; new_value: string | null; created_at: string }

type MutateResponse = { success: boolean; error?: string; data?: Item | null; meta?: { changed?: string[] } }

const SITE_LABELS: Record<string, string> = { mercari: 'メルカリ', mercariShops: 'メルカリShops', rakuma: 'ラクマ', yahooFlea: 'ヤフフリ', cross: 'サイト横断' }

async function mutate(method: 'PATCH' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<MutateResponse> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res.json() as Promise<MutateResponse>
}

function text(v: unknown): string {
  return v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v)
}

function sameField(field: MasterField, a: unknown, b: unknown): boolean {
  if (field.type === 'integer' || field.type === 'money' || field.type === 'text' || field.type === 'select') return text(a).trim() === text(b).trim()
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function cellText(field: MasterField, v: unknown): string {
  switch (field.type) {
    case 'bool':
      return v ? '有効' : '無効'
    case 'money':
      return text(v) === '' ? '' : `${Number(v).toLocaleString('ja-JP')}円`
    case 'select':
      return field.options?.find((o) => o.value === v)?.label ?? text(v)
    case 'feature_keys':
      return Array.isArray(v) ? `${v.length} 機能` : ''
    case 'plan_features':
      return v && typeof v === 'object' ? `${Object.values(v as Values).filter((x) => x === true).length} 機能` : ''
    default:
      return text(v)
  }
}

function emptyValues(def: MasterKindDef, features: Item[]): Values {
  const out: Values = {}
  for (const f of def.fields) {
    if (f.type === 'bool') out[f.name] = true
    else if (f.type === 'feature_keys') out[f.name] = []
    else if (f.type === 'plan_features') out[f.name] = Object.fromEntries(features.map((x) => [x.key, x.key === 'AutoMultiChannel' ? '' : false]))
    else out[f.name] = ''
  }
  return out
}

function FeatureKeysInput({ value, features, onChange }: { value: string[]; features: Item[]; onChange: (v: string[]) => void }) {
  const groups = useMemo(() => {
    const m = new Map<string, Item[]>()
    for (const f of features) {
      const site = text(f.values.site)
      m.set(site, [...(m.get(site) ?? []), f])
    }
    return [...m.entries()]
  }, [features])
  const known = new Set(features.map((f) => f.key))
  const unknown = value.filter((k) => !known.has(k.split('=')[0]))
  const toggle = (key: string) => onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key])
  return (
    <div className="border border-gray-300 rounded-lg p-2 space-y-2 max-h-72 overflow-y-auto">
      {groups.map(([site, items]) => (
        <div key={site}>
          <div className="text-xs font-semibold text-gray-500 mb-1">{SITE_LABELS[site] ?? site}</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5">
            {items.map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-sm text-gray-800" title={f.key}>
                <input type="checkbox" checked={value.includes(f.key)} onChange={() => toggle(f.key)} className="h-4 w-4 accent-green-600" />
                <span className="truncate">{text(f.values.display_name) || f.key}</span>
                <span className="text-xs text-gray-400 truncate">{f.key}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
      {unknown.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-red-600 mb-1">機能マスタに無いキー（外すと戻せません）</div>
          {unknown.map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm text-red-700">
              <input type="checkbox" checked onChange={() => onChange(value.filter((x) => x !== k))} className="h-4 w-4 accent-red-600" />
              <span>{k}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function PlanFeaturesInput({ value, features, onChange }: { value: Values; features: Item[]; onChange: (v: Values) => void }) {
  const keys = [...Object.keys(value), ...features.map((f) => f.key).filter((k) => !(k in value))]
  const nameOf = new Map(features.map((f) => [f.key, `${SITE_LABELS[text(f.values.site)] ?? ''}${text(f.values.display_name) || f.key}`]))
  return (
    <div className="border border-gray-300 rounded-lg p-2 max-h-80 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5">
      {keys.map((k) =>
        k === 'AutoMultiChannel' ? (
          <label key={k} className="flex items-center gap-2 text-sm text-gray-800 sm:col-span-2" title={k}>
            <span className="shrink-0">{nameOf.get(k) ?? k}</span>
            <input
              type="text"
              value={text(value[k])}
              placeholder="メルカリ/Shops/ラクマ/ヤフオク/ヤフフリ（空なら無し）"
              onChange={(e) => onChange({ ...value, [k]: e.target.value })}
              className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded"
            />
          </label>
        ) : (
          <label key={k} className="flex items-center gap-2 text-sm text-gray-800" title={k}>
            <input type="checkbox" checked={value[k] === true} onChange={() => onChange({ ...value, [k]: value[k] !== true })} className="h-4 w-4 accent-green-600" />
            <span className="truncate">{nameOf.get(k) ?? k}</span>
          </label>
        ),
      )}
    </div>
  )
}

function MasterEditor({
  def,
  item,
  features,
  onClose,
  onSaved,
  onDeleted,
}: {
  def: MasterKindDef
  item: Item | null
  features: Item[]
  onClose: () => void
  onSaved: (item: Item, inserted: boolean) => void
  onDeleted: (key: string) => void
}) {
  const insert = item === null
  const [draft, setDraft] = useState<Values>(() => (item ? { ...item.values } : emptyValues(def, features)))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [audit, setAudit] = useState<AuditRow[]>([])
  const savingRef = useRef(false)

  const loadAudit = useCallback(async () => {
    if (!item) return
    try {
      const res = await fetchApi<{ success: boolean; data: AuditRow[] }>(`/api/furim/admin/furim_master/${encodeURIComponent(item.id)}/audit`)
      if (res.success) setAudit(res.data)
    } catch {
      setAudit([])
    }
  }, [item])

  useEffect(() => {
    loadAudit()
  }, [loadAudit])

  const changed = def.fields.filter((f) => !insert && !sameField(f, draft[f.name], item!.values[f.name]))

  const handleSave = async () => {
    if (savingRef.current || (!insert && changed.length === 0)) return
    savingRef.current = true
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const res = insert
        ? await mutate('POST', `/api/furim/admin/masters/${def.kind}`, { values: draft })
        : await mutate('PATCH', `/api/furim/admin/masters/${def.kind}/${encodeURIComponent(item!.key)}`, {
            values: Object.fromEntries(changed.map((f) => [f.name, draft[f.name]])),
          })
      if (!res.success || !res.data) throw new Error(res.error ?? '保存に失敗しました')
      onSaved(res.data, insert)
      if (!insert) {
        const labels = (res.meta?.changed ?? []).map((n) => def.fields.find((f) => f.name === n)?.label ?? n)
        setNotice(`保存しました（${labels.join('、') || '変更なし'}）`)
        setDraft({ ...res.data.values })
        await loadAudit()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!item || !window.confirm(`${def.label} の「${item.key}」を削除します。元に戻せません。よろしいですか？`)) return
    setSaving(true)
    setError('')
    try {
      const res = await mutate('DELETE', `/api/furim/admin/masters/${def.kind}/${encodeURIComponent(item.key)}`)
      if (!res.success) throw new Error(res.error ?? '削除に失敗しました')
      onDeleted(item.key)
    } catch (e) {
      setError(e instanceof Error ? e.message : '削除に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const set = (name: string, v: unknown) => setDraft((d) => ({ ...d, [name]: v }))

  const renderField = (f: MasterField) => {
    const locked = !insert && f.name === def.keyField
    const isChanged = changed.some((c) => c.name === f.name)
    const inputClass = `w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 ${
      locked ? 'border-gray-200 bg-gray-50 text-gray-500' : isChanged ? 'border-yellow-400 bg-yellow-50' : 'border-gray-300'
    }`
    let input: React.ReactNode
    switch (f.type) {
      case 'bool':
        input = (
          <label className="flex items-center gap-2 text-sm text-gray-800">
            <input type="checkbox" checked={draft[f.name] === true} onChange={() => set(f.name, draft[f.name] !== true)} className="h-4 w-4 accent-green-600" />
            <span>{draft[f.name] === true ? '有効' : '無効'}</span>
          </label>
        )
        break
      case 'select': {
        const current = text(draft[f.name])
        const options = f.options ?? []
        input = (
          <select value={current} onChange={(e) => set(f.name, e.target.value)} className={inputClass}>
            <option value="">（選択）</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}（{o.value}）
              </option>
            ))}
            {current && !options.some((o) => o.value === current) && <option value={current}>{current}</option>}
          </select>
        )
        break
      }
      case 'feature_keys':
        input = <FeatureKeysInput value={(draft[f.name] as string[]) ?? []} features={features} onChange={(v) => set(f.name, v)} />
        break
      case 'plan_features':
        input = <PlanFeaturesInput value={(draft[f.name] as Values) ?? {}} features={features} onChange={(v) => set(f.name, v)} />
        break
      default:
        input = (
          <input
            type="text"
            inputMode={f.type === 'integer' || f.type === 'money' ? 'numeric' : undefined}
            value={text(draft[f.name])}
            readOnly={locked}
            onChange={(e) => set(f.name, e.target.value)}
            className={inputClass}
          />
        )
    }
    return (
      <div key={f.name}>
        <label className="block text-xs font-medium text-gray-700 mb-1" title={f.name}>
          <span>{f.label}</span>
          {f.required && <span className="ml-1 text-red-500">*</span>}
          <span className="ml-2 text-gray-400">{locked ? '変更不可' : f.help ?? ''}</span>
        </label>
        {input}
      </div>
    )
  }

  const labelOf = (name: string) => def.fields.find((f) => f.name === name)?.label ?? name

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-3xl overflow-y-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 border-b border-gray-200 bg-white flex items-center justify-between px-5 py-3">
          <div>
            <div className="text-sm font-semibold text-gray-900">{insert ? `${def.label} に追加` : `${def.label} ・ ${item!.key}`}</div>
            {!insert && item!.updated_at && <div className="text-xs text-gray-500">更新 {toDisplayDateTime(item!.updated_at)}</div>}
          </div>
          <div className="flex items-center gap-2">
            {!insert && (
              <button onClick={handleDelete} disabled={saving} className="px-3 py-2 text-sm font-medium text-red-700 bg-white border border-red-300 rounded-lg hover:bg-red-50 disabled:opacity-50">
                削除
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={saving || (!insert && changed.length === 0)}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 hover:opacity-90"
              style={{ backgroundColor: '#06C755' }}
            >
              {saving ? '保存中...' : insert ? '追加' : `保存${changed.length ? `（${changed.length}）` : ''}`}
            </button>
            <button onClick={onClose} className="px-3 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
              閉じる
            </button>
          </div>
        </div>
        <div className="px-5 py-4 space-y-3">
          {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
          {notice && <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-800 text-sm">{notice}</div>}
          {def.fields.map(renderField)}
        </div>
        {!insert && (
          <div className="border-t border-gray-200 px-5 py-4">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">変更履歴</div>
            {audit.length === 0 ? (
              <div className="text-xs text-gray-400">まだ変更はありません</div>
            ) : (
              <ul className="space-y-1.5 text-xs text-gray-700">
                {audit.map((a) => (
                  <li key={a.id} className="flex flex-wrap gap-x-2">
                    <span className="text-gray-400">{toDisplayDateTime(a.created_at)}</span>
                    <span>{a.staff_name}</span>
                    <span title={a.column_name}>{labelOf(a.column_name)}</span>
                    <span className="text-gray-400 line-through break-all">{a.old_value ?? '(空)'}</span>
                    <span className="break-all">→ {a.new_value ?? '(空)'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function MastersInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const kind = searchParams.get('kind') ?? 'feature'
  const [kinds, setKinds] = useState<MasterKindDef[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [features, setFeatures] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Item | null>(null)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [k, list, feat] = await Promise.all([
        fetchApi<{ success: boolean; error?: string; data: MasterKindDef[] }>('/api/furim/admin/masters'),
        fetchApi<{ success: boolean; error?: string; data: Item[] }>(`/api/furim/admin/masters/${encodeURIComponent(kind)}`),
        kind === 'feature' ? Promise.resolve(null) : fetchApi<{ success: boolean; data: Item[] }>('/api/furim/admin/masters/feature'),
      ])
      if (!k.success || !list.success) throw new Error(k.error ?? list.error ?? '読み込みに失敗しました')
      setKinds(k.data)
      setItems(list.data)
      setFeatures(feat ? (feat.success ? feat.data : []) : list.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : '読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [kind])

  useEffect(() => {
    setEditing(null)
    setAdding(false)
    load()
  }, [load])

  const def = kinds.find((k) => k.kind === kind)
  const cols = def ? def.fields.filter((f) => f.list) : []
  const query = q.trim().toLowerCase()
  const shown = query ? items.filter((it) => [it.key, text(it.values.display_name)].some((s) => s.toLowerCase().includes(query))) : items

  const upsertItem = (saved: Item, inserted: boolean) => {
    setItems((xs) => (inserted ? [...xs, saved] : xs.map((x) => (x.key === saved.key ? saved : x))))
    if (kind === 'feature') setFeatures((xs) => (inserted ? [...xs, saved] : xs.map((x) => (x.key === saved.key ? saved : x))))
    setKinds((ks) => ks.map((k) => (k.kind === kind && inserted ? { ...k, count: (k.count ?? 0) + 1 } : k)))
    if (inserted) {
      setAdding(false)
      setEditing(saved)
    } else {
      setEditing(saved)
    }
  }

  return (
    <div>
      <Header
        title="マスタ編集"
        description="機能・パッケージ・プラン一覧・チケット単価（D1 が正）"
        action={
          <div className="flex items-center gap-2">
            {def && (
              <button onClick={() => setAdding(true)} className="px-3 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90" style={{ backgroundColor: '#06C755' }}>
                ＋ 追加
              </button>
            )}
            <Link href="/data" className="text-sm text-gray-500 hover:text-gray-700">
              ← テーブル一覧
            </Link>
          </div>
        }
      />

      <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 text-sm">
        スプレッドシートの「機能マスタ」「パッケージマスタ」「プラン一覧」「チケット単価一覧」は 2026-09-14 に凍結しました。シートを編集しても反映されません。ここで保存した値は、料金シミュレーター・申し込み・プラン変更・機能フラグの再計算に次の読み込みから使われます（顧客の機能フラグは、次の決済・プラン変更のときに再計算されます）。
      </div>

      <div className="mb-3 flex flex-wrap gap-1 border-b border-gray-200">
        {kinds.map((k) => (
          <button
            key={k.kind}
            onClick={() => router.replace(`/data/masters?kind=${k.kind}`)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${k.kind === kind ? 'border-green-500 text-gray-900 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            {k.label}
            <span className="ml-1 text-xs text-gray-400">{k.count ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="mb-3">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="キー・表示名で絞り込み"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
        />
      </div>

      {error && <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      {loading && !def ? (
        <div className="text-sm text-gray-400">読み込み中...</div>
      ) : def ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-auto max-h-[calc(100vh-16rem)]">
          <table className="min-w-full text-sm border-separate border-spacing-0">
            <thead>
              <tr>
                {cols.map((f) => (
                  <th key={f.name} title={f.name} className="px-3 py-2 text-left text-xs font-semibold text-gray-500 whitespace-nowrap sticky top-0 z-10 bg-gray-50 border-b border-gray-200">
                    {f.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={cols.length} className="px-4 py-8 text-center text-gray-400">
                    行がありません
                  </td>
                </tr>
              ) : (
                shown.map((it) => (
                  <tr key={it.key} onClick={() => setEditing(it)} className={`cursor-pointer hover:bg-green-50 ${def.hasActive && !it.active ? 'text-gray-400' : 'text-gray-800'}`}>
                    {cols.map((f) => {
                      const v = cellText(f, it.values[f.name])
                      return (
                        <td key={f.name} title={v} className="px-3 py-2 whitespace-nowrap max-w-xs truncate border-b border-gray-100">
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

      {def && editing && (
        <MasterEditor
          key={`${editing.key}-${editing.updated_at}`}
          def={def}
          item={editing}
          features={features}
          onClose={() => setEditing(null)}
          onSaved={upsertItem}
          onDeleted={(key) => {
            setEditing(null)
            setItems((xs) => xs.filter((x) => x.key !== key))
            if (kind === 'feature') setFeatures((xs) => xs.filter((x) => x.key !== key))
            setKinds((ks) => ks.map((k) => (k.kind === kind ? { ...k, count: Math.max(0, (k.count ?? 0) - 1) } : k)))
          }}
        />
      )}
      {def && adding && <MasterEditor def={def} item={null} features={features} onClose={() => setAdding(false)} onSaved={upsertItem} onDeleted={() => setAdding(false)} />}
    </div>
  )
}

export default function MastersPage() {
  return (
    <Suspense fallback={<div className="p-8 text-gray-400">読み込み中...</div>}>
      <MastersInner />
    </Suspense>
  )
}
