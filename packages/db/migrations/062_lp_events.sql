-- LP behavior beacon events (FurimAuto LP行動計測)
-- 静的LP(furimauto.com)の js/lp-metrics.js から /api/lp-beacon 経由で書き込まれる。
-- page は location.pathname をそのまま保存し、新規LPは無設定で自動的に計測対象になる。
CREATE TABLE lp_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  page TEXT NOT NULL,
  event_type TEXT NOT NULL,
  max_scroll_pct INTEGER,
  ms_on_page INTEGER,
  ref TEXT,
  has_click_id INTEGER DEFAULT 0,
  utm_campaign TEXT,
  utm_content TEXT,
  is_mobile INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_lp_events_page_created ON lp_events(page, created_at);
CREATE INDEX idx_lp_events_session ON lp_events(session_id);

-- LPセッションと友だち追加の接続キー（/auth/line?sid= 経由で搬送）
ALTER TABLE ref_tracking ADD COLUMN lp_session_id TEXT;
