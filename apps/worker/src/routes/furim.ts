import { Hono } from 'hono';
import {
  getFriendByLineUserId,
  completeFriendActiveScenarios,
  enrollFriendInScenario,
  upsertFriend,
  jstNow,
} from '@line-crm/db';
import { gasGet } from '../furim/gas-client.js';
import type { Env } from '../index.js';

const furim = new Hono<Env>();

// 2026-08-24 シナリオ一本化: セグメント・通常/紹介に依らず常にこの1本へ enroll する。
// セグメント切替でも本編の進捗はリセットされない（alreadyEnrolled ガードでスキップ）。
// セグメントはタグとして付与を続けるので分析軸としては従来どおり使える。
// 旧14本（FurimAuto 通常/紹介 ステップ配信（セグメントN: ...））は is_active=0 で残置。
export const UNIFIED_SCENARIO_NAME = 'FurimAuto ステップ配信 統合版';

function scenarioNameFor(segment: number, _isReferral: boolean): string | null {
  if (!Number.isInteger(segment) || segment < 1 || segment > 8) return null;
  return UNIFIED_SCENARIO_NAME;
}

/**
 * POST /api/furim/scenario-switch
 * GASから呼び出される。ユーザーのセグメントが変わった時に
 * 現在のシナリオを完了させ、新しいシナリオに切り替える。
 *
 * Body: { lineUserId: string, segment: 1-6, isReferral: boolean }
 */
