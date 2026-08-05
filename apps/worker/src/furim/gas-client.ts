const GAS_BASE = 'https://script.google.com/macros/s';

// GAS Web Appは散発的に5xx/タイムアウトを返す（2026-08-02/05に顧客対応フローの
// 無言死が複数発生）。冪等な読み取り・記録系のみなので1回だけ短い間隔で再試行する
async function fetchGasWithRetry(input: string, init?: RequestInit): Promise<Response> {
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(input, init);
      if (res.ok) return res;
    } catch (err) {
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
