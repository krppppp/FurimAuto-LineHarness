import { describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { recordRefTracking, getRefTrackingWithClickIds } from '../src/entry-routes.js';
import { retryMissedAdConversions } from '../../../apps/worker/src/services/ad-conversion.js';

// Keep real SQL persistence and lookup; isolate LINE/account/referral side effects.
vi.mock('../src/index.js', async (orig) => ({
  ...(await orig<typeof import('../src/index.js')>()),
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getFriendByLineUserId: vi.fn().mockResolvedValue({ id: 'friend-yclid', user_id: 'U-uuid' }),
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
  const migrationFiles = ['003_entry_routes.sql', '004_friend_metadata.sql', '010_ad_conversions.sql', '062_lp_events.sql', '065_utm_content_term.sql', '086_ref_tracking_braid.sql', '091_ref_tracking_yclid.sql'];
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

describe('yclid persistence (TB-1727)', () => {
  test('migration keeps existing rows and leaves yclid NULL', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec("CREATE TABLE ref_tracking (id TEXT PRIMARY KEY, gclid TEXT); INSERT INTO ref_tracking VALUES ('old', 'GC_OLD');");
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '091_ref_tracking_yclid.sql'), 'utf8'));
      expect(sqlite.prepare('SELECT * FROM ref_tracking').get()).toEqual({ id: 'old', gclid: 'GC_OLD', yclid: null });
    } finally {
      sqlite.close();
    }
  });

  test('/auth/line LIFF URL and /auth/oauth state carry yclid', async () => {
    const sqlite = setupDb();
    try {
      const env = { DB: asD1(sqlite), LIFF_URL: 'https://liff.line.me/1000000000-Test', LINE_LOGIN_CHANNEL_ID: 'test' };
      const res = await liffRoutes.request('/auth/line?ref=ad_yahoo_search&yclid=YSS.TEST123', {}, env);
      const html = await res.text();
      const liffTarget = new URL(decodeURIComponent(html.match(/data=([^" ]+)/)![1]));
      expect(liffTarget.searchParams.get('yclid')).toBe('YSS.TEST123');
      const redirect = await liffRoutes.request('/auth/oauth?ref=ad_yahoo_search&yclid=YSS.TEST123', {}, env);
      expect(redirect.status).toBe(302);
      const state = new URL(redirect.headers.get('location')!).searchParams.get('state')!;
      const json = new TextDecoder().decode(Uint8Array.from(atob(state), (ch) => ch.charCodeAt(0)));
      expect(JSON.parse(json).yclid).toBe('YSS.TEST123');
    } finally {
      sqlite.close();
    }
  });

  test.each(['ad_yahoo_search', 'ad_yahoo_display'])('LIFF link saves %s and yclid to the friend, and Google is not called', async (ref) => {
    const sqlite = setupDb();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sub: 'U-yclid', name: 'Test' })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const DB = asD1(sqlite);
      insertFriend(sqlite, 'friend-yclid', 'U-yclid');
      sqlite.prepare('INSERT INTO ad_platforms (id, name, config) VALUES (?, ?, ?)').run('google-test', 'google', JSON.stringify({ customer_id: 'test', conversion_action_id: 'test', oauth_token: 'test' }));
      const env = { DB, LIFF_URL: 'https://liff.line.me/1000000000-Test', LINE_LOGIN_CHANNEL_ID: 'test' };
      const res = await liffRoutes.request('/api/liff/link', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: 'mock', ref, yclid: 'YSS.TEST123', utm_source: 'yahoo' }),
      }, env);
      expect(res.status).toBe(200);
      const row = sqlite.prepare('SELECT ref_code, yclid, gclid FROM ref_tracking WHERE friend_id = ?').get('friend-yclid');
      expect(row).toEqual({ ref_code: ref, yclid: 'YSS.TEST123', gclid: null });
      const friend = sqlite.prepare('SELECT ref_code FROM friends WHERE id = ?').get('friend-yclid');
      expect(friend).toEqual({ ref_code: ref });
      await retryMissedAdConversions(DB);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sqlite.prepare('SELECT COUNT(*) n FROM ad_conversion_logs').get()).toEqual({ n: 0 });
    } finally {
      vi.unstubAllGlobals();
      sqlite.close();
    }
  });
});
