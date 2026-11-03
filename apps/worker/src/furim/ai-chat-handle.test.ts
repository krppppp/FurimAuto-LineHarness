import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./firebase-client.js', () => ({ getChatHistory: vi.fn(async () => []), saveChatHistory: vi.fn(async () => undefined) }));
vi.mock('./howto-source.js', () => ({ loadHowtoText: vi.fn(async () => ({ text: '## 再出品機能 〔id: msRelist〕\n本文', ids: ['msRelist', 'planCancel'], source: 'cache' })) }));

const { handleAIChat } = await import('./ai-chat.js');

function makeDb() {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare: (sql: string) => ({ bind: (...binds: unknown[]) => ({ run: async () => { runs.push({ sql, binds }); return {}; } }) }),
  } as unknown as D1Database;
  return { db, runs };
}

let aiRun: ReturnType<typeof vi.fn>;

const FAQ_TEXT = '# よくある質問\n' + '無料期間が終わっても自動で請求されることはありません。\n'.repeat(200);

function makeKv(faqValue: string | null = JSON.stringify({ text: FAQ_TEXT })) {
  const puts: Array<[string, string]> = [];
  const kv = {
    get: vi.fn(async (key: string) => (key === 'furim:ai-chat:faq-text:v1' ? faqValue : null)),
    put: vi.fn(async (key: string, value: string) => { puts.push([key, value]); }),
  } as unknown as KVNamespace;
  return { kv, puts };
}

function stubFetch(aiText: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
  aiRun = vi.fn(async () => ({ choices: [{ message: { content: aiText } }], usage: { prompt_tokens: 40000, completion_tokens: 80 } }));
}

const env = (db: D1Database, kv: KVNamespace = makeKv().kv) => ({ AI: { run: aiRun }, FIREBASE_DATABASE_URL: 'https://fb', FURIM_EXT_CACHE: kv, DB: db });

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

  it('faq.md は KV から読んで AI に渡し、GitHub には取りに行かない（TB-2976）', async () => {
    stubFetch('【AIチャットボット】\n料金は月額です。');
    const { db, runs } = makeDb();
    const { kv, puts } = makeKv();
    const client = { replyMessage: vi.fn(async () => ({})), pushMessage: vi.fn(async () => ({})) };

    await handleAIChat(client as never, 'Uabc', 'rt', '料金は？', env(db, kv));

    const urls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('api.github.com'))).toBe(false);
    const [, input] = aiRun.mock.calls[0] as [string, { messages: Array<{ content: string }> }];
    expect(input.messages[0].content).toContain('【資料2: よくある質問（faq.md）】');
    expect(input.messages[0].content).toContain('無料期間が終わっても自動で請求されることはありません。');
    expect(runs.some((r) => r.sql.includes("'botHandler'"))).toBe(false);
    const usage = JSON.parse(puts.find(([k]) => k === 'furim:ai-chat:recent-usage')![1])[0];
    expect(usage.faqChars).toBe(FAQ_TEXT.length);
    expect(usage.faq).toBe('kv');
  });

  it('KV に faq.md が無ければ説明書だけで答え、取得失敗を botHandler（faq_load）で D1 に残す（TB-2976）', async () => {
    stubFetch('【AIチャットボット】\n料金は月額です。');
    const { db, runs } = makeDb();
    const { kv, puts } = makeKv(null);
    const client = { replyMessage: vi.fn(async () => ({})), pushMessage: vi.fn(async () => ({})) };

    await handleAIChat(client as never, 'Uabc', 'rt', '料金は？', env(db, kv));

    const sent = (client.replyMessage.mock.calls[0] as unknown as [string, Array<{ text: string }>])[1];
    expect(sent[0].text).toBe('【AIチャットボット】\n料金は月額です。');
    const rec = runs.find((r) => r.sql.includes("'botHandler'"))!;
    expect(rec.binds[1]).toBe('Uabc');
    expect(String(rec.binds[2])).toContain('handleAIChat / faq_load / faq: KV に furim:ai-chat:faq-text:v1 が無い');
    const usage = JSON.parse(puts.find(([k]) => k === 'furim:ai-chat:recent-usage')![1])[0];
    expect(usage.faqChars).toBe(0);
    expect(usage.faq).toBe('failed');
  });

  it('壊れた（短すぎる）faq.md は渡さず、失敗として残す（TB-2976）', async () => {
    stubFetch('【AIチャットボット】\n料金は月額です。');
    const { db, runs } = makeDb();
    const { kv } = makeKv(JSON.stringify({ text: '短い' }));
    const client = { replyMessage: vi.fn(async () => ({})), pushMessage: vi.fn(async () => ({})) };

    await handleAIChat(client as never, 'Uabc', 'rt', '料金は？', env(db, kv));

    const [, input] = aiRun.mock.calls[0] as [string, { messages: Array<{ content: string }> }];
    expect(input.messages[0].content).not.toContain('【資料2: よくある質問（faq.md）】');
    expect(String(runs.find((r) => r.sql.includes("'botHandler'"))!.binds[2])).toContain('本文が短すぎる (2 chars)');
  });

  it('非会員には会員向けの章（月額プランのキャンセル等）の URL を付けず、作り話と同じく anchorRejected に残す（TB-2976）', async () => {
    stubFetch('【AIチャットボット】\n有料会員ではないため、解約のお手続きは不要です。\n[[howto:planCancel]]');
    const { db, runs } = makeDb();
    const client = { replyMessage: vi.fn(async () => ({})), pushMessage: vi.fn(async () => ({})) };

    await handleAIChat(client as never, 'Uabc', 'rt', '解約したい', env(db), { member: false });

    const sent = (client.replyMessage.mock.calls[0] as unknown as [string, Array<{ text: string }>])[1];
    expect(sent).toHaveLength(1);
    expect(sent[0].text).not.toContain('furimauto.com/howto');
    const [, input] = aiRun.mock.calls[0] as [string, { messages: Array<{ content: string }> }];
    expect(input.messages[0].content).toContain('有料会員（月額会員）ではありません');
    const update = runs.find((r) => r.sql.includes('UPDATE furim_ai_chat_logs'))!;
    expect(update.binds[1]).toBeNull();
    expect(update.binds[2]).toBe('planCancel');
  });

  it('会員には今までどおり会員向けの章の URL も付ける（TB-2976）', async () => {
    stubFetch('【AIチャットボット】\n解約は月額プランのキャンセルの章をご覧ください。\n[[howto:planCancel]]');
    const { db } = makeDb();
    const client = { replyMessage: vi.fn(async () => ({})), pushMessage: vi.fn(async () => ({})) };

    await handleAIChat(client as never, 'Uabc', 'rt', '解約したい', env(db), { member: true });

    const sent = (client.replyMessage.mock.calls[0] as unknown as [string, Array<{ text: string }>])[1];
    expect(sent[1].text).toContain('https://furimauto.com/howto/#planCancel');
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
