-- furim_ext_errors の全件削除（案 A・くろさん決定 2026-09-17）。
--
-- ■ これは本番データの削除（#273 でくろさん本人が権限管理課に指示する 4 種類の 1 つ）。LHarness課・統括は実行しない。
-- ■ 理由（くろさん）: 「データが見にくいから一度全部削除していい」
-- ■ 作成: LHarness課（本番は読み取りのみ）。作成時点 2026-09-17 18:06 JST の件数:
--     sheet               2,773 件（2026-01-01〜2026-09-14・旧 GAS のエラーシートからの取り込み）
--     getKeyCodeSet           8 件（2026-09-13〜2026-09-16・拡張のキーコード認証）
--     stackExecutionData      3 件（2026-09-16・拡張の自動化処理履歴の送信）
--     collectSkip・botHandler・aiChatHowto・updateCopyCredit（Worker 側の監視の記録など）  0 件
--     合計 2,784 件
--
-- ■ 消えるものの内訳（実行の直前に下の 1) で必ず確認する）
--   - 拡張の記録: getKeyCodeSet（キーコード認証で弾かれた）・stackExecutionData（処理履歴の送信で会員が見つからない）・updateCopyCredit
--   - シートからの取り込み: sheet（呼び出し元が分からない過去分）
--   - Worker 側の監視の記録（2026-09-17 から入り始めた）: collectSkip（巡回キューの取りこぼし）・botHandler（LINE bot の処理失敗）・
--     aiChatHowto（AI チャットの説明書取得失敗）。作成時点では 0 件だが、実行までに入っていればこれも消える
--
-- ■ 消したあとに起きること
--   - トップの異常区画「拡張のエラー（直近 24 時間）」と「巡回キューの取りこぼし」は、次の記録が入るまで出なくなる
--   - データ区画の「拡張エラー」は空になる
--   - 注意: sheet-backfill の errors（POST /api/furim/backfill-sheets の Error シート）を流し直すと、sheet の過去分が戻る。流し直さないこと
--
-- ── 1) 実行前の確認（method 別の件数） ─────────────────────────────
--   SELECT method, COUNT(*) AS n, MIN(created_at) AS first_at, MAX(created_at) AS last_at FROM furim_ext_errors GROUP BY method ORDER BY n DESC;
--   → 作成時点の期待値: sheet 2773 / getKeyCodeSet 8 / stackExecutionData 3。
--     getKeyCodeSet・stackExecutionData は拡張の利用で増えることがある（増えていても実行してよい）。
--     collectSkip・botHandler・aiChatHowto の行が出ていたら、その件数を記録してから実行する（消える Worker 側の監視の記録）
--   SELECT COUNT(*) FROM furim_ext_errors;   -- 期待値 2784 前後
--
-- ── 2) 記録してから削除（件数は削除の直前に数える） ─────────────────────
INSERT INTO furim_ops_log (id, acted_at, actor, action, target, target_count, goal, note)
SELECT '0917e001-0000-4000-8000-000000000001', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', '権限管理課', 'delete_all', 'furim_ext_errors',
       (SELECT COUNT(*) FROM furim_ext_errors), NULL,
       'くろさん指示「データが見にくいから一度全部削除していい」（案 A・全件）。内訳: ' ||
       COALESCE((SELECT GROUP_CONCAT(method || ' ' || n, '・') FROM (SELECT method, COUNT(*) AS n FROM furim_ext_errors GROUP BY method ORDER BY n DESC)), 'なし');

DELETE FROM furim_ext_errors;

-- ── 3) 実行後の確認 ────────────────────────────────────────────────
--   SELECT COUNT(*) FROM furim_ext_errors;   -- 期待値 0（実行の直後に拡張やWorkerが新しく書いた行があれば、その数だけ。created_at が実行時刻より後であることを確認）
--   SELECT target_count, note FROM furim_ops_log WHERE id = '0917e001-0000-4000-8000-000000000001';   -- 1) で数えた合計と method 別の内訳と同じ
