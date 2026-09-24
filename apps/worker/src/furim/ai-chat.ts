import type { LineClient } from '@line-crm/line-sdk';
import { jstNow } from '@line-crm/db';
import { getChatHistory, saveChatHistory } from './firebase-client.js';
import { loadHowtoText } from './howto-source.js';
import { recordBotHandlerError } from './bot-routed-message.js';

/**
 * LINE の AI チャットボット（Capsec #307）。
 *
 * 2026-09-17 くろさんの方針変更:
 * - 回答はつらつら説明せず、要点だけをテキストで返す
 * - 根拠にした説明書の章の URL（アンカー付き）を別の吹き出しで返す。画像やデザインのあるページで読む方が分かりやすいため
 * - 機能ごとの解説動画の案内（旧 FUNCTION_URLS）と、「答えが見つからないとき」の長尺動画への誘導はやめる
 * - AI が出した章の id は、説明書を取得したときに作った見出し id の一覧にあるときだけ URL にする（作り話の id で飛ばないリンクを送らない）
 * - 1 問 1 答で furim_ai_chat_logs に 1 行残す（くろさん「誰がどの質問でどういった回答をしたのかを D1 で」）
 */

export type AIChatEnv = {
  GEMINI_API_KEY: string;
  GITHUB_PAT: string;
  FIREBASE_DATABASE_URL: string;
  /** 説明書の本文のキャッシュと、直近の使用量の記録に使う */
  FURIM_EXT_CACHE?: KVNamespace;
  /** 会話の記録（furim_ai_chat_logs）と、取得・送信の失敗の記録に使う */
  DB?: D1Database;
};

export type ChatMessage = { role: 'user' | 'model'; text: string; ts: number };

export const HOWTO_BASE_URL = 'https://furimauto.com/howto/';
const KEYCODE_RESET_TOKEN = '[キーコードリセット]';
const ANCHOR_TOKEN_RE = /\[\[howto:([^\]\s]+)\]\]/g;

export const FALLBACK_TEXT =
  'お問い合わせありがとうございます。恐れ入りますが、AIでのご案内は難しい内容のようです。\n\nリッチメニュー下部の「AIチャットボットを終了する」ボタンを押した後、「追加サポートを希望する」ボタンをタップしてご連絡ください。担当者より確認の上、返信させていただきます。';
const FALLBACK_MARKER = 'AIでのご案内は難しい内容のようです';
const GEMINI_ERROR_TEXT = 'AIからの応答中にエラーが発生しました。少し時間をおいて、もう一度お試しください。';

const SPEC_FILE_PATHS = ['faq.md'];

/** base64 → UTF-8 の文字列。atob だけだと日本語が 1 バイト 1 文字の文字化けのまま AI に渡っていた（2026-09-17 まで） */
export function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

