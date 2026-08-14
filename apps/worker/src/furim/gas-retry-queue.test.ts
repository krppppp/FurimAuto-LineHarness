import { describe, test, expect, vi, beforeEach } from 'vitest';

// getGasErrorFromResponse は実実装を使う（success:false / HTMLページ検知のテストのため）
vi.mock('./gas-client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gasGet: vi.fn(),
  gasPost: vi.fn(),
}));

import { gasGet, gasPost } from './gas-client.js';
import { enqueueGasRetryJob, sweepGasRetryJobs, DONE_CHECKS } from './gas-retry-queue.js';

type Write = { sql: string; args: unknown[] };

function makeQueueDb(opts: { jobs?: unknown[]; pendingExists?: boolean } = {}) {
  const writes: Write[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            run: async () => { writes.push({ sql, args }); return {}; },
            first: async () => (/SELECT id FROM gas_retry_jobs/.test(sql) ? (opts.pendingExists ? { id: 'existing' } : null) : null),
            all: async () => ({ results: [] }),
          };
        },
        all: async () => ({ results: opts.jobs ?? [] }),
        run: async () => ({}),
      };
    },
  } as unknown as D1Database;
  return { db, writes };
}

function makeLineClient() {
  return { replyMessage: vi.fn().mockResolvedValue({}), pushMessage: vi.fn().mockResolvedValue({}) };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    line_user_id: 'U1',
    method: 'setSubscriptionData',
    params: '{}',
    call_type: 'post',
    reply_token: null,
    done_check: null,
    notify_message: null,
    attempts: 0,
    max_attempts: 20,
    ...overrides,
  };
}

const envOk = { GAS_DEPLOY_ID: 'dep-1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enqueueGasRetryJob', () => {
  test('同一dedupe_keyのpendingがあれば積まない', async () => {
    const { db, writes } = makeQueueDb({ pendingExists: true });
    await enqueueGasRetryJob(db, { lineUserId: 'U1', method: 'setSubscriptionData', dedupeKey: 'setSubscriptionData:evt_1' });
    expect(writes.filter((w) => /INSERT INTO gas_retry_jobs/.test(w.sql))).toHaveLength(0);
  });

  test('dedupe_keyとmax_attemptsがINSERTに入る', async () => {
    const { db, writes } = makeQueueDb();
    await enqueueGasRetryJob(db, { lineUserId: 'U1', method: 'setSubscriptionData', dedupeKey: 'setSubscriptionData:evt_1', maxAttempts: 20, callType: 'post', doneCheck: 'subscriptionRecorded' });
    const insert = writes.find((w) => /INSERT INTO gas_retry_jobs/.test(w.sql));
    expect(insert).toBeTruthy();
    expect(insert!.args).toContain('setSubscriptionData:evt_1');
    expect(insert!.args).toContain(20);
    expect(insert!.args).toContain('subscriptionRecorded');
  });
});

