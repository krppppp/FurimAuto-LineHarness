import { describe, it, expect, vi, beforeEach } from 'vitest';

// 段階2.5（Capsec #250）: LINE 起点の残り（アンケート・Free30・在庫管理シート・無料開放・Furimanクーポン・解説見た・Meet予約）は
// D1 で完結し、GAS へは setCustomerFields の鏡写しだけを送る。gasGet / gasPost を差し替えて経路を確認する
const gasGet = vi.fn();
const gasPost = vi.fn();
vi.mock('./gas-client.js', () => ({ gasGet, gasPost, getGasErrorFromResponse: () => null }));
vi.mock('./firebase-client.js', () => ({
  getSentGiftBatches: vi.fn().mockResolvedValue([]),
  setSentGiftBatches: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@line-crm/db', () => ({
  jstNow: () => '2026-09-14T12:00:00.000+09:00',
  getFriendByLineUserId: vi.fn(),
  getAffiliateByFriendId: vi.fn(),
  createAffiliate: vi.fn(),
  enrollAffiliateInOffer: vi.fn(),
}));

const { handleButtonAction } = await import('./button-actions.js');
const { actionFurimanCoupon, actionExtendTrial, applyExtendTrialKeyword, resolveFurimanCoupon, handleFurimAction } = await import('./actions.js');

function makeClient() {
  return { replyMessage: vi.fn().mockResolvedValue({}), pushMessage: vi.fn().mockResolvedValue({}) };
}

type Write = { sql: string; args: unknown[] };

