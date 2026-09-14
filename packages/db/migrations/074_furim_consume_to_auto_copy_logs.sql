-- FurimAuto 段階4-D（Capsec #258・2026-09-14）: チケット消費の置き場を furim_ticket_ledger から furim_auto_copy_logs へ移す。
-- 台帳は増える側（購入・付与）だけ。消費は 1 回 = 自動コピー出品履歴 1 行で、二重減算防止の冪等キー consume:<dedupeKey> もこちらに持つ。
-- シートから取り込んだ既存行は idempotency_key が NULL のまま（UNIQUE は NULL 同士では衝突しない）。
ALTER TABLE furim_auto_copy_logs ADD COLUMN delta INTEGER;            -- 使った枚数（通常 -1）
ALTER TABLE furim_auto_copy_logs ADD COLUMN idempotency_key TEXT;     -- consume:<dedupeKey>
CREATE UNIQUE INDEX IF NOT EXISTS idx_furim_auto_copy_logs_idempotency ON furim_auto_copy_logs(idempotency_key);
