function url(dbUrl: string, path: string) {
  return `${dbUrl.replace(/\/$/, '')}/${path}.json`;
}

export async function fbGet(dbUrl: string, path: string): Promise<unknown> {
  const res = await fetch(url(dbUrl, path));
  if (!res.ok) return null;
  return res.json();
}

export async function fbSet(dbUrl: string, path: string, value: unknown): Promise<void> {
  await fetch(url(dbUrl, path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
}

export async function fbDelete(dbUrl: string, path: string): Promise<void> {
  await fetch(url(dbUrl, path), { method: 'DELETE' });
}

export async function getAiMode(dbUrl: string, lineUserId: string): Promise<boolean> {
  const val = await fbGet(dbUrl, `userStatus/${lineUserId}/ai_mode`);
  return val === true;
}

export async function setAiMode(dbUrl: string, lineUserId: string): Promise<void> {
  await fbSet(dbUrl, `userStatus/${lineUserId}`, { ai_mode: true, startedAt: Date.now() });
}

export async function deleteAiMode(dbUrl: string, lineUserId: string): Promise<void> {
  await fbDelete(dbUrl, `userStatus/${lineUserId}/ai_mode`);
  await fbDelete(dbUrl, `userStatus/${lineUserId}/startedAt`);
}

export async function getSentGiftBatches(dbUrl: string, lineUserId: string): Promise<number[]> {
  const val = await fbGet(dbUrl, `userStatus/${lineUserId}/sentGiftBatches`);
  if (!val) return [];
  return Array.isArray(val) ? val : Object.values(val as Record<string, number>);
}

export async function setSentGiftBatches(dbUrl: string, lineUserId: string, batches: number[]): Promise<void> {
  await fbSet(dbUrl, `userStatus/${lineUserId}/sentGiftBatches`, batches);
}
