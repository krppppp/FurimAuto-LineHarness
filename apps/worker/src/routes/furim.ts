import { Hono } from 'hono';
import {
  getFriendByLineUserId,
  completeFriendActiveScenarios,
  enrollFriendInScenario,
  upsertFriend,
  jstNow,
} from '@line-crm/db';
import type { Env } from '../index.js';

const furim = new Hono<Env>();

// シナリオ名マップ: segment番号 → DB上のシナリオ名
// isReferral による区別なし（試用期間の差はGAS側のsegment切り替えタイミングで吸収）
const SCENARIO_NAME_MAP: Record<string, string> = {
  '1': 'FurimAuto セグメント1: アンケート未回答',
  '2': 'FurimAuto セグメント2: アンケート回答済み',
  '3': 'FurimAuto セグメント3: キーコード発行済み',
  '4': 'FurimAuto セグメント4: 拡張インストール済み',
  '5': 'FurimAuto セグメント5: Free30未取得',
  '6': 'FurimAuto セグメント6: Free30取得済み',
  '7': 'FurimAuto セグメント7: Youtubeクーポン取得済み',
};

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

    // 月額会員は既に課金済みのためセグメント管理対象外
    const memberTag = await db.prepare(`SELECT t.id FROM tags t JOIN friend_tags ft ON t.id = ft.tag_id WHERE ft.friend_id = ? AND t.name = '月額会員' LIMIT 1`).bind(friend.id).first<{ id: string }>();
    if (memberTag) {
      console.log(`[furim/scenario-switch] friend=${friend.id} は月額会員のためセグメント切り替えをスキップ`);
      return c.json({ success: true, data: { friendId: friend.id, scenarioId: null, scenarioName: 'skipped_member' } });
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

    // seg8 はシナリオなし（kaisetsu cron で管理）
    if (body.segment === 8) {
      await completeFriendActiveScenarios(db, friend.id);
      console.log(`[furim/scenario-switch] friend=${friend.id} seg=8 → kaisetsu cron 管理（シナリオ登録なし）`);
      return c.json({ success: true, data: { friendId: friend.id, scenarioId: null, scenarioName: 'kaisetsu' } });
    }

    const key = `${body.segment}`;
    const scenarioName = SCENARIO_NAME_MAP[key];
    if (!scenarioName) {
      return c.json({ success: false, error: `Unknown segment: ${key}` }, 400);
    }

    const scenario = await db
      .prepare('SELECT id, name FROM scenarios WHERE name = ? AND is_active = 1 LIMIT 1')
      .bind(scenarioName)
      .first<{ id: string; name: string }>();

    if (!scenario) {
      return c.json({ success: false, error: `Scenario not found or inactive: ${scenarioName}` }, 404);
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
 * Body: { lineUserId: string, displayName?: string, pictureUrl?: string, statusMessage?: string }
 */
furim.post('/api/furim/upsert-friend', async (c) => {
  try {
    const body = await c.req.json<{
      lineUserId: string;
      displayName?: string | null;
      pictureUrl?: string | null;
      statusMessage?: string | null;
      createdAt?: string | null;
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

export { furim };
