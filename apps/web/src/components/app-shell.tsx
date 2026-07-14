'use client'
import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import Sidebar from './layout/sidebar'
// FurimAuto: upstreamの「改造を検知」バナーは出さず、フォーク元の新リリース通知のみ表示する独自バナーに差し替え。
import { UpstreamUpdateBanner } from './furim/upstream-update-banner'
import AuthGuard from './auth-guard'
import { AccountProvider } from '@/contexts/account-context'
import { registerServiceWorker, syncAppBadge } from '@/lib/push'
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events'

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isLogin = pathname === '/login'

  useEffect(() => {
    if (isLogin) return
    registerServiceWorker()
    syncAppBadge()
    const onVisible = () => {
      if (document.visibilityState === 'visible') syncAppBadge()
    }
    const onRefresh = () => syncAppBadge()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener(UNANSWERED_REFRESH_EVENT, onRefresh)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener(UNANSWERED_REFRESH_EVENT, onRefresh)
    }
  }, [isLogin])

  if (isLogin) {
    return <>{children}</>
  }

  return (
    <AuthGuard>
      <AccountProvider>
        <div className="flex min-h-screen flex-col">
          {/* Phase 6: banner above sidebar+header so it pins to the top of the
              admin shell. Renders nothing while loading; one of latest/fork/
              upgrade once /admin/version + manifest resolve. */}
          <UpstreamUpdateBanner />
          <div className="flex flex-1 min-h-0">
            <Sidebar />
            <main className="flex-1 overflow-auto">
              {/* /chats はモバイル全画面（余白ゼロ）。他ページは左上のフローティング
                  メニューボタンと重ならないよう上に余白を確保する */}
              <div className={pathname === '/chats'
                ? 'lg:pt-8 lg:px-8 lg:pb-8'
                : 'px-4 pt-14 pb-6 sm:px-6 lg:pt-8 lg:px-8 lg:pb-8'}>
                {children}
              </div>
            </main>
          </div>
        </div>
      </AccountProvider>
    </AuthGuard>
  )
}
