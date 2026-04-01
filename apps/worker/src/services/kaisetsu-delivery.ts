import type { LineClient } from '@line-crm/line-sdk';

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

function buildMessage(remainingDays: number): string | null {
  if (remainingDays >= 5) {
    return `【FurimAuto 有料プランのご案内】

動画をご視聴いただきありがとうございます！

改めて有料プランの魅力をお伝えします✨

✅ 自動値下げで毎日の作業を完全ゼロに
✅ コピー出品・まとめ買い割引の自動設定
✅ 売れ筋商品のリサーチ支援
✅ 全機能無制限で使い放題

▼料金・プラン一覧はこちら
https://furimauto.com/lp0/#scroll_plan

気になる方は今すぐ↑をチェック！
申し込みはMeetなしでできます😊`;
  }

  if (remainingDays >= 2) {
    return `【無料期間終了まであと${remainingDays}日】

FurimAutoです。

有料プランへの申し込み方法をご案内します👇

▼FurimAuto完全解説動画（申し込み手順あり）
https://www.youtube.com/watch?v=jhaCPxgE_Sk

申し込みはMeetなしでOK！
動画を見れば全ての疑問が解決します。

▼料金シミュレーション
1日10商品を値下げするとして...
月額プランなら1商品あたり約○円のコスト。
売れた時の利益と比べてみてください📊

▼今すぐ申し込みはこちら
https://furimauto.com/lp0/#scroll_plan`;
  }

  if (remainingDays === 1) {
    return `【明日で無料期間終了！最後のご案内】

FurimAutoです。

今日が最後のチャンスです。

▼今すぐ有料プランに申し込む
https://furimauto.com/lp0/#scroll_plan

Meetなし・動画確認だけでそのままご加入いただけます。

「まだ迷っている」という方は
このLINEに一言メッセージください。
直接ご相談に乗ります😊`;
  }

  return null;
}

export async function processKaisetsuDeliveries(
  db: D1Database,
  lineClient: LineClient,
): Promise<void> {
  const today = todayJst();

  const result = await db
    .prepare(`SELECT id, line_user_id, metadata FROM friends WHERE metadata LIKE '%"kaisetsu":true%' AND is_following = 1`)
    .all<{ id: string; line_user_id: string; metadata: string }>();

  for (const friend of result.results) {
    try {
      const meta = JSON.parse(friend.metadata || '{}') as KaisetsuMeta;
      if (!meta.kaisetsu || !meta.trial_end) continue;

      const remaining = getRemainingDays(meta.trial_end);

      // 期限切れ: タグ整理 + フラグクリア
      if (remaining <= 0) {
        // セグメント4〜6を持っていたか確認（削除前に）
        const wasHighSeg = await db.prepare(
          `SELECT 1 FROM friend_tags ft JOIN tags t ON ft.tag_id = t.id WHERE ft.friend_id = ? AND t.name IN ('セグメント4','セグメント5','セグメント6','セグメント7','セグメント8') LIMIT 1`
        ).bind(friend.id).first();

        // 解説見た・無料試用期間中・セグメントタグ削除
        for (const tagName of ['解説見た', '無料試用期間中', 'セグメント1', 'セグメント2', 'セグメント3', 'セグメント4', 'セグメント5', 'セグメント6', 'セグメント7', 'セグメント8']) {
          const tag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(tagName).first<{ id: string }>();
          if (tag) await db.prepare('DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ?').bind(friend.id, tag.id).run();
        }

        // 未使用ユーザー / 見込客 付与
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

      const text = buildMessage(remaining);
      if (!text) continue;

      await lineClient.pushMessage(friend.line_user_id, [{ type: 'text', text } as never]);

      meta.kaisetsu_last_sent = today;
      await db.prepare('UPDATE friends SET metadata = ?, updated_at = datetime("now", "+9 hours") WHERE id = ?')
        .bind(JSON.stringify(meta), friend.id).run();

      console.log(`[kaisetsu] sent to ${friend.line_user_id}, remaining=${remaining}days`);
    } catch (err) {
      console.error(`[kaisetsu] error for ${friend.line_user_id}:`, err);
    }
  }
}
