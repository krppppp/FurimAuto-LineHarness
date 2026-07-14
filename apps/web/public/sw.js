/* L Harness PWA Service Worker — Web Push 受信・通知表示・アイコンバッジ更新 */

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    // payload が JSON でない場合もデフォルト表示にフォールバック
  }
  const title = data.title || '新着メッセージ'
  const tasks = [
    // iOS は push イベント内で必ず通知を表示しないと購読が無効化される
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      tag: data.url || 'lh-message',
      data: { url: data.url || '/notifications' },
    }),
  ]
  if (typeof data.badge === 'number' && 'setAppBadge' in navigator) {
    tasks.push(navigator.setAppBadge(data.badge).catch(() => {}))
  }
  event.waitUntil(Promise.all(tasks))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const client = list.find((c) => 'focus' in c)
      if (client) {
        client.navigate(url)
        return client.focus()
      }
      return self.clients.openWindow(url)
    }),
  )
})
