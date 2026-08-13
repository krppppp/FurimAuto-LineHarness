import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@line-crm/db', () => ({
  getFriendByLineUserId: vi.fn(),
  jstNow: vi.fn(() => '2026-07-21T12:00:00.000+09:00'),
  toJstString: vi.fn((d: Date) => d.toISOString().replace('Z', '+09:00')),
  getStalePendingStripeEvents: vi.fn(),
  claimStripeEventForRetry: vi.fn(),
  markStripeEventCompleted: vi.fn(),
  markStripeEventFailed: vi.fn(),
  applyScoring: vi.fn(),
  updateFriendPlanName: vi.fn(),
}));

vi.mock('../furim/gas-client.js', () => ({
  gasGet: vi.fn(),
  gasPost: vi.fn(),
}));

vi.mock('./event-bus.js', () => ({
  // 既定は automations 全成功(true)。invoiceハンドラは false のとき throw して再処理に回す。
  fireEvent: vi.fn().mockResolvedValue(true),
}));

vi.mock('../utils/message-log.js', () => ({
  logOutgoing: vi.fn(),
}));

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => ({ pushMessage: vi.fn() })),
}));

import {
  getFriendByLineUserId,
  getStalePendingStripeEvents,
  claimStripeEventForRetry,
  markStripeEventCompleted,
  markStripeEventFailed,
  updateFriendPlanName,
} from '@line-crm/db';
import { gasGet } from '../furim/gas-client.js';
import { fireEvent } from './event-bus.js';
import { processStripeEvent, sweepPendingStripeEvents } from './stripe-processor.js';

function makeDb(recentAutomationRow: unknown = null) {
  const stmt = {
    bind: vi.fn(),
    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn().mockResolvedValue(recentAutomationRow),
  };
  stmt.bind.mockReturnValue(stmt);
  return { db: { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database, stmt };
}

const env = {
  LINE_CHANNEL_ACCESS_TOKEN: 'tok',
  GAS_DEPLOY_ID: 'gas-deploy-1',
} as never;

function failedBody(attemptCount: number) {
  return {
    id: 'evt_pf_1',
    type: 'invoice.payment_failed',
    data: { object: { id: 'in_1', customer: 'cus_1', attempt_count: attemptCount } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gasGet).mockResolvedValue({ customer_line_id: 'U-fail' });
});

describe('processStripeEvent — invoice.payment_failed 通知判定', () => {
  test('新規Checkout中(subscription_create × attempt=0)は通知もautomationもしない（3DS途中経過）', async () => {
    const { db } = makeDb(null);
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);

    await processStripeEvent(db, env, {
      id: 'evt_pf_3ds',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_3ds', customer: 'cus_3ds', billing_reason: 'subscription_create', attempt_count: 0 } },
    });

    expect(fireEvent).not.toHaveBeenCalled();
  });

  test('継続課金の失敗(subscription_cycle × attempt=0相当)は従来どおり通知する', async () => {
    const { db } = makeDb(null);
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);

    await processStripeEvent(db, env, {
      id: 'evt_pf_cycle',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_cycle', customer: 'cus_cycle', billing_reason: 'subscription_cycle', attempt_count: 0 } },
    });

    expect(fireEvent).toHaveBeenCalledTimes(1);
  });

  test('初回失敗(attempt=1)は通知する', async () => {
    const { db } = makeDb(null);
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);

    await processStripeEvent(db, env, failedBody(1));

    expect(fireEvent).toHaveBeenCalledWith(
      db, 'stripe_payment_failed',
      expect.objectContaining({ friendId: 'friend-1' }),
      'tok', null, expect.anything(),
    );
  });

  test('リトライ(attempt=3)でも直近14日に通知実績が無ければ通知する（初回通知消失の救済）', async () => {
    const { db } = makeDb(null);
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);

    await processStripeEvent(db, env, failedBody(3));

    expect(fireEvent).toHaveBeenCalledTimes(1);
  });

  test('直近14日に通知実績があればスキップ（リトライスパム防止）', async () => {
    const { db } = makeDb({ id: 'log-1' });
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);

    await processStripeEvent(db, env, failedBody(2));

    expect(fireEvent).not.toHaveBeenCalled();
  });

  test('友だち未特定ならattempt=1のみ通知（従来動作）', async () => {
    const { db } = makeDb(null);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(null as never);

    await processStripeEvent(db, env, failedBody(2));
    expect(fireEvent).not.toHaveBeenCalled();

    await processStripeEvent(db, env, failedBody(1));
    expect(fireEvent).toHaveBeenCalledTimes(1);
  });
});

