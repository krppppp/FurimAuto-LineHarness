import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./firebase-client.js', () => ({ getChatHistory: vi.fn(async () => []), saveChatHistory: vi.fn(async () => undefined) }));
vi.mock('./howto-source.js', () => ({ loadHowtoText: vi.fn(async () => ({ text: '## 再出品機能 〔id: msRelist〕\n本文', ids: ['msRelist'], source: 'cache' })) }));

const { handleAIChat } = await import('./ai-chat.js');

function makeDb() {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare: (sql: string) => ({ bind: (...binds: unknown[]) => ({ run: async () => { runs.push({ sql, binds }); return {}; } }) }),
  } as unknown as D1Database;
  return { db, runs };
}

let aiRun: ReturnType<typeof vi.fn>;

function stubFetch(aiText: string) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ content: Buffer.from('料金は月額です', 'utf8').toString('base64') }), { status: 200 }),
  ));
  aiRun = vi.fn(async () => ({ choices: [{ message: { content: aiText } }], usage: { prompt_tokens: 40000, completion_tokens: 80 } }));
}

const env = (db: D1Database) => ({ AI: { run: aiRun }, GITHUB_PAT: 'p', FIREBASE_DATABASE_URL: 'https://fb', DB: db });

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('handleAIChat（Capsec #307）', () => {
  it('要点と、章の URL を別の吹き出しで reply し、会話を 1 行（pending → replied）で残す', async () => {
    stubFetch('【AIチャットボット】\nはい、Shops でも再出品できます。\n[[howto:msRelist]]');
    const { db, runs } = makeDb();
    const client = { replyMessage: vi.fn(async () => ({})), pushMessage: vi.fn(async () => ({})) };

    await handleAIChat(client as never, 'Uabc', 'rt', 'Shopsで再出品できる？', env(db));

    const sent = (client.replyMessage.mock.calls[0] as unknown as [string, Array<{ text: string }>])[1];
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toBe('【AIチャットボット】\nはい、Shops でも再出品できます。');
    expect(sent[1].text).toContain('https://furimauto.com/howto/#msRelist');
    expect(client.pushMessage).not.toHaveBeenCalled();

    expect(runs[0].sql).toContain('INSERT INTO furim_ai_chat_logs');
    expect(runs[0].binds.slice(1, 3)).toEqual(['Uabc', 'Shopsで再出品できる？']);
    const update = runs.find((r) => r.sql.includes('UPDATE furim_ai_chat_logs'))!;
    expect(update.binds[0]).toBe('【AIチャットボット】\nはい、Shops でも再出品できます。');
    expect(update.binds[1]).toBe('msRelist');
    expect(update.binds[5]).toBe('replied');
    expect(update.binds[8]).toBe(40000);
  });

  it('reply が失敗したら（トークン失効など）push で送り直し、送信を pushed で残す', async () => {
    stubFetch('【AIチャットボット】\n料金は月額です。');
    const { db, runs } = makeDb();
    const client = { replyMessage: vi.fn(async () => { throw new Error('LINE API error: 400 Invalid reply token'); }), pushMessage: vi.fn(async () => ({})) };

    await handleAIChat(client as never, 'Uabc', 'rt', '料金は？', env(db));

    expect(client.pushMessage).toHaveBeenCalledWith('Uabc', [{ type: 'text', text: '【AIチャットボット】\n料金は月額です。' }]);
    const update = runs.find((r) => r.sql.includes('UPDATE furim_ai_chat_logs'))!;
    expect(update.binds[5]).toBe('pushed');
    expect(String(update.binds[6])).toContain('Invalid reply token');
  });

  it('reply も push も失敗したら failed で残し、botHandler の記録にも出す', async () => {
    stubFetch('【AIチャットボット】\n料金は月額です。');
    const { db, runs } = makeDb();
    const client = { replyMessage: vi.fn(async () => { throw new Error('reply down'); }), pushMessage: vi.fn(async () => { throw new Error('push down'); }) };

    await handleAIChat(client as never, 'Uabc', 'rt', '料金は？', env(db));

    expect(runs.some((r) => r.sql.includes("'botHandler'"))).toBe(true);
    expect(runs.find((r) => r.sql.includes('UPDATE furim_ai_chat_logs'))!.binds[5]).toBe('failed');
  });

  it('faq.md は furimauto-faq のルートから取る（#329 で T4ClaudeCompany から移した）', async () => {
    stubFetch('【AIチャットボット】\n料金は月額です。');
    const { db } = makeDb();
    const client = { replyMessage: vi.fn(async () => ({})), pushMessage: vi.fn(async () => ({})) };

    await handleAIChat(client as never, 'Uabc', 'rt', '料金は？', env(db));

    const urls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('https://api.github.com/repos/krppppp/furimauto-faq/contents/faq.md');
  });

  it('Workers AI の Gemma 4 を思考なしで呼ぶ（TB-2156。思考ありだと 45 秒かかり webhook の打ち切りに間に合わない）', async () => {
    stubFetch('【AIチャットボット】\n料金は月額です。');
    const { db } = makeDb();
    const client = { replyMessage: vi.fn(async () => ({})), pushMessage: vi.fn(async () => ({})) };

    await handleAIChat(client as never, 'Uabc', 'rt', '料金は？', env(db));

    const [model, input] = aiRun.mock.calls[0] as [string, { messages: Array<{ role: string; content: string }>; chat_template_kwargs: unknown }];
    expect(model).toBe('@cf/google/gemma-4-26b-a4b-it');
    expect(input.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(input.messages).toHaveLength(1);
    expect(input.messages[0].content).toContain('お客様からのメッセージ: 料金は？');
  });

  it('Workers AI が失敗したら（無料枠の超過など）エラーの文面を返し、error に残す', async () => {
    stubFetch('');
    aiRun = vi.fn(async () => { throw new Error('4006: you have used up your daily free allocation of 10,000 neurons'); });
    const { db, runs } = makeDb();
    const client = { replyMessage: vi.fn(async () => ({})), pushMessage: vi.fn(async () => ({})) };

    await handleAIChat(client as never, 'Uabc', 'rt', '料金は？', env(db));

    const sent = (client.replyMessage.mock.calls[0] as unknown as [string, Array<{ text: string }>])[1];
    expect(sent[0].text).toContain('AIからの応答中にエラーが発生しました');
    const update = runs.find((r) => r.sql.includes('UPDATE furim_ai_chat_logs'))!;
    expect(String(update.binds[6])).toContain('workers-ai: 4006');
  });
});
