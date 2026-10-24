import { describe, it, expect, vi, beforeEach } from 'vitest';

// TB-2209: FURIM_MODE=off の Worker（新 LINE）では FurimAuto 専用の cron を呼ばない。付けなければ今までどおり呼ぶ
vi.mock('@line-crm/db', () => ({
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getTrafficPoolBySlug: vi.fn(),
  getTrafficPoolById: vi.fn(),
  getRandomPoolAccount: vi.fn(),
  getPoolAccounts: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn().mockResolvedValue(undefined),
  recoverStuckDeliveries: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./cron-jobs.js', () => ({ furimCronJobs: vi.fn(() => []) }));
vi.mock('../services/step-delivery.js', () => ({ processStepDeliveries: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/broadcast.js', () => ({
  processScheduledBroadcasts: vi.fn().mockResolvedValue(undefined),
  processQueuedBroadcasts: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/reminder-delivery.js', () => ({ processReminderDeliveries: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/ban-monitor.js', () => ({ checkAccountHealth: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/token-refresh.js', () => ({ refreshLineAccessTokens: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/insight-fetcher.js', () => ({ processInsightFetch: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/booking-reminders.js', () => ({ processDueReminders: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }) }));

const { furimCronJobs } = await import('./cron-jobs.js');
const { processStepDeliveries } = await import('../services/step-delivery.js');
const worker = (await import('../index.js')).default;

function run(env: Record<string, unknown>) {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
  const event = { cron: '*/5 * * * *', scheduledTime: Date.parse('2026-10-24T12:00:00+09:00') } as ScheduledEvent;
  return worker.scheduled(event, { DB: {} as D1Database, LINE_CHANNEL_ACCESS_TOKEN: 't', ...env } as never, ctx);
}

beforeEach(() => vi.clearAllMocks());

describe('scheduled — FurimAuto 専用の cron（TB-2209）', () => {
  it('FURIM_MODE を付けない Worker（FurimAuto 本番）では今までどおり呼ぶ', async () => {
    await run({});
    expect(furimCronJobs).toHaveBeenCalledTimes(1);
    expect(processStepDeliveries).toHaveBeenCalledTimes(1);
  });

  it('FURIM_MODE=off では呼ばない。ステップ配信は動かす', async () => {
    await run({ FURIM_MODE: 'off' });
    expect(furimCronJobs).not.toHaveBeenCalled();
    expect(processStepDeliveries).toHaveBeenCalledTimes(1);
  });
});
