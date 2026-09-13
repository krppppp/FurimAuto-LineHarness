import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// gasGet/gasPost を差し替え、他は実体を使う
const gasGet = vi.fn();
const gasPost = vi.fn();
vi.mock('./gas-client.js', () => ({ gasGet, gasPost, getGasErrorFromResponse: () => null }));

const { processReferral, handleKeywordAction } = await import('./keyword-actions.js');

function makeClient() {
  return {
    replyMessage: vi.fn().mockResolvedValue({}),
    pushMessage: vi.fn().mockResolvedValue({}),
  };
}

type Write = { sql: string; args: unknown[] };

/**
 * 紹介処理（D1 だけで完結・Capsec #244）用の簡易 D1。SQL とバインド値でルーティングする。
 */
function makeReferralDb(opts: {
  introduced?: Record<string, unknown> | null;
  ambassador?: Record<string, unknown> | null;
  affiliate?: Record<string, unknown> | null;
  alreadyTag?: boolean;
  referralRow?: Record<string, unknown> | null;
  customers?: Record<string, Record<string, unknown>>;
  coupons?: Record<string, string>;
  counts?: { total: number; rewarded: number; applied: number };
  pendingReward?: Record<string, unknown> | null;
} = {}) {
  const writes: Write[] = [];
  const coupons = opts.coupons ?? { 'お友達紹介初回月額プラン半額クーポン': 'IDLf7QBx', 'アンバサダー1500円引きクーポン': 'Tb8WoYb4' };
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            run: async () => { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
            all: async () => ({ results: [] }),
            first: async () => {
              if (/FROM friends WHERE line_user_id/.test(sql) && /SELECT \*/.test(sql)) {
                if (args[0] === 'Uintroduced') return opts.introduced === undefined ? { id: 'friend1', line_user_id: 'Uintroduced', display_name: '太郎', plan_name: null, metadata: '{}' } : opts.introduced;
                if (args[0] === 'Uamb') return opts.ambassador === undefined ? { id: 'friendA', line_user_id: 'Uamb', display_name: 'アンバ', plan_name: 'PBプラン:メルカリ 全自動化プラン', metadata: '{}' } : opts.ambassador;
                return null;
              }
              if (/FROM friends WHERE id = \?/.test(sql)) return opts.ambassador === undefined ? { id: 'friendA', line_user_id: 'Uamb', display_name: 'アンバ', plan_name: 'PBプラン:メルカリ 全自動化プラン', metadata: '{}' } : opts.ambassador;
              if (/SELECT metadata FROM friends/.test(sql)) return null;
              if (/FROM tags WHERE name/.test(sql)) return { id: 'introtag' };
              if (/FROM friend_tags WHERE friend_id/.test(sql)) return opts.alreadyTag ? { 1: 1 } : null;
              if (/FROM furim_referrals WHERE introduced_friend_id/.test(sql)) return opts.referralRow ?? null;
              if (/FROM affiliates WHERE code/.test(sql)) return opts.affiliate === undefined ? { id: 'aff1', code: 'AMB12345', friend_id: 'friendA' } : opts.affiliate;
              if (/FROM furim_customers WHERE line_user_id/.test(sql)) {
                const c = opts.customers ?? { Uintroduced: { stripe_customer_id: 'cus_intro', subscription_end_at: '2026-09-27 12:00:00' }, Uamb: { stripe_customer_id: 'cus_amb' } };
                return c[String(args[0])] ?? null;
              }
              if (/FROM furim_coupons WHERE name/.test(sql)) { const id = coupons[String(args[0])]; return id ? { coupon_id: id } : null; }
              if (/count\(\*\) AS total/.test(sql)) return opts.counts ?? { total: 0, rewarded: 0, applied: 0 };
              if (/reward_applied_at IS NULL/.test(sql) && /ORDER BY created_at LIMIT 1/.test(sql)) return opts.pendingReward === undefined ? { id: 'ref-new', reward_coupon_name: 'アンバサダー1500円引きクーポン', reward_coupon_id: 'Tb8WoYb4' } : opts.pendingReward;
              if (/FROM scenarios WHERE name/.test(sql)) return null;
              return null;
            },
          };
        },
      };
    },
  };
  return { db, writes };
}

