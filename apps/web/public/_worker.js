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

// 本番の管理画面は furimauto-line.t4-corp.com（Cloudflare Access の内側・TB-2546。旧 line.t4-corp.com は TB-2219）。
// 本番の pages.dev そのものは新しい住所へ飛ばす（Access を通らない入口を残さない）。
// プレビュー URL (<hash>.line-harness-admin-prod-6mo.pages.dev) は飛ばさない。
const ADMIN_HOST = 'furimauto-line.t4-corp.com'
const LEGACY_ADMIN_HOST = 'line.t4-corp.com'
const LEGACY_PROD_HOST = 'line-harness-admin-prod-6mo.pages.dev'

// 新 LINE「フリマ物販トレンド情報局」の管理画面は trend-line.t4-corp.com（Pages line-harness-admin-fmb・Access の内側・TB-2546。旧 trend.t4-corp.com は TB-2396）。
// 同じ _worker.js を別の Pages に出す。pages.dev は同じく新しい住所へ飛ばす。
const FMB_ADMIN_HOST = 'trend-line.t4-corp.com'
const LEGACY_FMB_ADMIN_HOST = 'trend.t4-corp.com'
const FMB_PAGES_HOST = 'line-harness-admin-fmb.pages.dev'

// 旧住所（line.・trend.）は新しい住所へ 302 で残す。外すかは 11 月末に別 Issue。
const CANONICAL_HOSTS = {
  [LEGACY_ADMIN_HOST]: ADMIN_HOST,
  [LEGACY_PROD_HOST]: ADMIN_HOST,
  [LEGACY_FMB_ADMIN_HOST]: FMB_ADMIN_HOST,
  [FMB_PAGES_HOST]: FMB_ADMIN_HOST,
}

function workerOrigin(hostname, env) {
  if (env.API_PROXY_ORIGIN) return env.API_PROXY_ORIGIN
  if (hostname === ADMIN_HOST) {
    return 'https://line-harness-prod.furimuato.workers.dev'
  }
  if (hostname === FMB_ADMIN_HOST || hostname.endsWith(FMB_PAGES_HOST)) {
    return 'https://line-harness-fmb.furimuato.workers.dev'
  }
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
    const canonicalHost = CANONICAL_HOSTS[url.hostname]
    if (canonicalHost) {
      return Response.redirect(`https://${canonicalHost}${url.pathname}${url.search}`, 302)
    }
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
