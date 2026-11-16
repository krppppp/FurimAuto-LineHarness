/**
 * PC で来た人が QR を読まずに、そのパソコンで LINE ログイン → 友だち追加まで進む道（TB-3475）。
 *
 * PC の QR 画面（/r/:ref と /auth/line）にボタンを置き、/auth/oauth（bot_prompt=aggressive）へ渡す。
 * 戻り（/auth/callback）では friendship/v1/status で友だちになったかを確かめ、なっていなければ
 * friends を作らず「友だち追加がまだです」の画面からもう一度ログイン画面へ戻す。
 */

export const PC_LOGIN_VIA = 'pc_qr';

const PASS_KEYS = [
  'ref', 'form', 'gate', 'xh', 'pool', 'account', 'uid', 'ig', 'iga', 'igan', 'redirect',
  'gclid', 'gbraid', 'wbraid', 'yclid', 'fbclid', 'twclid', 'ttclid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
];

/**
 * ボタンの行き先。/r/ は furimauto.com 配下でも開かれるので、WORKER_PUBLIC_URL の絶対 URL にする
 * （/auth/oauth は furimauto.com に載っていない・TB-2362 の QR 画像と同じ理由）。
 * xh: の ref は X Harness の使い捨てトークンなので、画面の URL に出さない。
 */
export function buildPcLoginHref(
  workerPublicUrl: string | undefined,
  query: Record<string, string | undefined>,
  sid: string,
): string {
  const params = new URLSearchParams();
  for (const k of PASS_KEYS) {
    const v = query[k];
    if (!v) continue;
    if (k === 'ref' && v.startsWith('xh:')) continue;
    params.set(k, v);
  }
  if (sid) params.set('sid', sid);
  params.set('via', PC_LOGIN_VIA);
  return `${workerPublicUrl ?? ''}/auth/oauth?${params.toString()}`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const PC_LOGIN_CSS =
  '.pc-or{display:flex;align-items:center;gap:12px;font-size:12px;color:#aaa;margin:28px 0 16px}'
  + '.pc-or:before,.pc-or:after{content:"";flex:1;height:1px;background:#eee}'
  + '.pc-login{display:block;width:100%;padding:15px;border-radius:12px;font-size:15px;font-weight:700;text-decoration:none;text-align:center;color:#fff;background:#06C755;box-shadow:0 2px 12px rgba(6,199,85,0.2)}'
  + '.pc-login:hover{opacity:.92}'
  + '.pc-login-hint{font-size:12px;color:#999;margin-top:10px;line-height:1.6}';

/** QR の下に置く「このパソコンで LINE にログイン」。data-gate はビーコンの gate_open で使う */
export function pcLoginBlockHtml(href: string): string {
  return `<div class="pc-or">スマートフォンが手元にない方</div>
<a href="${escapeAttr(href)}" class="pc-login" data-gate="pc_login">このパソコンで LINE にログイン</a>
<p class="pc-login-hint">パソコン版 LINE かメールアドレスでログインし、<br>そのまま友だち追加できます</p>`;
}

/**
 * LINE ログインのアクセストークンで、ログインチャネルにつながる公式アカウントと友だちかを聞く。
 * 聞けなかったとき（通信失敗・チャネルが未連携）は null を返し、呼び出し側は今までどおり進める。
 */
export async function fetchFriendFlag(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | null> {
  try {
    const res = await fetchImpl('https://api.line.me/friendship/v1/status', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const body = await res.json() as { friendFlag?: unknown };
    return typeof body.friendFlag === 'boolean' ? body.friendFlag : null;
  } catch {
    return null;
  }
}

/**
 * 友だち追加を飛ばした人をもう一度ログイン画面へ戻す URL。同意画面を出し直さないと
 * 友だち追加の選択肢が出ないので prompt=consent を付ける。state はそのまま使い回す。
 */
export function buildRetryLoginUrl(opts: {
  channelId: string;
  callbackUrl: string;
  state: string;
}): string {
  const u = new URL('https://access.line.me/oauth2/v2.1/authorize');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', opts.channelId);
  u.searchParams.set('redirect_uri', opts.callbackUrl);
  u.searchParams.set('scope', 'profile openid email');
  u.searchParams.set('bot_prompt', 'aggressive');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', opts.state);
  return u.toString();
}

const NOT_FRIEND_COPY = {
  not_friend: {
    title: '友だち追加がまだです',
    msg: 'LINE へのログインはできましたが、<br>FurimAuto の友だち追加が済んでいません。<br>もう一度進み、<strong>「友だち追加」</strong>を選んでください。',
  },
  canceled: {
    title: 'LINE へのログインが途中で止まりました',
    msg: 'もう一度進み、ログインのあとに<br><strong>「友だち追加」</strong>を選んでください。',
  },
} as const;

export function notFriendPage(retryUrl: string, kind: keyof typeof NOT_FRIEND_COPY = 'not_friend'): string {
  const copy = NOT_FRIEND_COPY[kind];
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${copy.title}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Helvetica Neue',system-ui,sans-serif;background:#f5f7f5;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#fff;border-radius:20px;box-shadow:0 2px 20px rgba(0,0,0,0.06);text-align:center;max-width:440px;width:90%;padding:44px 32px;border:1px solid rgba(0,0,0,0.04)}
h2{font-size:18px;color:#333;margin-bottom:14px}
.msg{font-size:14px;color:#555;line-height:1.8;margin-bottom:28px}
.msg strong{color:#06C755}
.btn{display:block;width:100%;padding:15px;border-radius:12px;font-size:15px;font-weight:700;text-decoration:none;text-align:center;color:#fff;background:#06C755;box-shadow:0 2px 12px rgba(6,199,85,0.2)}
.hint{font-size:12px;color:#999;margin-top:14px;line-height:1.6}
</style>
</head>
<body>
<div class="card">
<h2>${copy.title}</h2>
<p class="msg">${copy.msg}</p>
<a href="${escapeAttr(retryUrl)}" class="btn">友だち追加に進む</a>
<p class="hint">友だち追加で全機能を無料体験できます</p>
</div>
</body>
</html>`;
}
