import type { LineClient } from '@line-crm/line-sdk';
import { jstNow } from '@line-crm/db';
import { sendPushToAll, type PushEnv } from '../services/push-notify.js';

// プラン変更（PB-… change intent）の未反映検知（Capsec #240・2026-09-13）。
//
// 9/11 の PB-CF0DAF は処理が途中で落ちて Stripe に予約が作られず、本人は LIFF の
// 「予約しました」表示を信じて待ち、更新日に旧プランで課金された。LIFF の表示だけで
// 「変更完了」と判断しないため、5分 cron で次を1回だけ通知する:
//   - LINE でコードを送ってから 30 分経っても used_at が付いていない（未処理）
//   - used_at は付いたが Stripe に反映が無い（downgrade: schedule 無し / upgrade: items 不一致）
// LIFF で発行しただけで LINE に送っていない intent は対象外（messages_log の受信で判定）。

const STAFF_LINE_USER_ID = 'U5d35c3e6b2be0a6ec699b2a1de2aba93';
const GRACE_MINUTES = 30;
const LOOKBACK_DAYS = 3;

export type PlanChangeWatchEnv = PushEnv & { STRIPE_SECRET_KEY?: string; GAS_DEPLOY_ID?: string };

type IntentRow = {
  id: string;
  line_user_id: string;
  payload: string;
  used_at: string | null;
  stage: string | null;
  error: string | null;
  created_at: string;
  display_name: string | null;
};

type ChangePayload = {
  type?: string;
  kind?: 'upgrade' | 'downgrade';
  subscriptionId?: string;
  packages?: string[];
  features?: string[];
  multiChannelSites?: string[];
};

export async function watchPlanChangeIntents(
  db: D1Database,
  lineClient: LineClient,
  env: PlanChangeWatchEnv,
): Promise<void> {
  // created_at は JST の "YYYY-MM-DD HH:MM:SS"（plan-builder が書く）。同じ形式で比較する
  const rows = await db
    .prepare(
      `SELECT i.id, i.line_user_id, i.payload, i.used_at, i.stage, i.error, i.created_at, f.display_name
       FROM plan_builder_intents i
       LEFT JOIN friends f ON f.line_user_id = i.line_user_id
       WHERE i.notified_at IS NULL
         AND json_extract(i.payload, '$.type') = 'change'
         AND i.created_at < datetime('now', '+9 hours', '-${GRACE_MINUTES} minutes')
         AND i.created_at > datetime('now', '+9 hours', '-${LOOKBACK_DAYS} days')
       ORDER BY i.created_at
       LIMIT 20`,
    )
    .all<IntentRow>();

  for (const row of rows.results ?? []) {
    try {
      const sent = await db
        .prepare(
          `SELECT 1 FROM messages_log m JOIN friends f ON f.id = m.friend_id
           WHERE f.line_user_id = ? AND m.direction = 'incoming' AND m.content LIKE ? LIMIT 1`,
        )
        .bind(row.line_user_id, `%【プラン変更】${row.id}%`)
        .first();
      if (!sent) continue; // LIFF で発行しただけ。送られたら次の tick で見る

      let reason: string | null = null;
      if (!row.used_at) {
        reason = '未処理（used_at なし）';
      } else if (env.STRIPE_SECRET_KEY) {
        reason = await verifyOnStripe(row, env);
      }

      if (reason === null) {
        await db.prepare('UPDATE plan_builder_intents SET notified_at = ?, updated_at = ? WHERE id = ?')
          .bind(`ok:${jstNow()}`, jstNow(), row.id).run();
        continue;
      }

      const payload = parsePayload(row.payload);
      const name = row.display_name ?? row.line_user_id;
      const text = [
        '⚠️ プラン変更が未反映のままです',
        `code: ${row.id}（${payload.kind ?? 'change'}）`,
        `顧客: ${name}`,
        `送信: ${row.created_at} / 判定: ${reason}`,
        `stage: ${row.stage ?? '(なし)'}`,
        row.error ? `error: ${row.error.slice(0, 200)}` : null,
        'Stripe と顧客マスターを確認して手動で反映してください。',
      ].filter(Boolean).join('\n');

      await db.prepare('UPDATE plan_builder_intents SET notified_at = ?, stage = ?, updated_at = ? WHERE id = ?')
        .bind(jstNow(), `watch:alert:${reason}`.slice(0, 120), jstNow(), row.id).run();
      try {
        await lineClient.pushMessage(STAFF_LINE_USER_ID, [{ type: 'text', text } as never]);
      } catch (e) {
        console.error('[plan-change-watch] staff LINE push failed:', e);
      }
      try {
        await sendPushToAll(db, env, {
          title: 'プラン変更が未反映',
          body: `${name}: ${row.id} ${reason}`,
          url: '/friends',
        });
      } catch (e) {
        console.error('[plan-change-watch] web push failed:', e);
      }
      console.warn(`[plan-change-watch] alert code=${row.id} reason=${reason}`);
    } catch (e) {
      console.error('[plan-change-watch] check failed:', row.id, e);
    }
  }
}

function parsePayload(raw: string): ChangePayload {
  try {
    return JSON.parse(raw) as ChangePayload;
  } catch {
    return {};
  }
}

// used_at あり: Stripe 側に反映が実在するか。null = 問題なし、文字列 = 未反映の理由
async function verifyOnStripe(row: IntentRow, env: PlanChangeWatchEnv): Promise<string | null> {
  const payload = parsePayload(row.payload);
  if (!payload.subscriptionId || !env.STRIPE_SECRET_KEY) return null;
  const { stripeCall, resolvePlanSelection, buildItemsFromSelection } = await import('../routes/plan-builder.js');
  const sub = (await stripeCall(env.STRIPE_SECRET_KEY, `subscriptions/${payload.subscriptionId}`, undefined, 'GET')) as unknown as {
    status: string;
    schedule?: string | null;
    items: { data: Array<{ price: { id: string } }> };
  };
  if (payload.kind === 'downgrade') {
    // 次回更新日に切り替わる schedule が付いているはず（更新後は release されて null に戻る）
    return sub.schedule ? null : 'Stripe に予約スケジュールが無い';
  }
  // upgrade: 新構成の price が items に揃っているはず
  const sel = await resolvePlanSelection(env.GAS_DEPLOY_ID, {
    packages: payload.packages,
    features: payload.features,
    multiChannelSites: payload.multiChannelSites,
    lineUserId: row.line_user_id,
  });
  const expected = buildItemsFromSelection(sel).map((it) => it.price);
  const actual = new Set(sub.items.data.map((it) => it.price.id));
  const missing = expected.filter((p) => !actual.has(p));
  return missing.length === 0 ? null : `Stripe の items に新プランが無い（${missing.length}件不足）`;
}
