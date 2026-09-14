import { describe, it, expect, vi, beforeEach } from 'vitest';

// POST /api/furim/test-reset（Capsec #257）: D1 化で増えた furim_* と friends を FK 参照する表まで消すこと
const dbMocks = {
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
  jstNow: () => '2026-09-14T10:00:00.000+09:00',
};
vi.mock('@line-crm/db', () => dbMocks);

const worker = (await import('../index.js')).default;

type Stmt = { sql: string; args: unknown[] };

function makeDb(opts: { friend?: { id: string; metadata: string } | null; paid?: boolean; customer?: { stripe_customer_id: string | null; key_code: string | null } | null; affiliate?: { id: string } | null }) {
  const statements: Stmt[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const stmt = { sql, args };
          statements.push(stmt);
          return {
            first: async () => {
              if (/SELECT id, metadata FROM friends/.test(sql)) return opts.friend ?? null;
              if (/t\.name = '月額会員'/.test(sql)) return opts.paid ? { x: 1 } : null;
              if (/FROM furim_customers WHERE line_user_id/.test(sql)) return opts.customer ?? null;
              if (/SELECT id FROM affiliates WHERE friend_id/.test(sql)) return opts.affiliate ?? null;
              return null;
            },
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, statements };
}

const OWNER_KEY = 'owner-key';

function req(db: D1Database, body: unknown) {
  return worker.fetch(
    new Request('https://worker.example.com/api/furim/test-reset', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OWNER_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { DB: db, LINE_LOGIN_CHANNEL_ID: '2000000000', API_KEY: OWNER_KEY, WORKER_URL: 'https://worker.example.com', WORKER_NAME: 'line-harness' } as unknown as import('../index.js').Env['Bindings'],
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
}

const deletesOf = (statements: Stmt[]) => statements.filter((s) => s.sql.startsWith('DELETE FROM'));
const tableOf = (s: Stmt) => s.sql.match(/^DELETE FROM (\w+) WHERE (.+)$/)!.slice(1, 3);

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getLineAccounts.mockResolvedValue([]);
  dbMocks.getStaffByApiKey.mockResolvedValue(null);
});

describe('POST /api/furim/test-reset（Capsec #257）', () => {
  it('friend_id 参照の全表（FK 6 表を含む）→ 紹介台帳・アンバサダー → friends → line_user_id キーの furim_* → 無料台帳（key_code）の順で消す', async () => {
    const { db, statements } = makeDb({
      friend: { id: 'f1', metadata: '{"stripeCustomerId":"cus_meta"}' },
      customer: { stripe_customer_id: 'cus_d1', key_code: 'pb_abc' },
      affiliate: { id: 'aff1' },
    });
    const res = await req(db, { lineUserId: 'U1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; d1: string; deleted: Record<string, number>; stripeCustomersDeleted: string[] };
    expect(body.d1).toBe('deleted');

    const dels = deletesOf(statements).map(tableOf);
    const byFriend = dels.filter(([, w]) => w === 'friend_id = ?').map(([t]) => t);
    for (const t of ['friend_tags', 'messages_log', 'calendar_bookings', 'link_clicks', 'form_submissions', 'bookings', 'event_bookings', 'coupon_notifications']) {
      expect(byFriend, t).toContain(t);
    }
    expect(dels.find(([t]) => t === 'furim_referrals')![1]).toBe('ambassador_friend_id = ? OR introduced_friend_id = ?');
    const byAffiliate = dels.filter(([, w]) => w === 'affiliate_id = ?').map(([t]) => t);
    expect(byAffiliate).toEqual(['furim_referrals', 'affiliate_links', 'affiliate_clicks', 'conversion_events']);
    expect(dels.some(([t, w]) => t === 'affiliates' && w === 'id = ?')).toBe(true);
    // friends は FK 参照表の後に消す
    const friendsIdx = dels.findIndex(([t]) => t === 'friends');
    expect(friendsIdx).toBeGreaterThan(dels.findIndex(([t]) => t === 'coupon_notifications'));
    expect(friendsIdx).toBeGreaterThan(dels.findIndex(([t]) => t === 'affiliates'));

    const byLine = dels.filter(([, w]) => w === 'line_user_id = ?').map(([t]) => t);
    for (const t of ['furim_customers', 'furim_sync_diffs', 'furim_feature_flags', 'furim_survey_answers', 'furim_ticket_ledger', 'furim_payments', 'furim_cancellations', 'furim_coupon_applications', 'furim_execution_logs', 'furim_ext_errors', 'furim_manual_copy_logs', 'furim_shop_research_logs', 'furim_auto_copy_logs']) {
      expect(byLine, t).toContain(t);
    }
    const freeAccounts = dels.find(([t]) => t === 'furim_free_accounts')!;
    expect(freeAccounts[1]).toBe('key_code = ?');
    expect(statements.find((s) => s.sql.startsWith('DELETE FROM furim_free_accounts'))!.args).toEqual(['pb_abc']);
    // 件数は表ごとに返す（run が changes:1 を返す前提）
    expect(body.deleted.furim_feature_flags).toBe(1);
    expect(body.deleted.friends).toBe(1);
    // Stripe顧客ID は friends.metadata と furim_customers の両方から集める（STRIPE_SECRET_KEY 未設定なので削除はしない）
    expect(body.stripeCustomersDeleted).toEqual([]);
  });

  it('friends に無くても line_user_id キーの furim_* は消す。furim_customers にキーコードが無ければ無料台帳は触らない', async () => {
    const { db, statements } = makeDb({ friend: null, customer: { stripe_customer_id: null, key_code: null } });
    const res = await req(db, { lineUserId: 'U2' });
    const body = (await res.json()) as { d1: string };
    expect(body.d1).toBe('not_found');
    const dels = deletesOf(statements).map(tableOf);
    expect(dels.some(([t]) => t === 'friends')).toBe(false);
    expect(dels.some(([t]) => t === 'furim_free_accounts')).toBe(false);
    expect(dels.filter(([, w]) => w === 'line_user_id = ?').map(([t]) => t)).toContain('furim_feature_flags');
  });

  it('月額会員タグ付きは force なしなら 409 で何も消さない', async () => {
    const { db, statements } = makeDb({ friend: { id: 'f1', metadata: '{}' }, paid: true });
    const res = await req(db, { lineUserId: 'U1' });
    expect(res.status).toBe(409);
    expect(deletesOf(statements)).toHaveLength(0);
  });
});