/** SQL でルーティングする簡易 D1（batch は run 相当で記録） */
function makeDb(opts: {
  customer?: Record<string, unknown> | null;
  friend?: Record<string, unknown> | null;
  coupons?: Record<string, string>;
  flagKeys?: string[];
  copyTicketsAfter?: number;
} = {}) {
  const writes: Write[] = [];
  const coupons = opts.coupons ?? { 'Youtubeご視聴感謝半額クーポン': '0lVkixXx', 'Youtubeご視聴感謝20%OFFクーポン': 'MxrPwCf8' };
  const friend = opts.friend === undefined ? { id: 'friend1', display_name: '太郎', created_at: '2026-09-10T10:00:00.000+09:00', metadata: '{}' } : opts.friend;
  const db = {
    prepare(sql: string) {
      const make = (args: unknown[]) => ({
        sql,
        args,
        run: async () => { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
        first: async () => {
          if (/FROM furim_customers WHERE line_user_id/.test(sql) && /SELECT \*/.test(sql)) return opts.customer === undefined ? null : opts.customer;
          if (/SELECT copy_tickets FROM furim_customers/.test(sql)) return { copy_tickets: opts.copyTicketsAfter ?? 0 };
          if (/SELECT stripe_customer_id FROM furim_customers/.test(sql)) return opts.customer ? { stripe_customer_id: (opts.customer as { stripe_customer_id?: string }).stripe_customer_id ?? null } : null;
          if (/SELECT created_at FROM friends/.test(sql)) return friend ? { created_at: friend.created_at } : null;
          if (/SELECT id, display_name FROM friends/.test(sql)) return friend ? { id: friend.id, display_name: friend.display_name } : null;
          if (/SELECT id, metadata FROM friends/.test(sql)) return friend ? { id: friend.id, metadata: friend.metadata } : null;
          if (/SELECT id FROM friends WHERE line_user_id/.test(sql)) return friend ? { id: friend.id } : null;
          if (/SELECT metadata FROM friends/.test(sql)) return friend ? { metadata: friend.metadata } : null;
          if (/FROM furim_coupons WHERE name/.test(sql)) { const id = coupons[String(args[0])]; return id ? { coupon_id: id } : null; }
          if (/FROM tags WHERE name/.test(sql)) return { id: 'tag1' };
          if (/FROM friend_tags WHERE friend_id/.test(sql)) return null;
          if (/SELECT id FROM gas_retry_jobs/.test(sql)) return null;
          return null;
        },
        all: async () => {
          if (/SELECT feature_key FROM furim_feature_flags/.test(sql)) return { results: (opts.flagKeys ?? []).map((k) => ({ feature_key: k })) };
          return { results: [] };
        },
      });
      return { bind: (...args: unknown[]) => make(args), ...make([]) };
    },
    async batch(stmts: Array<{ sql: string; args: unknown[] }>) {
      for (const s of stmts) writes.push({ sql: s.sql, args: s.args });
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  } as unknown as D1Database;
  return { db, writes };
}

const env = { GAS_DEPLOY_ID: 'deploy-id', STRIPE_SECRET_KEY: 'sk_test' };

function mirrorCall(fields: Record<string, unknown>, flags?: Record<string, string>) {
  return ['deploy-id', flags ? { method: 'setCustomerFields', lineUserId: 'Uxxx', fields, flags } : { method: 'setCustomerFields', lineUserId: 'Uxxx', fields }];
}

beforeEach(() => {
  vi.clearAllMocks();
  gasPost.mockResolvedValue({ success: true });
});

describe('【ボタン】アンケート回答', () => {
  it('D1 survey_answer と furim_survey_answers を書き、シートへは setCustomerFields で鏡写し（GAS setSurveyResult は呼ばない）', async () => {
    const client = makeClient();
    const { db, writes } = makeDb({ customer: { line_user_id: 'Uxxx', survey_answer: null } });
    await handleButtonAction(client as never, 'Uxxx', 'rt', '【ボタン】アンケート回答:物販', env, db);
    expect(writes.some((w) => /INSERT INTO furim_customers/.test(w.sql) && /survey_answer/.test(w.sql))).toBe(true);
    const hist = writes.find((w) => /INSERT INTO furim_survey_answers/.test(w.sql));
    expect(hist?.args.slice(1, 4)).toEqual(['Uxxx', '太郎', '物販']);
    expect(gasPost).toHaveBeenCalledWith(...mirrorCall({ 'アンケート回答': '物販' }));
    expect(gasPost).toHaveBeenCalledTimes(1);
  });
});

describe('【ボタン】コピー出品チケット30枚GET', () => {
  it('未受領なら台帳 free30:<id> で +30 して free30_ticket=1、残数をシートへ鏡写し', async () => {
    const client = makeClient();
    const { db, writes } = makeDb({ customer: { line_user_id: 'Uxxx', key_code: 'pb_1', free30_ticket: 0 }, copyTicketsAfter: 30 });
    await handleButtonAction(client as never, 'Uxxx', 'rt', '【ボタン】コピー出品チケット30枚GET', env, db);
    const ledger = writes.find((w) => /INSERT OR IGNORE INTO furim_ticket_ledger/.test(w.sql));
    expect(ledger?.args).toContain('free30:Uxxx');
    expect(ledger?.args).toContain(30);
    expect(writes.some((w) => /INSERT INTO furim_customers/.test(w.sql) && /free30_ticket/.test(w.sql))).toBe(true);
    expect(gasPost).toHaveBeenCalledWith(...mirrorCall({ 'Free30チケット': true, 'コピー出品チケット': 30 }));
    expect(client.replyMessage).toHaveBeenCalledTimes(1);
  });

  it('受領済みなら付与も鏡写しもしない（返信は同じ）', async () => {
    const client = makeClient();
    const { db, writes } = makeDb({ customer: { line_user_id: 'Uxxx', key_code: 'pb_1', free30_ticket: 1 } });
    await handleButtonAction(client as never, 'Uxxx', 'rt', '【ボタン】コピー出品チケット30枚GET', env, db);
    expect(writes.some((w) => /furim_ticket_ledger/.test(w.sql))).toBe(false);
    expect(gasPost).not.toHaveBeenCalled();
    expect(client.replyMessage).toHaveBeenCalledTimes(1);
  });
});

describe('【ボタン】在庫管理シート無料お試し', () => {
  it('D1 furim_feature_flags に InventorySheet/AutoMultiChannel を書き、flags で鏡写し（GAS enableInventorySheet は呼ばない）', async () => {
    const client = makeClient();
    const { db, writes } = makeDb({ customer: { line_user_id: 'Uxxx', key_code: 'pb_1' } });
    await handleButtonAction(client as never, 'Uxxx', 'rt', '【ボタン】在庫管理シート無料お試し', env, db);
    const flagWrites = writes.filter((w) => /INSERT INTO furim_feature_flags/.test(w.sql));
    expect(flagWrites.map((w) => w.args.slice(1, 3))).toEqual([['InventorySheet', '1'], ['AutoMultiChannel', 'メルカリ/Shops/ラクマ/ヤフオク/ヤフフリ']]);
    expect(gasPost).toHaveBeenCalledWith(...mirrorCall({}, { InventorySheet: '1', AutoMultiChannel: 'メルカリ/Shops/ラクマ/ヤフオク/ヤフフリ' }));
  });
});

describe('【ボタン】無料開放プレゼント', () => {
  it('キャンペーン終了後は終了案内を返し、GAS は呼ばない', async () => {
    const client = makeClient();
    const { db } = makeDb({ customer: { line_user_id: 'Uxxx', key_code: 'pb_1', plan_label: '', subscription_end_at: null } });
    await handleButtonAction(client as never, 'Uxxx', 'rt', '【ボタン】無料開放プレゼント', env, db);
    expect(client.replyMessage.mock.calls[0][1][0].text).toContain('このキャンペーンは終了しました');
    expect(gasPost).not.toHaveBeenCalled();
  });
});

describe('Furimanです（Youtube クーポン）', () => {
  function stubStripe(discount: unknown = null) {
    const fetchStub = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve({ ok: true, json: async () => ({}) });
      return Promise.resolve({ ok: true, json: async () => ({ discount }) });
    });
    vi.stubGlobal('fetch', fetchStub);
    return fetchStub;
  }

  it('登録 1 週間以内は半額クーポン: Stripe 適用 → D1 youtube_coupon＋適用履歴 → 返信 → シートへ鏡写し', async () => {
    const fetchStub = stubStripe();
    const client = makeClient();
    const { db, writes } = makeDb({ customer: { line_user_id: 'Uxxx', stripe_customer_id: 'cus_1', youtube_coupon: null }, friend: { id: 'friend1', display_name: '太郎', created_at: '2026-09-12T10:00:00.000+09:00', metadata: '{}' } });
    try {
      await actionFurimanCoupon(client as never, 'Uxxx', 'rt', env as never, db);
    } finally {
      vi.unstubAllGlobals();
    }
    const apply = fetchStub.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(String((apply?.[1] as RequestInit).body)).toContain('coupon=0lVkixXx');
    expect(writes.some((w) => /INSERT INTO furim_customers/.test(w.sql) && /youtube_coupon/.test(w.sql))).toBe(true);
    const hist = writes.find((w) => /INSERT INTO furim_coupon_applications/.test(w.sql));
    expect(hist?.args.slice(1, 6)).toEqual(['Uxxx', 'cus_1', 'Youtubeご視聴感謝半額クーポン', '0lVkixXx', 'Furiman経由']);
    expect(client.replyMessage.mock.calls[0][1][0].text).toContain('Youtubeご視聴感謝半額クーポン');
    expect(gasPost).toHaveBeenCalledWith(...mirrorCall({ 'Youtubeクーポン': 'Youtubeご視聴感謝半額クーポン' }));
    expect(gasGet).not.toHaveBeenCalled();
  });

  it('付与済みなら「既にご利用」を返して何も書かない', async () => {
    stubStripe();
    const client = makeClient();
    const { db, writes } = makeDb({ customer: { line_user_id: 'Uxxx', stripe_customer_id: 'cus_1', youtube_coupon: 'Youtubeご視聴感謝半額クーポン' } });
    try {
      await actionFurimanCoupon(client as never, 'Uxxx', 'rt', env as never, db);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(client.replyMessage.mock.calls[0][1][0].text).toContain('既にご利用いただいている');
    expect(writes).toHaveLength(0);
    expect(gasPost).not.toHaveBeenCalled();
  });

  it('resolveFurimanCoupon: 1 週間超は 20%OFF、顧客IDが無ければ null', async () => {
    const now = Date.parse('2026-09-20T10:00:00+09:00');
    const { db } = makeDb({ customer: { line_user_id: 'Uxxx', stripe_customer_id: 'cus_1', youtube_coupon: null } });
    expect(await resolveFurimanCoupon(db, 'Uxxx', now)).toMatchObject({ eligibleCouponName: 'Youtubeご視聴感謝20%OFFクーポン', eligibleCouponId: 'MxrPwCf8', canApply: true, daysSinceRegistration: 10 });
    const { db: db2 } = makeDb({ customer: null, friend: null });
    expect(await resolveFurimanCoupon(db2, 'Uxxx', now)).toBeNull();
  });
});

describe('解説見た（applyExtendTrialKeyword / actionExtendTrial）', () => {
  it('無料試用中・登録 1 週間以内 → 期限 +7 日・1w を D1 に書き、鏡写し fields を返す', async () => {
    const now = Date.parse('2026-09-14T12:00:00+09:00');
    const { db, writes } = makeDb({ customer: { line_user_id: 'Uxxx', key_code: '2weektrial_a', plan_label: null, extend_keyword: null, subscription_end_at: '2026-09-24 10:00:00' } });
    const r = await applyExtendTrialKeyword(db, undefined, 'Uxxx', now);
    expect(r.result).toBe('extended1w');
    expect(r.mirror).toEqual({ 'サブスク終了日時': '2026-10-01 10:00:00', '延長キーワード': '1w' });
    expect(r.newExpiry).toBe('2026-10-01T01:00:00.000Z');
    const upsert = writes.find((w) => /INSERT INTO furim_customers/.test(w.sql));
    expect(upsert?.args).toEqual(expect.arrayContaining(['2026-10-01T10:00:00.000+09:00', '1w']));
  });

  it('登録 1 週間超 → +3 日・3d', async () => {
    const now = Date.parse('2026-09-20T12:00:00+09:00');
    const { db } = makeDb({ customer: { line_user_id: 'Uxxx', key_code: '2weektrial_a', plan_label: '', extend_keyword: null, subscription_end_at: '2026-09-24 10:00:00' } });
    const r = await applyExtendTrialKeyword(db, undefined, 'Uxxx', now);
    expect(r.result).toBe('extended3d');
    expect(r.mirror?.['サブスク終了日時']).toBe('2026-09-27 10:00:00');
  });

  it('有料加入済み（プラン名あり）→ 対象外・台帳 +100（extend_keyword:<id>）', async () => {
    const { db, writes } = makeDb({ customer: { line_user_id: 'Uxxx', key_code: 'pb_1', plan_label: 'PBプラン:メルカリ', extend_keyword: null }, copyTicketsAfter: 105 });
    const r = await applyExtendTrialKeyword(db, undefined, 'Uxxx');
    expect(r.result).toBe('notEligible');
    expect(r.mirror).toEqual({ '延長キーワード': '対象外', 'コピー出品チケット': 105 });
    const ledger = writes.find((w) => /INSERT OR IGNORE INTO furim_ticket_ledger/.test(w.sql));
    expect(ledger?.args).toEqual(expect.arrayContaining([100, 'extend_keyword:Uxxx']));
  });

  it('使用済み → alreadyUsed、行なし → error', async () => {
    const { db } = makeDb({ customer: { line_user_id: 'Uxxx', plan_label: null, extend_keyword: '1w' } });
    expect((await applyExtendTrialKeyword(db, undefined, 'Uxxx')).result).toBe('alreadyUsed');
    const { db: db2 } = makeDb({ customer: null });
    expect((await applyExtendTrialKeyword(db2, undefined, 'Uxxx')).result).toBe('error');
  });

  it('actionExtendTrial: 返信 → 鏡写し → kaisetsu メタ（trial_end は新期限）', async () => {
    const now = Date.parse('2026-09-14T12:00:00+09:00');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const client = makeClient();
    const { db, writes } = makeDb({ customer: { line_user_id: 'Uxxx', key_code: '2weektrial_a', plan_label: null, extend_keyword: null, subscription_end_at: '2026-09-24 10:00:00' } });
    try {
      await actionExtendTrial(client as never, 'Uxxx', 'rt', 'deploy-id', db);
    } finally {
      vi.useRealTimers();
    }
    expect(client.replyMessage.mock.calls[0][1][0].text).toContain('1週間延長しました');
    expect(gasPost).toHaveBeenCalledWith(...mirrorCall({ 'サブスク終了日時': '2026-10-01 10:00:00', '延長キーワード': '1w' }));
    const meta = writes.find((w) => /UPDATE friends SET metadata = \?/.test(w.sql));
    expect(String(meta?.args[0])).toContain('"trial_end":"2026-10-01"');
  });
});

describe('Meet予約（延長キーワード送信済みかは D1 を見る）', () => {
  it('extend_keyword があれば予約 URL、無ければ動画視聴の案内。GAS は呼ばない', async () => {
    const client = makeClient();
    const { db } = makeDb({ customer: { line_user_id: 'Uxxx', extend_keyword: '1w' } });
    await handleFurimAction(client as never, 'Uxxx', 'rt', '【リッチメニュー】Meet予約', env, db);
    expect(client.replyMessage.mock.calls[0][1][0].text).toContain('FA_reservation');
    const client2 = makeClient();
    const { db: db2 } = makeDb({ customer: { line_user_id: 'Uxxx', extend_keyword: null } });
    await handleFurimAction(client2 as never, 'Uxxx', 'rt', '【リッチメニュー】Meet予約', env, db2);
    expect(client2.replyMessage.mock.calls[0][1][0].text).toContain('Meet予約の前に動画をご覧ください');
    expect(gasPost).not.toHaveBeenCalled();
    expect(gasGet).not.toHaveBeenCalled();
  });
});
