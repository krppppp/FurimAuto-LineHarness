import type { LineClient } from '@line-crm/line-sdk';
import { getChatHistory, saveChatHistory } from './firebase-client.js';

export type AIChatEnv = {
  GEMINI_API_KEY: string;
  GITHUB_PAT: string;
  FIREBASE_DATABASE_URL: string;
};

const FUNCTION_URLS: Record<string, { video: string; manual: string }> = {
  '値段変更': { video: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E5%80%A4%E6%AE%B5%E5%A4%89%E6%9B%B4.mov', manual: 'https://furimauto.com/howto/#ｍChangePrice' },
  'コメント投稿': { video: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E3%82%B3%E3%83%A1%E3%83%B3%E3%83%88%E6%8A%95%E7%A8%BF.mov', manual: 'https://furimauto.com/howto/#ｍComment' },
  'コメント削除': { video: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E3%82%B3%E3%83%A1%E3%83%B3%E3%83%88%E5%89%8A%E9%99%A4.mov', manual: 'https://furimauto.com/howto/#mCommentDelete' },
  '商品別底値設定': { video: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E5%95%86%E5%93%81%E5%88%A5%E5%BA%95%E5%80%A4%E8%A8%AD%E5%AE%9A.mov', manual: 'https://furimauto.com/howto/#mBottomPrice' },
  'オークション': { video: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E3%82%AA%E3%83%BC%E3%82%AF%E3%82%B7%E3%83%A7%E3%83%B3.mov', manual: 'https://furimauto.com/howto/#mAuction' },
  'バックアップ': { video: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E3%83%8F%E3%82%99%E3%83%83%E3%82%AF%E3%82%A2%E3%83%83%E3%83%95%E3%82%9A.mov', manual: 'https://furimauto.com/howto/#mBackup' },
  '再出品': { video: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E5%86%8D%E5%87%BA%E5%93%81.mov', manual: 'https://furimauto.com/howto/#mRelist' },
  '商品削除': { video: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E5%95%86%E5%93%81%E5%89%8A%E9%99%A4.mov', manual: 'https://furimauto.com/howto/#mDelete' },
  '出品一覧追加情報表示': { video: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E5%87%BA%E5%93%81%E4%B8%80%E8%A6%A7%E8%BF%BD%E5%8A%A0%E6%83%85%E5%A0%B1%E8%A1%A8%E7%A4%BA.mov', manual: 'https://furimauto.com/howto/#mLoadAdditionalInfo' },
  'チェックコントローラー': { video: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E3%83%81%E3%82%A7%E3%83%83%E3%82%AF%E3%83%9B%E3%82%99%E3%83%83%E3%82%AF%E3%82%B9%E3%82%B3%E3%83%B3%E3%83%88%E3%83%AD%E3%83%BC%E3%83%A9%E3%83%BC.mov', manual: 'https://furimauto.com/howto/#mAttributeCheckbox' },
  'ショップ調査機能': { video: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E3%82%B7%E3%83%A7%E3%83%83%E3%83%95%E3%82%9A%E8%AA%BF%E6%9F%BB.mov', manual: 'https://furimauto.com/howto/#mProfileOptions' },
  '自動化処理予約機能': { video: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E8%87%AA%E5%8B%95%E5%8C%96%E5%87%A6%E7%90%86%E4%BA%88%E7%B4%84.mov', manual: 'https://furimauto.com/howto/#mTimeReservation' },
  '自動いいね対応機能': { video: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E8%87%AA%E5%8B%95%E3%81%84%E3%81%84%E3%81%AD%E5%AF%BE%E5%BF%9C.mov', manual: 'https://furimauto.com/howto/#mAutoComment' },
  '自動取引対応機能': { video: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E8%87%AA%E5%8B%95%E5%8F%96%E5%BC%95%E5%AF%BE%E5%BF%9C.mov', manual: 'https://furimauto.com/howto/#mAutoTransaction' },
  '売上表CSV出力機能': { video: 'https://storage.googleapis.com/furimauto_line/video/%E7%B0%A1%E5%8D%98%E8%A7%A3%E8%AA%AC1%E5%88%86%E5%8B%95%E7%94%BB/%E5%A3%B2%E4%B8%8ACSV%E5%87%BA%E5%8A%9B.mov', manual: 'https://furimauto.com/howto/#mCSV' },
};

const SPEC_FILE_PATHS = ['.claude-company/projects/furim-auto/specs/faq.md'];

async function fetchSpecFiles(githubPat: string): Promise<string> {
  const results = await Promise.all(
    SPEC_FILE_PATHS.map(async (filePath) => {
      // GitHub APIはUser-Agent必須（無いと403。Workersのfetchは自動付与しない）
      const res = await fetch(`https://api.github.com/repos/krppppp/T4ClaudeCompany/contents/${filePath}`, {
        headers: { Authorization: `Bearer ${githubPat}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'line-harness-worker' },
      });
      if (!res.ok) {
        console.warn(`[furim/ai-chat] spec fetch failed: ${filePath} (${res.status})`);
        return '';
      }
      const json = await res.json() as { content: string };
      return atob(json.content.replace(/\n/g, ''));
    })
  );
  return results.filter(Boolean).join('\n\n---\n\n');
}

type ChatMessage = { role: 'user' | 'model'; text: string; ts: number };

const RETRY_DELAYS_MS = [10000, 20000, 40000, 80000]; // 10s, 20s, 40s, 80s

async function callGeminiWithRetry(apiKey: string, body: unknown): Promise<Response> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429 && attempt < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(`[furim/ai-chat] 429 retry ${attempt + 1}/${RETRY_DELAYS_MS.length} after ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    return res;
  }
  throw new Error('Gemini API unreachable after retries');
}

async function generateAIResponse(queryText: string, lineUserId: string, env: AIChatEnv): Promise<{ text: string; additionalMessages: unknown[] }> {
  const [contextText, history] = await Promise.all([
    fetchSpecFiles(env.GITHUB_PAT),
    getChatHistory(env.FIREBASE_DATABASE_URL, lineUserId),
  ]);

  if (!contextText) {
    return { text: '申し訳ありません、関連する情報が見つかりませんでした。', additionalMessages: [] };
  }

  // 会話履歴をテキスト形式に変換
  const historyText = history.length > 0
    ? '\n\n----------------------------\n【これまでの会話履歴】\n' +
      history.map(msg => {
        const time = new Date(msg.ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
        const role = msg.role === 'user' ? 'ユーザー' : 'AI';
        return `[${time}] ${role}: ${msg.text}`;
      }).join('\n') +
      '\n----------------------------'
    : '';

  const prompt = `あなたは、当社のサービスである、メルカリやラクマなどのフリマサイトを自動化するツールFurimAuto(フリマート)について熟知した、親切で丁寧なカスタマーサポート担当者です。
以下の「お客様からのメッセージ」がLINEに届いたユーザーからのメッセージとなっております。

お客様からのメッセージ: ${queryText}
${historyText}

**回答冒頭の指示:**
文章の最初にはAIからの返信であるとユーザーに明確に認識させるために【AIチャットボット】というテキストを必ず付けてください。
その次の行には、ユーザーのメッセージが「質問」であれば、「〇〇についての質問で承りました。」のような形で、質問内容を要約した一文を返答の冒頭に含めてください。
ユーザーのメッセージが「エラー報告」のように思える場合は、「〇〇についてのエラー報告として承りました。」のように要約して返答の冒頭に含めてください。
それ以外のメッセージの場合は、この冒頭文は含めないでください。

----------------------------

サービス仕様情報:
${contextText}

----------------------------
もし、提供されたサービス仕様情報の中に、お客様のメッセージへの適切な回答が見つからない場合は、以下のメッセージを返してください。
「お問い合わせありがとうございます。恐れ入りますが、AIでのご案内は難しい内容のようです。\n\nまずは以下の長尺解説動画をご覧いただくと、多くの疑問が解決できる可能性がございます。\nhttps://www.youtube.com/watch?v=jhaCPxgE_Sk&t=6s\n\nそれでもご不明な点がございましたら、リッチメニュー下部の「AIチャットボットを終了する」ボタンを押した後、「追加サポートを希望する」ボタンをタップしてご連絡ください。担当者より確認の上、返信させていただきます。」
----------------------------
もしお客様のメッセージがエラーやバグの報告のように思える場合は、「リッチメニューのガイドタブから、「バグ・エラー報告」をタップして、指示に従ってご報告ください。」と案内をしてください。
----------------------------

**補足:**
もし、お客様の質問がツールの「利用方法」、「操作方法」、「設定方法」に関するもので、かつ、以下の機能リストのいずれかに関連する場合は、回答の最後に該当する機能名を記載してください。
（例: 「[バックアップ] [再出品]」）
- 値段変更 / コメント投稿 / コメント削除 / 商品別底値設定 / オークション / バックアップ / 再出品 / 商品削除 / 出品一覧追加情報表示 / チェックコントローラー / ショップ調査機能 / 自動化処理予約機能 / 自動いいね対応機能 / 自動取引対応機能 / 売上表CSV出力機能
キーコードがNGになる、や有効ににならないなどの趣旨の場合も「[キーコードリセット]」を使用してください。
----------------------------
以上を踏まえて、日本語で回答してください。LINEにて返答をするので、読みやすいように改行を入れてください。
会話履歴がある場合はその流れを踏まえて回答してください。`;

  const res = await callGeminiWithRetry(env.GEMINI_API_KEY, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });

  if (!res.ok) {
    console.error('[furim/ai-chat] Gemini API error:', res.status, await res.text());
    return { text: 'AIからの応答中にエラーが発生しました。もう一度お試しください。', additionalMessages: [] };
  }

  const json = await res.json() as { candidates?: Array<{ content: { parts: Array<{ text: string }> } }> };
  let aiReply = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!aiReply) return { text: 'AIからの応答中にエラーが発生しました。もう一度お試しください。', additionalMessages: [] };

  // 履歴を保存
  const now = Date.now();
  await saveChatHistory(env.FIREBASE_DATABASE_URL, lineUserId, [
    ...history,
    { role: 'user', text: queryText, ts: now },
    { role: 'model', text: aiReply, ts: now },
  ]);

  const additionalMessages: unknown[] = [];

  for (const [keyword, urls] of Object.entries(FUNCTION_URLS)) {
    const regex = new RegExp(`\\[${keyword}\\]`, 'g');
    if (regex.test(aiReply)) {
      aiReply = aiReply.replace(new RegExp(`\\[${keyword}\\]`, 'g'), '');
      additionalMessages.push({ type: 'video', originalContentUrl: urls.video, previewImageUrl: 'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png', altText: `${keyword}機能の解説動画` });
      additionalMessages.push({ type: 'text', text: `【利用方法説明書】\n${urls.manual}` });
    }
  }

  if (aiReply.includes('[キーコードリセット]')) {
    aiReply = aiReply.replace(/\[キーコードリセット\]/g, '');
    additionalMessages.push({ type: 'text', text: '【キーワード】キーコードリセット' });
  }

  return { text: aiReply.trim(), additionalMessages };
}

export async function handleAIChat(
  lineClient: LineClient,
  lineUserId: string,
  replyToken: string,
  text: string,
  env: AIChatEnv,
): Promise<void> {
  console.log('[furim/ai-chat] handling:', lineUserId);
  const { text: aiReply, additionalMessages } = await generateAIResponse(text, lineUserId, env);
  const messages: unknown[] = [{ type: 'text', text: aiReply }, ...additionalMessages];
  await lineClient.replyMessage(replyToken, (messages.slice(0, 5)) as never[]);
}
