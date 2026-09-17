-- LINE の AI チャットボットの会話を 1 問 1 答で 1 行残す（Capsec #307・2026-09-17 くろさん依頼）。
--
-- くろさん「AI チャットボットを通しての会話、誰がどの質問でどういった回答をしたのかを D1 データで取るようにしておいて。
-- 時間と人と、1 問 1 答で 1 データでいい」。
-- 受けた時点で質問だけ書き（reply_status='pending'）、送り終えたら回答と結果で埋める。
-- 途中で処理が打ち切られた回は pending のまま残るので、無返信に気づける。
CREATE TABLE IF NOT EXISTS furim_ai_chat_logs (
  id TEXT PRIMARY KEY,
  line_user_id TEXT,
  question TEXT NOT NULL,        -- お客様のメッセージ
  answer TEXT,                   -- 送った回答の本文（札を除いたもの）
  howto_anchor TEXT,             -- URL を付けた説明書の章の id（付けなかったら NULL）
  anchor_rejected TEXT,          -- AI が出したが説明書の見出し id の一覧に無かった id（作り話の頻度を見る）
  fallback INTEGER NOT NULL DEFAULT 0,  -- 「AIでのご案内は難しい」の定型文を返した回は 1（説明書・faq に足すべき質問の材料）
  latency_ms INTEGER,            -- 受けてから送り終えるまで
  reply_status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'replied' | 'pushed'（reply 失敗→push）| 'failed'
  error TEXT,                    -- Gemini の失敗や reply/push の失敗の内容
  howto_source TEXT,             -- 説明書の本文: 'cache' | 'fetched' | 'failed'
  prompt_tokens INTEGER,         -- Gemini の promptTokenCount
  cached_tokens INTEGER,         -- Gemini の cachedContentTokenCount（暗黙キャッシュが効いたとき）
  created_at TEXT NOT NULL       -- 受けた時刻（JST の ISO+09:00）
);
CREATE INDEX IF NOT EXISTS idx_furim_ai_chat_logs_created ON furim_ai_chat_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_furim_ai_chat_logs_user ON furim_ai_chat_logs(line_user_id, created_at);