describe('sweepPendingStripeEvents — cron再処理', () => {
  test('滞留pendingをクレームして処理し、completedにする', async () => {
    const { db } = makeDb(null);
    vi.mocked(getStalePendingStripeEvents).mockResolvedValue([
      { id: 'row-1', stripe_event_id: 'evt_x', event_type: 'noop.event', attempts: 1, payload: JSON.stringify({ id: 'evt_x', type: 'noop.event', data: { object: { id: 'x' } } }) } as never,
    ]);
    vi.mocked(claimStripeEventForRetry).mockResolvedValue(true);

    await sweepPendingStripeEvents(db, env);

    expect(claimStripeEventForRetry).toHaveBeenCalledWith(db, 'row-1', 1);
    expect(markStripeEventCompleted).toHaveBeenCalledWith(db, 'row-1');
    expect(markStripeEventFailed).not.toHaveBeenCalled();
  });

  test('payload無し（052以前の行）はfailedにして触らない', async () => {
    const { db } = makeDb(null);
    vi.mocked(getStalePendingStripeEvents).mockResolvedValue([
      { id: 'row-old', stripe_event_id: 'evt_old', event_type: 'invoice.payment_succeeded', attempts: 0, payload: null } as never,
    ]);

    await sweepPendingStripeEvents(db, env);

    expect(claimStripeEventForRetry).not.toHaveBeenCalled();
    expect(markStripeEventFailed).toHaveBeenCalledWith(db, 'row-old', expect.stringContaining('no payload'), false);
  });

  test('別tickが先にクレーム済みなら処理しない', async () => {
    const { db } = makeDb(null);
    vi.mocked(getStalePendingStripeEvents).mockResolvedValue([
      { id: 'row-1', stripe_event_id: 'evt_x', event_type: 'noop.event', attempts: 2, payload: '{}' } as never,
    ]);
    vi.mocked(claimStripeEventForRetry).mockResolvedValue(false);

    await sweepPendingStripeEvents(db, env);

    expect(markStripeEventCompleted).not.toHaveBeenCalled();
    expect(markStripeEventFailed).not.toHaveBeenCalled();
  });

  test('処理が失敗したら最終試行(4回目)でfailed、それ以外はpendingのまま', async () => {
    const { db } = makeDb(null);
    vi.mocked(claimStripeEventForRetry).mockResolvedValue(true);
    vi.mocked(getStalePendingStripeEvents).mockResolvedValue([
      { id: 'row-1', stripe_event_id: 'evt_x', event_type: 'invoice.payment_failed', attempts: 1, payload: 'not-json{' } as never,
    ]);
    await sweepPendingStripeEvents(db, env);
    expect(markStripeEventFailed).toHaveBeenCalledWith(db, 'row-1', expect.any(String), true);

    vi.clearAllMocks();
    vi.mocked(claimStripeEventForRetry).mockResolvedValue(true);
    vi.mocked(getStalePendingStripeEvents).mockResolvedValue([
      { id: 'row-2', stripe_event_id: 'evt_y', event_type: 'invoice.payment_failed', attempts: 3, payload: 'not-json{' } as never,
    ]);
    await sweepPendingStripeEvents(db, env);
    expect(markStripeEventFailed).toHaveBeenCalledWith(db, 'row-2', expect.any(String), false);
  });
});

