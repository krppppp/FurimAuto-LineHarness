import { describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../src/index.js', async (orig) => ({
  ...(await orig<typeof import('../src/index.js')>()),
  jstNow: () => '2026-10-08T09:00:00.000+09:00',
}));
const { liffRoutes } = await import('../../../apps/worker/src/routes/liff.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const BENIGN = /duplicate column name|already exists/i;

function execSafe(db: Database.Database, sql: string): void {
  for (const stmt of sql.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
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
  for (const file of ['003_entry_routes.sql', '004_friend_metadata.sql', '010_ad_conversions.sql', '062_lp_events.sql', '065_utm_content_term.sql', '086_ref_tracking_braid.sql']) {
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
            async all<T>() {
              return { results: stmt.all(...params) as T[], success: true, meta: {} };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function seed(sqlite: Database.Database) {
  const friend = sqlite.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, created_at, updated_at) VALUES (?, ?, 'T', '2026-10-01T00:00:00.000', '2026-10-01T00:00:00.000')`,
  );
  friend.run('f1', 'U1');
  friend.run('f2', 'U2');
  friend.run('f3', 'U3');
  friend.run('ftest', 'Ue4941a030cb2ec8758095fb0fffff344');
  const rt = sqlite.prepare(`INSERT INTO ref_tracking (id, ref_code, friend_id, utm_content, created_at) VALUES (?, ?, ?, ?, ?)`);
  rt.run('r1', 'org_x', 'f1', 'x_p1', '2026-10-06T08:31:00.000+09:00');
  rt.run('r2', 'org_x', 'f1', 'x_p1', '2026-10-06T08:32:00.000+09:00');
  rt.run('r3', 'org_x', 'f2', 'x_p1', '2026-10-06 21:00:00');
  rt.run('r4', 'org_x', 'f3', null, '2026-10-07T10:00:00.000+09:00');
  rt.run('r5', 'org_x', 'ftest', 'x_p1', '2026-10-06T09:00:00.000+09:00');
  rt.run('r6', 'org_blog', 'f3', 'blog_a', '2026-10-06T09:00:00.000+09:00');
  rt.run('r7', 'org_x', null, 'x_p9', '2026-10-06T09:00:00.000+09:00');
  rt.run('r8', 'org_x', 'f2', 'x_p2', '2026-10-08T09:00:00.000+09:00');
}

describe('GET /api/analytics/ref-daily (TB-987)', () => {
  test('ref の友だちを日付 × utm_content で数える（社内・検証用と friend 無しは数えない）', async () => {
    const sqlite = setupDb();
    try {
      seed(sqlite);
      const res = await liffRoutes.request('/api/analytics/ref-daily?ref=org_x&from=2026-10-06&to=2026-10-07', {}, { DB: asD1(sqlite) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        data: {
          refCode: 'org_x',
          from: '2026-10-06',
          to: '2026-10-07',
          tz: 'Asia/Tokyo',
          rows: [
            { date: '2026-10-06', utmContent: 'x_p1', friends: 2 },
            { date: '2026-10-07', utmContent: null, friends: 1 },
          ],
        },
      });
    } finally {
      sqlite.close();
    }
  });

  test('from/to を省くと今日（JST）だけ', async () => {
    const sqlite = setupDb();
    try {
      seed(sqlite);
      const res = await liffRoutes.request('/api/analytics/ref-daily?ref=org_x', {}, { DB: asD1(sqlite) });
      const body = (await res.json()) as { data: { from: string; to: string; rows: unknown[] } };
      expect(body.data.from).toBe('2026-10-08');
      expect(body.data.to).toBe('2026-10-08');
      expect(body.data.rows).toEqual([{ date: '2026-10-08', utmContent: 'x_p2', friends: 1 }]);
    } finally {
      sqlite.close();
    }
  });

  test.each([
    ['', 'ref が無い'],
    ['ref=org_x&from=2026-10-7', '日付の形が違う'],
    ['ref=org_x&from=2026-10-08&to=2026-10-07', 'from > to'],
    ['ref=org_x&from=2026-01-01&to=2026-10-07', '93 日を超える'],
  ])('%s は 400（%s）', async (qs) => {
    const sqlite = setupDb();
    try {
      const res = await liffRoutes.request(`/api/analytics/ref-daily?${qs}`, {}, { DB: asD1(sqlite) });
      expect(res.status).toBe(400);
    } finally {
      sqlite.close();
    }
  });
});
