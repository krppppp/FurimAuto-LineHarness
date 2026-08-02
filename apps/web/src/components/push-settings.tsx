'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import {
  getCurrentSubscription,
  isIos,
  isPushSupported,
  isStandalone,
  registerServiceWorker,
  subscribeToPush,
  unsubscribeFromPush,
} from '@/lib/push'

type PushState =
  | 'loading'
  | 'unsupported'      // ブラウザ非対応 → 非表示
  | 'need-install'     // iOS で Safari から開いている → ホーム画面追加の案内
  | 'denied'           // 通知許可を拒否済み
  | 'off'
  | 'on'

export default function PushSettings() {
  const [state, setState] = useState<PushState>('loading')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const refresh = useCallback(async () => {
    if (!isPushSupported()) {
      // iOS Safari (非 standalone) は PushManager 自体が生えないので、
      // インストール案内を出すべきケースをここで拾う
      setState(isIos() && !isStandalone() ? 'need-install' : 'unsupported')
      return
    }
    if (isIos() && !isStandalone()) {
      setState('need-install')
      return
    }
    if (Notification.permission === 'denied') {
      setState('denied')
      return
    }
    const sub = await getCurrentSubscription()
    setState(sub ? 'on' : 'off')
  }, [])

  useEffect(() => {
    registerServiceWorker().finally(refresh)
  }, [refresh])

  const handleEnable = async () => {
    setBusy(true)
    setMessage('')
    try {
      const result = await subscribeToPush()
      if (!result.ok) setMessage(result.error ?? '有効化に失敗しました')
    } catch (err) {
      console.error(err)
      setMessage('有効化に失敗しました')
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const handleDisable = async () => {
    setBusy(true)
    setMessage('')
    try {
      await unsubscribeFromPush()
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const handleTest = async () => {
    setBusy(true)
    setMessage('')
    try {
      const res = await api.push.test()
      setMessage(res.success ? 'テスト通知を送信しました' : '送信に失敗しました')
    } catch {
      setMessage('送信に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  if (state === 'loading' || state === 'unsupported') return null

  if (state === 'need-install') {
    return (
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
        プッシュ通知を使うには、Safariの共有メニューから「ホーム画面に追加」した後、ホーム画面のアイコンからアプリを開いてください。
      </div>
    )
  }

  if (state === 'denied') {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        通知がブロックされています。iOSの「設定 → 通知 → L Harness」から通知を許可した後、もう一度お試しください。
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-3">
      <span className="text-sm font-medium text-gray-700">プッシュ通知</span>
      {state === 'on' ? (
        <>
          <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
            有効
          </span>
          <button
            onClick={handleTest}
            disabled={busy}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            テスト通知を送る
          </button>
          <button
            onClick={handleDisable}
            disabled={busy}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-50 disabled:opacity-50"
          >
            無効にする
          </button>
        </>
      ) : (
        <button
          onClick={handleEnable}
          disabled={busy}
          className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          この端末で通知を有効にする
        </button>
      )}
      {message && <span className="text-xs text-gray-500">{message}</span>}
    </div>
  )
}
