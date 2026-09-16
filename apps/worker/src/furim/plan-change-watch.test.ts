import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/push-notify.js', () => ({
  sendPushToAll: vi.fn(async () => undefined),
}));
vi.mock('../routes/plan-builder.js', () => ({
  stripeCall: vi.fn(),
  resolvePlanSelection: vi.fn(async () => ({ pkgs: [{ package_key: 'm_full', stripe_price_id: 'price_full' }], feats: [], mcSites: [] })),
  buildItemsFromSelection: vi.fn(() => [{ price: 'price_full', quantity: 1 }]),
}));

import { watchPlanChangeIntents } from './plan-change-watch.js';
import { sendPushToAll } from '../services/push-notify.js';
import { stripeCall } from '../routes/plan-builder.js';

type Intent = {
  id: string; line_user_id: string; payload: string; used_at: string | null;
  stage: string | null; error: string | null; created_at: string; display_name: string | null;
};

function makeDb(intents: Intent[], sentCodes: string[], supersedingId: string | null = null) {
  const updates: Array<{ sql: string; binds: unknown[] }> = [];
  const queries: string[] = [];
  const db = {
    prepare(sql: string) {
      queries.push(sql);
      const stmt = {
        binds: [] as unknown[],
        bind(...args: unknown[]) { stmt.binds = args; return stmt; },
        async all() { return { results: intents }; },
        async first() {
          // 上書き検査（同じサブスクの、より新しい used 済み intent）
          if (sql.includes('$.subscriptionId')) return supersedingId ? { id: supersedingId } : null;
          const like = String(stmt.binds[1] ?? '');
          return sentCodes.some((c) => like.includes(c)) ? { 1: 1 } : null;
        },
        async run() { updates.push({ sql, binds: stmt.binds }); return { meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, updates, queries };
}

const push = vi.fn(async () => undefined);
const lineClient = { pushMessage: push } as never;
const env = { STRIPE_SECRET_KEY: 'sk_test', VAPID_PUBLIC_KEY: 'x', VAPID_PRIVATE_KEY: 'y' };

beforeEach(() => {
  vi.clearAllMocks();
});

const base: Intent = {
  id: 'PB-TEST01', line_user_id: 'Uabc', payload: JSON.stringify({ type: 'change', kind: 'downgrade', subscriptionId: 'sub_1', packages: ['m_full'], features: [] }),
  used_at: null, stage: 'stripe_sub', error: 'Stripe subscription_schedules/x: bad', created_at: '2026-09-11 19:10:48', display_name: '澁谷',
};

describe('watchPlanChangeIntents', () => {
  it('LINE に送られていない intent は通知しない', async () => {
    const { db, updates } = makeDb([base], []);
    await watchPlanChangeIntents(db, lineClient, env);
    expect(push).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('送信済みで used_at が無ければ「未処理」で1回通知し notified_at を書く', async () => {
    const { db, updates } = makeDb([base], ['PB-TEST01']);
    await watchPlanChangeIntents(db, lineClient, env);
    expect(push).toHaveBeenCalledTimes(1);
    const text = (push.mock.calls[0] as unknown as [string, Array<{ text: string }>])[1][0].text;
    expect(text).toContain('PB-TEST01');
    expect(text).toContain('未処理');
    expect(text).toContain('stage: stripe_sub');
    expect(sendPushToAll).toHaveBeenCalledTimes(1);
    expect(updates.some((u) => u.sql.includes('notified_at') && u.binds.includes('PB-TEST01'))).toBe(true);
  });

  it('used 済みの downgrade に schedule があれば通知せず ok を記録する', async () => {
    (stripeCall as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: 'active', schedule: 'sub_sched_1', items: { data: [] } });
    const { db, updates } = makeDb([{ ...base, used_at: '2026-09-11 19:11:00' }], ['PB-TEST01']);
    await watchPlanChangeIntents(db, lineClient, env);
    expect(push).not.toHaveBeenCalled();
    expect(updates.some((u) => String(u.binds[0]).startsWith('ok:'))).toBe(true);
  });

  it('used 済みの downgrade に schedule が無ければ通知する', async () => {
    (stripeCall as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: 'active', schedule: null, items: { data: [] } });
    const { db } = makeDb([{ ...base, used_at: '2026-09-11 19:11:00' }], ['PB-TEST01']);
    await watchPlanChangeIntents(db, lineClient, env);
    expect(push).toHaveBeenCalledTimes(1);
    expect((push.mock.calls[0] as unknown as [string, Array<{ text: string }>])[1][0].text).toContain('予約スケジュールが無い');
  });

  it('あとから出た完了済みの変更に上書きされた intent は検査せず、ok:superseded を記録する', async () => {
    const { db, updates } = makeDb([{ ...base, used_at: '2026-09-15 07:41:26' }], ['PB-TEST01'], 'PB-NEWER1');
    await watchPlanChangeIntents(db, lineClient, env);
    expect(push).not.toHaveBeenCalled();
    expect(stripeCall).not.toHaveBeenCalled();
    expect(updates.some((u) => String(u.binds[0]) === 'ok:superseded:PB-NEWER1')).toBe(true);
  });

  it('手で片づけた intent（stage が manual: で始まる）は取得対象から外す', async () => {
    const { db, queries } = makeDb([], []);
    await watchPlanChangeIntents(db, lineClient, env);
    expect(queries[0]).toContain("i.stage NOT LIKE 'manual:%'");
  });

  it('used 済みの upgrade は items に新プランの price が揃っていれば通知しない', async () => {
    (stripeCall as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: 'active', schedule: null, items: { data: [{ price: { id: 'price_full' } }] } });
    const up = { ...base, used_at: '2026-09-11 19:11:00', payload: JSON.stringify({ type: 'change', kind: 'upgrade', subscriptionId: 'sub_1', packages: ['m_full'], features: [] }) };
    const { db } = makeDb([up], ['PB-TEST01']);
    await watchPlanChangeIntents(db, lineClient, env);
    expect(push).not.toHaveBeenCalled();
  });
});
