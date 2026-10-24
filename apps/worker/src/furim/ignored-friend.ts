// 「対応しない」タグの付いた友だちは無視する（TB-2236）。LINE の Messaging API には相手をブロックする
// 操作が無いので、こちらからの反応を止める。受信は messages_log に残すが、返信・AI チャット・キーワード応答・
// くろさんへの通知・未返信一覧・オートメーション・ステップ配信・一斉配信（セグメント・タグ・複数アカウント）・
// 試用プレゼント・セミナーのリマインドには出さない。
// target_type='all' の一斉配信は LINE の broadcast API が全フォロワーに送るので外せない（セグメント付きなら外れる）
export const IGNORED_TAG_NAME = '対応しない';

/** friends の別名を受け取り、「対応しない」タグが無い友だちだけに絞る WHERE 句の断片を返す */
export function notIgnoredSql(friendAlias = 'f'): string {
  return `NOT EXISTS (SELECT 1 FROM friend_tags ift JOIN tags it ON it.id = ift.tag_id WHERE ift.friend_id = ${friendAlias}.id AND it.name = '${IGNORED_TAG_NAME}')`;
}

/** 判定に失敗したら「無視しない」に倒す（この確認のせいで全員の返信が止まらないように） */
export async function isIgnoredFriend(db: D1Database, friendId: string): Promise<boolean> {
  try {
    const row = await db
      .prepare(`SELECT 1 AS x FROM friend_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.friend_id = ? AND t.name = ? LIMIT 1`)
      .bind(friendId, IGNORED_TAG_NAME)
      .first<{ x: number }>();
    return !!row;
  } catch (err) {
    console.error('[ignored-friend] lookup failed', friendId, err);
    return false;
  }
}

export async function getIgnoredFriendIds(db: D1Database): Promise<Set<string>> {
  const rows = await db
    .prepare(`SELECT ft.friend_id FROM friend_tags ft JOIN tags t ON t.id = ft.tag_id WHERE t.name = ?`)
    .bind(IGNORED_TAG_NAME)
    .all<{ friend_id: string }>();
  return new Set((rows.results ?? []).map((r) => r.friend_id));
}
