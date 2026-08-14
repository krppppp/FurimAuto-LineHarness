-- GAS再実行キューのStripe経路統合（2026-08-14）。
-- dedupe_key: 重複積み防止の判定キー。従来の(line_user_id, method)だと同一ユーザーの
--             別インボイス分が落ちるため、stripe系は method:stripeイベントID で一意化する。
--             NULL行はmethodで判定（既存互換）
-- max_attempts: 台帳書き込み系(post)はGASの長時間障害に耐えるため上限を大きくする
ALTER TABLE gas_retry_jobs ADD COLUMN dedupe_key TEXT;
ALTER TABLE gas_retry_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 5;
UPDATE gas_retry_jobs SET dedupe_key = method WHERE dedupe_key IS NULL;
