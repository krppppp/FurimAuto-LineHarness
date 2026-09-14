import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { gasGet, gasPost, setGasSharedSecret } from './gas-client.js';

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

describe('共有の秘密を付けて送る', () => {
  afterEach(() => {
    setGasSharedSecret(undefined);
  });

  test('秘密が設定されていれば GET のクエリに token を付ける', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"success":true,"rows":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    setGasSharedSecret('s3cret');

    await gasGet('deploy-1', { method: 'getData', sheet: 'シート', headerRow: '3' });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('method')).toBe('getData');
    expect(url.searchParams.get('sheet')).toBe('シート');
    expect(url.searchParams.get('token')).toBe('s3cret');
  });

  test('呼び出し側が token を渡しても設定済みの秘密で上書きする', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    setGasSharedSecret('s3cret');

    await gasGet('deploy-1', { method: 'getData', token: 'other' });

    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.getAll('token')).toEqual(['s3cret']);
  });

  test('秘密が未設定なら GET に token を付けない', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await gasGet('deploy-1', { method: 'getData', sheet: 'シート' });

    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.has('token')).toBe(false);
  });

  test('秘密が設定されていれば POST の本文に token を付ける', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"success":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    setGasSharedSecret('s3cret');

    await gasPost('deploy-1', { method: 'setKeyCode', lineUserId: 'U1' });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ method: 'setKeyCode', lineUserId: 'U1', token: 's3cret' });
  });

  test('秘密が未設定なら POST の本文は変えない', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"success":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await gasPost('deploy-1', { method: 'setKeyCode', lineUserId: 'U1' });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ method: 'setKeyCode', lineUserId: 'U1' });
  });
});
