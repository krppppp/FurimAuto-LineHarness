import { describe, it, expect, vi, beforeEach } from 'vitest';

// gasGet/gasPost を差し替え、他は実体を使う
const gasGet = vi.fn();
vi.mock('./gas-client.js', () => ({ gasGet, gasPost: vi.fn() }));

const { processReferral, handleKeywordAction } = await import('./keyword-actions.js');

function makeClient() {
  return {
    replyMessage: vi.fn().mockResolvedValue({}),
    pushMessage: vi.fn().mockResolvedValue({}),
  };
}

/**
 * SQL文字列でルーティングする簡易 D1。
 * - friends 取得 → { id: 'friend1' }
 * - tags(紹介経由) 取得 → { id: 'introtag' }
 * - friend_tags 存在チェック → opts.alreadyReferred で true/null
 */
function makeDb(opts: { alreadyReferred: boolean }) {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => {
              if (/FROM friends WHERE line_user_id/.test(sql)) return { id: 'friend1' };
              if (/FROM tags WHERE name/.test(sql)) return { id: 'introtag' };
              if (/FROM friend_tags WHERE friend_id/.test(sql)) return opts.alreadyReferred ? { 1: 1 } : null;
              return null;
            },
            run: async () => ({}),
          };
        },
      };
    },
  };
}

const env = { GAS_DEPLOY_ID: 'deploy-id', STRIPE_SECRET_KEY: 'sk_test' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('processReferral 冪等ガード', () => {
  it('被紹介者に既に紹介経由タグがある → GAS/Stripe を呼ばず already_referred で return', async () => {
    const client = makeClient();
    const db = makeDb({ alreadyReferred: true });

    const result = await processReferral(client as never, 'Uintroduced', 'AMB12345', env, db as never, {});

    expect(result).toEqual({ ok: false, reason: 'already_referred' });
    expect(gasGet).not.toHaveBeenCalled();
    expect(client.replyMessage).not.toHaveBeenCalled();
    expect(client.pushMessage).not.toHaveBeenCalled();
  });

  it('紹介経由タグ無し → ガードを通過し GAS を呼ぶ（無効codeは invalid_code）', async () => {
    gasGet.mockResolvedValueOnce({}); // introducedCouponID 無し → invalid_code で早期return
    const client = makeClient();
    const db = makeDb({ alreadyReferred: false });

    const result = await processReferral(client as never, 'Uintroduced', 'AMB12345', env, db as never, { replyToken: 'rt' });

    expect(gasGet).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, reason: 'invalid_code' });
    // replyToken あり → reply でエラー通知
    expect(client.replyMessage).toHaveBeenCalled();
  });

  it('被紹介者が有料会員（GAS res=ineligible_paid_member）→ 対象外の趣旨を返答し paid_member で return', async () => {
    gasGet.mockResolvedValueOnce({ res: 'ineligible_paid_member' });
    const client = makeClient();
    const db = makeDb({ alreadyReferred: false });

    const result = await processReferral(client as never, 'Uintroduced', 'AMB12345', env, db as never, { replyToken: 'rt' });

    expect(result).toEqual({ ok: false, reason: 'paid_member' });
    expect(client.replyMessage).toHaveBeenCalled();
    const msg = (client.replyMessage.mock.calls[0][1] as { text: string }[])[0].text;
    expect(msg).toContain('対象外');
  });

  it('自己紹介（ambassadorLineID === 被紹介者）→ self_referral で return', async () => {
    gasGet.mockResolvedValueOnce({ introducedCouponID: 'cp_1', introducedStripeID: 'cus_1', ambassadorLineID: 'Uintroduced' });
    const client = makeClient();
    const db = makeDb({ alreadyReferred: false });

    const result = await processReferral(client as never, 'Uintroduced', 'AMB12345', env, db as never, {});

    expect(result).toEqual({ ok: false, reason: 'self_referral' });
  });
});

describe('handleKeywordAction キーコードリセットの特別対応', () => {
  it('【キーワード】プレフィックスなしの単体文字列でも resetKeyCode が呼ばれる', async () => {
    gasGet.mockResolvedValueOnce({});
    const client = makeClient();

    const result = await handleKeywordAction(client as never, 'Uuser', 'rt', 'キーコードリセット', env);

    expect(result).toBe(true);
    expect(gasGet).toHaveBeenCalledWith('deploy-id', { method: 'resetKeyCode', lineUserId: 'Uuser' });
    expect(client.replyMessage).toHaveBeenCalledWith('rt', [{ type: 'text', text: '紐づいた設定のリセットが完了しました。' }]);
  });

  it('文中に含まれる場合でも部分一致で発火する（既存の他キーワードと同じ判定方式）', async () => {
    gasGet.mockResolvedValueOnce({});
    const client = makeClient();

    const result = await handleKeywordAction(client as never, 'Uuser', 'rt', 'お手数ですがキーコードリセットお願いします', env);

    expect(result).toBe(true);
    expect(gasGet).toHaveBeenCalledWith('deploy-id', { method: 'resetKeyCode', lineUserId: 'Uuser' });
  });

  it('従来通り【キーワード】プレフィックス付きでも動く', async () => {
    gasGet.mockResolvedValueOnce({});
    const client = makeClient();

    const result = await handleKeywordAction(client as never, 'Uuser', 'rt', '【キーワード】キーコードリセット', env);

    expect(result).toBe(true);
    expect(gasGet).toHaveBeenCalledWith('deploy-id', { method: 'resetKeyCode', lineUserId: 'Uuser' });
  });

  it('replyが失敗してもpushで完了通知を届ける（リセット自体は成功しているため）', async () => {
    gasGet.mockResolvedValueOnce({});
    const client = makeClient();
    client.replyMessage.mockRejectedValueOnce(new Error('Invalid reply token'));

    const result = await handleKeywordAction(client as never, 'Uuser', 'rt', '【キーワード】キーコードリセット', env);

    expect(result).toBe(true);
    // 例外を外へ投げない（呼び出し元がエラー文言に化けさせないため）
    expect(client.pushMessage).toHaveBeenCalledWith('Uuser', [{ type: 'text', text: '紐づいた設定のリセットが完了しました。' }]);
  });

  it('replyが成功したときはpushしない（無駄な二重送信をしない）', async () => {
    gasGet.mockResolvedValueOnce({});
    const client = makeClient();

    await handleKeywordAction(client as never, 'Uuser', 'rt', 'キーコードリセット', env);

    expect(client.replyMessage).toHaveBeenCalledTimes(1);
    expect(client.pushMessage).not.toHaveBeenCalled();
  });

  it('無関係なメッセージには反応しない', async () => {
    const client = makeClient();

    const result = await handleKeywordAction(client as never, 'Uuser', 'rt', 'こんにちは', env);

    expect(result).toBe(false);
    expect(gasGet).not.toHaveBeenCalled();
    expect(client.replyMessage).not.toHaveBeenCalled();
  });
});
