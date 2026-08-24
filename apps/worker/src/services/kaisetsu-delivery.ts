import { fireEvent } from './event-bus.js';
import { gasGet, getGasErrorFromResponse } from '../furim/gas-client.js';

type KaisetsuMeta = {
  kaisetsu: boolean;
  /** 「解説見た」以外の一般の試用ユーザーもクロージング対象にするフラグ（GASの顧客マスター由来） */
  closing?: boolean;
  trial_end: string;
  kaisetsu_last_sent?: string;
  /**
   * closing_daily を発火済みの残日数の記録（例: ["5","3"]）。
   * 「解説見た」で試用が1週間延長されると remaining_days が巻き戻り、同じ残日数の
   * クロージング文面が二重に届いてしまうため、一度発火した残日数は再発火させない。
   */
  closing_sent?: string[];
};

type ActiveTrial = { lineUserId: string; trialEnd: string };

/**
 * 顧客マスター（GAS）から「無料試用中で終了が近い人」を取り込み、friends.metadata に
 * closing=true / trial_end を立てる。
 *
 * これが無いと配信対象は「解説見た」を送った人（kaisetsu=true）だけで、本番全期間で6人しか
 * 居なかった。試用終了が近い一般ユーザーには終盤の案内が1通も無い状態だったため取り込む。
 * kaisetsu フラグには触らない（タグ整理や通常シナリオ停止の挙動は解説見た組だけのまま）。
 */
async function syncClosingTargets(db: D1Database, gasDeployId: string): Promise<void> {
  const res = await gasGet(gasDeployId, { method: 'listActiveTrials' }, { timeoutMs: 30_000 });
  const gasError = getGasErrorFromResponse(res);
  if (gasError) throw new Error(`listActiveTrials: ${gasError}`);

  const trials = ((res as { trials?: ActiveTrial[] })?.trials ?? []).filter((t) => t?.lineUserId && t?.trialEnd);
  let updated = 0;

  for (const trial of trials) {
    const friend = await db
      .prepare('SELECT id, metadata FROM friends WHERE line_user_id = ? AND is_following = 1')
      .bind(trial.lineUserId)
      .first<{ id: string; metadata: string }>();
    if (!friend) continue;

    const meta = JSON.parse(friend.metadata || '{}') as KaisetsuMeta;
    // 解説見た組は独自の延長日を持っているので上書きしない
    if (meta.kaisetsu) continue;
    if (meta.closing === true && meta.trial_end === trial.trialEnd) continue;

    meta.closing = true;
    meta.trial_end = trial.trialEnd;
    await db
      .prepare('UPDATE friends SET metadata = ?, updated_at = datetime("now", "+9 hours") WHERE id = ?')
      .bind(JSON.stringify(meta), friend.id)
      .run();
    updated++;
  }

  console.log(`[kaisetsu] closing targets synced: ${trials.length} trials, ${updated} updated`);
}

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
  lineAccessToken: string,
  gasDeployId?: string,
): Promise<void> {
  const today = todayJst();

  // 21:00 JST にのみ配信
  const jstHour = new Date(Date.now() + 9 * 60 * 60_000).getUTCHours();
  if (jstHour !== 21) return;

  if (gasDeployId) {
    try {
      await syncClosingTargets(db, gasDeployId);
    } catch (err) {
      // 取り込みに失敗しても既存対象への配信は続ける
      console.error('[kaisetsu] syncClosingTargets error:', err);
    }
  }

  const result = await db
    .prepare(
      `SELECT id, line_user_id, metadata FROM friends
       WHERE is_following = 1
         AND (metadata LIKE '%"kaisetsu":true%' OR metadata LIKE '%"closing":true%')`,
    )
    .all<{ id: string; line_user_id: string; metadata: string }>();

  for (const friend of result.results) {
    try {
      const meta = JSON.parse(friend.metadata || '{}') as KaisetsuMeta;
      if ((!meta.kaisetsu && !meta.closing) || !meta.trial_end) continue;

      const remaining = getRemainingDays(meta.trial_end);

      // 期限切れ: フラグクリア（タグ整理は解説見た組だけ。一般の試用ユーザーの
      // セグメントタグを触ると通常14シナリオの前提が崩れるため）
      if (remaining <= 0) {
        if (!meta.kaisetsu) {
          meta.closing = false;
          await db.prepare('UPDATE friends SET metadata = ?, updated_at = datetime("now", "+9 hours") WHERE id = ?')
            .bind(JSON.stringify(meta), friend.id).run();
          console.log(`[kaisetsu] expired ${friend.line_user_id} (closing only)`);
          continue;
        }
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

      // 発火済み残日数ガード: 「解説見た」延長で remaining_days が巻き戻っても、
      // 一度発火した残日数のクロージングは再発火させない（延長組への二重配信防止）。
      const closingSent = Array.isArray(meta.closing_sent) ? meta.closing_sent.map(String) : [];
      if (closingSent.includes(String(remaining))) {
        console.log(`[kaisetsu] skip ${friend.line_user_id} remaining=${remaining} (already fired)`);
        continue;
      }

      // 今日の配信枠を先に取る（21:00 JST は "*/5" と "0 */6" の2つの cron が同時に発火し、
      // 送信後に last_sent を書く方式では両方が同じ枠を通過して二重配信になっていた）。
      // 条件付き UPDATE の changes で「自分が枠を取れたか」を判定し、取れた側だけが配信する。
      const claim = await db
        .prepare(
          `UPDATE friends SET metadata = json_set(metadata, '$.kaisetsu_last_sent', ?), updated_at = datetime("now", "+9 hours")
           WHERE id = ? AND COALESCE(json_extract(metadata, '$.kaisetsu_last_sent'), '') <> ?`,
        )
        .bind(today, friend.id, today)
        .run();
      if ((claim.meta?.changes ?? 0) === 0) continue;

      // 発火記録は fireEvent の前に書く（送信失敗より二重配信の方が実害が大きい）。
      // json_set で $.closing_sent だけ更新し、claim が書いた kaisetsu_last_sent は保持する。
      await db
        .prepare(
          `UPDATE friends SET metadata = json_set(metadata, '$.closing_sent', json(?)), updated_at = datetime("now", "+9 hours") WHERE id = ?`,
        )
        .bind(JSON.stringify([...closingSent, String(remaining)]), friend.id)
        .run();

      // オートメーションに委譲（closing_daily = 試用終盤クロージング配信）
      await fireEvent(db, 'closing_daily', {
        friendId: friend.id,
        eventData: { remaining_days: remaining },
      }, lineAccessToken);

      console.log(`[kaisetsu] fired closing_daily for ${friend.line_user_id}, remaining=${remaining}days`);
    } catch (err) {
      console.error(`[kaisetsu] error for ${friend.line_user_id}:`, err);
    }
  }
}