const env = { GAS_DEPLOY_ID: 'deploy-id', STRIPE_SECRET_KEY: 'sk_test' };

function stubStripe(opts: { ambassadorDiscount?: boolean; monthly?: number } = {}) {
  const calls: Array<{ url: string; body?: string; method?: string }> = [];
  const fetchStub = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, body: init?.body, method: init?.method });
    if (/\/v1\/subscriptions\?customer=/.test(url)) {
      return { ok: true, json: async () => ({ data: [{ items: { data: [{ price: { unit_amount: opts.monthly ?? 5980 }, quantity: 1 }] } }] }) };
    }
    if (/\/v1\/customers\/cus_amb$/.test(url) && !init?.method) {
      return { ok: true, json: async () => (opts.ambassadorDiscount ? { discount: { coupon: { id: 'x' } } } : {}) };
    }
    return { ok: true, json: async () => ({}), text: async () => '' };
  });
  vi.stubGlobal('fetch', fetchStub);
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('processReferral（D1 だけで完結・Capsec #244）', () => {
  it('被紹介者に既に紹介経由タグがある → Stripe を呼ばず already_referred', async () => {
    const calls = stubStripe();
    const client = makeClient();
    const { db, writes } = makeReferralDb({ alreadyTag: true });

    const result = await processReferral(client as never, 'Uintroduced', 'AMB12345', env, db as never, {});

    expect(result).toEqual({ ok: false, reason: 'already_referred' });
    expect(calls).toHaveLength(0);
    expect(writes.filter((w) => /INSERT INTO furim_referrals/.test(w.sql))).toHaveLength(0);
    expect(gasGet).not.toHaveBeenCalled();
  });

  it('紹介台帳に被紹介者が居ても already_referred（タグ無しでも）', async () => {
    stubStripe();
    const client = makeClient();
    const { db } = makeReferralDb({ referralRow: { id: 'r0', affiliate_id: 'aff9' } });
    const result = await processReferral(client as never, 'Uintroduced', 'AMB12345', env, db as never, { replyToken: 'rt' });
    expect(result).toEqual({ ok: false, reason: 'already_referred' });
    expect((client.replyMessage.mock.calls[0][1] as { text: string }[])[0].text).toContain('すでに適用済み');
  });

  it('適用済みは replyToken があれば reply、無ければ push、silent なら何も送らない', async () => {
    stubStripe();
    const c1 = makeClient();
    await processReferral(c1 as never, 'Uintroduced', 'AMB12345', env, makeReferralDb({ alreadyTag: true }).db as never, { replyToken: 'rt' });
    expect(c1.replyMessage).toHaveBeenCalledOnce();
    expect(c1.pushMessage).not.toHaveBeenCalled();
    const c2 = makeClient();
    await processReferral(c2 as never, 'Uintroduced', 'AMB12345', env, makeReferralDb({ alreadyTag: true }).db as never, {});
    expect(c2.pushMessage.mock.calls[0][0]).toBe('Uintroduced');
    const c3 = makeClient();
    await processReferral(c3 as never, 'Uintroduced', 'AMB12345', env, makeReferralDb({ alreadyTag: true }).db as never, { silent: true });
    expect(c3.replyMessage).not.toHaveBeenCalled();
    expect(c3.pushMessage).not.toHaveBeenCalled();
  });

  it('被紹介者が未登録 → introduced_not_registered（通知なし）', async () => {
    stubStripe();
    const client = makeClient();
    const result = await processReferral(client as never, 'Uintroduced', 'AMB12345', env, makeReferralDb({ introduced: null }).db as never, {});
    expect(result).toEqual({ ok: false, reason: 'introduced_not_registered' });
    expect(client.pushMessage).not.toHaveBeenCalled();
  });

  it('アンバサダーコードが affiliates に無い → invalid_code（文面は従来どおり）', async () => {
    stubStripe();
    const client = makeClient();
    const result = await processReferral(client as never, 'Uintroduced', 'ZZZZZZZZ', env, makeReferralDb({ affiliate: null }).db as never, { replyToken: 'rt' });
    expect(result).toEqual({ ok: false, reason: 'invalid_code' });
    expect((client.replyMessage.mock.calls[0][1] as { text: string }[])[0].text).toContain('友達紹介コードが有効ではない');
  });

  it('被紹介者が有料会員（plan_name に「プラン」）→ paid_member', async () => {
    stubStripe();
    const client = makeClient();
    const { db } = makeReferralDb({ introduced: { id: 'friend1', line_user_id: 'Uintroduced', display_name: '太郎', plan_name: 'PBプラン:メルカリ 基本プラン', metadata: '{}' } });
    const result = await processReferral(client as never, 'Uintroduced', 'AMB12345', env, db as never, { replyToken: 'rt' });
    expect(result).toEqual({ ok: false, reason: 'paid_member' });
    expect((client.replyMessage.mock.calls[0][1] as { text: string }[])[0].text).toContain('対象外');
  });

  it('自己紹介（アンバサダー本人）→ self_referral', async () => {
    stubStripe();
    const client = makeClient();
    const { db } = makeReferralDb({ ambassador: { id: 'friend1', line_user_id: 'Uintroduced', display_name: '太郎', plan_name: null, metadata: '{}' } });
    const result = await processReferral(client as never, 'Uintroduced', 'AMB12345', env, db as never, {});
    expect(result).toEqual({ ok: false, reason: 'self_referral' });
  });

  it('成立: 台帳に記録 → 被紹介者に半額クーポン → 期限 +7 日（D1→シート鏡写し）→ 2 通の通知 → 報酬クーポン適用', async () => {
    const calls = stubStripe({ monthly: 5980 });
    gasPost.mockResolvedValue({ success: true });
    const client = makeClient();
    const { db, writes } = makeReferralDb();

    const result = await processReferral(client as never, 'Uintroduced', 'AMB12345', env, db as never, { replyToken: 'rt' });

    expect(result).toEqual({ ok: true });
    expect(gasGet).not.toHaveBeenCalled();
    const insert = writes.find((w) => /INSERT INTO furim_referrals/.test(w.sql));
    expect(insert?.args).toContain('friend1');
    expect(insert?.args).toContain('アンバサダー1500円引きクーポン'); // 5980 円 → 1500 円帯
    expect(insert?.args).toContain('IDLf7QBx');
    // 被紹介者の Stripe 顧客に半額クーポン
    const introducedPost = calls.find((c) => c.url.endsWith('/v1/customers/cus_intro') && c.method === 'POST');
    expect(introducedPost?.body).toContain('coupon=IDLf7QBx');
    expect(introducedPost?.body).toContain('metadata%5BambassadorStripeID%5D=cus_amb');
    // +7 日: 2026-09-27 12:00:00 → 2026-10-04 12:00:00 を D1 とシートへ
    const extend = writes.find((w) => /INSERT INTO furim_customers/.test(w.sql) && w.sql.includes('subscription_end_at'));
    expect(extend?.args).toContain('2026-10-04 12:00:00');
    expect(gasPost).toHaveBeenCalledWith('deploy-id', { method: 'setCustomerFields', lineUserId: 'Uintroduced', fields: { 'サブスク終了日時': '2026-10-04 12:00:00' } });
    // 通知: 被紹介者は reply、アンバサダーは push（クーポン付与の文面）
    expect((client.replyMessage.mock.calls[0][1] as { text: string }[])[0].text).toContain('無料試用期間を1週間追加');
    expect(client.pushMessage.mock.calls[0][0]).toBe('Uamb');
    expect((client.pushMessage.mock.calls[0][1] as { text: string }[])[0].text).toContain('アンバサダー1500円引きクーポンを付与');
    // 報酬クーポンは Stripe 適用後に reward_applied_at
    const ambPost = calls.find((c) => c.url.endsWith('/v1/customers/cus_amb') && c.method === 'POST');
    expect(ambPost?.body).toContain('coupon=Tb8WoYb4');
    expect(writes.some((w) => /UPDATE furim_referrals SET reward_applied_at/.test(w.sql))).toBe(true);
    // 紹介経由タグ
    expect(writes.some((w) => /INSERT OR IGNORE INTO friend_tags/.test(w.sql))).toBe(true);
  });

  it('アンバサダーに既存の discount があれば報酬は未来に充当（適用しない）', async () => {
    const calls = stubStripe({ ambassadorDiscount: true });
    gasPost.mockResolvedValue({ success: true });
    const client = makeClient();
    const { db, writes } = makeReferralDb();
    await processReferral(client as never, 'Uintroduced', 'AMB12345', env, db as never, {});
    expect((client.pushMessage.mock.calls[1][1] as { text: string }[])[0].text).toContain('未来の支払いに充当');
    expect(calls.some((c) => c.url.endsWith('/v1/customers/cus_amb') && c.method === 'POST')).toBe(false);
    expect(writes.some((w) => /UPDATE furim_referrals SET reward_applied_at/.test(w.sql))).toBe(false);
  });

  it('報酬クーポンが 10 枚に達していれば付与せず感謝の文面', async () => {
    stubStripe();
    gasPost.mockResolvedValue({ success: true });
    const client = makeClient();
    const { db, writes } = makeReferralDb({ counts: { total: 12, rewarded: 10, applied: 10 }, pendingReward: null });
    await processReferral(client as never, 'Uintroduced', 'AMB12345', env, db as never, {});
    const insert = writes.find((w) => /INSERT INTO furim_referrals/.test(w.sql));
    expect(insert?.args).not.toContain('アンバサダー1500円引きクーポン');
    expect((client.pushMessage.mock.calls[1][1] as { text: string }[])[0].text).toContain('数多くのご紹介');
  });
});

