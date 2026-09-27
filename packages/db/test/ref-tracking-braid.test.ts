import { describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { recordRefTracking, getRefTrackingWithClickIds } from '../src/entry-routes.js';
import { buildGoogleConversionEvent, retryMissedAdConversions } from '../../../apps/worker/src/services/ad-conversion.js';

// Keep real SQL persistence and lookup; isolate LINE/account/referral side effects.
vi.mock('../src/index.js', async (orig) => ({
  ...(await orig<typeof import('../src/index.js')>()),
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getFriendByLineUserId: vi.fn().mockResolvedValue({ id: 'friend-braid', user_id: 'U-uuid' }),
  getTrafficPoolBySlug: vi.fn().mockResolvedValue(null),
  getEntryRouteByRefCode: vi.fn().mockResolvedValue(null),
  getTrackedLinkById: vi.fn().mockResolvedValue(null),
  getAffiliateLinkByRefCode: vi.fn().mockResolvedValue(null),
}));
const { liffRoutes } = await import('../../../apps/worker/src/routes/liff.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');

const BENIGN = /duplicate column name|already exists/i;

function execSafe(db: Database.Database, sql: string): void {
  for (const stmt of sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!BENIGN.test(msg)) throw err;
    }
  }
}

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  execSafe(db, readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  const migrationFiles = ['003_entry_routes.sql', '004_friend_metadata.sql', '010_ad_conversions.sql', '062_lp_events.sql', '065_utm_content_term.sql', '086_ref_tracking_braid.sql'];
  for (const file of migrationFiles) {
    execSafe(db, readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return db;
}

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          const stmt = sqlite.prepare(query);
          return {
            async run() {
              stmt.run(...params);
              return { results: [], success: true, meta: {} };
            },
            async first<T>() {
              return (stmt.get(...params) as T) ?? null;
            },
            async all<T>() {
              return { results: stmt.all(...params) as T[], success: true, meta: {} };
            },
          };
        },
        async run() {
          sqlite.prepare(query).run();
          return { results: [], success: true, meta: {} };
        },
        async first<T>() {
          return (sqlite.prepare(query).get() as T) ?? null;
        },
        async all<T>() {
          return { results: sqlite.prepare(query).all() as T[], success: true, meta: {} };
        },
      };
    },
  } as unknown as D1Database;
}

function insertFriend(sqlite: Database.Database, id: string, lineUserId: string) {
  sqlite
    .prepare(
      `INSERT INTO friends (id, line_user_id, display_name, created_at, updated_at)
       VALUES (?, ?, 'Test User', '2024-01-01T00:00:00.000', '2024-01-01T00:00:00.000')`,
    )
    .run(id, lineUserId);
}

describe('braid persistence (TB-363)', () => {
  test.each(['gbraid', 'wbraid'] as const)('stores and finds a row with only %s', async (key) => {
    const sqlite = setupDb();
    try {
      const db = asD1(sqlite);
      insertFriend(sqlite, 'friend-braid', 'U-braid');
      await recordRefTracking(db, { refCode: 'ad_google_search', friendId: 'friend-braid', [key]: 'TEST123' });
      const saved = await getRefTrackingWithClickIds(db, 'friend-braid');
      expect(saved?.[key]).toBe('TEST123');
      expect(saved?.gclid).toBeNull();
      const event = buildGoogleConversionEvent({ customer_id: 'test', conversion_action_id: 'test' }, saved!);
      expect(event.body.events[0].adIdentifiers).toEqual({ [key]: 'TEST123' });
      expect(saved?.[key === 'gbraid' ? 'wbraid' : 'gbraid']).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  test('migration keeps existing rows and leaves both new TEXT columns NULL', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec("CREATE TABLE ref_tracking (id TEXT PRIMARY KEY, gclid TEXT); INSERT INTO ref_tracking VALUES ('old', 'GC_OLD');");
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '086_ref_tracking_braid.sql'), 'utf8'));
      expect(sqlite.prepare('SELECT * FROM ref_tracking').get()).toEqual({ id: 'old', gclid: 'GC_OLD', gbraid: null, wbraid: null });
      const columns = sqlite.prepare('PRAGMA table_info(ref_tracking)').all() as { name: string; type: string }[];
      expect(columns.filter(c => c.name.endsWith('braid')).map(c => c.type)).toEqual(['TEXT', 'TEXT']);
    } finally {
      sqlite.close();
    }
  });
});


test.each(['gbraid', 'wbraid'] as const)('local /auth/line QR → LIFF link persists %s=TEST123 and builds CV', async (key) => {
  const sqlite = setupDb();
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe('https://api.line.me/oauth2/v2.1/verify');
    return new Response(JSON.stringify({ sub: 'U-braid', name: 'Test' }));
  });
  vi.stubGlobal('fetch', fetchMock);
  try {
    const DB = asD1(sqlite);
    insertFriend(sqlite, 'friend-braid', 'U-braid');
    const env = { DB, LIFF_URL: 'https://liff.line.me/1000000000-Test', LINE_LOGIN_CHANNEL_ID: 'test' };
    const entry = await liffRoutes.request(`/auth/line?ref=ad_google_search&${key}=TEST123`, {}, env);
    expect(entry.status).toBe(200);
    const html = await entry.text();
    const liffTarget = new URL(decodeURIComponent(html.match(/data=([^" ]+)/)![1]));
    const res = await liffRoutes.request('/api/liff/link', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: 'mock', ref: liffTarget.searchParams.get('ref'), [key]: liffTarget.searchParams.get(key) }),
    }, env);
    expect(res.status).toBe(200);
    const saved = await getRefTrackingWithClickIds(DB, 'friend-braid');
    expect(saved?.[key]).toBe('TEST123');
    const event = buildGoogleConversionEvent({ customer_id: 'test', conversion_action_id: 'test' }, saved!);
    expect(event.body.events[0].adIdentifiers).toEqual({ [key]: 'TEST123' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // mocked LINE verification only, no Google ingestion
  } finally {
    vi.unstubAllGlobals();
    sqlite.close();
  }
});


test.each(['gbraid', 'wbraid'] as const)('catch-up finds %s-only rows and records line_friend_add once', async (key) => {
  const sqlite = setupDb();
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ events: [{}] })));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const db = asD1(sqlite);
    insertFriend(sqlite, 'friend-braid', 'U-braid');
    sqlite.prepare('UPDATE friends SET created_at = ?').run(new Date().toISOString());
    sqlite.prepare('INSERT INTO ad_platforms (id, name, config) VALUES (?, ?, ?)').run('google-test', 'google', JSON.stringify({ customer_id: 'test', conversion_action_id: 'test', oauth_token: 'test' }));
    await recordRefTracking(db, { refCode: 'ad_google_search', friendId: 'friend-braid', [key]: 'TEST123' });
    await retryMissedAdConversions(db);
    await retryMissedAdConversions(db);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const log = sqlite.prepare('SELECT event_name, click_id_type, click_id, status, request_body FROM ad_conversion_logs').get() as Record<string, string>;
    expect(log).toMatchObject({ event_name: 'line_friend_add', click_id_type: key, click_id: 'TEST123', status: 'sent' });
    expect(JSON.parse(log.request_body)[key]).toBe('TEST123');
  } finally {
    vi.unstubAllGlobals();
    sqlite.close();
  }
});
