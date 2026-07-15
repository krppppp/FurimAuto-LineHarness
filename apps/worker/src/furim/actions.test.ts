import { describe, it, expect, vi, beforeEach } from 'vitest';

// gasGet だけ差し替え、他の furim モジュールは実体を使う
const gasGet = vi.fn();
vi.mock('./gas-client.js', () => ({ gasGet, gasPost: vi.fn() }));

const { handleFurimAction } = await import('./actions.js');

function makeClient() {
  return {
    replyMessage: vi.fn().mockResolvedValue({}),
    pushMessage: vi.fn().mockResolvedValue({}),
  };
}

const env = { GAS_DEPLOY_ID: 'deploy-id' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('actionKeycodeIssue (キーコード発行のフォールバック)', () => {
  it('正常系: GAS成功 → reply でキーコードを返す', async () => {
    gasGet.mockResolvedValueOnce({ keyCode: 'pb_abcd1234' });
    const client = makeClient();

    const handled = await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】キーコード発行', env);

    expect(handled).toBe(true);
    expect(client.replyMessage).toHaveBeenCalledWith('rt', [{ type: 'text', text: 'pb_abcd1234' }]);
    expect(client.pushMessage).not.toHaveBeenCalled();
  });

  it('reply が失敗 (replyToken失効) → 同じ内容を push で届ける', async () => {
    gasGet.mockResolvedValueOnce({ keyCode: 'pb_abcd1234' });
    const client = makeClient();
    client.replyMessage.mockRejectedValueOnce(new Error('Invalid reply token'));

    await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】キーコード発行', env);

    expect(client.pushMessage).toHaveBeenCalledWith('Uxxx', [{ type: 'text', text: 'pb_abcd1234' }]);
  });

  it('GAS 1回目失敗 → リトライ成功で通常返信', async () => {
    gasGet.mockRejectedValueOnce(new Error('GAS GET 500')).mockResolvedValueOnce({ keyCode: 'pb_abcd1234' });
    const client = makeClient();

    await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】キーコード発行', env);

    expect(gasGet).toHaveBeenCalledTimes(2);
    expect(client.replyMessage).toHaveBeenCalledWith('rt', [{ type: 'text', text: 'pb_abcd1234' }]);
  });

  it('GAS 2回失敗 → push で再操作を案内 (無言にしない)', async () => {
    gasGet.mockRejectedValue(new Error('GAS GET 500'));
    const client = makeClient();

    await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】キーコード発行', env);

    expect(client.replyMessage).not.toHaveBeenCalled();
    expect(client.pushMessage).toHaveBeenCalledTimes(1);
    expect((client.pushMessage.mock.calls[0][1] as { text: string }[])[0].text).toContain('もう一度');
  });

  it('該当レコードなし (エラーコード401) → 準備中案内を返す', async () => {
    gasGet.mockResolvedValueOnce({ keyCode: 'エラーコード(401)' });
    const client = makeClient();

    await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】キーコード発行', env);

    expect((client.replyMessage.mock.calls[0][1] as { text: string }[])[0].text).toContain('準備中');
  });
});

describe('handleFurimAction の汎用エラーフォールバック', () => {
  it('アクション内で例外 → push でエラー案内 (無言にしない)', async () => {
    // 月額会員ページは STRIPE_SECRET_KEY ありで GAS を呼ぶ — gasGet を落として例外経路に入れる
    gasGet.mockRejectedValue(new Error('boom'));
    const client = makeClient();

    const handled = await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】月額会員ページ', {
      GAS_DEPLOY_ID: 'deploy-id',
      STRIPE_SECRET_KEY: 'sk_test_x',
    });

    expect(handled).toBe(true);
    expect(client.pushMessage).toHaveBeenCalledTimes(1);
    expect((client.pushMessage.mock.calls[0][1] as { text: string }[])[0].text).toContain('エラーが発生しました');
  });
});