async function fetchSpecFiles(githubPat: string): Promise<string> {
  const results = await Promise.all(
    SPEC_FILE_PATHS.map(async (filePath) => {
      // GitHub APIはUser-Agent必須（無いと403。Workersのfetchは自動付与しない）
      const res = await fetch(`https://api.github.com/repos/krppppp/furimauto-faq/contents/${filePath}`, {
        headers: { Authorization: `Bearer ${githubPat}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'line-harness-worker' },
      });
      if (!res.ok) {
        console.warn(`[furim/ai-chat] spec fetch failed: ${filePath} (${res.status})`);
        return '';
      }
      const json = await res.json() as { content: string };
      return decodeBase64Utf8(json.content);
    })
  );
  return results.filter(Boolean).join('\n\n---\n\n');
}

/**
 * 429 の再試行は短く、合計の上限つき。webhook の処理は応答後の約 30 秒で打ち切られるため、
 * 以前の 10・20・40・80 秒の待ちでは、再試行に入った時点で返信が出ないまま打ち切られていた
 */
const RETRY_DELAYS_MS = [2000, 4000];
const GEMINI_DEADLINE_MS = 20_000;

async function callGeminiWithRetry(apiKey: string, body: unknown, startedAt: number): Promise<Response> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const delay = RETRY_DELAYS_MS[attempt];
    if (res.status === 429 && delay !== undefined && Date.now() - startedAt + delay < GEMINI_DEADLINE_MS) {
      console.warn(`[furim/ai-chat] 429 retry ${attempt + 1}/${RETRY_DELAYS_MS.length} after ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    return res;
  }
}

/**
 * Gemini に渡すプロンプト。固定の指示・説明書・faq.md を先頭（prefix）、会話履歴とお客様のメッセージを末尾（suffix）に置く。
 * systemInstruction と contents を分けると履歴が増えたときに不安定だった（2026-04-24）ため、1 つの user メッセージの 2 つの part で送る
 */
export function buildAIChatPrompt(input: { howtoText: string; faqText: string; history: ChatMessage[]; queryText: string }): { prefix: string; suffix: string } {
  const hasHowto = Boolean(input.howtoText);
  const sources = [
    hasHowto ? `【資料1: 利用方法説明書（https://furimauto.com/howto/ の本文・最新の仕様）】\n見出しの末尾の〔id: …〕は、その章のページ内リンクの id です。\n\n${input.howtoText}` : '',
    input.faqText ? `【資料2: よくある質問（faq.md）】\n${input.faqText}` : '',
  ].filter(Boolean).join('\n\n----------------------------\n\n');

  const prefix = `あなたは、当社のサービスである、メルカリやラクマなどのフリマサイトを自動化するツールFurimAuto(フリマート)について熟知した、親切で丁寧なカスタマーサポート担当者です。
このあとに続く「サービス仕様情報」だけを根拠に、最後に書かれている「お客様からのメッセージ」に回答してください。

**資料の優先順位:**
${hasHowto ? '資料1（利用方法説明書）が最新の仕様です。資料1と資料2（よくある質問）の内容が食い違う場合は、必ず資料1を正として回答してください。資料2は、料金・キーコード・LINEの操作・症状別の対応など資料1に書かれていない内容の根拠として使ってください。' : '今回は資料2（よくある質問）だけを根拠に回答してください。'}

**回答の書き方（必ず守ってください）:**
- 1行目は必ず【AIチャットボット】とだけ書いてください。
- 2行目から、要点だけを書いてください。結論を1文で書き、補足が必要なら「・」で始まる行を最大3つまで続けます。全体で200文字以内を目安にしてください。
- 手順の細かい説明や画面の操作の一つ一つは書かないでください（説明書のページで案内します）。
- 「**」などの装飾記号や見出し記号は使わないでください（LINEではそのまま表示されてしまいます）。
- 動画の案内はしないでください。
${hasHowto ? `- 回答の根拠にした資料1の章が1つに決まる場合は、回答の最後の行に [[howto:その章のid]] を1つだけ書いてください（idは資料1の見出しの〔id: …〕に書かれているものをそのまま使い、作らないでください）。資料2だけを根拠にした場合や、該当する章が無い場合は書かないでください。
` : ''}- キーコードが認証されない、無効になる、などの趣旨の場合は、回答の最後に ${KEYCODE_RESET_TOKEN} と書いてください。
- 上の ${hasHowto ? '[[howto:…]] と ' : ''}${KEYCODE_RESET_TOKEN} 以外に、[ ] で囲んだ文字は書かないでください。

**答えられないとき:**
提供されたサービス仕様情報の中に、お客様のメッセージへの適切な回答が見つからない場合は、1行目の【AIチャットボット】のあとに、次の文だけを返してください。
${FALLBACK_TEXT}

**エラーやバグの報告のとき:**
お客様のメッセージがエラーやバグの報告のように思える場合は、要点に「リッチメニューのガイドタブから、「バグ・エラー報告」をタップして、指示に従ってご報告ください。」という案内を含めてください。

会話履歴がある場合は、その流れを踏まえて回答してください。

==============================
サービス仕様情報:

${sources}
==============================
`;

  const historyText = input.history.length > 0
    ? '【これまでの会話履歴】\n' +
      input.history.map((msg) => {
        const time = new Date(msg.ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
        const role = msg.role === 'user' ? 'ユーザー' : 'AI';
        return `[${time}] ${role}: ${msg.text}`;
      }).join('\n') +
      '\n----------------------------\n'
    : '';

  const suffix = `${historyText}お客様からのメッセージ: ${input.queryText}`;
  return { prefix, suffix };
}

/** 説明書の章の URL。全角の id（ｍCommentDelete 等）も LINE で押せるようパーセントエンコードする */
export function howtoAnchorUrl(id: string): string {
  return `${HOWTO_BASE_URL}#${encodeURIComponent(id)}`;
}

export type ParsedAIReply = {
  text: string;
  anchorId: string | null;
  anchorRejected: string | null;
  keycodeReset: boolean;
  fallback: boolean;
};

/**
 * AI の返答から、章の id とキーコードリセットの札を取り出し、本文から消す。
 * id は説明書の見出し id の一覧（validIds）にあるときだけ採用する。無ければ URL を付けず、作り話として anchorRejected に残す。
 * ほかの [ ] だけの行（「[下書き予約出品機能]」のような札）は消す
 */
export function parseAIReply(raw: string, validIds: ReadonlySet<string>): ParsedAIReply {
  let text = raw;
  const found = [...text.matchAll(ANCHOR_TOKEN_RE)].map((m) => m[1]);
  text = text.replace(ANCHOR_TOKEN_RE, '');
  const first = found[0] ?? null;
  const anchorId = first && validIds.has(first) ? first : null;
  const anchorRejected = first && !validIds.has(first) ? first : null;

  const keycodeReset = text.includes(KEYCODE_RESET_TOKEN);
  text = text.split(KEYCODE_RESET_TOKEN).join('');

  text = text
    .split('\n')
    .filter((line) => !/^\s*(\[[^\]\n]+\]\s*)+$/.test(line))
    .join('\n')
    .replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, anchorId, anchorRejected, keycodeReset, fallback: text.includes(FALLBACK_MARKER) };
}

export type GeminiUsage = {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
};

const USAGE_LOG_KEY = 'furim:ai-chat:recent-usage';
const USAGE_LOG_KEEP = 30;

/** 直近の応答時間と使用量を KV に 30 件だけ残す（本番の確認用・wrangler kv key get で読める） */
async function recordUsage(kv: KVNamespace | undefined, entry: Record<string, unknown>): Promise<void> {
  console.log('[furim/ai-chat] usage', JSON.stringify(entry));
  if (!kv) return;
  try {
    const prev = JSON.parse((await kv.get(USAGE_LOG_KEY)) ?? '[]') as unknown[];
    await kv.put(USAGE_LOG_KEY, JSON.stringify([entry, ...prev].slice(0, USAGE_LOG_KEEP)));
  } catch (e) {
    console.warn('[furim/ai-chat] usage record failed:', e);
  }
}

type GeneratedReply = {
  messages: unknown[];
  answer: string;
  parsed: ParsedAIReply | null;
  howtoSource: string;
  usage: GeminiUsage;
  error: string | null;
};

async function generateAIResponse(queryText: string, lineUserId: string, env: AIChatEnv, startedAt: number): Promise<GeneratedReply> {
  const [faqText, howto, history] = await Promise.all([
    fetchSpecFiles(env.GITHUB_PAT),
    loadHowtoText(env.FURIM_EXT_CACHE, env.DB),
    getChatHistory(env.FIREBASE_DATABASE_URL, lineUserId),
  ]);

  if (!faqText && !howto.text) {
    const answer = '申し訳ありません、関連する情報が見つかりませんでした。';
    return { messages: [{ type: 'text', text: answer }], answer, parsed: null, howtoSource: howto.source, usage: {}, error: 'no sources' };
  }

  const { prefix, suffix } = buildAIChatPrompt({ howtoText: howto.text, faqText, history, queryText });
  const res = await callGeminiWithRetry(env.GEMINI_API_KEY, {
    contents: [{ role: 'user', parts: [{ text: prefix }, { text: suffix }] }],
  }, startedAt);

  if (!res.ok) {
    const detail = await res.text();
    console.error('[furim/ai-chat] Gemini API error:', res.status, detail);
    return { messages: [{ type: 'text', text: GEMINI_ERROR_TEXT }], answer: GEMINI_ERROR_TEXT, parsed: null, howtoSource: howto.source, usage: {}, error: `gemini ${res.status}: ${detail.slice(0, 200)}` };
  }

  const json = await res.json() as { candidates?: Array<{ content: { parts: Array<{ text: string }> } }>; usageMetadata?: GeminiUsage };
  const rawReply = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const usage = json.usageMetadata ?? {};
  if (!rawReply) {
    return { messages: [{ type: 'text', text: GEMINI_ERROR_TEXT }], answer: GEMINI_ERROR_TEXT, parsed: null, howtoSource: howto.source, usage, error: 'gemini empty reply' };
  }

  const parsed = parseAIReply(rawReply, new Set(howto.ids));

  // 履歴には、利用者に見せた本文を残す
  const now = Date.now();
  await saveChatHistory(env.FIREBASE_DATABASE_URL, lineUserId, [
    ...history,
    { role: 'user', text: queryText, ts: now },
    { role: 'model', text: parsed.text, ts: now },
  ]);

  const messages: unknown[] = [{ type: 'text', text: parsed.text }];
  if (parsed.anchorId) {
    messages.push({ type: 'text', text: `詳しい手順は説明書（画像つき）をご覧ください👇\n${howtoAnchorUrl(parsed.anchorId)}` });
  }
  if (parsed.keycodeReset) {
    messages.push({ type: 'text', text: '【キーワード】キーコードリセット' });
  }

  await recordUsage(env.FURIM_EXT_CACHE, {
    at: new Date(startedAt).toISOString(),
    latencyMs: Date.now() - startedAt,
    howto: howto.source,
    howtoChars: howto.text.length,
    howtoIds: howto.ids.length,
    faqChars: faqText.length,
    historyCount: history.length,
    anchorId: parsed.anchorId,
    anchorRejected: parsed.anchorRejected,
    fallback: parsed.fallback,
    ...usage,
  });

  return { messages, answer: parsed.text, parsed, howtoSource: howto.source, usage, error: null };
}

/** 1 問 1 答で 1 行（furim_ai_chat_logs）。受けた時点で質問だけ書き、送り終えたら回答と結果で埋める（途中で打ち切られた回は pending のまま残る） */
async function insertChatLog(db: D1Database | undefined, id: string, lineUserId: string, question: string): Promise<void> {
  if (!db) return;
  try {
    await db
      .prepare(
        `INSERT INTO furim_ai_chat_logs (id, line_user_id, question, reply_status, created_at)
         VALUES (?, ?, ?, 'pending', ?)`,
      )
      .bind(id, lineUserId, question, jstNow())
      .run();
  } catch (e) {
    console.error('[furim/ai-chat] chat log insert failed:', e);
  }
}

async function finishChatLog(
  db: D1Database | undefined,
  id: string,
  r: { answer: string; parsed: ParsedAIReply | null; latencyMs: number; replyStatus: 'replied' | 'pushed' | 'failed'; error: string | null; howtoSource: string; usage: GeminiUsage },
): Promise<void> {
  if (!db) return;
  try {
    await db
      .prepare(
        `UPDATE furim_ai_chat_logs
         SET answer = ?, howto_anchor = ?, anchor_rejected = ?, fallback = ?, latency_ms = ?, reply_status = ?, error = ?,
             howto_source = ?, prompt_tokens = ?, cached_tokens = ?
         WHERE id = ?`,
      )
      .bind(
        r.answer,
        r.parsed?.anchorId ?? null,
        r.parsed?.anchorRejected ?? null,
        r.parsed?.fallback ? 1 : 0,
        r.latencyMs,
        r.replyStatus,
        r.error ? r.error.slice(0, 500) : null,
        r.howtoSource,
        r.usage.promptTokenCount ?? null,
        r.usage.cachedContentTokenCount ?? null,
        id,
      )
      .run();
  } catch (e) {
    console.error('[furim/ai-chat] chat log update failed:', e);
  }
}

export async function handleAIChat(
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string,
  text: string,
  env: AIChatEnv,
): Promise<void> {
  console.log('[furim/ai-chat] handling:', lineUserId);
  const startedAt = Date.now();
  const logId = crypto.randomUUID();
  await insertChatLog(env.DB, logId, lineUserId, text);

  const generated = await generateAIResponse(text, lineUserId, env, startedAt);
  const messages = generated.messages.slice(0, 5) as never[];

  // reply トークンは受信から約 1 分で失効する。失効や一時的な失敗で無返信にならないよう、reply が落ちたら push で送り直す
  let replyStatus: 'replied' | 'pushed' | 'failed' = 'replied';
  let error = generated.error;
  try {
    await lineClient.replyMessage(replyToken, messages);
  } catch (replyErr) {
    console.warn('[furim/ai-chat] reply failed, falling back to push:', replyErr);
    try {
      await lineClient.pushMessage(lineUserId, messages);
      replyStatus = 'pushed';
      error = error ?? `reply failed: ${replyErr instanceof Error ? replyErr.message : String(replyErr)}`;
    } catch (pushErr) {
      replyStatus = 'failed';
      error = `reply and push failed: ${pushErr instanceof Error ? pushErr.message : String(pushErr)}`;
      await recordBotHandlerError(env.DB, lineUserId, 'handleAIChat', 'fallback_push', pushErr);
    }
  }

  await finishChatLog(env.DB, logId, {
    answer: generated.answer,
    parsed: generated.parsed,
    latencyMs: Date.now() - startedAt,
    replyStatus,
    error,
    howtoSource: generated.howtoSource,
    usage: generated.usage,
  });
}
