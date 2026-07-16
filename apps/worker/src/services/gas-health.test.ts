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

describe('checkGasSheetAuth', () => {
  it('GAS_DEPLOY_ID 未設定なら skipped', async () => {
    expect(await checkGasSheetAuth(DB, {})).toBe('skipped');
    expect(gasGet).not.toHaveBeenCalled();
  });

  it('JSON が返れば ok (該当なし応答でも健康)', async () => {
    gasGet.mockResolvedValueOnce({ customer_stripe_id: null });
    expect(await checkGasSheetAuth(DB, env)).toBe('ok');
    expect(sendPushToAll).not.toHaveBeenCalled();
  });

  it('HTML ページ (string) が返れば認可切れ → スタッフへ push', async () => {
    gasGet.mockResolvedValueOnce('<!DOCTYPE html><html>承認が必要です</html>');
    expect(await checkGasSheetAuth(DB, env)).toBe('unhealthy');
    expect(sendPushToAll).toHaveBeenCalledTimes(1);
    expect(sendPushToAll.mock.calls[0][2].title).toContain('GAS認可エラー');
  });

  it('gasGet が throw しても unhealthy 通知 (throw しない)', async () => {
    gasGet.mockRejectedValueOnce(new Error('GAS GET 401: unauthorized'));
    expect(await checkGasSheetAuth(DB, env)).toBe('unhealthy');
    expect(sendPushToAll).toHaveBeenCalledTimes(1);
  });

  it('通知の push が失敗しても throw しない', async () => {
    gasGet.mockRejectedValueOnce(new Error('boom'));
    sendPushToAll.mockRejectedValueOnce(new Error('push down'));
    expect(await checkGasSheetAuth(DB, env)).toBe('unhealthy');
  });
});
