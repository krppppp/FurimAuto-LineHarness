// 試用が終わった見込み客への 1 週間プレゼント（TB-25・くろさん 2026-10-06）。
//
// - Flex のボタンが「【ボタン】1週間無料プレゼントを受け取る」を送り、button-actions → grantTrialPromo が受ける
//   （ACTIVE_TRIAL_PROMO '2026-10-06': 受付は当日 21 時まで・押した時点から 7 日・新しいキーコード）
// - 対象: 友だち（ブロックなし）で、furim_customers の終了日時が過ぎていて、有料の契約（subscription_id）が無く、
//   プラン欄が空か「可能性あり」「なし」で始まる人（解約者・サブアカは入れない）
import { formatJstIso } from './customer-store.js';
import { ACTIVE_TRIAL_PROMO, TRIAL_PROMOS } from './trial-promo.js';

export const TRIAL_GIFT_BUTTON_TEXT = '【ボタン】1週間無料プレゼントを受け取る';
const MULTICAST_LIMIT = 500;

type LineClientLike = { multicast(to: string[], messages: unknown[]): Promise<unknown> };

export function trialGiftFlexMessage() {
  return {
    type: 'flex',
    altText: '【本日21時まで】FurimAuto全機能を1週間プレゼント',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#E8473F',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '本日21:00まで', color: '#FFFFFF', size: 'sm', weight: 'bold' },
          { type: 'text', text: '全機能を1週間プレゼント', color: '#FFFFFF', size: 'xl', weight: 'bold', wrap: true, margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '以前FurimAutoをお試しいただき、ありがとうございました。', size: 'sm', wrap: true },
          { type: 'text', text: '今日だけ、FurimAutoの全機能を1週間まるごとプレゼントします！', size: 'md', weight: 'bold', wrap: true },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            backgroundColor: '#F5F5F5',
            cornerRadius: '8px',
            paddingAll: '12px',
            contents: [
              { type: 'text', text: '・メルカリの全自動化', size: 'sm', wrap: true },
              { type: 'text', text: '・ラクマ／メルカリShops／ヤフオク／ヤフフリへの多販路自動化', size: 'sm', wrap: true },
              { type: 'text', text: '・在庫管理シートで、1つ売れたら他の販路は自動で取り下げ', size: 'sm', wrap: true },
            ],
          },
          { type: 'text', text: '年末年始に向けてイベントが続く今が商戦です。\nボタンを押した時から1週間、追加の料金なしでお使いいただけます。', size: 'sm', color: '#555555', wrap: true },
          { type: 'text', text: '※本日21:00までにボタンを押した方が対象です', size: 'xs', color: '#E8473F', wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#E8473F',
            action: { type: 'message', label: '1週間プレゼントを受け取る', text: TRIAL_GIFT_BUTTON_TEXT },
          },
        ],
      },
    },
  };
}

/** 送る相手（line_user_id）。受付中のキャンペーンを既に受け取った人は外す */
export async function selectTrialGiftTargets(db: D1Database, nowMs = Date.now()): Promise<string[]> {
  const prefix = TRIAL_PROMOS[ACTIVE_TRIAL_PROMO].keyCodePrefix;
  const rows = await db
    .prepare(
      `SELECT c.line_user_id FROM furim_customers c JOIN friends f ON f.line_user_id = c.line_user_id
       WHERE f.is_following = 1
         AND c.subscription_end_at IS NOT NULL AND c.subscription_end_at < ?
         AND (c.subscription_id IS NULL OR c.subscription_id = '')
         AND (c.plan_label IS NULL OR c.plan_label = '' OR c.plan_label LIKE '可能性あり%' OR c.plan_label LIKE 'なし%')
         AND (c.key_code IS NULL OR c.key_code NOT LIKE ?)
       ORDER BY c.line_user_id`,
    )
    .bind(formatJstIso(nowMs), `${prefix}%`)
    .all<{ line_user_id: string }>();
  return (rows.results ?? []).map((r) => r.line_user_id);
}

export type TrialGiftSendResult = { dryRun: boolean; targets: number; sent: number; failedBatches: number };

/** lineUserIds を渡せばその人だけ（テスト送信）。dryRun なら数えるだけ */
export async function sendTrialGift(
  db: D1Database,
  lineClient: LineClientLike,
  opts: { dryRun: boolean; lineUserIds?: string[]; nowMs?: number },
): Promise<TrialGiftSendResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const to = opts.lineUserIds?.length ? opts.lineUserIds : await selectTrialGiftTargets(db, nowMs);
  const result: TrialGiftSendResult = { dryRun: opts.dryRun, targets: to.length, sent: 0, failedBatches: 0 };
  if (opts.dryRun || to.length === 0) return result;
  const message = trialGiftFlexMessage();
  for (let i = 0; i < to.length; i += MULTICAST_LIMIT) {
    const batch = to.slice(i, i + MULTICAST_LIMIT);
    try {
      await lineClient.multicast(batch, [message]);
      result.sent += batch.length;
      await logGift(db, batch, message.altText, nowMs);
    } catch (err) {
      result.failedBatches++;
      console.error('[furim/trial-gift] multicast failed', i, String(err));
    }
  }
  return result;
}

async function logGift(db: D1Database, lineUserIds: string[], text: string, nowMs: number): Promise<void> {
  for (const lineUserId of lineUserIds) {
    try {
      const friend = await db.prepare('SELECT id FROM friends WHERE line_user_id = ?').bind(lineUserId).first<{ id: string }>();
      if (!friend) continue;
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, created_at)
           VALUES (?, ?, 'outgoing', 'flex', ?, NULL, NULL, 'push', 'trial-gift', ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, text, formatJstIso(nowMs))
        .run();
    } catch (err) {
      console.error('[furim/trial-gift] messages_log insert failed', lineUserId, err);
    }
  }
}
