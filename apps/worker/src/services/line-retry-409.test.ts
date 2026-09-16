import { describe, it, expect, vi, afterEach } from 'vitest';
import { LineClient } from '@line-crm/line-sdk';

/**
 * 再送キー付きの 409 を成功として扱う（Capsec #287）。
 *
 * LINE は同じ X-Line-Retry-Key の送信を受理済みのとき 409 を返す。これを失敗にすると、
 * 配信の 2 段階記録が done にならず、stripe_events が完了しないまま試行を使い切って止まる。
 * 2026-08〜09 に継続課金メッセージのアクションが 10 件そのままになった。
 */
const ACCEPTED = JSON.stringify({ message: 'The retry key is already accepted', sentMessages: [{ id: '123' }] });

function mockFetch(status: number, body: string) {
  const spy = vi.fn(async () => new Response(body, { status, headers: { 'content-type': 'application/json' } }));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LINE 409 の扱い', () => {
  it('再送キーを付けた送信の 409 は成功として扱い、応答の中身を返す', async () => {
    mockFetch(409, ACCEPTED);
    const res = (await new LineClient('token').pushMessage('U1', [{ type: 'text', text: 'hi' }], { retryKey: 'key-1' })) as {
      message: string;
      sentMessages: Array<{ id: string }>;
    };
    expect(res.message).toContain('already accepted');
    expect(res.sentMessages[0].id).toBe('123');
  });

  it('再送キーを付けていない 409 は今までどおり例外にする', async () => {
    mockFetch(409, ACCEPTED);
    await expect(new LineClient('token').pushMessage('U1', [{ type: 'text', text: 'hi' }])).rejects.toThrow('409');
  });

  it('再送キーを付けていても 400 は例外のまま', async () => {
    mockFetch(400, JSON.stringify({ message: 'invalid' }));
    await expect(
      new LineClient('token').pushMessage('U1', [{ type: 'text', text: 'hi' }], { retryKey: 'key-1' }),
    ).rejects.toThrow('400');
  });

  it('再送キーは X-Line-Retry-Key ヘッダで送る', async () => {
    const calls: unknown[][] = [];
    globalThis.fetch = (async (...args: unknown[]) => {
      calls.push(args);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await new LineClient('token').pushMessage('U1', [{ type: 'text', text: 'hi' }], { retryKey: 'key-9' });
    const init = calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['X-Line-Retry-Key']).toBe('key-9');
  });
});
