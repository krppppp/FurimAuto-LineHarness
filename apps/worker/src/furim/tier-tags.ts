import { jstNow } from '@line-crm/db';

// 金額帯タグ（月額3000/5000/8000/10000/15000/19800）を 1 人 1 帯にする（Capsec #241・段階2）。
// 従来は automation の add_tag_by_name で追加するだけで旧帯が残り、プラン変更した会員に複数の帯が付いていた。
export const PLAN_TIERS = [3000, 5000, 8000, 10000, 15000, 19800] as const;

export function tierFor(planAmount: number): number {
  return PLAN_TIERS.find((t) => planAmount <= t) ?? 19800;
}

const TIER_TAG_RE = /^月額\d+$/;

/** 対象以外の金額帯タグを外し、対象の帯だけを付ける。タグ行が無ければ付けない（automation と同じ） */
export async function replaceTierTag(db: D1Database, friendId: string, tier: number): Promise<{ removed: string[]; added: string | null }> {
  const want = `月額${tier}`;
  const rows = await db
    .prepare(`SELECT t.id, t.name FROM friend_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.friend_id = ? AND t.name LIKE '月額%'`)
    .bind(friendId)
    .all<{ id: string; name: string }>();
  const removed: string[] = [];
  for (const r of rows.results ?? []) {
    if (!TIER_TAG_RE.test(r.name) || r.name === want) continue;
    await db.prepare('DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ?').bind(friendId, r.id).run();
    removed.push(r.name);
  }
  const tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(want).first<{ id: string }>();
  if (!tag) return { removed, added: null };
  await db
    .prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)')
    .bind(friendId, tag.id, jstNow())
    .run();
  return { removed, added: want };
}
