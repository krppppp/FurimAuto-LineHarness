import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { gasGet } from './gas-client.js';

describe('gasGet のタイムアウトとリトライ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('fetchに中断シグナルを渡す（応答が無いまま待ち続けない）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await gasGet('deploy-1', { method: 'resetKeyCode', lineUserId: 'U1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('1回目が失敗しても2回目で成功すれば結果を返す', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(new Response('{"respnse":"ok"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const p = gasGet('deploy-1', { method: 'resetKeyCode', lineUserId: 'U1' });
    await vi.advanceTimersByTimeAsync(2000); // リトライ間隔
    await expect(p).resolves.toEqual({ respnse: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('3回とも失敗したら例外を投げる（呼び出し元がキュー投入/エラー通知できる）', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('TimeoutError'));
    vi.stubGlobal('fetch', fetchMock);

    const p = gasGet('deploy-1', { method: 'resetKeyCode', lineUserId: 'U1' });
    const assertion = expect(p).rejects.toThrow(/TimeoutError/);
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('5xxが続いた場合も最後のレスポンスでthrowする', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const p = gasGet('deploy-1', { method: 'resetKeyCode', lineUserId: 'U1' });
    const assertion = expect(p).rejects.toThrow(/GAS GET 500/);
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
