const GAS_BASE = 'https://script.google.com/macros/s';

// 1回のGAS呼び出しの上限。webhookの処理は waitUntil で走り約30秒で打ち切られるため、
// 応答の無いfetchを待ち続けると打ち切りに巻き込まれ、呼び出し元のcatch（＝ユーザーへの
// エラー通知）にすら到達せず無言で終わる。
// 実測: 2026-08-12 19:47 のキーコードリセットがGASの実行ログに残らないまま無反応だった
// （19:54の再送は成功）。リトライ2回＋間隔2秒で最大22秒に収め、通知を送る余地を残す。
const GAS_FETCH_TIMEOUT_MS = 10_000;

// GAS Web Appは散発的に5xx/タイムアウトを返す（2026-08-02/05に顧客対応フローの
// 無言死が複数発生）。冪等な読み取り・記録系のみなので1回だけ短い間隔で再試行する。
//
// タイムアウトは AbortSignal と Promise.race の二段構え。
// 2026-08-13 の実測（くろさんテスト垢の再現＋wrangler tail）で、fetchが固まったまま
// AbortSignal.timeout の中断が発火せず、waitUntil の30秒打ち切りまで無言で待ち続ける
// 事象を確認した（ログ・例外ゼロ / cpu=7ms / wall=30022ms）。raceのタイマー拒否は
// 下層のfetchが残っていてもこちらのawaitを確実に解いて例外へ進める。
async function fetchGasWithRetry(input: string, init?: RequestInit): Promise<Response> {
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let hangTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      console.log(`[gas] fetch attempt=${attempt} start`);
      const fetchPromise = fetch(input, { ...init, signal: AbortSignal.timeout(GAS_FETCH_TIMEOUT_MS) });
      fetchPromise.catch(() => {}); // raceで負けた後にabortで拒否されたときの未処理拒否を防ぐ
      const hangGuard = new Promise<never>((_, reject) => {
        hangTimer = setTimeout(() => reject(new Error(`GAS fetch hang (${GAS_FETCH_TIMEOUT_MS + 1000}ms)`)), GAS_FETCH_TIMEOUT_MS + 1000);
      });
      res = await Promise.race([fetchPromise, hangGuard]);
      console.log(`[gas] fetch attempt=${attempt} done status=${res.status}`);
      if (res.ok) return res;
    } catch (err) {
      // タイムアウト・ハングもここに来る。2回目で諦めて呼び出し元へ投げ、
      // runHandlerSafely にユーザーへのエラー通知を出させる
      console.warn(`[gas] fetch attempt=${attempt} failed: ${String(err)}`);
      if (attempt === 1) throw err;
      res = null;
    } finally {
      clearTimeout(hangTimer);
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
  }
  return res!;
}

export async function gasGet(deployId: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${GAS_BASE}/${deployId}/exec`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetchGasWithRetry(url.toString(), { redirect: 'follow' });
  if (!res.ok) throw new Error(`GAS GET ${res.status}: ${await res.text()}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

export async function gasPost(deployId: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetchGasWithRetry(`${GAS_BASE}/${deployId}/exec`, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GAS POST ${res.status}: ${await res.text()}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}