// キーコードは D1 furim_customers から読む（Capsec #243）。GAS getKeyCode は呼ばない
function makeKeycodeDb(keyCode: string | null) {
  const stmt = {
    bind: vi.fn(),
    run: vi.fn().mockResolvedValue({}),
    first: vi.fn().mockImplementation(async () => (keyCode ? { key_code: keyCode } : null)),
  };
  stmt.bind.mockReturnValue(stmt);
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

describe('handleKeywordAction キーコードリセットの特別対応', () => {
  it('【キーワード】プレフィックスなしでも動き、説明＋キーコード単体を一括で返信する', async () => {
    gasGet.mockResolvedValueOnce({});                          // resetKeyCode
    const client = makeClient();

    const result = await handleKeywordAction(client as never, 'Uuser', 'rt', 'キーコードリセット', env, makeKeycodeDb('pb_test123') as never);

    expect(result).toBe(true);
    expect(gasGet).toHaveBeenCalledTimes(1);
    expect(gasGet).toHaveBeenCalledWith('deploy-id', { method: 'resetKeyCode', lineUserId: 'Uuser' });
    const messages = client.replyMessage.mock.calls[0][1];
    expect(messages).toHaveLength(2);
    expect(messages[0].text).toContain('リセットされたもの');
    expect(messages[0].text).toContain('お手数ですが次の対応をお願いいたします');
    // キーコードはコピーしやすいよう単体メッセージ
    expect(messages[1].text).toBe('pb_test123');
  });

  it('キーコードが取得できなくても、メニュー誘導つきの説明だけで返す', async () => {
    gasGet.mockResolvedValueOnce({});                                  // resetKeyCode
    const client = makeClient();

    const result = await handleKeywordAction(client as never, 'Uuser', 'rt', 'キーコードリセット', env, makeKeycodeDb(null) as never);

    expect(result).toBe(true);
    const messages = client.replyMessage.mock.calls[0][1];
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain('キーコード発行');
  });

  it('文中に含まれる場合でも部分一致で発火する（既存の他キーワードと同じ判定方式）', async () => {
    gasGet.mockResolvedValueOnce({});
    const client = makeClient();

    const result = await handleKeywordAction(client as never, 'Uuser', 'rt', 'お手数ですがキーコードリセットお願いします', env);

    expect(result).toBe(true);
    expect(gasGet).toHaveBeenCalledWith('deploy-id', { method: 'resetKeyCode', lineUserId: 'Uuser' });
  });

  it('従来通り【キーワード】プレフィックス付きでも動く', async () => {
    gasGet.mockResolvedValueOnce({});
    const client = makeClient();

    const result = await handleKeywordAction(client as never, 'Uuser', 'rt', '【キーワード】キーコードリセット', env);

    expect(result).toBe(true);
    expect(gasGet).toHaveBeenCalledWith('deploy-id', { method: 'resetKeyCode', lineUserId: 'Uuser' });
  });

  it('GASが失敗したら再実行キューに積むだけで中間返信はしない（2026-08-14 くろさん方針）', async () => {
    gasGet.mockRejectedValueOnce(new Error('GAS fetch hang (8000ms)'));
    const client = makeClient();
    const stmt = { bind: vi.fn(), run: vi.fn().mockResolvedValue({}), first: vi.fn().mockResolvedValue(null) };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) };

    const result = await handleKeywordAction(client as never, 'Uuser', 'rt', 'キーコードリセット', env, db as never);

    expect(result).toBe(true);
    // gas_retry_jobs への INSERT が走る（完遂通知はcron側がreplyToken優先で送る）
    const sqls = db.prepare.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqls.some((q: string) => q.includes('INSERT INTO gas_retry_jobs'))).toBe(true);
    expect(stmt.run).toHaveBeenCalled();
    // 中間の「受け付けました」返信は廃止（余計な返信はしない）
    expect(client.replyMessage).not.toHaveBeenCalled();
    expect(client.pushMessage).not.toHaveBeenCalled();
  });

  it('replyが失敗してもpushで完了通知を届ける（リセット自体は成功しているため）', async () => {
    gasGet.mockResolvedValueOnce({});
    const client = makeClient();
    client.replyMessage.mockRejectedValueOnce(new Error('Invalid reply token'));

    const result = await handleKeywordAction(client as never, 'Uuser', 'rt', '【キーワード】キーコードリセット', env, makeKeycodeDb('pb_test123') as never);

    expect(result).toBe(true);
    // 例外を外へ投げない（呼び出し元がエラー文言に化けさせないため）。reply と同じ2通をpushで届ける
    const pushed = client.pushMessage.mock.calls[0][1];
    expect(pushed).toHaveLength(2);
    expect(pushed[1].text).toBe('pb_test123');
  });

  it('replyが成功したときはpushしない（無駄な二重送信をしない）', async () => {
    gasGet.mockResolvedValueOnce({});
    const client = makeClient();

    await handleKeywordAction(client as never, 'Uuser', 'rt', 'キーコードリセット', env, makeKeycodeDb('pb_test123') as never);

    expect(client.replyMessage).toHaveBeenCalledTimes(1);
    expect(client.pushMessage).not.toHaveBeenCalled();
  });

  it('無関係なメッセージには反応しない', async () => {
    const client = makeClient();

    const result = await handleKeywordAction(client as never, 'Uuser', 'rt', 'こんにちは', env);

    expect(result).toBe(false);
    expect(gasGet).not.toHaveBeenCalled();
    expect(client.replyMessage).not.toHaveBeenCalled();
  });
});
