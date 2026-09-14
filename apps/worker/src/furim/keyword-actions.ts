import type { LineClient } from '@line-crm/line-sdk';
import { buildKeycodeResetMessages, fetchCurrentKeyCode } from './gas-retry-queue.js';
import { copyTicketFlexMessage } from './messages.js';
import { upsertFurimCustomer, resolveStripeCustomerId, extendSubscriptionEnd, getFurimCustomer } from './customer-store.js';
import { mirrorCustomerFieldsToGas } from './gas-retry-queue.js';
import { invalidateExtCache, type ExtCache } from './ext-auth.js';
import { applyTrialCampaign, buildLegacyCheckoutUrl } from './legacy-keywords.js';
import { isPaidPlan } from './ticket-checkout.js';
import {
  INTRODUCED_COUPON_NAME,
  REWARD_COUPON_LIMIT,
  getCouponId,
  countReferrals,
  recordReferral,
  findReferralByIntroduced,
  findUnappliedReward,
  markRewardApplied,
} from './referral-store.js';
import { getFriendByLineUserId, getFriendById, getAffiliateByCode, completeFriendActiveScenarios, getScenarioByName, enrollFriendInScenario, jstNow } from '@line-crm/db';

// seed-furimauto-all-scenarios.mjs v2 の命名と一致させること（旧統合7本命名だと見つからず切替が空振りする）
const REFERRAL_SCENARIO_NAME = 'FurimAuto 紹介 ステップ配信（セグメント1: アンケート未回答）';

// アンバサダー報酬クーポンの額を、アンバサダー自身の月額（Stripe実額）帯で決める。
// クーポン名は GAS couponSheet の名称と完全一致させること（GAS側でIDに解決される）。
function ambassadorCouponNameFromPrice(monthlyAmount: number): string | null {
  if (!(monthlyAmount > 0)) return null;
  if (monthlyAmount < 4000) return 'アンバサダー500円引きクーポン';
  if (monthlyAmount < 8000) return 'アンバサダー1500円引きクーポン';
  if (monthlyAmount < 12000) return 'アンバサダー3000円引きクーポン';
  return 'アンバサダー5000円引きクーポン';
}

/**
 * アンバサダーの現サブスク月額(Stripe実額)からアンバサダー報酬クーポン名を決める。
 * ambassadorCode → affiliate → friend → lineUserId → GAS getStripeIDwithLINEID → 顧客ID
 * → Stripe の active サブスク（前提: アンバサダーは常に1本）の全item合計 → 金額帯 → クーポン名。
 * 解決できなければ null（GAS側の従来ロジックにフォールバック）。
 */
async function resolveAmbassadorCouponName(ambassadorCode: string, env: KeywordActionsEnv, db?: D1Database): Promise<string | null> {
  try {
    if (!db || !env.STRIPE_SECRET_KEY) return null;
    const affiliate = await getAffiliateByCode(db, ambassadorCode);
    if (!affiliate?.friend_id) return null;
    const friend = await getFriendById(db, affiliate.friend_id);
    if (!friend?.line_user_id) return null;
    // Stripe顧客ID は D1（furim_customers → friends.metadata）から（Capsec #244。GAS getStripeIDwithLINEID は呼ばない）
    const customerId = await resolveStripeCustomerId(db, friend.line_user_id);
    if (!customerId) return null;
    const res = await fetch(`https://api.stripe.com/v1/subscriptions?customer=${customerId}&status=active&limit=1`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    }).then(r => r.json()) as { data?: Array<{ items?: { data?: Array<{ price?: { unit_amount?: number }; quantity?: number }> } }> };
    const sub = res.data?.[0];
    if (!sub) return null;
    const monthly = (sub.items?.data ?? []).reduce((t, it) => t + (it.price?.unit_amount ?? 0) * (it.quantity ?? 1), 0);
    return ambassadorCouponNameFromPrice(monthly);
  } catch (err) {
    console.error('[furim] resolveAmbassadorCouponName failed (fallback to GAS plan logic):', err);
    return null;
  }
}

export type KeywordActionsEnv = {
  GAS_DEPLOY_ID: string;
  STRIPE_SECRET_KEY?: string;
  DB?: D1Database;
  FURIM_EXT_CACHE?: ExtCache;
  // 登録URL発行（旧プランの決済 LIFF）用。WORKER_NAME で dev/prod を判定
  LIFF_URL?: string;
  WORKER_NAME?: string;
};

