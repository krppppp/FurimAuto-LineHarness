import type { LineClient } from '@line-crm/line-sdk';
import { fireEvent } from './event-bus.js';

type KaisetsuMeta = {
  kaisetsu: boolean;
  trial_end: string;
  kaisetsu_last_sent?: string;
};

function todayJst(): string {
  return new Date(Date.now() + 9 * 60 * 60_000).toISOString().slice(0, 10);
}

function getRemainingDays(trialEnd: string): number {
  const today = new Date(todayJst());
  const end = new Date(trialEnd);
  return Math.ceil((end.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export async function processKaisetsuDeliveries(
  db: D1Database,
  lineClient: LineClient,
): Promise<void> {
  const today = todayJst();
  const lineAccessToken = (lineClient as unknown as { token?: string }).token;

  const result = await db
    .prepare(`SELECT id, line_user_id, metadata FROM friends WHERE metadata LIKE '%"kaisetsu":true%' AND is_following = 1`)
    .all<{ id: string; line_user_id: string; metadata: string }>();

  // 21:00 JST にのみ配信
  const jstHour = new Date(Date.now() + 9 * 60 * 60_000).getUTCHours();
  if (jstHour !== 21) return;

  for (const friend of result.results) {
    try {
      const meta = JSON.parse(friend.metadata || '{}') as KaisetsuMeta;
      if (!meta.kaisetsu || !meta.trial_end) continue;

      const remaining = getRemainingDays(meta.trial_end);

      // 期限切れ: タグ整理 + フラグクリア
      if (remaining <= 0) {
        const wasHighSeg = await db.prepare(
          `SELECT 1 FROM friend_tags ft JOIN tags t ON ft.tag_id = t.id WHERE ft.friend_id = ? AND t.name IN ('セグメント4','セグメント5','セグメント6','セグメント7','セグメント8') LIMIT 1`
        ).bind(friend.id).first();

        for (const tagName of ['解説見た', '無料試用期間中', 'セグメント1', 'セグメント2', 'セグメント3', 'セグメント4', 'セグメント5', 'セグメント6', 'セグメント7', 'セグメント8']) {
          const tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(tagName).first<{ id: string }>();
          if (tag) await db.prepare('DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ?').bind(friend.id, tag.id).run();
        }

        const classifyTagName = wasHighSeg ? '見込客' : '未使用ユーザー';
        const classifyTag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(classifyTagName).first<{ id: string }>();
        if (classifyTag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, datetime("now", "+9 hours"))').bind(friend.id, classifyTag.id).run();

        console.log(`[kaisetsu] expired ${friend.line_user_id} → ${classifyTagName}`);
        meta.kaisetsu = false;
        await db.prepare('UPDATE friends SET metadata = ?, updated_at = datetime("now", "+9 hours") WHERE id = ?')
          .bind(JSON.stringify(meta), friend.id).run();
        continue;
      }

      // 今日すでに送信済みならスキップ
      if (meta.kaisetsu_last_sent === today) continue;

      // オートメーションに委譲（closing_daily = 試用終盤クロージング配信）
      await fireEvent(db, 'closing_daily', {
        friendId: friend.id,
        eventData: { remaining_days: remaining },
      }, lineAccessToken);

      meta.kaisetsu_last_sent = today;
      await db.prepare('UPDATE friends SET metadata = ?, updated_at = datetime("now", "+9 hours") WHERE id = ?')
        .bind(JSON.stringify(meta), friend.id).run();

      console.log(`[kaisetsu] fired closing_daily for ${friend.line_user_id}, remaining=${remaining}days`);
    } catch (err) {
      console.error(`[kaisetsu] error for ${friend.line_user_id}:`, err);
    }
  }
}
