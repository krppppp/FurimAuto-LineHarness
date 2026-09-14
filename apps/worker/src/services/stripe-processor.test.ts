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
  hasProcessedStripeAction: vi.fn().mockResolvedValue(false),
  markStripeActionProcessed: vi.fn(),
}));

// getGasErrorFromResponse は実実装を使う（success:false 検知のテストのため）
vi.mock('../furim/gas-client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gasGet: vi.fn(),
  gasPost: vi.fn(),
}));

vi.mock('../furim/gas-retry-queue.js', () => ({
  enqueueGasRetryJob: vi.fn(),
}));

// 段階2（Capsec #244 の残）: 既定は D1 側の同期が失敗 → 従来の GAS 判定にフォールバックする経路をテストする。
// Worker 決定の経路は個別のテストで mockResolvedValueOnce する
vi.mock('../furim/feature-flags.js', () => ({
  applyPlanBuilderSync: vi.fn().mockRejectedValue(new Error('furim_master empty (test default)')),
  gasSyncArgs: (r: { keyCode: string; keyCodeIssued: boolean; planLabel: string; flags: Record<string, string> }) => ({ keyCode: r.keyCode, keyCodeIssued: r.keyCodeIssued, planLabel: r.planLabel, flags: r.flags }),
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

// lineUserId: Stripe顧客ID → LINE ID の逆引き（furim_customers）の結果。段階2.5 で GAS getLINEIDwithStripeID は削除され D1 だけを見る。
// Error を渡すと逆引きクエリが失敗する（D1 障害の再現）
function makeDb(recentAutomationRow: unknown = null, lineUserId: string | null | Error = 'U-fail') {
  let lastSql = '';
  const stmt = {
    bind: vi.fn(),
    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn().mockImplementation(async () => {
      if (/FROM furim_customers WHERE stripe_customer_id/.test(lastSql)) {
        if (lineUserId instanceof Error) throw lineUserId;
        return lineUserId ? { line_user_id: lineUserId } : null;
      }
      return recentAutomationRow;
    }),
  };
  stmt.bind.mockReturnValue(stmt);
  const prepare = vi.fn().mockImplementation((sql: string) => { lastSql = sql; return stmt; });
  return { db: { prepare } as unknown as D1Database, stmt };
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

  test('再処理でも直近のautomation実績では配信を抑制しない（2026-08-25にガード廃止）', async () => {
    // first() が行を返す = automation_logs に直近successがある状態。
    // 旧実装はこれを「送信済み」とみなして suppress していたが、successは条件不一致で
    // スキップされたアクションも含むため、1通も送っていない配信を止めていた
    // （継続課金メッセージ6件未達）。二重送信防止は event-bus の2段階機構が担う
    const { db } = makeDb({ id: 'log-1' });
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);
    vi.mocked(gasGet).mockResolvedValue({ customer_line_id: 'U-paid' });

    await processStripeEvent(db, env, {
      id: 'evt_ip_dup',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_dup', customer: 'cus_dup', billing_reason: 'subscription_cycle' } },
    }, { isRetry: true });

    expect(fireEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fireEvent).mock.calls[0][2].eventData).toMatchObject({ suppressMessages: false });
  });

  test('プラン変更の差額invoiceは配信を抑制する（唯一残る抑制条件）', async () => {
    const { db } = makeDb(null);
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);
    vi.mocked(gasGet).mockResolvedValue({ customer_line_id: 'U-paid' });

    await processStripeEvent(db, env, {
      id: 'evt_ip_upd',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_upd', customer: 'cus_upd', billing_reason: 'subscription_update' } },
    });

    expect(vi.mocked(fireEvent).mock.calls[0][2].eventData).toMatchObject({ suppressMessages: true });
  });

  test('再処理でも未送信なら抑制しない', async () => {
    // first() が null = automation_logs に直近successが無い状態
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
    // ガード廃止後も期待値は同じ（初回・再処理を問わず抑制しない）
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
    const { db } = makeDb({ id: 'log-1' }, 'U-plan');
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);
    // metadata に lineUserId が無いケース → D1 furim_customers の逆引きで resolvedLineUserId が確定する
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

      // friendId(metadata由来、未解決でnull)ではなく resolvedLineUserId(D1逆引き)で更新される
      expect(updateFriendPlanName).toHaveBeenCalledWith(db, 'U-plan', 'プレミアムプラン');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('プラン名が確定しない場合は同期しない（STRIPE_SECRET_KEY未設定でsubscriptions.retrieveがスキップされるケース）', async () => {
    const { db } = makeDb({ id: 'log-1' }, 'U-noplan');
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);

    await processStripeEvent(db, env, {
      id: 'evt_plan_2',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_plan_2', customer: 'cus_plan_2', billing_reason: 'subscription_cycle' } },
    });

    expect(updateFriendPlanName).not.toHaveBeenCalled();
  });
});

import { hasProcessedStripeAction, markStripeActionProcessed } from '@line-crm/db';
import { gasPost } from '../furim/gas-client.js';
import { enqueueGasRetryJob } from '../furim/gas-retry-queue.js';

