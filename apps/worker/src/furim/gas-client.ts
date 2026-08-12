const GAS_BASE = 'https://script.google.com/macros/s';

// 1回のGAS呼び出しの上限。webhookの処理は waitUntil で走り約30秒で打ち切られるため、
// 応答の無いfetchを待ち続けると打ち切りに巻き込まれ、呼び出し元のcatch（＝ユーザーへの
// エラー通知）にすら到達せず無言で終わる。
// 実測: 2026-08-12 19:47 のキーコードリセットがGASの実行ログに残らないまま無反応だった
// （19:54の再送は成功）。リトライ2回＋間隔2秒で最大22秒に収め、通知を送る余地を残す。
const GAS_FETCH_TIMEOUT_MS = 10_000;

// GAS Web Appは散発的に5xx/タイムアウトを返す（2026-08-02/05に顧客対応フローの
// 無言死が複数発生）。冪等な読み取り・記録系のみなので1回だけ短い間隔で再試行する
async function fetchGasWithRetry(input: string, init?: RequestInit): Promise<Response> {
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(input, { ...init, signal: AbortSignal.timeout(GAS_FETCH_TIMEOUT_MS) });
      if (res.ok) return res;
    } catch (err) {
      // タイムアウトもここに来る。2回目で諦めて呼び出し元へ投げ、
      // runHandlerSafely にユーザーへのエラー通知を出させる
      if (attempt === 1) throw err;
      res = null;
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
