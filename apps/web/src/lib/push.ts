import { api } from './api'

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

// iOS は「ホーム画面に追加」から起動した standalone モードでのみ push/badge が使える
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  )
}

export function isIos(): boolean {
  if (typeof window === 'undefined') return false
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null
  try {
    return await navigator.serviceWorker.register('/sw.js')
  } catch (err) {
    console.error('SW registration failed', err)
    return null
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return null
  return reg.pushManager.getSubscription()
}

// 必ずユーザー操作 (クリックハンドラ) 内で呼ぶこと。iOS は gesture 外の
// Notification.requestPermission() を無視する。
export async function subscribeToPush(): Promise<{ ok: boolean; error?: string }> {
  if (!isPushSupported()) return { ok: false, error: 'このブラウザはプッシュ通知に対応していません' }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    return { ok: false, error: '通知が許可されませんでした' }
  }

  const keyRes = await api.push.vapidPublicKey()
  if (!keyRes.success || !keyRes.data?.publicKey) {
    return { ok: false, error: 'サーバー側でプッシュ通知が設定されていません' }
  }

  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registerServiceWorker())
  if (!reg) return { ok: false, error: 'Service Worker の登録に失敗しました' }
  await navigator.serviceWorker.ready

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(keyRes.data.publicKey) as BufferSource,
  })

  const json = subscription.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    return { ok: false, error: '購読情報の取得に失敗しました' }
  }
  const res = await api.push.subscribe({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  })
  if (!res.success) {
    await subscription.unsubscribe().catch(() => {})
    return { ok: false, error: '購読の登録に失敗しました' }
  }
  return { ok: true }
}

export async function unsubscribeFromPush(): Promise<void> {
  const subscription = await getCurrentSubscription()
  if (!subscription) return
  const endpoint = subscription.endpoint
  await subscription.unsubscribe().catch(() => {})
  await api.push.unsubscribe({ endpoint }).catch(() => {})
}

// アイコンバッジを未対応件数に同期する。非対応環境では何もしない。
export async function syncAppBadge(): Promise<void> {
  if (typeof navigator === 'undefined' || !('setAppBadge' in navigator)) return
  try {
    const res = await api.inbox.unanswered.count()
    if (!res.success) return
    const total = res.data.total
    if (total > 0) {
      await (navigator as Navigator & { setAppBadge: (n: number) => Promise<void> }).setAppBadge(total)
    } else {
      await (navigator as Navigator & { clearAppBadge: () => Promise<void> }).clearAppBadge()
    }
  } catch {
    // バッジ更新失敗は無視 (通知そのものには影響しない)
  }
}
