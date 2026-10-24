-- 新 LINE「フリマ物販トレンド情報局」（@533jinxg）の流入経路 7 本と流入タグ・本番の確認用 fmb_test（TB-2209）
-- 流す先: D1 line-crm-fmb だけ（FurimAuto の line-crm-prod には流さない）
--   npx wrangler d1 execute line-crm-fmb --remote --file=../../scripts/data/fmb-001-entry-routes.sql
-- 経路名は TB-2192（管理画面の友だち追加経路）のキャンペーン名と同じ。URL は https://line.t4-corp.com/r/<ref_code>
-- /r/<ref_code> → LIFF → /api/liff/link で friends.ref_code（最初の 1 回だけ）・ref_tracking・下のタグが付く
-- INSERT OR IGNORE なので 2 回流しても増えない

INSERT OR IGNORE INTO tags (id, name, color) VALUES
  ('fmb-tag-inflow-media', '流入:メディアサイト', '#0EA5E9'),
  ('fmb-tag-inflow-note',  '流入:note',           '#22C55E'),
  ('fmb-tag-inflow-blog',  '流入:ブログ',         '#A855F7'),
  ('fmb-tag-inflow-yt',    '流入:YouTube',        '#EF4444'),
  ('fmb-tag-inflow-tt',    '流入:TikTok',         '#111827'),
  ('fmb-tag-inflow-other', '流入:その他',         '#6B7280'),
  ('fmb-tag-inflow-test',  '流入:テスト',         '#D1D5DB');

INSERT OR IGNORE INTO entry_routes (id, ref_code, name, tag_id, scenario_id, is_active) VALUES
  ('fmb-route-media_top', 'fmb_media_top', 'メディアサイト 上部の帯・トップ', 'fmb-tag-inflow-media', NULL, 1),
  ('fmb-route-media_s0',  'fmb_media_s0',  'メディアサイト ⓪の記事の CTA',    'fmb-tag-inflow-media', NULL, 1),
  ('fmb-route-note',      'fmb_note',      'note の⓪の記事',                  'fmb-tag-inflow-note',  NULL, 1),
  ('fmb-route-blog',      'fmb_blog',      'ブログの⓪の記事',                 'fmb-tag-inflow-blog',  NULL, 1),
  ('fmb-route-yt',        'fmb_yt',        '「メルカリ調査員」YouTube',       'fmb-tag-inflow-yt',    NULL, 1),
  ('fmb-route-tt',        'fmb_tt',        '「メルカリ調査員」TikTok',        'fmb-tag-inflow-tt',    NULL, 1),
  ('fmb-route-other',     'fmb_other',     '予備（使う人が LINE導線担当に申し出る）', 'fmb-tag-inflow-other', NULL, 1),
  ('fmb-route-test',      'fmb_test',      '本番の確認用（テスト用アカウントだけ。外に出さない・数から外す）', 'fmb-tag-inflow-test', NULL, 1);
