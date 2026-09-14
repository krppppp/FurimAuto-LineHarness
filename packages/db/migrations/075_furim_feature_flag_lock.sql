-- FurimAuto #261 案 A（2026-09-14）: 機能フラグの固定マーク。locked=1 の機能は手動（管理画面）以外の自動書き込み
-- （決済時の再計算・解約・legacy-keywords・trial-promo・試用系ボタン・シート取り込み）で上書きしない。
-- source は既存の promo 判定・取り込み元の記録に使われているので触らず、列を分ける。
ALTER TABLE furim_feature_flags ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
