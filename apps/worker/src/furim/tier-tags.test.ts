import { describe, it, expect } from 'vitest';
import { replaceTierTag, tierFor } from './tier-tags.js';

type Write = { sql: string; args: unknown[] };

function makeDb(tags: Array<{ id: string; name: string }>, tagExists = true) {
  const writes: Write[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            run: async () => { writes.push({ sql, args }); return {}; },
            all: async () => ({ results: tags }),
            first: async () => (tagExists ? { id: `tag-${String(args[0])}` } : null),
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, writes };
}

describe('tierFor', () => {
  it('automation と同じ帯（19800 超は 19800）', () => {
    expect(tierFor(3980)).toBe(5000);
    expect(tierFor(8980)).toBe(10000);
    expect(tierFor(17960)).toBe(19800);
    expect(tierFor(25000)).toBe(19800);
  });
});

describe('replaceTierTag', () => {
  it('旧帯を外して新帯だけを付ける。月額会員タグは触らない', async () => {
    const { db, writes } = makeDb([
      { id: 't5000', name: '月額5000' },
      { id: 't8000', name: '月額8000' },
      { id: 'tmember', name: '月額会員' },
    ]);
    const r = await replaceTierTag(db, 'f1', 10000);
    expect(r).toEqual({ removed: ['月額5000', '月額8000'], added: '月額10000' });
    const deletes = writes.filter((w) => /DELETE FROM friend_tags/.test(w.sql)).map((w) => w.args[1]);
    expect(deletes).toEqual(['t5000', 't8000']);
    expect(writes.some((w) => /INSERT OR IGNORE INTO friend_tags/.test(w.sql) && w.args[1] === 'tag-月額10000')).toBe(true);
  });

  it('既に対象の帯だけなら何も消さない', async () => {
    const { db, writes } = makeDb([{ id: 't10000', name: '月額10000' }]);
    const r = await replaceTierTag(db, 'f1', 10000);
    expect(r.removed).toEqual([]);
    expect(writes.filter((w) => /DELETE/.test(w.sql))).toHaveLength(0);
  });
});
