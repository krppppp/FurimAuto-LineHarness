import { describe, it, expect, vi, beforeEach } from 'vitest';

const pushMessage = vi.fn().mockResolvedValue({});
const LineClientMock = vi.fn().mockImplementation((token: string) => ({
  __token: token,
  pushMessage,
}));
vi.mock('@line-crm/line-sdk', () => ({ LineClient: LineClientMock }));

const dbMocks = {
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
  jstNow: vi.fn(() => '2026-07-15T18:00:00.000+09:00'),
  toJstString: vi.fn((d: Date) => d.toISOString()),
};
vi.mock('@line-crm/db', () => dbMocks);

// 送信直前ガードが参照するサブスク discounts スタック
const getSubDiscounts = vi.fn();
vi.mock('../routes/plan-builder.js', () => ({ getSubDiscounts }));

const { processPendingCouponNotifications } = await import('./coupon-notifications.js');

/**
 * D1 の最小 fake。prepare(sql).bind(...).all/run/first を記録し、
 * SELECT (due 行取得) には rows を返す。
 */
function makeDb(dueRows: unknown[]) {
  const executed: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        all: async () => {
          executed.push({ sql, args });
          return { results: dueRows };
        },
        run: async () => {
          executed.push({ sql, args });
          return {};
        },
        first: async () => {
          executed.push({ sql, args });
          return null;
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, executed };
}

const ROW = {
  id: 'cn-1',
  friend_id: 'fr-1',
  subscription_id: 'sub_123',
  coupon_id: 'coupon_abc',
  message: 'クーポンを付与しました',
};

const FRIEND = {
  id: 'fr-1',
  line_user_id: 'Uaaa',
  line_account_id: null,
  is_following: 1,
};

const STACK_WITH_COUPON = [
  { discountId: 'di_combo', couponId: 'combo-f1-s1', name: '併用割引', amountOff: 1980, percentOff: null, duration: 'forever' },
  { discountId: 'di_new', couponId: 'coupon_abc', name: '口コミ感謝クーポン', amountOff: 1000, percentOff: null, duration: 'once' },
];

const env = { LINE_CHANNEL_ACCESS_TOKEN: 'env-token', STRIPE_SECRET_KEY: 'sk_test_x' };

beforeEach(() => {
  vi.clearAllMocks();
  pushMessage.mockResolvedValue({});
  dbMocks.jstNow.mockReturnValue('2026-07-15T18:00:00.000+09:00');
});

describe('processPendingCouponNotifications', () => {
  it('STRIPE_SECRET_KEY 未設定なら何もしない', async () => {
    const { db, executed } = makeDb([ROW]);
    const result = await processPendingCouponNotifications(db, { LINE_CHANNEL_ACCESS_TOKEN: 'x' });
    expect(result).toEqual({ sent: 0, skipped: 0 });
    expect(executed).toHaveLength(0);
    expect(getSubDiscounts).not.toHaveBeenCalled();
  });

  it('サブスクの discounts に coupon が残っている → 送信 + messages_log 記録 + sent', async () => {
    const { db, executed } = makeDb([ROW]);
    getSubDiscounts.mockResolvedValueOnce(STACK_WITH_COUPON);
    dbMocks.getFriendById.mockResolvedValue(FRIEND);

    const result = await processPendingCouponNotifications(db, env);

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(getSubDiscounts).toHaveBeenCalledWith('sk_test_x', 'sub_123');
    expect(LineClientMock).toHaveBeenCalledWith('env-token');
    expect(pushMessage).toHaveBeenCalledWith('Uaaa', [{ type: 'text', text: ROW.message }]);
    expect(executed.some((e) => e.sql.includes('INSERT INTO messages_log'))).toBe(true);
    expect(executed.some((e) => e.sql.includes(`status = 'sent'`))).toBe(true);
  });

  it('friend の line_account_id があればアカウントのトークンで送る', async () => {
    const { db } = makeDb([ROW]);
    getSubDiscounts.mockResolvedValueOnce(STACK_WITH_COUPON);
    dbMocks.getFriendById.mockResolvedValue({ ...FRIEND, line_account_id: 'acct-1' });
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'acct-token' });

    await processPendingCouponNotifications(db, env);

    expect(LineClientMock).toHaveBeenCalledWith('acct-token');
  });

  it('猶予中にスタックから削除されていたら skipped で送信しない (併用割引だけ残存)', async () => {
    const { db, executed } = makeDb([ROW]);
    getSubDiscounts.mockResolvedValueOnce([STACK_WITH_COUPON[0]]);

    const result = await processPendingCouponNotifications(db, env);

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(pushMessage).not.toHaveBeenCalled();
    expect(executed.some((e) => e.sql.includes(`status = 'skipped'`))).toBe(true);
  });

  it('サブスク自体が消えていたら (解約等) skipped', async () => {
    const { db } = makeDb([ROW]);
    getSubDiscounts.mockRejectedValueOnce(new Error('Stripe subscriptions/sub_123: No such subscription'));

    const result = await processPendingCouponNotifications(db, env);

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('ブロック済み友だちは skipped', async () => {
    const { db } = makeDb([ROW]);
    getSubDiscounts.mockResolvedValueOnce(STACK_WITH_COUPON);
    dbMocks.getFriendById.mockResolvedValue({ ...FRIEND, is_following: 0 });

    const result = await processPendingCouponNotifications(db, env);

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('Stripe 一時エラーは pending のまま残す (throw しない)', async () => {
    const { db, executed } = makeDb([ROW]);
    getSubDiscounts.mockRejectedValueOnce(new Error('Stripe subscriptions/sub_123: rate limited'));

    const result = await processPendingCouponNotifications(db, env);

    expect(result).toEqual({ sent: 0, skipped: 0 });
    expect(pushMessage).not.toHaveBeenCalled();
    expect(executed.filter((e) => e.sql.includes('UPDATE'))).toHaveLength(0);
  });
});
