const GAS_BASE = 'https://script.google.com/macros/s';

export async function gasGet(deployId: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${GAS_BASE}/${deployId}/exec`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), { redirect: 'follow' });
  if (!res.ok) throw new Error(`GAS GET ${res.status}: ${await res.text()}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

export async function gasPost(deployId: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${GAS_BASE}/${deployId}/exec`, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GAS POST ${res.status}: ${await res.text()}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}