furim.post('/api/furim/scenario-switch', async (c) => {
  try {
    const body = await c.req.json<{ lineUserId: string; segment: number; isReferral: boolean }>();

    if (!body.lineUserId || typeof body.segment !== 'number') {
      return c.json({ success: false, error: 'lineUserId and segment are required' }, 400);
    }

    const db = c.env.DB;

    const friend = await getFriendByLineUserId(db, body.lineUserId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    // 月額会員は既に課金済み、キャンセル済み(解約者)は試用導線の対象外のためセグメント管理対象外。
    // 解約者への掘り起こし配信は自動enrollではなく、管理側の手動enroll(dayZeroAt指定)で行う
    const excludedTag = await db.prepare(`SELECT t.name FROM tags t JOIN friend_tags ft ON t.id = ft.tag_id WHERE ft.friend_id = ? AND t.name IN ('月額会員', 'キャンセル済み') LIMIT 1`).bind(friend.id).first<{ name: string }>();
    if (excludedTag) {
      console.log(`[furim/scenario-switch] friend=${friend.id} は${excludedTag.name}のためセグメント切り替えをスキップ`);
      return c.json({ success: true, data: { friendId: friend.id, scenarioId: null, scenarioName: excludedTag.name === '月額会員' ? 'skipped_member' : 'skipped_cancelled' } });
    }

    // セグメントタグ切り替え（古いセグメント全削除 → 新規付与）
    const segTagRows = await db.prepare(
      `SELECT id FROM tags WHERE name IN ('セグメント1','セグメント2','セグメント3','セグメント4','セグメント5','セグメント6','セグメント7','セグメント8')`
    ).all<{ id: string }>();
    for (const t of segTagRows.results) {
      await db.prepare('DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ?').bind(friend.id, t.id).run();
    }
    const newSegTag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(`セグメント${body.segment}`).first<{ id: string }>();
    if (newSegTag) {
      await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)').bind(friend.id, newSegTag.id, jstNow()).run();
    }

    // seg8（解説見た）も本編を継続する（2026-08-24 一本化）。
    // 旧実装は seg8 でシナリオを complete して kaisetsu cron 専任にしていたが、
    // 解説を見た人だけ本編が止まる理由がないため撤廃。クロージングは従来どおり
    // kaisetsu cron（closing_daily）が独立して面倒を見る。

    const scenarioName = scenarioNameFor(body.segment, Boolean(body.isReferral));
    if (!scenarioName) {
      return c.json({ success: false, error: `Unknown segment: ${body.segment}` }, 400);
    }

    const scenario = await db
      .prepare('SELECT id, name FROM scenarios WHERE name = ? AND is_active = 1 LIMIT 1')
      .bind(scenarioName)
      .first<{ id: string; name: string }>();

    if (!scenario) {
      return c.json({ success: false, error: `Scenario not found or inactive: ${scenarioName}` }, 404);
    }

    // 在籍中 or 完走済みなら何もしない。GAS sendStepMessages は毎時・対象者全員分を
    // 呼んでくるため、このガードがないと毎時 complete→re-enroll でステップ進行が
    // Day0 にリセットされ続け、日次のステップ配信が一切前進しない。
    // completed を含めるのは一本化(2026-08-24)から: 統合版はDay6で完走するため、
    // 完走後もGASが毎時セグメントを送ってくる → completed を弾かないと本編が
    // Day0から無限に再スタートする。掘り起こしは管理側の手動 enroll(dayZeroAt指定)で行う。
    const alreadyEnrolled = await db
      .prepare(`SELECT id, status FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ? AND status IN ('active', 'delivering', 'completed') LIMIT 1`)
      .bind(friend.id, scenario.id)
      .first<{ id: string; status: string }>();
    if (alreadyEnrolled) {
      return c.json({ success: true, data: { friendId: friend.id, scenarioId: scenario.id, scenarioName, alreadyEnrolled: true, enrollmentStatus: alreadyEnrolled.status } });
    }

    await completeFriendActiveScenarios(db, friend.id);
    await enrollFriendInScenario(db, friend.id, scenario.id);

    console.log(`[furim/scenario-switch] friend=${friend.id} seg=${body.segment} referral=${body.isReferral} → ${scenario.id}`);

    return c.json({ success: true, data: { friendId: friend.id, scenarioId: scenario.id, scenarioName } });
  } catch (err) {
    console.error('[furim/scenario-switch] error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/furim/upsert-friend
 * 外部スクリプト（import-customers.mjs）から呼び出す。
 * lineUserId をキーに友だちを作成/更新し、内部 UUID を返す。
 *
 * Body: { lineUserId: string, displayName?: string, pictureUrl?: string, statusMessage?: string,
 *         createdAt?: string, stripeCustomerId?: string, isFollowing?: boolean }
 * stripeCustomerId は friends.metadata にmerge（friend_addのStripe顧客作成スキップ判定と整合させる）。
 * isFollowing=false はブロック中ユーザーのインポート用（配信対象から外れる）。
 */
furim.post('/api/furim/upsert-friend', async (c) => {
  try {
    const body = await c.req.json<{
      lineUserId: string;
      displayName?: string | null;
      pictureUrl?: string | null;
      statusMessage?: string | null;
      createdAt?: string | null;
      stripeCustomerId?: string | null;
      isFollowing?: boolean;
    }>();

    if (!body.lineUserId) {
      return c.json({ success: false, error: 'lineUserId is required' }, 400);
    }

    const db = c.env.DB;
    const friend = await upsertFriend(db, {
      lineUserId: body.lineUserId,
      displayName: body.displayName ?? null,
      pictureUrl: body.pictureUrl ?? null,
      statusMessage: body.statusMessage ?? null,
      createdAt: body.createdAt ?? null,
    });

    // インポート用の追加フィールド: Stripe顧客ID（metadataへmerge）とフォロー状態
    if (body.stripeCustomerId || body.isFollowing !== undefined) {
      const row = await db
        .prepare('SELECT metadata, is_following FROM friends WHERE id = ?')
        .bind(friend.id)
        .first<{ metadata: string; is_following: number }>();
      const meta = JSON.parse(row?.metadata || '{}') as Record<string, unknown>;
      if (body.stripeCustomerId) meta.stripeCustomerId = body.stripeCustomerId;
      const following = body.isFollowing === undefined ? (row?.is_following ?? 1) : body.isFollowing ? 1 : 0;
      await db
        .prepare('UPDATE friends SET metadata = ?, is_following = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(meta), following, jstNow(), friend.id)
        .run();
    }

    return c.json({
      success: true,
      data: {
        id: friend.id,
        lineUserId: friend.line_user_id,
        displayName: friend.display_name,
        pictureUrl: friend.picture_url,
        createdAt: friend.created_at,
      },
    });
  } catch (err) {
    console.error('[furim/upsert-friend] error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/furim/test-reset
 * 動作検証用: 指定LINEユーザーのデータを D1・スプシ・Stripe・Firebase から
 * 全削除し、「新規友達」として最初からフローをやり直せる状態にする。
 * ブロック→ブロック解除で isNewUser=true の新規登録フローが再現される。
 *
 * Body: { lineUserId: string, confirmProd?: boolean, force?: boolean }
 * - 本番worker: confirmProd=true が必須（実顧客データ・本番Stripe顧客を削除するため）
 * - 月額会員タグ付きユーザー: force=true が必須（実顧客の誤削除防止）
 */
furim.post('/api/furim/test-reset', async (c) => {
  const isDev = c.env.WORKER_NAME === 'line-harness';
  try {
    const body = await c.req.json<{ lineUserId?: string; confirmProd?: boolean; force?: boolean }>();
    const lineUserId = body.lineUserId;
    if (!lineUserId) return c.json({ success: false, error: 'lineUserId required' }, 400);
    if (!isDev && body.confirmProd !== true) {
      return c.json({
        success: false,
        error: '本番workerです。実顧客データ・本番Stripe顧客を削除するため confirmProd: true が必要です',
      }, 403);
    }
    const db = c.env.DB;
    const result: Record<string, unknown> = { lineUserId, env: isDev ? 'dev' : 'prod' };
    const stripeIds = new Set<string>();

    // 1) D1: friendと関連レコード
    const friend = await db
      .prepare('SELECT id, metadata FROM friends WHERE line_user_id = ?')
      .bind(lineUserId)
      .first<{ id: string; metadata: string }>();

    // 有料会員保護: 月額会員タグ付きは force がない限り中断（実顧客の誤削除防止）
    if (friend && !body.force) {
      const paid = await db
        .prepare(
          "SELECT 1 AS x FROM friend_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.friend_id = ? AND t.name = '月額会員'",
        )
        .bind(friend.id)
        .first();
      if (paid) {
        return c.json({
          success: false,
          error: '月額会員タグが付いています。有料会員の可能性があるため中断しました。本当に消す場合は force: true',
        }, 409);
      }
    }
    if (friend) {
      const meta = JSON.parse(friend.metadata || '{}') as Record<string, string>;
      if (meta.stripeCustomerId) stripeIds.add(meta.stripeCustomerId);
      const tables = [
        'friend_tags', 'friend_scenarios', 'friend_scores', 'friend_reminders',
        'messages_log', 'chats', 'conversion_events', 'automation_logs',
        'stripe_events', 'ad_conversion_logs', 'ref_tracking',
      ];
      for (const t of tables) {
        try {
          await db.prepare(`DELETE FROM ${t} WHERE friend_id = ?`).bind(friend.id).run();
        } catch (e) {
          console.log(`[test-reset] ${t} skip:`, e);
        }
      }
      await db.prepare('DELETE FROM friends WHERE id = ?').bind(friend.id).run();
      result.d1 = 'deleted';
    } else {
      result.d1 = 'not_found';
    }

    // 2) スプシ: マスター行削除（行にあったStripe顧客IDも回収）
    if (c.env.GAS_DEPLOY_ID) {
      try {
        const { gasPost } = await import('../furim/gas-client.js');
        const r = (await gasPost(c.env.GAS_DEPLOY_ID, { method: 'deleteCustomerRowByLineId', lineUserId })) as {
          success?: boolean;
          deleted?: Array<{ row: number; stripeCustomerId?: string }>;
        };
        (r?.deleted ?? []).forEach((d) => { if (d.stripeCustomerId) stripeIds.add(d.stripeCustomerId); });
        result.sheetRowsDeleted = (r?.deleted ?? []).length;
      } catch (e) {
        result.sheet = `error: ${String(e)}`;
      }
    }

    // 3) Stripe顧客削除（dev=テスト/prod=本番。サブスクも同時にキャンセルされる）
    const deletedCustomers: string[] = [];
    if (c.env.STRIPE_SECRET_KEY) {
      for (const cus of stripeIds) {
        try {
          const res = await fetch(`https://api.stripe.com/v1/customers/${cus}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}` },
          });
          if (res.ok) deletedCustomers.push(cus);
        } catch (e) {
          console.log('[test-reset] stripe skip:', e);
        }
      }
    }
    result.stripeCustomersDeleted = deletedCustomers;

    // 4) Firebase: 特典配布状態(sentGiftBatches)・AIモード・チャット履歴
    if (c.env.FIREBASE_DATABASE_URL) {
      try {
        const { fbDelete } = await import('../furim/firebase-client.js');
        await fbDelete(c.env.FIREBASE_DATABASE_URL, `userStatus/${lineUserId}`);
        await fbDelete(c.env.FIREBASE_DATABASE_URL, `aiChatHistory/${lineUserId}`);
        result.firebase = 'deleted';
      } catch (e) {
        result.firebase = `error: ${String(e)}`;
      }
    }

    console.log('[test-reset]', JSON.stringify(result));
    return c.json({ success: true, ...result });
  } catch (err) {
    console.error('[furim/test-reset] error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/furim/migrate-subscriptions （タスク#7: 旧サブスク一括移行）
 * 旧プランのStripeサブスクを、キャンセルせずに items のin-place更新で
 * 新方式（パッケージ/機能Price構成 + metadata.source=plan-builder）へ移行する。
 * キャンセルしないので subscription.deleted webhook（退会メッセージ）は発生しない。
 *
 * Body: {
 *   dryRun?: boolean = true,      // trueなら読み取りのみ（レポート生成）
 *   confirmProd?: boolean,        // 本番workerで dryRun=false にする場合必須
 *   mapping: Record<プラン名, { packages: string[]; features: string[];
 *     multiChannelSites?: string[]; priceMatch?: boolean; manual?: boolean }>,
 *   onlySubscriptionId?: string,  // 検証用: 対象を1件に絞る
 *   forceNickname?: string,       // 検証用: onlySubscriptionId対象をこのプラン名として扱う
 * }
 */
/**
 * POST /api/furim/grant-coupon
 * 有料会員へキャンペーンクーポン（次回請求で1回だけ効く固定額OFF）を付与する。
 * 併用割引(forever)とスタックされ、次回請求で両方効く（Stripe新版discounts配列・検証済み）。
 * onceクーポンは適用後に自動でサブスクから外れる。
 *
 * Body: { lineUserId: string, amountOff: number, name?: string, notify?: boolean (既定true) }
 */
furim.post('/api/furim/grant-coupon', async (c) => {
  try {
    const body = await c.req.json<{ lineUserId?: string; amountOff?: number; name?: string; notify?: boolean }>();
    const lineUserId = body.lineUserId ?? '';
    const amountOff = Math.floor(Number(body.amountOff ?? 0));
    if (!lineUserId || !amountOff || amountOff <= 0) {
      return c.json({ success: false, error: 'lineUserId と amountOff（正の整数・円）が必要です' }, 400);
    }
    const secretKey = c.env.STRIPE_SECRET_KEY;
    if (!secretKey) return c.json({ success: false, error: 'STRIPE_SECRET_KEY not configured' }, 500);

    const { getActiveSubscriptionForLine, getSubDiscounts, stripeCall, STRIPE_STACK_VERSION } = await import('./plan-builder.js');
    const found = await getActiveSubscriptionForLine(c.env, lineUserId);
    if (!found) {
      return c.json({ success: false, error: 'アクティブなサブスクリプションが見つかりません（有料会員のみ付与できます）' }, 404);
    }
    const subId = String((found.sub as { id: string }).id);

    const name = body.name || `キャンペーンクーポン ${amountOff.toLocaleString('ja-JP')}円OFF`;
    const coupon = await stripeCall(secretKey, 'coupons', {
      amount_off: String(amountOff),
      currency: 'jpy',
      duration: 'once',
      name,
    });

    // 既存discount（併用割引等）を保持したままスタック追加
    const existing = await getSubDiscounts(secretKey, subId);
    const params: Record<string, string> = {};
    existing.forEach((d, i) => {
      params[`discounts[${i}][discount]`] = d.discountId;
    });
    params[`discounts[${existing.length}][coupon]`] = String(coupon.id);
    await stripeCall(secretKey, `subscriptions/${subId}`, params, 'POST', STRIPE_STACK_VERSION);

    let notified = false;
    if (body.notify !== false && c.env.LINE_CHANNEL_ACCESS_TOKEN) {
      try {
        const { LineClient } = await import('@line-crm/line-sdk');
        const text = `🎁 ${name}を適用しました！\n次回のお支払いが${amountOff.toLocaleString('ja-JP')}円引きになります。いつもご利用ありがとうございます！`;
        await new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN).pushMessage(lineUserId, [{ type: 'text', text } as never]);
        const friend = await getFriendByLineUserId(c.env.DB, lineUserId);
        if (friend) {
          const { logOutgoing } = await import('../utils/message-log.js');
          await logOutgoing(c.env.DB, friend.id, 'text', text);
        }
        notified = true;
      } catch (e) {
        console.error('[furim/grant-coupon] notify failed:', e);
      }
    }

    console.log('[furim/grant-coupon]', JSON.stringify({ lineUserId, subId, couponId: coupon.id, amountOff, notified }));
    return c.json({
      success: true,
      subscriptionId: subId,
      couponId: coupon.id,
      amountOff,
      name,
      stackedWith: existing.map((d) => d.name || d.couponId),
      notified,
    });
  } catch (err) {
    console.error('[furim/grant-coupon] error:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

furim.post('/api/furim/migrate-subscriptions', async (c) => {
  const isDev = c.env.WORKER_NAME === 'line-harness';
  try {
    const body = await c.req.json<{
      dryRun?: boolean;
      confirmProd?: boolean;
      mapping?: Record<string, { packages: string[]; features: string[]; multiChannelSites?: string[]; priceMatch?: boolean; manual?: boolean }>;
      onlySubscriptionId?: string;
      forceNickname?: string;
      testClock?: string; // 検証用: Stripeのlistはテストクロック顧客を除外するため明示指定が必要
    }>();
    const dryRun = body.dryRun !== false;
    if (!dryRun && !isDev && body.confirmProd !== true) {
      return c.json({ success: false, error: '本番workerでの実行には confirmProd: true が必要です' }, 403);
    }
    const secretKey = c.env.STRIPE_SECRET_KEY;
    if (!secretKey) return c.json({ success: false, error: 'STRIPE_SECRET_KEY not configured' }, 500);
    const mapping = body.mapping ?? {};

    const { stripeCall, ensureComboCoupon, fetchMasterByEnv } = await import('./plan-builder.js');
    const master = await fetchMasterByEnv(c.env.GAS_DEPLOY_ID);
    const pkgByKey = Object.fromEntries(master.packages.map((p) => [p.package_key, p]));
    const featByKey = Object.fromEntries(master.features.map((f) => [f.feature_key, f]));

    // 全activeサブスクをページング取得
    type SubItem = { id: string; quantity?: number; price?: { id: string; unit_amount?: number; nickname?: string | null } };
    type Sub = { id: string; customer: string; metadata?: Record<string, string>; items: { data: SubItem[] }; plan?: { nickname?: string | null } };
    const subs: Sub[] = [];
    let startingAfter: string | undefined;
    for (;;) {
      const params: Record<string, string> = { status: 'active', limit: '100' };
      if (body.testClock) params.test_clock = body.testClock;
      if (startingAfter) params.starting_after = startingAfter;
      const page = (await stripeCall(secretKey, 'subscriptions', params, 'GET')) as unknown as { data: Sub[]; has_more: boolean };
      subs.push(...page.data);
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1].id;
    }

    const report: Array<Record<string, unknown>> = [];
    let migrated = 0;
    const maxExecute = 15; // サブリクエスト上限対策。移行済みはskip-pbになるので再実行で続きから進む
    for (const sub of subs) {
      if (body.onlySubscriptionId && sub.id !== body.onlySubscriptionId) continue;
      const row: Record<string, unknown> = { id: sub.id, customer: sub.customer };
      // 検証用: onlySubscriptionId+forceNickname 指定時はPBサブスクでも強制的に移行対象にする
      const forceTarget = Boolean(body.onlySubscriptionId && body.forceNickname && sub.id === body.onlySubscriptionId);
      if (sub.metadata?.source === 'plan-builder' && !forceTarget) {
        row.status = 'skip-pb';
        row.oldAmount = sub.items.data.reduce((sum, it) => sum + (it.price?.unit_amount ?? 0) * (it.quantity ?? 1), 0);
        if (sub.metadata?.migratedFrom) row.migratedFrom = sub.metadata.migratedFrom;
        report.push(row);
        continue;
      }
      const nickname =
        (body.onlySubscriptionId && body.forceNickname) ||
        sub.items.data[0]?.price?.nickname ||
        sub.plan?.nickname ||
        '';
      row.nickname = nickname;
      row.oldAmount = sub.items.data.reduce((sum, it) => sum + (it.price?.unit_amount ?? 0) * (it.quantity ?? 1), 0);

      const entry = nickname ? mapping[nickname] : undefined;
      if (!entry) { row.status = 'unmapped'; report.push(row); continue; }
      if (entry.manual) { row.status = 'manual'; report.push(row); continue; }
      if (entry.priceMatch === false) { row.status = 'price-mismatch'; report.push(row); continue; }

      // 新item構成と新金額
      const mcSites = entry.multiChannelSites ?? [];
      const newItems: Array<{ price: string; quantity: number }> = [];
      let newAmount = 0;
      let bad = '';
      const nFull = entry.packages.filter((k) => pkgByKey[k]?.plan_type === 'full').length;
      const nSemi = entry.packages.filter((k) => pkgByKey[k]?.plan_type === 'semi').length;
      const combo = entry.packages.length >= 2 ? 1500 * nFull + 480 * nSemi : 0;
      for (const k of entry.packages) {
        const p = pkgByKey[k];
        if (!p?.stripe_price_id || p.stripe_price_id === 'なし') { bad = `package price missing: ${k}`; break; }
        newItems.push({ price: p.stripe_price_id, quantity: 1 });
        newAmount += Number(p.monthly_price);
      }
      if (!bad) {
        for (const k of entry.features) {
          const f = featByKey[k];
          if (!f?.stripe_price_id) { bad = `feature price missing: ${k}`; break; }
          const qty = k === 'AutoMultiChannel' ? Math.max(1, mcSites.length) : 1;
          newItems.push({ price: f.stripe_price_id, quantity: qty });
          newAmount += k === 'AutoMultiChannel'
            ? Number(f.monthly_price) + Math.max(0, mcSites.length - 2) * 1980
            : Number(f.monthly_price);
        }
      }
      newAmount -= combo;
      if (bad) { row.status = 'error'; row.error = bad; report.push(row); continue; }
      row.newAmount = newAmount;
      row.packages = entry.packages;
      row.features = entry.features;
      row.amountDiff = newAmount - (row.oldAmount as number);
      row.status = dryRun ? 'ready' : 'pending';

      if (!dryRun) {
        if (migrated >= maxExecute) { row.status = 'deferred'; report.push(row); continue; }
        try {
          // LINE ID逆引き（syncFeatures・plan-apply系がmetadata.lineUserIdを参照するため）
          let lineUserId = '';
          if (c.env.GAS_DEPLOY_ID) {
            try {
              const { gasGet } = await import('../furim/gas-client.js');
              const r = (await gasGet(c.env.GAS_DEPLOY_ID, { method: 'getLINEIDwithStripeID', stripeCustomerID: sub.customer })) as { customer_line_id?: string };
              lineUserId = r?.customer_line_id ?? '';
            } catch { /* 逆引き失敗は許容 */ }
          }
          const params: Record<string, string> = { proration_behavior: 'none' };
          sub.items.data.forEach((it, i) => {
            params[`items[${i}][id]`] = it.id;
            params[`items[${i}][deleted]`] = 'true';
          });
          newItems.forEach((it, i) => {
            const idx = sub.items.data.length + i;
            params[`items[${idx}][price]`] = it.price;
            params[`items[${idx}][quantity]`] = String(it.quantity);
          });
          if (combo > 0) {
            const couponId = await ensureComboCoupon(secretKey, nFull, nSemi);
            if (couponId) params.coupon = couponId;
          }
          params['metadata[source]'] = 'plan-builder';
          params['metadata[packages]'] = entry.packages.join(',');
          params['metadata[features]'] = entry.features.join(',');
          if (mcSites.length > 0) params['metadata[multiChannelSites]'] = mcSites.join('/');
          if (lineUserId) params['metadata[lineUserId]'] = lineUserId;
          params['metadata[migratedFrom]'] = nickname;
          await stripeCall(secretKey, `subscriptions/${sub.id}`, params);
          row.status = 'migrated';
          migrated++;
        } catch (e) {
          row.status = 'error';
          row.error = String(e);
        }
      }
      report.push(row);
    }

    const counts: Record<string, number> = {};
    for (const r of report) counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1;
    console.log('[migrate-subscriptions]', JSON.stringify({ dryRun, total: subs.length, counts }));
    return c.json({ success: true, dryRun, total: subs.length, migrated, counts, report });
  } catch (err) {
    console.error('[furim/migrate-subscriptions] error:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

/**
 * POST /api/furim/setup-prices
 * 機能マスタ・パッケージマスタのStripe Product+Priceを作成する（lookup_keyで冪等）。
 * scratchpad消失した setup_test_mode.py の再実装（worker内=本番鍵はsecretsから）。
 * Body: { dryRun?: boolean = true }
 * 仕様: currency=jpy / recurring=month / tax_behavior=exclusive / lookup_key=feature_key|package_key
 *   Product名=「{サイト名} {機能名}」（crossはdisplay_nameそのまま）/ metadata.feature|package
 *   AutoMultiChannelのみ tiered graduated（〜2サイトflat=monthly_price / 3〜 +1980/サイト）
 */
furim.post('/api/furim/setup-prices', async (c) => {
  try {
    const body = await c.req.json<{ dryRun?: boolean }>().catch(() => ({}) as { dryRun?: boolean });
    const dryRun = body.dryRun !== false;
    const secretKey = c.env.STRIPE_SECRET_KEY;
    if (!secretKey) return c.json({ success: false, error: 'STRIPE_SECRET_KEY not configured' }, 500);
    const { stripeCall, fetchMasterByEnv } = await import('./plan-builder.js');
    const master = await fetchMasterByEnv(c.env.GAS_DEPLOY_ID);

    const SITE_JP: Record<string, string> = {
      mercari: 'メルカリ', mercariShops: 'メルカリShops', rakuma: 'ラクマ', yahooFlea: 'ヤフフリ',
      yahooAuction: 'ヤフオク', inventory: '在庫管理', cross: '',
    };
    const results: Array<Record<string, unknown>> = [];
    const maxCreate = 25; // Workersのサブリクエスト上限(50)対策。残りは再実行で作成される
    let created = 0;

    // 既存Priceのlookup_keyを一括プリロード（1件ずつのlookupだと上限超過する）
    const byLookup = new Map<string, string>();
    {
      let after: string | undefined;
      for (;;) {
        const params: Record<string, string> = { limit: '100', active: 'true' };
        if (after) params.starting_after = after;
        const page = (await stripeCall(secretKey, 'prices', params, 'GET')) as unknown as { data: Array<{ id: string; lookup_key?: string | null }>; has_more: boolean };
        for (const pr of page.data) if (pr.lookup_key) byLookup.set(pr.lookup_key, pr.id);
        if (!page.has_more || page.data.length === 0) break;
        after = page.data[page.data.length - 1].id;
      }
    }
    const findByLookup = async (key: string): Promise<string | null> => byLookup.get(key) ?? null;

    for (const f of master.features) {
      if (f.billing_type !== 'subscription') { results.push({ key: f.feature_key, status: 'skip-ticket' }); continue; }
      const existing = await findByLookup(f.feature_key);
      if (existing) { results.push({ key: f.feature_key, priceId: existing, status: 'existing' }); continue; }
      if (dryRun) { results.push({ key: f.feature_key, status: 'would-create' }); continue; }
      if (created >= maxCreate) { results.push({ key: f.feature_key, status: 'deferred' }); continue; }
      const siteJp = SITE_JP[f.site] ?? '';
      const productName = siteJp ? `${siteJp} ${f.display_name}` : f.display_name;
      const params: Record<string, string> = {
        currency: 'jpy',
        'recurring[interval]': 'month',
        tax_behavior: 'exclusive',
        lookup_key: f.feature_key,
        'metadata[feature]': f.feature_key,
        'product_data[name]': productName,
        'product_data[metadata][feature]': f.feature_key,
      };
      if (f.feature_key === 'AutoMultiChannel') {
        params.billing_scheme = 'tiered';
        params.tiers_mode = 'graduated';
        params['tiers[0][up_to]'] = '2';
        params['tiers[0][flat_amount]'] = String(f.monthly_price);
        params['tiers[1][up_to]'] = 'inf';
        params['tiers[1][unit_amount]'] = '1980';
      } else {
        params.unit_amount = String(f.monthly_price);
      }
      const price = await stripeCall(secretKey, 'prices', params);
      created++;
      results.push({ key: f.feature_key, priceId: price.id, status: 'created' });
    }

    for (const p of master.packages) {
      if (p.package_key === 'trial' || Number(p.monthly_price) <= 0) { results.push({ key: p.package_key, status: 'skip-free' }); continue; }
      const existing = await findByLookup(p.package_key);
      if (existing) { results.push({ key: p.package_key, priceId: existing, status: 'existing' }); continue; }
      if (dryRun) { results.push({ key: p.package_key, status: 'would-create' }); continue; }
      if (created >= maxCreate) { results.push({ key: p.package_key, status: 'deferred' }); continue; }
      const price = await stripeCall(secretKey, 'prices', {
        currency: 'jpy',
        'recurring[interval]': 'month',
        tax_behavior: 'exclusive',
        unit_amount: String(p.monthly_price),
        lookup_key: p.package_key,
        'metadata[package]': p.package_key,
        'product_data[name]': p.display_name,
        'product_data[metadata][package]': p.package_key,
      });
      created++;
      results.push({ key: p.package_key, priceId: price.id, status: 'created' });
    }

    const counts: Record<string, number> = {};
    for (const r of results) counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1;
    console.log('[setup-prices]', JSON.stringify({ dryRun, counts }));
    return c.json({ success: true, dryRun, counts, results });
  } catch (err) {
    console.error('[furim/setup-prices] error:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

/**
 * POST /api/furim/backfill-plan-names
 * GASスプシ「顧客情報-サブスク情報-キーコード」の既存プラン名データをD1 friends.plan_nameへ
 * 一括バックフィルする。Stripe webhook同期(stripe-processor.ts)導入前の既存データ用、および
 * スプシ側が手動編集された場合の再同期用リカバリ手段として維持する。
 * Body: { dryRun?: boolean = true, confirmProd?: boolean }
 */
furim.post('/api/furim/backfill-plan-names', async (c) => {
  const isDev = c.env.WORKER_NAME === 'line-harness';
  try {
    const body = await c.req.json<{ dryRun?: boolean; confirmProd?: boolean }>().catch(() => ({}) as { dryRun?: boolean; confirmProd?: boolean });
    const dryRun = body.dryRun !== false;
    if (!dryRun && !isDev && body.confirmProd !== true) {
      return c.json({ success: false, error: '本番workerでの実行には confirmProd: true が必要です' }, 403);
    }
    if (!c.env.GAS_DEPLOY_ID) return c.json({ success: false, error: 'GAS_DEPLOY_ID not configured' }, 500);

    const gasRes = (await gasGet(c.env.GAS_DEPLOY_ID, {
      method: 'getData',
      sheet: '顧客情報-サブスク情報-キーコード',
      headerRow: '3',
    })) as { success: boolean; rows?: Array<Record<string, unknown>> };
    if (!gasRes.success || !gasRes.rows) {
      return c.json({ success: false, error: 'GASからのデータ取得に失敗しました' }, 500);
    }

    const targets = gasRes.rows
      .map((row) => ({
        lineUserId: String(row['LINE_ID'] ?? '').trim(),
        planName: String(row['プラン名'] ?? '').trim(),
      }))
      .filter((r) => r.lineUserId && r.planName);

    if (dryRun) {
      return c.json({
        success: true,
        dryRun,
        totalRows: gasRes.rows.length,
        targetCount: targets.length,
        sample: targets.slice(0, 5),
      });
    }

    // Workersのサブリクエスト上限対策で100件単位のbatchに分割。
    // updated は「実際にUPDATEがマッチした行数」(meta.changesの合計)。試行数(targets.length)
    // ではない — D1のline_user_idにマッチする行が無ければ changes=0 のまま無言で通り過ぎるため、
    // 差分を notMatched として可視化する（GAS側の表記ゆれ・削除済み友だち等の検知用）。
    const CHUNK = 100;
    let updated = 0;
    for (let i = 0; i < targets.length; i += CHUNK) {
      const chunk = targets.slice(i, i + CHUNK);
      const now = jstNow();
      const stmts = chunk.map((t) =>
        c.env.DB.prepare(`UPDATE friends SET plan_name = ?, updated_at = ? WHERE line_user_id = ?`).bind(
          t.planName,
          now,
          t.lineUserId,
        ),
      );
      const results = await c.env.DB.batch(stmts);
      updated += results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
    }
    const notMatched = targets.length - updated;

    console.log(
      '[furim/backfill-plan-names]',
      JSON.stringify({ dryRun, totalRows: gasRes.rows.length, targetCount: targets.length, updated, notMatched }),
    );
    return c.json({
      success: true,
      dryRun,
      totalRows: gasRes.rows.length,
      targetCount: targets.length,
      updated,
      notMatched,
    });
  } catch (err) {
    console.error('[furim/backfill-plan-names] error:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

export { furim };
