'use client'

import { useEffect, useRef, useState } from 'react'
import { fetchApi } from '@/lib/api'
import { mutate } from './admin-client'

export type FeatureFlagItem = { feature_key: string; label: string; flag: 'bool' | 'text'; value: string | null; locked: 0 | 1 }

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
      {locked ? (
        <path fillRule="evenodd" d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z" clipRule="evenodd" />
      ) : (
        <path fillRule="evenodd" d="M14.5 1A4.5 4.5 0 0 0 10 5.5V9H3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1.5V5.5a3 3 0 1 1 6 0v2.75a.75.75 0 0 0 1.5 0V5.5A4.5 4.5 0 0 0 14.5 1Z" clipRule="evenodd" />
      )}
    </svg>
  )
}

export function featureToggleMessage(item: FeatureFlagItem, kind: 'value' | 'lock', who: string): string {
  if (kind === 'lock') return `${who} の「${item.label}」を${item.locked ? '固定から外します' : '固定します'}。よろしいですか？`
  return `${who} の「${item.label}」を ${item.value === '1' ? 'オン → オフ' : 'オフ → オン'} にします。拡張の動きがすぐ変わります。よろしいですか？`
}

// 行ドロワーの「機能」（Capsec #261）: その顧客 1 人分の機能フラグ。0/1 はその場保存、各機能に固定（鍵）の切り替え
// confirmToggle: 個別チャットの顧客パネルでは、切り替えと固定の前に確認を出す（#308 くろさん OK）。顧客DB の行ドロワーは今までどおり確認なし
export default function FeaturePanel({
  lineUserId,
  displayName,
  confirmToggle = false,
  compact = false,
  onChanged,
}: {
  lineUserId: string
  displayName: string
  confirmToggle?: boolean
  /** 個別チャットの顧客パネル: 余白を詰める */
  compact?: boolean
  onChanged?: () => void
}) {
  const [items, setItems] = useState<FeatureFlagItem[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState<Set<string>>(() => new Set())
  const savingRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await fetchApi<{ success: boolean; error?: string; data: FeatureFlagItem[] }>(
          `/api/furim/admin/furim_customers/${encodeURIComponent(lineUserId)}/feature-flags`,
        )
        if (!alive) return
        if (res.success) setItems(res.data)
        else setError(res.error ?? '機能フラグの取得に失敗しました')
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : '機能フラグの取得に失敗しました')
      }
    })()
    return () => {
      alive = false
    }
  }, [lineUserId])

  const update = async (item: FeatureFlagItem, kind: 'value' | 'lock') => {
    const key = `${item.feature_key}|${kind}`
    if (savingRef.current.has(key)) return
    if (confirmToggle && !window.confirm(featureToggleMessage(item, kind, displayName || lineUserId))) return
    savingRef.current.add(key)
    setSaving(new Set(savingRef.current))
    const patch: Partial<FeatureFlagItem> =
      kind === 'value' ? { value: item.value === '1' ? '0' : '1' } : { locked: item.locked ? 0 : 1, value: item.value ?? (item.flag === 'bool' ? '0' : '') }
    const apply = (p: Partial<FeatureFlagItem>) =>
      setItems((xs) => (xs ?? []).map((x) => (x.feature_key === item.feature_key ? { ...x, ...p } : x)))
    apply(patch)
    setError('')
    try {
      const base = `/api/furim/admin/furim_customers/${encodeURIComponent(lineUserId)}/feature-flags`
      const res =
        kind === 'value'
          ? await mutate('PATCH', base, { feature_key: item.feature_key, value: patch.value === '1' ? 1 : 0 })
          : await mutate('PATCH', `${base}/lock`, { feature_key: item.feature_key, locked: patch.locked })
      if (!res.success) throw new Error(res.error ?? '保存に失敗しました')
      onChanged?.()
    } catch (e) {
      apply({ value: item.value, locked: item.locked })
      const what = kind === 'value' ? '' : 'の固定'
      setError(`${displayName || lineUserId} の「${item.label}」${what}を保存できませんでした: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      savingRef.current.delete(key)
      setSaving(new Set(savingRef.current))
    }
  }

  return (
    <div className={compact ? 'py-2 space-y-3' : 'px-5 py-4 space-y-3'}>
      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
      <div className="text-xs text-gray-500">
        鍵を付けた機能は、決済時の再計算・シート取り込みなど自動の書き込みで変わりません（旧拡張の顧客を除く）。外すと値はそのまま残り、次の再計算から契約どおりに戻ります。
      </div>
      {items === null ? (
        !error && <div className="text-sm text-gray-400">読み込み中...</div>
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
          {items.map((item) => {
            const locked = item.locked === 1
            return (
              <li key={item.feature_key} className={`flex items-center gap-3 px-3 py-1.5 text-sm ${locked ? 'bg-amber-50' : ''}`}>
                <span className="flex-1 min-w-0 truncate text-gray-800" title={item.feature_key}>
                  {item.label}
                </span>
                {item.flag === 'bool' ? (
                  <input
                    type="checkbox"
                    checked={item.value === '1'}
                    disabled={saving.has(`${item.feature_key}|value`)}
                    onChange={() => update(item, 'value')}
                    aria-label={item.label}
                    className="h-4 w-4 cursor-pointer accent-green-600 disabled:cursor-wait disabled:opacity-50"
                  />
                ) : (
                  <span className="max-w-[16rem] truncate text-gray-700" title={item.value ?? ''}>
                    {item.value ? item.value : <span className="text-gray-300">—</span>}
                  </span>
                )}
                <button
                  type="button"
                  disabled={saving.has(`${item.feature_key}|lock`)}
                  onClick={() => update(item, 'lock')}
                  aria-label={locked ? `${item.label}の固定を外す` : `${item.label}を固定する`}
                  title={locked ? '固定中（クリックで外す）' : '固定する（自動の書き込みで上書きしない）'}
                  className={`p-1 rounded disabled:cursor-wait disabled:opacity-50 ${locked ? 'text-amber-600' : 'text-gray-300 hover:text-gray-500'}`}
                >
                  <LockIcon locked={locked} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