describe('processStripeEvent — invoice_paid の冪等/再処理', () => {
  test('isRetry時もfireEventする（二重送信防止はevent-bus側のaction単位冪等が担保）', async () => {
    const { db } = makeDb({ id: 'log-1' });
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);
    vi.mocked(gasGet).mockResolvedValue({ customer_line_id: 'U-paid' });

    await processStripeEvent(db, env, {
      id: 'evt_ip_1',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_9', customer: 'cus_9', billing_reason: 'subscription_cycle' } },
    }, { isRetry: true });

    // fireEvent は呼ばれ、payload に冪等キー(stripe event id)が渡る
    expect(fireEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fireEvent).mock.calls[0][2]).toMatchObject({ idempotencyKey: 'evt_ip_1' });
  });

  test('初回実行も冪等キー付きでfireEventする', async () => {
    const { db } = makeDb({ id: 'log-1' });
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);
    vi.mocked(gasGet).mockResolvedValue({ customer_line_id: 'U-paid' });

    await processStripeEvent(db, env, {
      id: 'evt_ip_2',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_10', customer: 'cus_10', billing_reason: 'subscription_cycle' } },
    });

    expect(fireEvent).toHaveBeenCalledWith(
      db, 'stripe_invoice_paid',
      expect.objectContaining({ idempotencyKey: 'evt_ip_2' }),
      'tok', null, expect.anything(),
    );
  });

  test('再処理で継続課金メッセージが送信済みなら配信だけ抑制する', async () => {
    // first() が行を返す = automationRanRecently が true（初回のfireEventがsuccessまで到達済み）
    const { db } = makeDb({ id: 'log-1' });
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);
    vi.mocked(gasGet).mockResolvedValue({ customer_line_id: 'U-paid' });

    await processStripeEvent(db, env, {
      id: 'evt_ip_dup',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_dup', customer: 'cus_dup', billing_reason: 'subscription_cycle' } },
    }, { isRetry: true });

    // 配信は抑制するが、fireEvent自体は呼ぶ（GAS台帳記録など未完了の処理は再実行させる）
    expect(fireEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fireEvent).mock.calls[0][2].eventData).toMatchObject({ suppressMessages: true });
  });

  test('再処理でも未送信なら抑制しない', async () => {
    // first() が null = automationRanRecently が false（初回がfireEventに到達せず死んだ）
    const { db } = makeDb(null);
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);
    vi.mocked(gasGet).mockResolvedValue({ customer_line_id: 'U-paid' });

    await processStripeEvent(db, env, {
      id: 'evt_ip_nodup',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_nodup', customer: 'cus_nodup', billing_reason: 'subscription_cycle' } },
    }, { isRetry: true });

    expect(vi.mocked(fireEvent).mock.calls[0][2].eventData).toMatchObject({ suppressMessages: false });
  });

  test('初回実行は直近実績があっても抑制しない', async () => {
    const { db } = makeDb({ id: 'log-1' });
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);
    vi.mocked(gasGet).mockResolvedValue({ customer_line_id: 'U-paid' });

    await processStripeEvent(db, env, {
      id: 'evt_ip_first',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_first', customer: 'cus_first', billing_reason: 'subscription_cycle' } },
    });

    expect(vi.mocked(fireEvent).mock.calls[0][2].eventData).toMatchObject({ suppressMessages: false });
  });

  test('automationが未完(false)ならthrowする → sweepがcompletedにせず再処理する', async () => {
    const { db } = makeDb({ id: 'log-1' });
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);
    vi.mocked(gasGet).mockResolvedValue({ customer_line_id: 'U-paid' });
    vi.mocked(fireEvent).mockResolvedValueOnce(false as never);

    await expect(processStripeEvent(db, env, {
      id: 'evt_ip_3',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_11', customer: 'cus_11', billing_reason: 'subscription_cycle' } },
    })).rejects.toThrow(/incomplete/);
  });
});

describe('processStripeEvent — invoice_paid でのプラン名D1同期', () => {
  test('legacyサブスクのプラン名(sub.plan.nickname)を resolvedLineUserId で D1へ同期する', async () => {
    const { db } = makeDb({ id: 'log-1' });
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);
    // metadata に lineUserId が無いケース → GAS逆引きで resolvedLineUserId が確定する
    vi.mocked(gasGet).mockResolvedValue({ customer_line_id: 'U-plan' });
    const fetchStub = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/v1/subscriptions/')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ plan: { nickname: 'プレミアムプラン' }, items: { data: [] }, metadata: {} }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchStub);

    try {
      await processStripeEvent(db, { ...env, STRIPE_SECRET_KEY: 'sk_test_1' } as never, {
        id: 'evt_plan_1',
        type: 'invoice.payment_succeeded',
        data: {
          object: {
            id: 'in_plan_1',
            customer: 'cus_plan_1',
            billing_reason: 'subscription_cycle',
            subscription: 'sub_plan_1',
          },
        },
      });

      // friendId(metadata由来、未解決でnull)ではなく resolvedLineUserId(GAS逆引き)で更新される
      expect(updateFriendPlanName).toHaveBeenCalledWith(db, 'U-plan', 'プレミアムプラン');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('プラン名が確定しない場合は同期しない（STRIPE_SECRET_KEY未設定でsubscriptions.retrieveがスキップされるケース）', async () => {
    const { db } = makeDb({ id: 'log-1' });
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);
    vi.mocked(gasGet).mockResolvedValue({ customer_line_id: 'U-noplan' });

    await processStripeEvent(db, env, {
      id: 'evt_plan_2',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_plan_2', customer: 'cus_plan_2', billing_reason: 'subscription_cycle' } },
    });

    expect(updateFriendPlanName).not.toHaveBeenCalled();
  });
});
