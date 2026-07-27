import { describe, test, expect, vi } from 'vitest';
import { fetchAndStoreIncomingImage, fetchAndStoreIncomingMedia } from './incoming-image.js';

function makeR2Stub() {
  const store = new Map<string, { data: ArrayBuffer; contentType: string }>();
  return {
    put: vi.fn(async (key: string, data: ArrayBuffer, opts: { httpMetadata?: { contentType?: string } }) => {
      store.set(key, { data, contentType: opts.httpMetadata?.contentType ?? '' });
      return null;
    }),
    _store: store,
  };
}

describe('fetchAndStoreIncomingImage', () => {
  test('Content API 成功時に R2 PUT して URL を返す', async () => {
    const r2 = makeR2Stub();
    const fetchMock = vi.fn(async () =>
      new Response(new ArrayBuffer(100), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      }),
    );

    const result = await fetchAndStoreIncomingImage({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      accountId: 'acc-1',
      messageId: 'msg-xyz',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-data.line.me/v2/bot/message/msg-xyz/content',
      expect.objectContaining({
        headers: { Authorization: 'Bearer token-abc' },
      }),
    );
    expect(r2.put).toHaveBeenCalled();
    const [key, , opts] = r2.put.mock.calls[0];
    expect(key).toBe('incoming-acc-1-msg-xyz.jpg');
    expect(opts.httpMetadata?.contentType).toBe('image/jpeg');
    expect(result?.originalContentUrl).toBe('https://worker.example.com/images/incoming-acc-1-msg-xyz.jpg');
    expect(result?.previewImageUrl).toBe(result?.originalContentUrl);
  });

  test('Content API が非 200 を返したら null', async () => {
    const r2 = makeR2Stub();
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));

    const result = await fetchAndStoreIncomingImage({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-bad',
      accountId: 'acc-1',
      messageId: 'msg-y',
    });

    expect(result).toBeNull();
    expect(r2.put).not.toHaveBeenCalled();
  });

  test('R2 PUT が throw したら null', async () => {
    const r2 = makeR2Stub();
    r2.put.mockRejectedValueOnce(new Error('R2 down'));
    const fetchMock = vi.fn(async () =>
      new Response(new ArrayBuffer(50), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );

    const result = await fetchAndStoreIncomingImage({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      accountId: 'acc-1',
      messageId: 'msg-z',
    });

    expect(result).toBeNull();
  });

  test('Content-Type から拡張子を判定 (png)', async () => {
    const r2 = makeR2Stub();
    const fetchMock = vi.fn(async () =>
      new Response(new ArrayBuffer(50), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );

    await fetchAndStoreIncomingImage({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      accountId: 'a',
      messageId: 'm-png',
    });

    const [key] = r2.put.mock.calls[0];
    expect(key).toBe('incoming-a-m-png.png');
  });
});

describe('fetchAndStoreIncomingMedia (video)', () => {
  test('動画本体とpreviewサムネを R2 PUT して URL を返す', async () => {
    const r2 = makeR2Stub();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/content/preview')) {
        return new Response(new ArrayBuffer(10), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      return new Response(new ArrayBuffer(500), {
        status: 200,
        headers: { 'Content-Type': 'video/mp4' },
      });
    });

    const result = await fetchAndStoreIncomingMedia({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock as unknown as typeof fetch,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      accountId: 'acc-1',
      messageId: 'msg-v',
      messageType: 'video',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-data.line.me/v2/bot/message/msg-v/content',
      expect.objectContaining({ headers: { Authorization: 'Bearer token-abc' } }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-data.line.me/v2/bot/message/msg-v/content/preview',
      expect.objectContaining({ headers: { Authorization: 'Bearer token-abc' } }),
    );
    const keys = r2.put.mock.calls.map((call) => call[0]);
    expect(keys).toContain('incoming-acc-1-msg-v.mp4');
    expect(keys).toContain('incoming-acc-1-msg-v-preview.jpg');
    expect(result?.originalContentUrl).toBe('https://worker.example.com/images/incoming-acc-1-msg-v.mp4');
    expect(result?.previewImageUrl).toBe('https://worker.example.com/images/incoming-acc-1-msg-v-preview.jpg');
  });

  test('preview取得に失敗しても動画本体URLでフォールバックする', async () => {
    const r2 = makeR2Stub();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/content/preview')) {
        return new Response(null, { status: 404 });
      }
      return new Response(new ArrayBuffer(500), {
        status: 200,
        headers: { 'Content-Type': 'video/mp4' },
      });
    });

    const result = await fetchAndStoreIncomingMedia({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock as unknown as typeof fetch,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      accountId: 'acc-1',
      messageId: 'msg-v2',
      messageType: 'video',
    });

    expect(result?.originalContentUrl).toBe('https://worker.example.com/images/incoming-acc-1-msg-v2.mp4');
    expect(result?.previewImageUrl).toBe(result?.originalContentUrl);
    expect(r2.put).toHaveBeenCalledTimes(1);
  });

  test('image指定では preview エンドポイントを叩かない', async () => {
    const r2 = makeR2Stub();
    const fetchMock = vi.fn(async () =>
      new Response(new ArrayBuffer(100), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      }),
    );

    await fetchAndStoreIncomingMedia({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock as unknown as typeof fetch,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      accountId: 'acc-1',
      messageId: 'msg-i',
      messageType: 'image',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r2.put).toHaveBeenCalledTimes(1);
  });
});