describe('sweepGasRetryJobs', () => {
  test('max_attempts超過はfailedにする', async () => {
    const { db, writes } = makeQueueDb({ jobs: [job({ attempts: 20, max_attempts: 20 })] });
    await sweepGasRetryJobs(db, makeLineClient() as never, envOk);
    expect(writes.some((w) => /status = 'failed'/.test(w.sql))).toBe(true);
    expect(gasPost).not.toHaveBeenCalled();
  });

  test('done_checkがtrueなら実行せずdone（実行済みスキップ）', async () => {
    vi.mocked(gasGet).mockResolvedValue({ success: true, rows: [{ 'インボイスID': 'in_1' }] });
    const { db, writes } = makeQueueDb({ jobs: [job({ done_check: 'transactionRecorded', params: JSON.stringify({ invoiceID: 'in_1' }) })] });
    await sweepGasRetryJobs(db, makeLineClient() as never, envOk);
    expect(gasPost).not.toHaveBeenCalled();
    expect(writes.some((w) => w.sql.includes('skipped: already done'))).toBe(true);
  });

  test('done_checkがfalseなら実行してdone', async () => {
    vi.mocked(gasGet).mockResolvedValue({ success: true, rows: [] });
    vi.mocked(gasPost).mockResolvedValue({ success: true });
    const { db, writes } = makeQueueDb({ jobs: [job({ done_check: 'transactionRecorded', params: JSON.stringify({ invoiceID: 'in_1' }) })] });
    await sweepGasRetryJobs(db, makeLineClient() as never, envOk);
    expect(gasPost).toHaveBeenCalledTimes(1);
    expect(writes.some((w) => /status = 'done'/.test(w.sql) && !w.sql.includes('skipped: already done'))).toBe(true);
  });

  test('done_check自体が失敗したら実行せず次回巡回へ（attempts+1）', async () => {
    vi.mocked(gasGet).mockRejectedValue(new Error('getData timeout'));
    const { db, writes } = makeQueueDb({ jobs: [job({ done_check: 'transactionRecorded', params: JSON.stringify({ invoiceID: 'in_1' }) })] });
    await sweepGasRetryJobs(db, makeLineClient() as never, envOk);
    expect(gasPost).not.toHaveBeenCalled();
    expect(writes.some((w) => /attempts = attempts \+ 1/.test(w.sql))).toBe(true);
  });

  test('GAS応答がsuccess:falseなら失敗扱い（attempts+1）', async () => {
    vi.mocked(gasPost).mockResolvedValue({ success: false, error: '該当レコードなし' });
    const { db, writes } = makeQueueDb({ jobs: [job()] });
    await sweepGasRetryJobs(db, makeLineClient() as never, envOk);
    expect(writes.some((w) => /attempts = attempts \+ 1/.test(w.sql))).toBe(true);
    expect(writes.some((w) => /status = 'done'/.test(w.sql))).toBe(false);
  });

  test('__プレフィックスのparamsはGASに送らない', async () => {
    vi.mocked(gasPost).mockResolvedValue({ success: true, keyCodeIssued: false });
    const { db } = makeQueueDb({ jobs: [job({ method: 'syncFeaturesFromSubscription', params: JSON.stringify({ packages: 'premium', __notifyKeycodeReissue: '1' }) })] });
    await sweepGasRetryJobs(db, makeLineClient() as never, envOk);
    const body = vi.mocked(gasPost).mock.calls[0][1] as Record<string, unknown>;
    expect(body.packages).toBe('premium');
    expect('__notifyKeycodeReissue' in body).toBe(false);
  });

  test('syncFeatures完遂でキーコード再発行があれば通知する（reply_token無し→push）', async () => {
    vi.mocked(gasPost).mockResolvedValue({ success: true, keyCodeIssued: true, keyCode: 'pb_newcode1' });
    const lineClient = makeLineClient();
    const { db } = makeQueueDb({ jobs: [job({ method: 'syncFeaturesFromSubscription', params: JSON.stringify({ __notifyKeycodeReissue: '1' }) })] });
    await sweepGasRetryJobs(db, lineClient as never, envOk);
    expect(lineClient.pushMessage).toHaveBeenCalledTimes(1);
    const messages = lineClient.pushMessage.mock.calls[0][1] as Array<{ text: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[1].text).toBe('pb_newcode1');
  });

  test('getKeyCodeがエラーコードを返す間は失敗扱いで残す（マスター行作成後に発行して届ける）', async () => {
    vi.mocked(gasGet).mockResolvedValue({ keyCode: 'エラーコード(401)' });
    const { db, writes } = makeQueueDb({ jobs: [job({ method: 'getKeyCode', call_type: 'get', max_attempts: 5 })] });
    await sweepGasRetryJobs(db, makeLineClient() as never, envOk);
    expect(writes.some((w) => /attempts = attempts \+ 1/.test(w.sql))).toBe(true);
  });
});

describe('DONE_CHECKS', () => {
  test('subscriptionDeleted: 行のサブスクIDが対象と不一致（再契約済み）なら実行してはいけない=done', async () => {
    vi.mocked(gasGet).mockResolvedValue({ success: true, rows: [{ 'プラン名': 'PBプラン:premium', 'サブスクID': 'sub_new' }] });
    const done = await DONE_CHECKS.subscriptionDeleted('dep-1', { line_user_id: 'U1', params: JSON.stringify({ stripeCustomerID: 'cus_1', subscriptionID: 'sub_old' }) });
    expect(done).toBe(true);
  });

  test('subscriptionDeleted: 行が対象サブスクを持ちキャンセル未処理なら実行する=not done', async () => {
    vi.mocked(gasGet).mockResolvedValue({ success: true, rows: [{ 'プラン名': 'PBプラン:premium', 'サブスクID': 'sub_old' }] });
    const done = await DONE_CHECKS.subscriptionDeleted('dep-1', { line_user_id: 'U1', params: JSON.stringify({ stripeCustomerID: 'cus_1', subscriptionID: 'sub_old' }) });
    expect(done).toBe(false);
  });

  test('subscriptionRecorded: サブスクIDと終了日時(±60秒・JST/ISO混在)が一致すればdone', async () => {
    vi.mocked(gasGet).mockResolvedValue({ success: true, rows: [{ 'サブスクID': 'sub_1', 'サブスク終了日時': '2026-09-14T22:53:38.000Z' }] });
    const done = await DONE_CHECKS.subscriptionRecorded('dep-1', {
      line_user_id: 'U1',
      params: JSON.stringify({ stripeCustomerID: 'cus_1', subscriptionID: 'sub_1', subscriptionEndDateTime: '2026-09-15 07:53:38' }),
    });
    expect(done).toBe(true);
  });
});
