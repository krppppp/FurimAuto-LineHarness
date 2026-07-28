import { describe, it, expect, vi, beforeEach } from 'vitest';

const gasGet = vi.fn();
vi.mock('../furim/gas-client.js', () => ({ gasGet, gasPost: vi.fn() }));

const sendPushToAll = vi.fn().mockResolvedValue(undefined);
vi.mock('./push-notify.js', () => ({ sendPushToAll }));

const { checkGasSheetAuth } = await import('./gas-health.js');

const DB = {} as D1Database;
const env = { GAS_DEPLOY_ID: 'deploy-id', VAPID_PUBLIC_KEY: 'pk', VAPID_PRIVATE_KEY: 'sk' };

beforeEach(() => {
  vi.clearAllMocks();
});

// テストではリトライ待機を待たない (retryDelayMs: 0)。maxAttempts はデフォルトの3を使う。
const fastOpts = { retryDelayMs: 0 };

describe('checkGasSheetAuth', () => {
  it('GAS_DEPLOY_ID 未設定なら skipped', async () => {
    expect(await checkGasSheetAuth(DB, {})).toBe('skipped');
    expect(gasGet).not.toHaveBeenCalled();
  });

  it('JSON が返れば ok (該当なし応答でも健康、リトライせず即終了)', async () => {
    gasGet.mockResolvedValueOnce({ customer_stripe_id: null });
    expect(await checkGasSheetAuth(DB, env, fastOpts)).toBe('ok');
    expect(gasGet).toHaveBeenCalledTimes(1);
    expect(sendPushToAll).not.toHaveBeenCalled();
  });

  it('1回失敗しても2回目で成功すれば ok (通知しない)', async () => {
    gasGet.mockRejectedValueOnce(new Error('temporary blip'));
    gasGet.mockResolvedValueOnce({ customer_stripe_id: null });
    expect(await checkGasSheetAuth(DB, env, fastOpts)).toBe('ok');
    expect(gasGet).toHaveBeenCalledTimes(2);
    expect(sendPushToAll).not.toHaveBeenCalled();
  });

  it('HTML ページ (string) が3回連続で返れば認可切れ → スタッフへ push', async () => {
    gasGet.mockResolvedValue('<!DOCTYPE html><html>承認が必要です</html>');
    expect(await checkGasSheetAuth(DB, env, fastOpts)).toBe('unhealthy');
    expect(gasGet).toHaveBeenCalledTimes(3);
    expect(sendPushToAll).toHaveBeenCalledTimes(1);
    expect(sendPushToAll.mock.calls[0][2].title).toContain('GAS認可エラー');
    expect(sendPushToAll.mock.calls[0][2].body).toContain('3回連続失敗');
  });

  it('gasGet が3回連続 throw しても unhealthy 通知 (throw しない)', async () => {
    gasGet.mockRejectedValue(new Error('GAS GET 401: unauthorized'));
    expect(await checkGasSheetAuth(DB, env, fastOpts)).toBe('unhealthy');
    expect(gasGet).toHaveBeenCalledTimes(3);
    expect(sendPushToAll).toHaveBeenCalledTimes(1);
  });

  it('通知の push が失敗しても throw しない', async () => {
    gasGet.mockRejectedValue(new Error('boom'));
    sendPushToAll.mockRejectedValueOnce(new Error('push down'));
    expect(await checkGasSheetAuth(DB, env, fastOpts)).toBe('unhealthy');
  });
});
