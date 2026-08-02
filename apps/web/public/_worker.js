// FurimAuto 独自ファイル (upstream には存在しない)。
//
// iOS WebKit は第三者 Cookie を全面ブロックするため、管理画面 (pages.dev) から
// API worker (workers.dev) へ直接 credentialed fetch するとセッション Cookie が
// 保存されず、iPhone (PWA/Safari) でログインが無限ループする。
//
// 対策: Pages Functions (advanced mode) で /api/* と /admin/* を worker へ
// サーバー間転送する。ブラウザから見ると画面も API も同一オリジンになり、
// Cookie は first-party として扱われる。NEXT_PUBLIC_API_URL には Pages 自身の
// オリジンを設定してビルドする。LINE webhook / Stripe / GAS は従来どおり
// workers.dev 直通で、このプロキシを通らない。
//
// 注意: _worker.js が存在すると Pages は _redirects / _headers を無視する
// (現状どちらも実質未使用なので影響なし)。

const PROXY_PREFIXES = ['/api/', '/admin/']

function workerOrigin(hostname, env) {
  if (env.API_PROXY_ORIGIN) return env.API_PROXY_ORIGIN
  // プレビュー URL (<hash>.<project>.pages.dev) も拾えるよう endsWith で判定
  if (hostname.endsWith('line-harness-admin-prod-6mo.pages.dev')) {
    return 'https://line-harness-prod.furimuato.workers.dev'
  }
  if (hostname.endsWith('line-harness-admin-7je.pages.dev')) {
    return 'https://line-harness.furimuato.workers.dev'
  }
  return null
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (PROXY_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      const origin = workerOrigin(url.hostname, env)
      if (!origin) {
        return new Response(
          JSON.stringify({ success: false, error: 'API proxy origin not configured for this host' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }
      const target = new URL(url.pathname + url.search, origin)
      // redirect: 'manual' — worker が返す 3xx をそのままブラウザへ通す
      return fetch(new Request(target, request), { redirect: 'manual' })
    }
    return env.ASSETS.fetch(request)
  },
}
