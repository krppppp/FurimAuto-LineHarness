import { gasGet, getGasErrorFromResponse } from '../furim/gas-client.js';
import { applyScenarioSwitch, UNIFIED_SCENARIO_NAME, UNIFIED_CUTOVER_AT } from '../routes/furim.js';

type SegmentUser = { lineUserId: string; segment: number; isReferral: boolean };

/**
 * 毎時セグメント同期（旧GAS sendStepMessagesトリガーの置き換え・2026-08-25）。
 *
 * GASの読み取りAPI listSegments から「ステップ配信対象（登録0〜21日・非会員）の
 * 現在セグメント」を取得し、セグメントタグの更新と統合版シナリオへの安全網enrollを行う。
 *
 * 旧方式はGASの時間主導トリガーが毎時 scenario-switch を叩いていたが、トリガーが
 * 黙って止まる事故（2026-08-17〜、1週間気づけず）があったため、時間主導をworker cron
 * （Cloudflare管理・observabilityログあり）へ移した。GAS側は読み取りAPIのみ。
 *
 * D1サブリクエスト上限対策で、全員に applyScenarioSwitch を流すのではなく
 * 「タグが現状と食い違う人」「enrollが無いカットオーバー後登録者」だけに絞る。
 * セグメント変化は稀なので定常時の処理対象はごく少数になる。
 */
export async function syncSegmentsFromGas(db: D1Database, gasDeployId?: string): Promise<void> {
  if (!gasDeployId) return;

  // 5分cronの毎時 :00 tick でだけ動く（kaisetsu と同じ自己ゲート方式）。
  // 6時間cronと同時発火する時刻は二重実行になり得るが、差分方式なので冪等。
  const jstMinute = new Date(Date.now() + 9 * 60 * 60_000).getUTCMinutes();
  if (jstMinute >= 5) return;

  let res: unknown;
  try {
    res = await gasGet(gasDeployId, { method: 'listSegments' }, { timeoutMs: 60_000 });
  } catch (err) {
    console.error('[segment-sync] listSegments fetch error:', err);
    return;
  }
  const gasError = getGasErrorFromResponse(res);
  if (gasError) {
    console.error('[segment-sync] listSegments error:', gasError);
    return;
  }

  const users = ((res as { users?: SegmentUser[] })?.users ?? []).filter(
    (u) => u?.lineUserId && Number.isInteger(u.segment),
  );
  if (users.length === 0) {
    console.log('[segment-sync] 対象0件');
    return;
  }

  // 現状のセグメントタグ・登録日時・統合版enroll有無をまとめて引く
  type FriendRow = { id: string; line_user_id: string; created_at: string; seg_tag: string | null };
  const current = new Map<string, { friendId: string; createdAt: string; tags: Set<string>; enrolled: boolean }>();
  const CHUNK = 40;
  for (let i = 0; i < users.length; i += CHUNK) {
    const chunk = users.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db
      .prepare(
        `SELECT f.id, f.line_user_id, f.created_at, t.name AS seg_tag
         FROM friends f
         LEFT JOIN friend_tags ft ON ft.friend_id = f.id
           AND ft.tag_id IN (SELECT id FROM tags WHERE name LIKE 'セグメント_')
         LEFT JOIN tags t ON t.id = ft.tag_id
         WHERE f.line_user_id IN (${placeholders}) AND f.is_following = 1`,
      )
      .bind(...chunk.map((u) => u.lineUserId))
      .all<FriendRow>();
    for (const r of rows.results) {
      const entry = current.get(r.line_user_id) ?? { friendId: r.id, createdAt: r.created_at, tags: new Set<string>(), enrolled: false };
      if (r.seg_tag) entry.tags.add(r.seg_tag);
      current.set(r.line_user_id, entry);
    }
  }
  // 在籍判定は「統合版系（名前前方一致）」全体で見る（2026-08-27 14日化）。
  // 旧7日版と新14日版が並走するため、単一シナリオIDで見ると旧版在籍者を
  // 「enroll漏れ」と誤判定して二重enrollしてしまう
  {
    const friendIds = [...current.values()].map((e) => e.friendId);
    for (let i = 0; i < friendIds.length; i += CHUNK) {
      const chunk = friendIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await db
        .prepare(
          `SELECT DISTINCT fs.friend_id FROM friend_scenarios fs
           JOIN scenarios s ON s.id = fs.scenario_id
           WHERE s.name LIKE ? AND fs.status IN ('active','delivering','completed') AND fs.friend_id IN (${placeholders})`,
        )
        .bind(`${UNIFIED_SCENARIO_NAME}%`, ...chunk)
        .all<{ friend_id: string }>();
      const enrolledIds = new Set(rows.results.map((r) => r.friend_id));
      for (const entry of current.values()) {
        if (enrolledIds.has(entry.friendId)) entry.enrolled = true;
      }
    }
  }

  let applied = 0;
  let skipped = 0;
  let missing = 0;
  let errors = 0;
  for (const u of users) {
    const cur = current.get(u.lineUserId);
    if (!cur) {
      // D1に居ない/ブロック中。GAS側マスターとD1のズレは正常ケース（旧GASも404 skip扱い）
      missing++;
      continue;
    }
    const wantTag = `セグメント${u.segment}`;
    const tagUpToDate = cur.tags.size === 1 && cur.tags.has(wantTag);
    const needsEnroll = !cur.enrolled && new Date(cur.createdAt).getTime() >= UNIFIED_CUTOVER_AT;
    if (tagUpToDate && !needsEnroll) {
      skipped++;
      continue;
    }
    try {
      const result = await applyScenarioSwitch(db, u.lineUserId, u.segment, Boolean(u.isReferral));
      if (result.payload.success) applied++;
      else errors++;
    } catch (err) {
      errors++;
      console.error(`[segment-sync] apply error lineUserId=${u.lineUserId}:`, err);
    }
  }

  console.log(
    `[segment-sync] users=${users.length} applied=${applied} skipped=${skipped} missing=${missing} errors=${errors}`,
  );
}
