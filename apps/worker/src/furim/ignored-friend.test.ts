import { describe, expect, it } from 'vitest';
import { buildSegmentQuery } from '../services/segment-query.js';
import { IGNORED_TAG_NAME, notIgnoredSql } from './ignored-friend.js';

describe('「対応しない」の友だちを配信から外す（TB-2236）', () => {
  it('セグメント配信の SQL に「対応しない」タグの除外が入る', () => {
    const { sql } = buildSegmentQuery({ operator: 'OR', rules: [{ type: 'is_following', value: true }, { type: 'ref_code', value: 'x' }] });
    expect(sql).toContain(notIgnoredSql('f'));
    expect(sql).toContain(IGNORED_TAG_NAME);
    // OR 条件のどちらかに当たっても除外が効くよう、条件はかっこで囲む
    expect(sql).toMatch(/WHERE \(.+ OR .+\) AND NOT EXISTS/);
  });

  it('アカウント絞り込みの置換（最初の WHERE）が本体の WHERE に当たる', () => {
    const { sql } = buildSegmentQuery({ operator: 'AND', rules: [] });
    expect(sql.replace('WHERE', 'WHERE f.line_account_id = ? AND')).toMatch(/^SELECT f\.id, f\.line_user_id FROM friends f WHERE f\.line_account_id = \? AND \(1=1\) AND NOT EXISTS/);
  });
});
