import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getScenarios: vi.fn(),
  getScenarioById: vi.fn(),
  createScenario: vi.fn(),
  updateScenario: vi.fn(),
  deleteScenario: vi.fn(),
  createScenarioStep: vi.fn(),
  updateScenarioStep: vi.fn(),
  deleteScenarioStep: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getFriendById: vi.fn(),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

vi.mock('../services/scenario-stats.js', () => ({
  computeScenarioStats: vi.fn(),
}));

const { scenarios: scenariosModule } = await import('./scenarios.js');

interface ScenarioRow {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_tag_id: string | null;
  is_active: number;
  delivery_mode: string;
  created_at: string;
  updated_at: string;
  line_account_id: string | null;
  step_count: number;
}

function makeScenarioDb(rows: ScenarioRow[]) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async all<_T>() {
          calls.push({ sql, binds: bound });
          if (/FROM scenarios s\b/i.test(sql) && /line_account_id IS NULL/i.test(sql)) {
            const [lineAccountId] = bound as [string];
            const filtered = rows.filter(
              (r) => r.line_account_id == null || r.line_account_id === lineAccountId,
            );
            return { results: filtered };
          }
          return { results: [] };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

function setupApp(db: D1Database) {
  const app = new Hono<{ Bindings: { DB: D1Database } }>();
  app.use('*', async (c, next) => {
    c.env = { DB: db };
    await next();
  });
  app.route('/', scenariosModule);
  return app;
}

const rowBase = {
  description: null,
  trigger_type: 'friend_add',
  trigger_tag_id: null,
  is_active: 1,
  delivery_mode: 'relative',
  created_at: '2026-05-20T00:00:00.000',
  updated_at: '2026-05-20T00:00:00.000',
  step_count: 0,
};

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

describe('GET /api/scenarios?lineAccountId=X', () => {
  test('includes both account-bound and global (NULL) scenarios', async () => {
    const rows: ScenarioRow[] = [
      { id: 's-global', name: 'global', line_account_id: null, ...rowBase },
      { id: 's-acc1', name: 'acc1', line_account_id: 'acc-1', ...rowBase },
      { id: 's-acc2', name: 'acc2', line_account_id: 'acc-2', ...rowBase },
    ];
    const { db, calls } = makeScenarioDb(rows);

    const res = await setupApp(db).request('/api/scenarios?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string; lineAccountId: string | null }[] };
    expect(body.success).toBe(true);
    // webhook.ts:211 / liff.ts:878 trigger scenarios where line_account_id is
    // NULL (global) OR matches the active account. The list endpoint must
    // mirror that so the UI does not hide records the engine will fire.
    const ids = body.data.map((d) => d.id).sort();
    expect(ids).toEqual(['s-acc1', 's-global']);
    // Serializer surfaces the binding so the UI can distinguish 全アカ共通 from
    // an account-specific scenario.
    const globalRow = body.data.find((d) => d.id === 's-global');
    expect(globalRow?.lineAccountId).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/line_account_id IS NULL/);
    expect(calls[0].sql).toMatch(/s\.line_account_id = \?/);
    expect(calls[0].binds).toEqual(['acc-1']);
  });

  test('falls back to getScenarios helper when no lineAccountId is provided', async () => {
    dbMocks.getScenarios.mockResolvedValue([
      { id: 's-x', name: 'x', line_account_id: null, ...rowBase },
    ]);
    const { db } = makeScenarioDb([]);

    const res = await setupApp(db).request('/api/scenarios');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string }[] };
    expect(body.data.map((d) => d.id)).toEqual(['s-x']);
    expect(dbMocks.getScenarios).toHaveBeenCalledTimes(1);
  });

  test('returns empty array when filter matches nothing and no globals exist', async () => {
    const rows: ScenarioRow[] = [
      { id: 's-other', name: 'other', line_account_id: 'acc-other', ...rowBase },
    ];
    const { db } = makeScenarioDb(rows);

    const res = await setupApp(db).request('/api/scenarios?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: unknown[] };
    expect(body.data).toEqual([]);
  });
});

describe('POST /api/scenarios/:id/enroll/:friendId — dayZeroAt', () => {
  const enrollmentRow = {
    id: 'fs-1',
    friend_id: 'friend-1',
    scenario_id: 'scenario-1',
    current_step_order: -1,
    status: 'active',
    started_at: '2026-08-02T11:00:00.000+09:00',
    next_delivery_at: '2026-08-03T11:00:00.000+09:00',
    updated_at: '2026-08-02T11:00:00.000+09:00',
    day_zero_at: null as string | null,
  };

  function setup() {
    dbMocks.getScenarioById.mockResolvedValue({ id: 'scenario-1', name: 'S' });
    dbMocks.getFriendById.mockResolvedValue({ id: 'friend-1' });
    dbMocks.enrollFriendInScenario.mockResolvedValue(enrollmentRow);
    const app = new Hono();
    app.route('/', scenariosModule);
    return app;
  }

  test('body の dayZeroAt が enrollFriendInScenario に渡る', async () => {
    const app = setup();
    const res = await app.request('/api/scenarios/scenario-1/enroll/friend-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dayZeroAt: '2026-07-20T00:00:00.000+09:00' }),
    }, { DB: {} });
    expect(res.status).toBe(201);
    expect(dbMocks.enrollFriendInScenario).toHaveBeenCalledWith({}, 'friend-1', 'scenario-1', { dayZeroAt: '2026-07-20T00:00:00.000+09:00' });
  });

  test('ボディなしは従来どおり dayZeroAt undefined で登録される', async () => {
    const app = setup();
    const res = await app.request('/api/scenarios/scenario-1/enroll/friend-1', { method: 'POST' }, { DB: {} });
    expect(res.status).toBe(201);
    expect(dbMocks.enrollFriendInScenario).toHaveBeenCalledWith({}, 'friend-1', 'scenario-1', { dayZeroAt: undefined });
  });

  test('不正な dayZeroAt は 400', async () => {
    const app = setup();
    const res = await app.request('/api/scenarios/scenario-1/enroll/friend-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dayZeroAt: 'not-a-date' }),
    }, { DB: {} });
    expect(res.status).toBe(400);
  });
});
