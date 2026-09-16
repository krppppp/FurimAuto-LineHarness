-- Capsec #288: 手で片づけたプラン変更を「監視の対象外」にする（権限管理課が本番 D1 で実行）。
--
-- 対象: PB-CF0DAF（澁谷太郎さん・2026-09-11 19:10 のダウングレード）
-- 経緯: Worker の処理が途中で落ちたため、2026-09-13 に秘書が Stripe CLI で手で適用した（#240 の案 A）。
--       Stripe には 10/14 の更新で m_full に切り替わる予約が入り、キーコード pb_pkjozeqe も再発行・送信済み。
--       intent の行だけが used_at 空・stage=watch:alert:未処理 のまま残り、異常区画に出続けている。
--
-- なぜ used_at を埋めないか: used_at は「Worker がこの intent を処理した」という意味の列で、
-- 手で直したことを表せない。stage に manual: 接頭語で入れると、監視（plan-change-watch）が
-- 取得段階で除外する（stage NOT LIKE 'manual:%'）。
--
-- 実行前の確認:
--   SELECT id, used_at, stage, notified_at FROM plan_builder_intents WHERE id = 'PB-CF0DAF';
--   → used_at が NULL、stage が 'watch:alert:未処理（used_at なし）' であること
UPDATE plan_builder_intents
SET stage = 'manual:applied:2026-09-13 秘書が Stripe CLI で適用（#240 案A）',
    updated_at = '2026-09-16T23:00:00.000+09:00'
WHERE id = 'PB-CF0DAF';

-- 実行後の期待値:
--   SELECT id, used_at, stage FROM plan_builder_intents WHERE id = 'PB-CF0DAF';
--   → 1 行、used_at は NULL のまま、stage が 'manual:applied:2026-09-13 …' に変わっている
--   → 次の cron から監視の対象外になり、トップの異常区画からも消える
