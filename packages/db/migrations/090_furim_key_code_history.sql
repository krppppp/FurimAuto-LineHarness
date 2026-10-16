-- キーコードの発行履歴（TB-1246・2026-10-08）。
-- furim_customers.key_code は 1 人 1 列で上書きされ、古いキーコードが残らなかった。
-- 書き手（友だち追加・プランビルダー・試用延長・キャンペーン・解約・GAS 取り込み・管理 SQL）を問わず残すため、
-- アプリではなくトリガーで記録する。
--   reason: issued（空 → 発行。初回・解約後の再加入）/ replaced（別のキーコードに置き換え。プラン変更など）
--           / backfill（この migration 時点で使っていたもの。発行日時は不明なので issued_at は NULL）
--   replaced_at: 次のキーコードに置き換えられた・解約で消えた日時。NULL = いま使っているもの

CREATE TABLE IF NOT EXISTS furim_key_code_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT NOT NULL,
  key_code     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  issued_at    TEXT,
  replaced_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_furim_key_code_history_key ON furim_key_code_history(key_code);
CREATE INDEX IF NOT EXISTS idx_furim_key_code_history_user ON furim_key_code_history(line_user_id, replaced_at);

INSERT INTO furim_key_code_history (line_user_id, key_code, reason, issued_at, replaced_at)
SELECT line_user_id, key_code, 'backfill', NULL, NULL
FROM furim_customers
WHERE COALESCE(key_code, '') <> ''
  AND NOT EXISTS (SELECT 1 FROM furim_key_code_history h WHERE h.line_user_id = furim_customers.line_user_id AND h.replaced_at IS NULL);

CREATE TRIGGER IF NOT EXISTS trg_furim_key_code_history_insert
AFTER INSERT ON furim_customers
WHEN COALESCE(NEW.key_code, '') <> ''
BEGIN
  INSERT INTO furim_key_code_history (line_user_id, key_code, reason, issued_at, replaced_at)
  VALUES (NEW.line_user_id, NEW.key_code, 'issued', NEW.updated_at, NULL);
END;

CREATE TRIGGER IF NOT EXISTS trg_furim_key_code_history_update
AFTER UPDATE OF key_code ON furim_customers
WHEN COALESCE(OLD.key_code, '') <> COALESCE(NEW.key_code, '')
BEGIN
  UPDATE furim_key_code_history SET replaced_at = NEW.updated_at
  WHERE line_user_id = NEW.line_user_id AND replaced_at IS NULL;
  INSERT INTO furim_key_code_history (line_user_id, key_code, reason, issued_at, replaced_at)
  SELECT NEW.line_user_id, NEW.key_code, CASE WHEN COALESCE(OLD.key_code, '') = '' THEN 'issued' ELSE 'replaced' END, NEW.updated_at, NULL
  WHERE COALESCE(NEW.key_code, '') <> '';
END;
