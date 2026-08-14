import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { gasGet } from './gas-client.js';

describe('gasGet のタイムアウトと1回きり実行', () => {
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

  test('失敗したらリトライせず即座に例外を投げる（呼び出し元がキュー投入する。盲目リトライは非冪等メソッドで重複書き込みを生むため廃止）', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('TimeoutError'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(gasGet('deploy-1', { method: 'resetKeyCode', lineUserId: 'U1' })).rejects.toThrow(/TimeoutError/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('5xxもリトライせずthrowする', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(gasGet('deploy-1', { method: 'resetKeyCode', lineUserId: 'U1' })).rejects.toThrow(/GAS GET 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
