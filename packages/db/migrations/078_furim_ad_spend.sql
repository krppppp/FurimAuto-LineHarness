-- 広告費を D1 に置く（Capsec #282 段階2 / #285）。
-- トップの「広告費と実 CPA」は D1 だけを読む。Google 広告 API からの取り込みは
-- ~/github/FurimAuto/GoogleAds/ad_spend_to_d1.py が日次で POST /api/furim/ad-spend/import に流す。
-- date × source × campaign_id を主キーにして upsert するので、同じ日を何度入れ直しても二重にならない。
CREATE TABLE IF NOT EXISTS furim_ad_spend (
  date TEXT NOT NULL,            -- JST の YYYY-MM-DD
  source TEXT NOT NULL,          -- 'google'（将来 'meta' など）
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  cost_yen INTEGER NOT NULL,     -- 円（cost_micros / 1000000 を四捨五入）
  clicks INTEGER,
  impressions INTEGER,
  imported_at TEXT NOT NULL,     -- 取り込み時刻（JST の ISO+09:00）
  PRIMARY KEY (date, source, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_furim_ad_spend_date ON furim_ad_spend(date);