describe('processStripeEvent — GAS失敗のキュー退避（2026-08-14 Stripe経路統合）', () => {
  test('furim_customers の逆引き失敗＋metadataフォールバック不成立ならthrowしてsweep再試行に委ねる', async () => {
    const { db } = makeDb(null, new Error('D1 down'));

    await expect(processStripeEvent(db, env, {
      id: 'evt_lookup_1',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_l1', customer: 'cus_l1', billing_reason: 'subscription_cycle' } },
    })).rejects.toThrow(/furim_customers lookup failed/);
  });

  test('furim_customers の逆引きが失敗しても subscription metadata で解決できれば続行する', async () => {
    const { db } = makeDb({ id: 'log-1' }, new Error('D1 down'));
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);
    const fetchStub = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/v1/subscriptions/')) {
        return Promise.resolve({ ok: true, json: async () => ({ plan: { nickname: 'テストプラン' }, items: { data: [] }, metadata: { lineUserId: 'U-meta' } }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchStub);

    try {
      await expect(processStripeEvent(db, { ...(env as object), STRIPE_SECRET_KEY: 'sk_test_1' } as never, {
        id: 'evt_lookup_2',
        type: 'invoice.payment_succeeded',
        data: { object: { id: 'in_l2', customer: 'cus_l2', billing_reason: 'subscription_cycle', subscription: 'sub_l2' } },
      })).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('plan-builderのsyncFeatures失敗はキュー退避＋実行済みマークして処理を続行する', async () => {
    const { db } = makeDb({ id: 'log-1' }, 'U-pb');
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);
    vi.mocked(gasPost).mockRejectedValueOnce(new Error('GAS fetch hang'));
    const fetchStub = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/v1/subscriptions/')) {
        return Promise.resolve({ ok: true, json: async () => ({ items: { data: [] }, metadata: { source: 'plan-builder', lineUserId: 'U-pb', packages: 'premium' } }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchStub);

    try {
      await expect(processStripeEvent(db, { ...(env as object), STRIPE_SECRET_KEY: 'sk_test_1' } as never, {
        id: 'evt_pb_q1',
        type: 'invoice.payment_succeeded',
        data: { object: { id: 'in_pb1', customer: 'cus_pb1', billing_reason: 'subscription_cycle', subscription: 'sub_pb1' } },
      })).resolves.toBeUndefined();

      expect(enqueueGasRetryJob).toHaveBeenCalledTimes(1);
      const job = vi.mocked(enqueueGasRetryJob).mock.calls[0][1];
      expect(job).toMatchObject({
        lineUserId: 'U-pb',
        method: 'syncFeaturesFromSubscription',
        callType: 'post',
        dedupeKey: 'syncFeaturesFromSubscription:evt_pb_q1',
        maxAttempts: 20,
      });
      expect((job.params as Record<string, unknown>).__notifyKeycodeReissue).toBe('1');
      expect(markStripeActionProcessed).toHaveBeenCalledWith(db, 'evt_pb_q1', 'hardcoded:sync-features');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('sync-featuresが実行済みマーク済みならGASを呼ばない（sweep再実行とキューの二重経路防止）', async () => {
    const { db } = makeDb({ id: 'log-1' }, 'U-pb');
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1', plan_name: 'PBプラン:premium' } as never);
    vi.mocked(hasProcessedStripeAction).mockResolvedValueOnce(true as never);
    const fetchStub = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/v1/subscriptions/')) {
        return Promise.resolve({ ok: true, json: async () => ({ items: { data: [] }, metadata: { source: 'plan-builder', lineUserId: 'U-pb', packages: 'premium' } }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchStub);

    try {
      await processStripeEvent(db, { ...(env as object), STRIPE_SECRET_KEY: 'sk_test_1' } as never, {
        id: 'evt_pb_q2',
        type: 'invoice.payment_succeeded',
        data: { object: { id: 'in_pb2', customer: 'cus_pb2', billing_reason: 'subscription_cycle', subscription: 'sub_pb2' } },
      }, { isRetry: true });

      expect(gasPost).not.toHaveBeenCalled();
      expect(enqueueGasRetryJob).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

import { applyPlanBuilderSync } from '../furim/feature-flags.js';

describe('processStripeEvent — plan-builder の同期は Worker が決めて D1 に先に書く（Capsec #244 段階2 の残）', () => {
  test('Worker の決定値（keyCode/flags/planLabel）を GAS に渡し、再発行なら新キーコードを push する', async () => {
    const { db } = makeDb({ id: 'log-1' }, 'U-pb');
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);
    vi.mocked(applyPlanBuilderSync).mockResolvedValueOnce({
      keyCode: 'pb_new12345', keyCodeIssued: true, keyCodeReissued: true, previousKeyCode: 'pb_old', planLabel: 'PBプラン:メルカリ 全自動化プラン',
      flags: { mChangePrice: '1', AutoMultiChannel: '' }, ticketsGranted: 200,
    });
    vi.mocked(gasPost).mockResolvedValueOnce({ success: true });
    const fetchStub = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/v1/subscriptions/')) {
        return Promise.resolve({ ok: true, json: async () => ({ items: { data: [] }, metadata: { source: 'plan-builder', lineUserId: 'U-pb', packages: 'premium' } }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchStub);
    try {
      await processStripeEvent(db, { ...(env as object), STRIPE_SECRET_KEY: 'sk_test_1' } as never, {
        id: 'evt_pb_d1',
        type: 'invoice.payment_succeeded',
        data: { object: { id: 'in_pbd1', customer: 'cus_pbd1', billing_reason: 'subscription_cycle', subscription: 'sub_pbd1' } },
      });
      expect(applyPlanBuilderSync).toHaveBeenCalledWith(db, undefined, 'gas-deploy-1', expect.objectContaining({
        lineUserId: 'U-pb', packages: 'premium', grantPremiumTickets: true, invoiceId: 'in_pbd1', planLabel: 'PBプラン:premium',
      }));
      const gasCall = vi.mocked(gasPost).mock.calls.find((c) => (c[1] as { method?: string }).method === 'syncFeaturesFromSubscription');
      expect(gasCall?.[1]).toMatchObject({ keyCode: 'pb_new12345', keyCodeIssued: true, planLabel: 'PBプラン:メルカリ 全自動化プラン', flags: { mChangePrice: '1' } });
      // Worker が決めたのでフォールバック用の取り込み（GAS 応答の absorb）は走らず、プラン名は Worker の合成値
      expect(updateFriendPlanName).toHaveBeenCalledWith(db, 'U-pb', 'PBプラン:メルカリ 全自動化プラン');
      expect(enqueueGasRetryJob).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('D1 に書けたあと GAS が落ちたら鏡写しだけ再実行キューへ（Worker 決定値つき・sweep からの再発行通知は無し）', async () => {
    const { db } = makeDb({ id: 'log-1' }, 'U-pb');
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-1' } as never);
    vi.mocked(applyPlanBuilderSync).mockResolvedValueOnce({
      keyCode: 'pb_same', keyCodeIssued: false, keyCodeReissued: false, previousKeyCode: 'pb_same', planLabel: 'PBプラン:X', flags: { mChangePrice: '1' }, ticketsGranted: 0,
    });
    vi.mocked(gasPost).mockRejectedValueOnce(new Error('GAS fetch hang'));
    const fetchStub = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/v1/subscriptions/')) {
        return Promise.resolve({ ok: true, json: async () => ({ items: { data: [] }, metadata: { source: 'plan-builder', lineUserId: 'U-pb', packages: 'premium' } }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchStub);
    try {
      await processStripeEvent(db, { ...(env as object), STRIPE_SECRET_KEY: 'sk_test_1' } as never, {
        id: 'evt_pb_d2',
        type: 'invoice.payment_succeeded',
        data: { object: { id: 'in_pbd2', customer: 'cus_pbd2', billing_reason: 'subscription_cycle', subscription: 'sub_pbd2' } },
      });
      const job = vi.mocked(enqueueGasRetryJob).mock.calls[0][1];
      expect(job.params).toMatchObject({ keyCode: 'pb_same', flags: { mChangePrice: '1' }, __notifyKeycodeReissue: '0' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('processStripeEvent — customer.subscription.deleted（Capsec #263 (4) furim_customers.canceled_at を消した後）', () => {
  test('顧客マスターには canceled_at を書かず、解約日時は furim_cancellations に残る', async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        const entry = { sql, args: [] as unknown[] };
        calls.push(entry);
        const stmt = {
          bind: (...args: unknown[]) => { entry.args = args; return stmt; },
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          all: vi.fn().mockResolvedValue({ results: [] }),
          first: vi.fn().mockImplementation(async () => (/FROM furim_customers WHERE stripe_customer_id/.test(sql) ? { line_user_id: 'U-cancel', plan_label: 'PBプラン:X', mercari_url: 'https://jp.mercari.com/user/profile/1' } : null)),
        };
        return stmt;
      }),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database;
    vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-c' } as never);

    await processStripeEvent(db, { LINE_CHANNEL_ACCESS_TOKEN: 'tok' } as never, {
      id: 'evt_del_1',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_del_1', customer: 'cus_del_1', metadata: {} } },
    });

    const upserts = calls.filter((c) => /INSERT INTO furim_customers/.test(c.sql));
    expect(upserts.length).toBeGreaterThan(0);
    for (const u of upserts) expect(u.sql).not.toMatch(/canceled_at/);
    const cancel = calls.find((c) => /INSERT OR IGNORE INTO furim_cancellations/.test(c.sql));
    expect(cancel?.sql).toMatch(/canceled_at/);
    expect(cancel?.args).toEqual([expect.any(String), 'U-cancel', 'evt_del_1', 'sub_del_1', 'PBプラン:X', 'https://jp.mercari.com/user/profile/1', '2026-07-21T12:00:00.000+09:00']);
  });
});
