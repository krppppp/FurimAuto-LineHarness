const GAS_BASE = 'https://script.google.com/macros/s';

// 1回のGAS呼び出しの上限。webhookの処理は waitUntil で走り約30秒で打ち切られるため、
// 応答の無いfetchを待ち続けると打ち切りに巻き込まれ、呼び出し元のcatch（＝再実行キュー
// への退避）にすら到達せず無言で終わる。
// 2026-08-14 くろさん方針: インラインのリトライは廃止して1回きり。
// GAS側はWorkerがタイムアウトで見切っても実行を完走するため、非冪等な書き込み
// （setCustomerData等）へのリトライは重複行を生む（同日のよっしーさん3重行）。
// 失敗は gas_retry_jobs に積み、cron側が実行前の「実行済みチェック」付きで完遂させる。
// 単発になったぶんタイムアウトは7秒→15秒に緩和（30秒枠に後続処理の余地は残る）。
const GAS_FETCH_TIMEOUT_MS = 15_000;

export type GasCallOptions = {
  // cron（壁時計15分）から呼ぶ場合はGASのコールドスタートやシートロック待ちを
  // 悠然と待てるため、長いタイムアウトを指定する
  timeoutMs?: number;
};

// タイムアウトは AbortSignal と Promise.race の二段構え。
// 2026-08-13 の実測（くろさんテスト垢の再現＋wrangler tail）で、fetchが固まったまま
// AbortSignal.timeout の中断が発火せず、waitUntil の30秒打ち切りまで無言で待ち続ける
// 事象を確認した（ログ・例外ゼロ / cpu=7ms / wall=30022ms）。raceのタイマー拒否は
// 下層のfetchが残っていてもこちらのawaitを確実に解いて例外へ進める。
async function fetchGasOnce(input: string, init?: RequestInit, timeoutMs = GAS_FETCH_TIMEOUT_MS): Promise<Response> {
  let hangTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fetchPromise = fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    fetchPromise.catch(() => {}); // raceで負けた後にabortで拒否されたときの未処理拒否を防ぐ
    const hangGuard = new Promise<never>((_, reject) => {
      hangTimer = setTimeout(() => reject(new Error(`GAS fetch hang (${timeoutMs + 1000}ms)`)), timeoutMs + 1000);
    });
    return await Promise.race([fetchPromise, hangGuard]);
  } finally {
    clearTimeout(hangTimer);
  }
}

export async function gasGet(deployId: string, params: Record<string, string>, opts?: GasCallOptions): Promise<unknown> {
  const url = new URL(`${GAS_BASE}/${deployId}/exec`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetchGasOnce(url.toString(), { redirect: 'follow' }, opts?.timeoutMs);
  if (!res.ok) throw new Error(`GAS GET ${res.status}: ${await res.text()}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

// GASは処理失敗時もHTTP 200で {success:false, error} を返し、doGet/doPostの未捕捉例外は
// HTMLエラーページ(200)になる。res.okだけでは失敗を検知できないため、応答本文から
// 失敗を判定する。失敗ならその説明文字列、正常ならnullを返す。
// ※ success フィールドを持たない正常応答（getKeyCode等）は失敗扱いにしない
export function getGasErrorFromResponse(result: unknown): string | null {
  if (typeof result === 'string' && result.trimStart().startsWith('<')) {
    return 'GAS returned HTML error page (uncaught exception)';
  }
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (r.success === false) return `GAS success=false: ${String(r.error ?? '(no error message)')}`.slice(0, 300);
    if (r.result === 'error') return 'GAS result=error';
  }
  return null;
}

export async function gasPost(deployId: string, body: Record<string, unknown>, opts?: GasCallOptions): Promise<unknown> {
  const res = await fetchGasOnce(`${GAS_BASE}/${deployId}/exec`, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, opts?.timeoutMs);
  if (!res.ok) throw new Error(`GAS POST ${res.status}: ${await res.text()}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}
