import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./gas-client.js', () => ({ gasGet: vi.fn(), gasPost: vi.fn() }));

const { handleButtonAction } = await import('./button-actions.js');

function makeClient() {
  return {
    replyMessage: vi.fn().mockResolvedValue({}),
    pushMessage: vi.fn().mockResolvedValue({}),
  };
}

/**
 * SQL文字列でルーティングする簡易 D1。
 * - friends 取得 → { id: 'friend1' }
 * - tags 取得 → opts.tagExists で { id: 'tag1' } / null
 * - INSERT は記録して {} を返す
 */
function makeDb(opts: { tagExists: boolean }) {
  const inserts: string[] = [];
  let tagCreated = false;
  return {
    inserts,
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => {
              if (/FROM friends WHERE line_user_id/.test(sql)) return { id: 'friend1' };
              if (/FROM tags WHERE name/.test(sql)) return opts.tagExists || tagCreated ? { id: 'tag1' } : null;
              return null;
            },
            run: async () => {
              inserts.push(sql);
              if (/INSERT.*INTO tags/.test(sql)) tagCreated = true;
              return {};
            },
          };
        },
      };
    },
  };
}

const env = { GAS_DEPLOY_ID: 'deploy-id' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('解約理由アンケート回答', () => {
  it('料金理由 → タグ新規作成・付与＋お礼＋ダウングレード提案を返す', async () => {
    const client = makeClient();
    const db = makeDb({ tagExists: false });

    const handled = await handleButtonAction(client as never, 'U1', 'rt', '【ボタン】解約理由:料金が高い', env, db as never);

    expect(handled).toBe(true);
    expect(db.inserts.some((s) => /INSERT OR IGNORE INTO tags/.test(s))).toBe(true);
    expect(db.inserts.some((s) => /INSERT OR IGNORE INTO friend_tags/.test(s))).toBe(true);
    const messages = client.replyMessage.mock.calls[0][1] as Array<{ text: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0].text).toContain('ご回答ありがとうございます');
    expect(messages[1].text).toContain('liff.line.me');
  });

  it('物販休止 → タグ付与＋お礼のみ（提案なし）', async () => {
    const client = makeClient();
    const db = makeDb({ tagExists: true });

    const handled = await handleButtonAction(client as never, 'U1', 'rt', '【ボタン】解約理由:物販休止', env, db as never);

    expect(handled).toBe(true);
    expect(db.inserts.some((s) => /INSERT OR IGNORE INTO friend_tags/.test(s))).toBe(true);
    const messages = client.replyMessage.mock.calls[0][1] as Array<{ text: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].text).not.toContain('liff.line.me');
  });
});