export async function handleKeywordAction(
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string,
  rawText: string,
  env: KeywordActionsEnv,
  db?: D1Database,
): Promise<boolean> {
  // "キーコードリセット"のみ【キーワード】プレフィックスなしの単体文字列でも動く特別対応
  if (rawText.includes('キーコードリセット')) {
    // 段階2.5（Capsec #250）: リセットの実体（端末判定文字列のクリア）は D1 furim_customers で完結し、GAS は待たない。
    // 拡張の認証は D1（KV は 60 秒の写しなので消す）。シートへは返信後に setCustomerFields で鏡写し（旧拡張は GAS 経路で読む）
    console.log('[furim] キーコードリセット: D1 で端末判定を解除', lineUserId);
    const current = db ? await getFurimCustomer(db, lineUserId) : null;
    if (db) {
      await upsertFurimCustomer(db, lineUserId, { device_activated: 0, device_code: null });
      await invalidateExtCache(env.FURIM_EXT_CACHE, current?.key_code);
    }
    // 返信は「何がリセットされ・次に何をするか」の説明＋コピー用のキーコード単体を一括で送る
    // （2026-08-13 くろさん指示。「完了しました」だけでは次の行動が伝わらなかった）。
    // キーコードが取れなくてもリセット完了の案内は返す（メニュー誘導にフォールバック）
    const keyCode = await fetchCurrentKeyCode(db, lineUserId);
    const doneMessages = buildKeycodeResetMessages(keyCode) as never[];
    // GAS側のリセットは完了済みなので、返信は何があっても届けきる。
    // replyMessageが落ちると呼び出し元のcatchでエラー文言に化け、実際にはリセット済みなのに
    // 「失敗した」と伝わってしまう（2026-08-12 小笠さん事象では reply・エラー通知とも届かず無反応だった）
    try {
      await lineClient.replyMessage(replyToken, doneMessages);
      console.log('[furim] キーコードリセット: 返信完了', lineUserId);
    } catch (err) {
      console.error('[furim] キーコードリセットのreply失敗。pushで再送します:', lineUserId, err);
      await lineClient.pushMessage(lineUserId, doneMessages);
      console.log('[furim] キーコードリセット: push再送完了', lineUserId);
    }
    // シートの端末判定文字列を空に（旧拡張の GAS getKeyCodeSet が読む列。失敗は再実行キューが完遂させる）
    if (db) await mirrorCustomerFieldsToGas(db, env.GAS_DEPLOY_ID, lineUserId, { '端末判定文字列': '' });
    return true;
  }

  if (!rawText.includes('【キーワード】')) return false;
  const text = rawText.replace('【キーワード】', '');

  if (text.includes('登録URL発行')) {
    // 段階4（Capsec #246）: 旧 GAS getLIFFCheckoutUrl の移植。プラン一覧は D1 furim_master（kind='plan'）
    const planName = text.trim().split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? '';
    const checkoutURL = db && env.LIFF_URL
      ? await buildLegacyCheckoutUrl(db, {
          liffUrl: env.LIFF_URL,
          isDev: env.WORKER_NAME === 'line-harness',
          lineUserId,
          planName,
          stripeCustomerId: await resolveStripeCustomerId(db, lineUserId),
        })
      : null;
    if (!checkoutURL) {
      console.warn('[furim] 登録URL発行: プランが見つからないか LIFF_URL 未設定', planName);
      await lineClient.replyMessage(replyToken, [{ type: 'text', text: '該当するプランが見つかりませんでした。リッチメニューの「プラン診断」からお申し込みください🙇' } as never]);
      return true;
    }
    await lineClient.replyMessage(replyToken, [{
      type: 'imagemap',
      baseUrl: 'https://storage.googleapis.com/furimauto_line/images/checkout_image',
      altText: '決済ページURL含む画像',
      baseSize: { width: 1040, height: 1040 },
      actions: [{ type: 'uri', linkUri: checkoutURL, area: { x: 0, y: 0, width: 1040, height: 1040 } }],
    } as never]);
    return true;
  }

  if (text.includes('無料お試し1週間')) {
    const match = text.match(/無料お試し1週間(\d{8})/);
    const expiryDate = match ? match[1] : null;
    // 段階4（Capsec #246）: 旧 GAS setKeyCodeExpiry の移植。D1 に先に書き、シートへは setCustomerFields で鏡写し
    const data = db ? await applyTrialCampaign(db, env.FURIM_EXT_CACHE, lineUserId, expiryDate) : ({ success: false, message: 'D1 なし' } as const);
    if (data.success) {
      await lineClient.replyMessage(replyToken, [
        { type: 'text', text: `🎉【キャンペーン参加完了！】🎉\n\nFurimAutoの全機能を2週間無料でお試しいただけます！\n\nキーコードの準備ができましたので、\nリッチメニューの「キーコード発行」をタップしてください👇\n\n使い方は簡単3ステップ！\n①キーコードを発行\n②PCブラウザにFurimAutoを導入\n③キーコードを入力する\nだけ！✋\n\n初回の導入方法は下の1分動画を参考に最短3分で導入してみてください♪` } as never,
        { type: 'video', originalContentUrl: 'https://storage.googleapis.com/furimauto_line/video/install.mp4', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png', trackingId: 'setup' } as never,
        { type: 'text', text: `📣使い方や設定方法について\n\n💡無料の2週間で全機能フル活用!\n💡全自動化運用を実現して欲しい!\n💡理解することで必ず大きな効果がでます!\n\nリッチメニューの"Youtube動画講座"から\nFurimAutoの基礎から応用まで\n全ての機能を解説しています！` } as never,
        copyTicketFlexMessage() as never,
      ]);
    } else {
      await lineClient.replyMessage(replyToken, [{ type: 'text', text: `申し訳ございません。\nこのキャンペーンを既にご利用いただいているか、\nすでに終了いたしました。` } as never]);
    }
    if (db && data.success) await mirrorCustomerFieldsToGas(db, env.GAS_DEPLOY_ID, lineUserId, data.mirror, data.flags ?? undefined);
    return true;
  }

  if (text.includes('友達紹介コード:')) {
    const match = text.match(/友達紹介コード:(\w+)/);
    if (!match) {
      await lineClient.replyMessage(replyToken, [{ type: 'text', text: `友達紹介コードが有効ではないようです。\n確認後、弊アカウントからご連絡差し上げます。` } as never]);
      return true;
    }
    await processReferral(lineClient, lineUserId, match[1], env, db, { replyToken });
    return true;
  }

  return false;
}

/**
 * 紹介成立の本処理（手動code送信・URL経由の両経路から呼ぶ共有関数）。
 * - opts.replyToken あり → 被紹介者へ reply（手動code経路）
 * - opts.replyToken なし → 被紹介者へ push（URL経由経路）
 * アンバサダーへの通知は常に push。GAS/Stripe/D1 の副作用ロジックは経路非依存。
 */
export async function processReferral(
  lineClient: LineClient,
  introducedLineUserId: string,
  ambassadorCode: string,
  env: KeywordActionsEnv,
  db?: D1Database,
  opts: { replyToken?: string; silent?: boolean; refCode?: string | null } = {},
): Promise<{ ok: boolean; reason?: string }> {
  const targetDb = db ?? env.DB;

  const notifyIntroduced = (messages: never[]) =>
    opts.replyToken
      ? lineClient.replyMessage(opts.replyToken, messages)
      : lineClient.pushMessage(introducedLineUserId, messages);

  // 段階2（Capsec #244）: 紹介は D1 だけで完結する。GAS の stackLINEIntroductionInfo /
  // updateIntroductionCoupon / getAmbassadorInfo は呼ばない（今夜の「アンバサダー制度」エラー＝GAS 見切り）。
  if (!targetDb) {
    console.error('[furim] processReferral: D1 が無いため処理できません');
    return { ok: false, reason: 'no_db' };
  }

  const introducedFriend = await getFriendByLineUserId(targetDb, introducedLineUserId);
  // 被紹介者がまだ登録されていない（友だち追加直後のレース）→ 保留。URL経路のみ後続の再試行に委ねる
  if (!introducedFriend) {
    return { ok: false, reason: 'introduced_not_registered' };
  }

  // 冪等ガード: 「紹介経由」タグ、または紹介台帳に被紹介者が居れば即return。
  // 手動↔URLの経路跨ぎ・re-click・別アンバサダー2回目を1点で防ぐ。
  {
    const introTag = await targetDb.prepare('SELECT id FROM tags WHERE name = ?').bind('紹介経由').first<{ id: string }>();
    const tagged = introTag
      ? await targetDb.prepare('SELECT 1 FROM friend_tags WHERE friend_id = ? AND tag_id = ?').bind(introducedFriend.id, introTag.id).first()
      : null;
    const recorded = tagged ? null : await findReferralByIntroduced(targetDb, introducedFriend.id);
    if (tagged || recorded) {
      // 適用済みでも黙って終わると「コードを送ったのに無反応」に見えるので一言返す
      // （URL経由で成立した直後に本人が手動でコードを送るとここに来る）。
      // cron のリトライ経路は silent なので通知しない
      if (!opts.silent) {
        await notifyIntroduced([{ type: 'text', text: `お友達紹介の特典は、すでに適用済みです😊\n\n無料試用期間の1週間追加も反映されていますので、あらためてコードをお送りいただく必要はありません。\nそのままご利用ください🙌` } as never]);
      }
      return { ok: false, reason: 'already_referred' };
    }
  }

  // アンバサダー（affiliates.code＝アンバサダーコード）
  const affiliate = await getAffiliateByCode(targetDb, ambassadorCode);
  const ambassadorFriend = affiliate?.friend_id ? await getFriendById(targetDb, affiliate.friend_id) : null;
  if (!affiliate || !ambassadorFriend?.line_user_id || !env.STRIPE_SECRET_KEY) {
    if (!opts.silent) await notifyIntroduced([{ type: 'text', text: `友達紹介コードが有効ではないようです。\n確認後、弊アカウントからご連絡差し上げます。` } as never]);
    return { ok: false, reason: 'invalid_code' };
  }
  const ambassadorLineUserId = ambassadorFriend.line_user_id;

  // 自己紹介除外（アンバサダー自身が自分のURL/codeで登録した場合）
  if (ambassadorLineUserId === introducedLineUserId) {
    return { ok: false, reason: 'self_referral' };
  }

  // 被紹介者が既に有料会員 → 紹介特典の対象外（GAS はプラン名に「プラン」を含むかで判定していた）
  if (isPaidPlan((introducedFriend as { plan_name?: string | null }).plan_name)) {
    if (!opts.silent) await notifyIntroduced([{ type: 'text', text: `恐れ入りますが、既に月額プランをご利用中のため、お友達紹介特典（無料期間の延長・初月半額クーポン）の対象外となります🙇` } as never]);
    return { ok: false, reason: 'paid_member' };
  }

  const introducedStripeID = await resolveStripeCustomerId(targetDb, introducedLineUserId);
  const ambassadorStripeID = await resolveStripeCustomerId(targetDb, ambassadorLineUserId);
  // 被紹介者の Stripe 顧客はフォロー時の automation が作る。まだ無ければ保留（cron が拾う）
  if (!introducedStripeID) {
    return { ok: false, reason: 'introduced_not_registered' };
  }
  const introducedCouponID = await getCouponId(targetDb, INTRODUCED_COUPON_NAME);
  if (!introducedCouponID) {
    console.error('[furim] processReferral: furim_coupons に被紹介者クーポンが無い');
    if (!opts.silent) await notifyIntroduced([{ type: 'text', text: `友達紹介コードが有効ではないようです。\n確認後、弊アカウントからご連絡差し上げます。` } as never]);
    return { ok: false, reason: 'invalid_code' };
  }

  // アンバサダー報酬クーポン: 10 枚まで。額はアンバサダーの現サブスク月額（Stripe 実額）で決める
  const counts = await countReferrals(targetDb, affiliate.id);
  let ambassadorCouponName: string | null = null;
  let ambassadorCouponId: string | null = null;
  if (counts.rewarded < REWARD_COUPON_LIMIT) {
    ambassadorCouponName = await resolveAmbassadorCouponName(ambassadorCode, env, targetDb);
    ambassadorCouponId = ambassadorCouponName ? await getCouponId(targetDb, ambassadorCouponName) : null;
    if (!ambassadorCouponId) ambassadorCouponName = null;
  }

  // 台帳に記録（introduced_friend_id UNIQUE。ここで弾かれたら同時送信の 2 回目）
  const referralId = await recordReferral(targetDb, {
    affiliateId: affiliate.id,
    ambassadorFriendId: ambassadorFriend.id,
    introducedFriendId: introducedFriend.id,
    refCode: opts.refCode ?? null,
    source: opts.silent ? 'retry' : opts.replyToken ? 'keyword' : 'url',
    ambassadorPlanName: (ambassadorFriend as { plan_name?: string | null }).plan_name ?? null,
    rewardCouponName: ambassadorCouponName,
    rewardCouponId: ambassadorCouponId,
    introducedCouponId: introducedCouponID,
    trialExtendedDays: 7,
  });
  if (!referralId) {
    return { ok: false, reason: 'already_referred' };
  }

  await fetch(`https://api.stripe.com/v1/customers/${introducedStripeID}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ coupon: introducedCouponID, 'metadata[ambassadorStripeID]': ambassadorStripeID ?? '', 'metadata[isIntroduced]': 'true', 'metadata[isFirstSubscription]': 'true' }).toString(),
  });

  // 無料試用 +7 日: D1 の期限を延ばし、シート（段階3 まで拡張が読む）へ鏡写し
  try {
    const newEnd = await extendSubscriptionEnd(targetDb, introducedLineUserId, 7);
    if (newEnd && env.GAS_DEPLOY_ID) {
      await mirrorCustomerFieldsToGas(targetDb, env.GAS_DEPLOY_ID, introducedLineUserId, { 'サブスク終了日時': newEnd });
    }
  } catch (e) {
    console.error('[furim] processReferral: 期限延長に失敗', introducedLineUserId, e);
  }

  await notifyIntroduced([{ type: 'text', text: `友達紹介コードの確認が取れました😆\n\n無料試用期間を1週間追加して、友達登録から3週間ご利用いただけます。\n\n更に月額プランにご登録の際に、初月の利用料が半額になるクーポンを付与させていただきました♪\n\nそれではキーコードを発行して、3週間存分に使いまわして売り上げUPさせてください⭐️` } as never]);

  const introducedLineDisplayName = introducedFriend.display_name ?? '';
  let pushText = `【お友達の${introducedLineDisplayName}様があなたの友達紹介コードを入力しました】\n\n`;
  if (ambassadorCouponName && ambassadorStripeID) {
    const ambassadorRes = await fetch(`https://api.stripe.com/v1/customers/${ambassadorStripeID}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    }).then(r => r.json()) as { discount?: unknown };

    if (!ambassadorRes.discount) {
      // 未適用の報酬クーポン（今回分を含む古い順の 1 枚）を Stripe に適用してから適用済みにする
      const pending = await findUnappliedReward(targetDb, ambassadorFriend.id);
      if (pending) {
        const applyRes = await fetch(`https://api.stripe.com/v1/customers/${ambassadorStripeID}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ coupon: pending.reward_coupon_id }).toString(),
        });
        if (applyRes.ok) {
          await markRewardApplied(targetDb, pending.id);
          pushText += `それに伴い${pending.reward_coupon_name}を付与いたしましたので、次回以降のお支払い時に自動で適用されます。\n\nリッチメニューの月額会員ページから、次回の支払額についてクーポン値引きが適用されているのを確認してください。`;
        } else {
          console.error('[furim] processReferral: 報酬クーポンの Stripe 適用失敗', await applyRes.text());
        }
      }
    } else {
      pushText += 'すでに以前のクーポンを次回の支払いに適用しているので、今回分のクーポンは未来の支払いに充当されます。';
    }
  } else {
    pushText += '数多くのご紹介のご協力、誠に感謝いたします。';
  }
  await lineClient.pushMessage(ambassadorLineUserId, [{ type: 'text', text: pushText } as never]);

  // シナリオ切り替え: 通常シナリオを完了させ、Referralシナリオに登録
  if (targetDb) {
    try {
      const friend = introducedFriend;
      {
        await completeFriendActiveScenarios(targetDb, friend.id);
        const referralScenario = await getScenarioByName(targetDb, REFERRAL_SCENARIO_NAME);
        if (referralScenario?.is_active) {
          await enrollFriendInScenario(targetDb, friend.id, referralScenario.id);
          console.log(`[furim] Referral scenario enrolled: ${friend.id}`);
        }

        // 紹介経由タグ付与（紹介されたお友達）
        const introTag = await targetDb.prepare('SELECT id FROM tags WHERE name = ?').bind('紹介経由').first<{ id: string }>();
        if (introTag) await targetDb.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)').bind(friend.id, introTag.id, jstNow()).run();
      }

      // アンバサダーLvタグ更新（アンバサダー本人）。紹介数は D1 の台帳の件数
      {
        {
          const count = (await countReferrals(targetDb, affiliate.id)).total;

          // 既存アンバサダーLvタグを全削除
          for (const lv of ['アンバサダーLv.1', 'アンバサダーLv.5', 'アンバサダーLv.10']) {
            const lvTag = await targetDb.prepare('SELECT id FROM tags WHERE name = ?').bind(lv).first<{ id: string }>();
            if (lvTag) await targetDb.prepare('DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ?').bind(ambassadorFriend.id, lvTag.id).run();
          }

          // 新しいLvタグ付与
          const newLv = count >= 10 ? 'アンバサダーLv.10' : count >= 5 ? 'アンバサダーLv.5' : count >= 1 ? 'アンバサダーLv.1' : null;
          if (newLv) {
            const newLvTag = await targetDb.prepare('SELECT id FROM tags WHERE name = ?').bind(newLv).first<{ id: string }>();
            if (newLvTag) await targetDb.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)').bind(ambassadorFriend.id, newLvTag.id, jstNow()).run();
            console.log(`[furim] Ambassador ${ambassadorLineUserId} → ${newLv} (count=${count})`);
          }
        }
      }
    } catch (err) {
      console.error('[furim] Referral scenario enrollment error:', err);
    }
  }

  return { ok: true };
}

/**
 * アンバサダー紹介URLの再試行（cron 毎回）。友だち追加時に processReferral が走っても、
 * 被紹介者のGASマスター登録(CF eventFollow)が非同期で間に合わず保留(introduced_not_registered)に
 * なるレースを、タイミング非依存で確実に成立させるための catch-up。
 *
 * 対象: アンバサダーoffer の ref_code を持ち、「紹介経由」タグが無く、metadataに解決済フラグが無く、
 * 直近2時間に作成された friend。processReferral は冪等（成立で紹介経由タグ→次回から対象外）。
 * 通知連投を避けるため silent:true（成立時の確認/アンバサダーpushは出す。エラー/対象外の通知は抑制）。
 * 保留以外の終端（対象外/無効/自己紹介）は metadata.ambReferralDone=1 でマークし再試行を止める。
 */
export async function retryPendingAmbassadorReferrals(
  env: { GAS_DEPLOY_ID?: string; STRIPE_SECRET_KEY?: string; DB?: D1Database; FURIM_AMBASSADOR_OFFER_ID?: string; LINE_CHANNEL_ACCESS_TOKEN: string },
  db: D1Database,
): Promise<void> {
  if (!env.FURIM_AMBASSADOR_OFFER_ID) return;
  // 2時間前(JST)の閾値。friends.created_at は JST ISO(+09:00)。
  const cutoff = new Date(Date.now() - 2 * 60 * 60_000 + 9 * 60 * 60_000).toISOString().slice(0, -1) + '+09:00';
  const rows = await db.prepare(
    `SELECT f.id AS friend_id, f.line_user_id, f.line_account_id, af.code AS ambassador_code
       FROM friends f
       JOIN affiliate_links al ON al.ref_code = f.ref_code AND al.offer_id = ?
       JOIN affiliates af ON af.id = al.affiliate_id
      WHERE f.ref_code IS NOT NULL
        AND f.created_at > ?
        AND (f.metadata IS NULL OR f.metadata NOT LIKE '%ambReferralDone%')
        AND NOT EXISTS (
          SELECT 1 FROM friend_tags ft JOIN tags t ON t.id = ft.tag_id
           WHERE ft.friend_id = f.id AND t.name = '紹介経由'
        )
      LIMIT 20`,
  ).bind(env.FURIM_AMBASSADOR_OFFER_ID, cutoff).all<{ friend_id: string; line_user_id: string; line_account_id: string | null; ambassador_code: string }>();

  if (!rows.results.length) return;
  const { LineClient } = await import('@line-crm/line-sdk');
  const { getLineAccountById } = await import('@line-crm/db');

  for (const row of rows.results) {
    try {
      let token = env.LINE_CHANNEL_ACCESS_TOKEN;
      if (row.line_account_id) {
        const acct = await getLineAccountById(db, row.line_account_id);
        if (acct?.channel_access_token) token = acct.channel_access_token;
      }
      const result = await processReferral(new LineClient(token), row.line_user_id, row.ambassador_code, env as KeywordActionsEnv, db, { silent: true });
      // 保留(introduced_not_registered)は次回に委ねる。成立は紹介経由タグで対象外になる。
      // それ以外の終端（対象外/無効/自己紹介）は再試行を止める。
      const terminalUnsuccessful = !result.ok && result.reason !== 'introduced_not_registered' && result.reason !== 'already_referred';
      if (terminalUnsuccessful) {
        await db.prepare(`UPDATE friends SET metadata = json_set(COALESCE(metadata,'{}'), '$.ambReferralDone', ?) WHERE id = ?`)
          .bind(result.reason ?? 'done', row.friend_id).run();
      }
      if (result.ok) console.log(`[furim] ambassador referral retry succeeded: friend=${row.friend_id}`);
    } catch (err) {
      console.error('[furim] ambassador referral retry error (non-blocking):', row.friend_id, err);
    }
  }
}
