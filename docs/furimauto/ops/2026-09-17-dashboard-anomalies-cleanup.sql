-- Capsec #289 / #295 / #288: トップの異常区画に残っているものを原因ごと片づける（権限管理課が本番 D1 で実行）。
--
-- くろさんの指示（2026-09-17）: 「確認済み」で隠すのではなく解消する。
-- 作成: LHarness課（本番は読み取りのみで作成。書き込みはしていない）。作成時点 2026-09-17 16:00 JST。
--
-- ■ 実行の順番（重要）
--   A. 先にデプロイ: 38b4ece（未返信の判定）と、このファイルと同じコミット（監視・差分・広告 CV・初回課金の直し）
--   B. そのあと、このファイルの 1〜4 を上から流す。5 は SQL なし（理由は 5 の節）
--   デプロイ前に 3 を流すと、次のシート突き合わせ（旧コード）が同じ差分を新しい行として作り直す。
--   デプロイ前に 4 を流すと、旧コードは status <> 'sent' を数えるので異常区画から消えない。
--
-- ■ どの文も id を 1 件ずつ指定する。範囲での一括更新はしない。
-- ■ どれも顧客には何も届かない（返金・一斉配信・本番削除・会員のプラン/請求変更のいずれにも当たらない）。


-- ════════════════════════════════════════════════════════════════════
-- 1. 未返信 → 全部「解決済」（Capsec #295・くろさん「未返信は今 0 だから全部解決済に」）
-- ════════════════════════════════════════════════════════════════════
--
-- ■ 対象の絞り方: 判定の修正（38b4ece）のあとに残る 39 件だけを friend_id で列挙する。
--   全件（修正前の 164 件）にしない理由:
--   - 残り 125 件はリッチメニュー・ボタンの押下だけで、修正後は未返信に出ない。解決済みにしても画面は変わらず、
--     chats 行を作る対象が増えるだけ
--   - 対象を固定すれば、実行前・実行後の期待値がぶれない
-- ■ 取りこぼし防止: 一覧を作ったあとに顧客が新しく発言した友だちは、各文の NOT EXISTS で自動的に飛ばす
--   （くろさんがまだ見ていない新着を、黙って解決済みにしないため）。押下だけでも飛ばすので、飛ばした分は件数で報告する。
-- ■ 解決済みにしても顧客には何も届かない。顧客が次に発言すると webhook が unread に戻す。
-- ■ 書き方は管理画面の「解決済」（routes/chats.ts の resolveOrCreateChat + updateChat）と同じ:
--   - chats 行がある 31 件 → その行の status を resolved に
--   - chats 行が無い 8 件 → status='resolved' の行を作る（last_message_at は messages_log の最終時刻）
--
-- ── 実行前の確認 ────────────────────────────────────────────────
-- 1) 行がある 31 件が、まだ未解決であること（期待値 31）
--   SELECT COUNT(*) FROM chats WHERE status != 'resolved' AND id IN (
--     'ed7a6be4-ccef-40f7-9a07-ca9b03f50e35','79f881ea-d1a8-40d8-95d0-e84c5fcdd67b','10d1c85f-b331-43f6-b9e9-f10e3c6ee735',
--     '8dadfc78-0bf0-4c49-88c5-faf1504afb3b','d906d6a4-7ae3-41e5-83de-2b365fcc4637','00e6ed80-60b8-4ac4-8cd4-df226c24a1f4',
--     '69a8465c-8696-4d49-8a42-7931f78aa3f2','98af48d9-6a63-49f9-9db5-99affb67eb7f','ec3228c9-7929-4f3e-a29e-6b97edf6df6e',
--     '0dbbb2fd-d2d8-414b-afaa-33101c68d271','0969abb0-a149-4869-8ef5-e2fc48a1271f','30efecb2-07c3-4d4c-869e-2d214ef7bc84',
--     '9af04e86-b1ba-4f8b-bcb4-e0b472710307','e56e41b9-bf42-4884-8eca-4c12d46b6b43','3f347ed568f29bfd5dc66cd83f387cfe',
--     '7118d9dc-ec2d-43a6-bf1c-e2652311a485','8c6c41bb-95de-42ed-a80b-36974d457fff','65a9be2a-bafe-494e-8e29-2f2382ccf4a0',
--     'f0929f73-7fba-49f4-b64a-8b0acd33a4b3','a75bec14bb514596e51f1b287e182992','ca29341e-680a-46e5-97e2-cf0917d23de0',
--     'c95538b0-d19f-42b3-b914-db5995ee2ebd','d8db43c5-0bcc-4845-aeb3-62bb80cc3b91','85fa1f50-e12a-48f5-9077-f1fe45c0580f',
--     '6c612a37-d2a7-4513-9c9d-755fbd02a101','c52d8baa-cb37-49ec-a8c5-e368df84fd90','92e4e0be-ef87-466c-ac6e-84aa4873763a',
--     '62d73f25-3e14-4b34-b82c-965130afa1e9','b7284127-cce6-4829-9940-96cba71a75d1','1231462c-6229-4131-85de-764f897451ea',
--     '89383f19-012e-48a4-99b8-061ffc4e73d3');
-- 2) 行が無い 8 件に、まだ chats 行が無いこと（期待値 0）
--   SELECT COUNT(*) FROM chats WHERE friend_id IN (
--     '9fa4585f-4d2d-4cef-bbc3-3dc78661b6c3','c2160fd7-37db-4547-8d84-14249930edd4','32c95222-b50a-45dc-9a15-6f0e8c35d1da',
--     'fc7ff2d2-dfeb-40b6-8fe3-c4404042e7a0','75f48792-bc50-4331-900a-33a1a8f1a757','52653693-5cdf-45be-a4b7-49d700ed10a9',
--     '8a6c225d-74ae-4d45-b471-5db511964d4a','91b14aec-a9bf-46e9-8d08-4f1cfb3915bc');
-- 3) 一覧作成後の新着があるか（期待値 0 行。行が出た友だちは下の文で自動的に飛ばされる。件数を統括に報告）
--   SELECT m.friend_id, COUNT(*) FROM messages_log m WHERE m.direction = 'incoming' AND m.created_at > '2026-09-17T15:31:52'
--   GROUP BY m.friend_id;
--   ※ 一覧の中で最も新しい発言は もちを さんの 2026-09-17T14:40:16。それ以降の受信があれば、その友だちが一覧に含まれるかを見る

-- ── 1-a. chats 行がある 31 件を resolved に ─────────────────────────
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = 'ed7a6be4-ccef-40f7-9a07-ca9b03f50e35' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '067c2e67-1c25-4b59-bf6b-8eb55dc3650e' AND direction = 'incoming' AND created_at > '2026-07-19T22:19:40.902+09:00');  -- さいとう えつこ
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '79f881ea-d1a8-40d8-95d0-e84c5fcdd67b' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '354310ff-237f-4cef-8a27-4520057ed752' AND direction = 'incoming' AND created_at > '2026-08-25T08:52:25.165+09:00');  -- みお
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '10d1c85f-b331-43f6-b9e9-f10e3c6ee735' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '54d42104-d1b9-4da4-8d2a-2c2fef5b467f' AND direction = 'incoming' AND created_at > '2026-09-05T12:18:05.736+09:00');  -- 今井貴幹
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '8dadfc78-0bf0-4c49-88c5-faf1504afb3b' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'bd96079c-11e7-4269-a671-17f08940c33f' AND direction = 'incoming' AND created_at > '2026-09-04T14:01:55.152+09:00');  -- Keishirou Naruse
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = 'd906d6a4-7ae3-41e5-83de-2b365fcc4637' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '776fa598-d929-449a-b48d-d9ce4c8404f6' AND direction = 'incoming' AND created_at > '2026-08-10T21:48:38.240+09:00');  -- しもかわ
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '00e6ed80-60b8-4ac4-8cd4-df226c24a1f4' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '62749a15-1110-423b-a4c3-efb0734c1850' AND direction = 'incoming' AND created_at > '2026-08-16T22:04:44.994+09:00');  -- ウマっち
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '69a8465c-8696-4d49-8a42-7931f78aa3f2' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'cd863727-99fc-4e97-9573-0dcc7f7a00c8' AND direction = 'incoming' AND created_at > '2026-08-18T17:31:21.495+09:00');  -- NakaRyu
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '98af48d9-6a63-49f9-9db5-99affb67eb7f' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'cf0f3537-b224-4640-890a-70313d23e9fe' AND direction = 'incoming' AND created_at > '2026-09-15T08:03:36.526+09:00');  -- あかね
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = 'ec3228c9-7929-4f3e-a29e-6b97edf6df6e' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '24073f62-a124-4bc5-b1f5-e294072124a9' AND direction = 'incoming' AND created_at > '2026-08-21T13:10:15.065+09:00');  -- もえみ
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '0dbbb2fd-d2d8-414b-afaa-33101c68d271' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '7c97c335-e3a6-49c3-9bc3-ba6abf4dab89' AND direction = 'incoming' AND created_at > '2026-08-24T13:20:23.795+09:00');  -- 糠澤智子
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '0969abb0-a149-4869-8ef5-e2fc48a1271f' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '3477d26b-08ad-4944-b0ad-951e095fc802' AND direction = 'incoming' AND created_at > '2026-08-27T11:45:55.385+09:00');  -- Mz
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '30efecb2-07c3-4d4c-869e-2d214ef7bc84' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '7b11d2a9-88b0-4dc6-8ad6-879201a0e3f3' AND direction = 'incoming' AND created_at > '2026-08-27T16:59:00.209+09:00');  -- やまざき
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '9af04e86-b1ba-4f8b-bcb4-e0b472710307' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '47ed2cc2-ab61-43f5-9db4-4cf2e1daa5fa' AND direction = 'incoming' AND created_at > '2026-08-30T20:22:22.054+09:00');  -- 洋子
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = 'e56e41b9-bf42-4884-8eca-4c12d46b6b43' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '07d2c9a9-952b-4ff2-90c0-b7491d74fc91' AND direction = 'incoming' AND created_at > '2026-08-31T21:05:29.520+09:00');  -- 馬場優二
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '3f347ed568f29bfd5dc66cd83f387cfe' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'c6ada4f7-8631-40e0-9689-95675b811890' AND direction = 'incoming' AND created_at > '2026-09-01T15:17:16.048+09:00');  -- アリス
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '7118d9dc-ec2d-43a6-bf1c-e2652311a485' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '95da2c07-0f57-4bf5-81bd-86664e5fc171' AND direction = 'incoming' AND created_at > '2026-09-01T18:02:41.583+09:00');  -- 小倉亜希子
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '8c6c41bb-95de-42ed-a80b-36974d457fff' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'ef932123-cd97-4870-86ef-772f388a78cb' AND direction = 'incoming' AND created_at > '2026-09-14T21:24:36.114+09:00');  -- YUKI
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '65a9be2a-bafe-494e-8e29-2f2382ccf4a0' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'd89949d8-7cc9-4862-b0ff-32f2088d85f8' AND direction = 'incoming' AND created_at > '2026-09-08T10:34:18.869+09:00');  -- Sonkouki
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = 'f0929f73-7fba-49f4-b64a-8b0acd33a4b3' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'ae54f95f-d3d9-4c96-81ca-1e30d596430b' AND direction = 'incoming' AND created_at > '2026-09-08T10:36:57.265+09:00');  -- Asuka.H
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = 'a75bec14bb514596e51f1b287e182992' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'd8525c3f-999b-42a2-a744-aec9b3a4ca38' AND direction = 'incoming' AND created_at > '2026-09-08T21:30:11.583+09:00');  -- EY
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = 'ca29341e-680a-46e5-97e2-cf0917d23de0' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '8fdfde6f-cec1-4bb6-8f18-320df3924840' AND direction = 'incoming' AND created_at > '2026-09-11T22:40:58.849+09:00');  -- N
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = 'c95538b0-d19f-42b3-b914-db5995ee2ebd' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '3f0e57f7-31f5-4898-b257-7f18324e8cd0' AND direction = 'incoming' AND created_at > '2026-09-15T16:30:30.025+09:00');  -- 山田耕司
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = 'd8db43c5-0bcc-4845-aeb3-62bb80cc3b91' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '50d16780-e08d-4c70-8678-62a00072d81b' AND direction = 'incoming' AND created_at > '2026-09-16T22:21:06.695+09:00');  -- 森茂育栄
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '85fa1f50-e12a-48f5-9077-f1fe45c0580f' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '690bfd7f-0927-464e-a5f9-8076e981b525' AND direction = 'incoming' AND created_at > '2026-09-14T19:14:31.547+09:00');  -- 中園
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '6c612a37-d2a7-4513-9c9d-755fbd02a101' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '064907de-ae17-4146-8796-4f2f912175ca' AND direction = 'incoming' AND created_at > '2026-09-15T10:48:42.078+09:00');  -- D りょうすけ
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = 'c52d8baa-cb37-49ec-a8c5-e368df84fd90' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '2de0d12f-cbea-40c7-a986-2e13980b27bb' AND direction = 'incoming' AND created_at > '2026-09-15T12:26:25.539+09:00');  -- 楓太朗
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '92e4e0be-ef87-466c-ac6e-84aa4873763a' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'cd84e9f4-1c4e-4a00-8d81-07cd3539593b' AND direction = 'incoming' AND created_at > '2026-09-16T09:57:08.807+09:00');  -- miyuu
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '62d73f25-3e14-4b34-b82c-965130afa1e9' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '43d83399-e20f-4774-8abd-ea4a0a1afb9e' AND direction = 'incoming' AND created_at > '2026-09-15T20:28:38.251+09:00');  -- よっしー
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = 'b7284127-cce6-4829-9940-96cba71a75d1' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '48bc5464-3fae-4c4d-90ea-217ab179878c' AND direction = 'incoming' AND created_at > '2026-09-15T23:22:39.041+09:00');  -- くり
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '1231462c-6229-4131-85de-764f897451ea' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'ff27176a-454a-4c28-9af4-8291c56af69d' AND direction = 'incoming' AND created_at > '2026-09-17T14:40:16.538+09:00');  -- もちを
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '89383f19-012e-48a4-99b8-061ffc4e73d3' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'e25671ff-42e3-4898-9e10-a5f384250655' AND direction = 'incoming' AND created_at > '2026-09-17T10:21:48.486+09:00');  -- 佐藤　博治

-- ── 1-b. chats 行が無い 8 件は resolved の行を作る ───────────────────
INSERT OR IGNORE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
SELECT 'c1a0e2b4-5d6f-4a7b-8c9d-0e1f2a3b4c01', '9fa4585f-4d2d-4cef-bbc3-3dc78661b6c3', 'resolved',
       (SELECT MAX(created_at) FROM messages_log WHERE friend_id = '9fa4585f-4d2d-4cef-bbc3-3dc78661b6c3' AND (delivery_type IS NULL OR delivery_type != 'test')),
       strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = '9fa4585f-4d2d-4cef-bbc3-3dc78661b6c3')
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '9fa4585f-4d2d-4cef-bbc3-3dc78661b6c3' AND direction = 'incoming' AND created_at > '2026-07-27T21:16:42.270+09:00');  -- 水越 潤
INSERT OR IGNORE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
SELECT 'c1a0e2b4-5d6f-4a7b-8c9d-0e1f2a3b4c02', 'c2160fd7-37db-4547-8d84-14249930edd4', 'resolved',
       (SELECT MAX(created_at) FROM messages_log WHERE friend_id = 'c2160fd7-37db-4547-8d84-14249930edd4' AND (delivery_type IS NULL OR delivery_type != 'test')),
       strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = 'c2160fd7-37db-4547-8d84-14249930edd4')
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'c2160fd7-37db-4547-8d84-14249930edd4' AND direction = 'incoming' AND created_at > '2026-07-22T12:56:13.564+09:00');  -- めぐみ
INSERT OR IGNORE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
SELECT 'c1a0e2b4-5d6f-4a7b-8c9d-0e1f2a3b4c03', '32c95222-b50a-45dc-9a15-6f0e8c35d1da', 'resolved',
       (SELECT MAX(created_at) FROM messages_log WHERE friend_id = '32c95222-b50a-45dc-9a15-6f0e8c35d1da' AND (delivery_type IS NULL OR delivery_type != 'test')),
       strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = '32c95222-b50a-45dc-9a15-6f0e8c35d1da')
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '32c95222-b50a-45dc-9a15-6f0e8c35d1da' AND direction = 'incoming' AND created_at > '2026-08-18T11:16:19.484+09:00');  -- n
INSERT OR IGNORE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
SELECT 'c1a0e2b4-5d6f-4a7b-8c9d-0e1f2a3b4c04', 'fc7ff2d2-dfeb-40b6-8fe3-c4404042e7a0', 'resolved',
       (SELECT MAX(created_at) FROM messages_log WHERE friend_id = 'fc7ff2d2-dfeb-40b6-8fe3-c4404042e7a0' AND (delivery_type IS NULL OR delivery_type != 'test')),
       strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = 'fc7ff2d2-dfeb-40b6-8fe3-c4404042e7a0')
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'fc7ff2d2-dfeb-40b6-8fe3-c4404042e7a0' AND direction = 'incoming' AND created_at > '2026-08-30T15:31:10.874+09:00');  -- 恵里菜
INSERT OR IGNORE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
SELECT 'c1a0e2b4-5d6f-4a7b-8c9d-0e1f2a3b4c05', '75f48792-bc50-4331-900a-33a1a8f1a757', 'resolved',
       (SELECT MAX(created_at) FROM messages_log WHERE friend_id = '75f48792-bc50-4331-900a-33a1a8f1a757' AND (delivery_type IS NULL OR delivery_type != 'test')),
       strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = '75f48792-bc50-4331-900a-33a1a8f1a757')
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '75f48792-bc50-4331-900a-33a1a8f1a757' AND direction = 'incoming' AND created_at > '2026-09-01T14:17:43.768+09:00');  -- reiko
INSERT OR IGNORE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
SELECT 'c1a0e2b4-5d6f-4a7b-8c9d-0e1f2a3b4c06', '52653693-5cdf-45be-a4b7-49d700ed10a9', 'resolved',
       (SELECT MAX(created_at) FROM messages_log WHERE friend_id = '52653693-5cdf-45be-a4b7-49d700ed10a9' AND (delivery_type IS NULL OR delivery_type != 'test')),
       strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = '52653693-5cdf-45be-a4b7-49d700ed10a9')
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '52653693-5cdf-45be-a4b7-49d700ed10a9' AND direction = 'incoming' AND created_at > '2026-09-01T15:49:54.543+09:00');  -- 南　陽介
INSERT OR IGNORE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
SELECT 'c1a0e2b4-5d6f-4a7b-8c9d-0e1f2a3b4c07', '8a6c225d-74ae-4d45-b471-5db511964d4a', 'resolved',
       (SELECT MAX(created_at) FROM messages_log WHERE friend_id = '8a6c225d-74ae-4d45-b471-5db511964d4a' AND (delivery_type IS NULL OR delivery_type != 'test')),
       strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = '8a6c225d-74ae-4d45-b471-5db511964d4a')
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '8a6c225d-74ae-4d45-b471-5db511964d4a' AND direction = 'incoming' AND created_at > '2026-09-16T09:46:42.593+09:00');  -- Yocchi
INSERT OR IGNORE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
SELECT 'c1a0e2b4-5d6f-4a7b-8c9d-0e1f2a3b4c08', '91b14aec-a9bf-46e9-8d08-4f1cfb3915bc', 'resolved',
       (SELECT MAX(created_at) FROM messages_log WHERE friend_id = '91b14aec-a9bf-46e9-8d08-4f1cfb3915bc' AND (delivery_type IS NULL OR delivery_type != 'test')),
       strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = '91b14aec-a9bf-46e9-8d08-4f1cfb3915bc')
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '91b14aec-a9bf-46e9-8d08-4f1cfb3915bc' AND direction = 'incoming' AND created_at > '2026-09-16T16:32:36.987+09:00');  -- TANAKAmium

-- ── 1-c. #300 の判定（bot の送信記録が無い押下は未返信に残す）で新たに出る 7 件 ─────
-- #300 のコミットでは、bot に回る押下でも 60 秒以内に bot の送信記録（失敗の案内を除く）が無ければ未返信に残す。
-- 本番で再現すると、過去に bot が返せなかった押下の 7 人が未返信に戻る（8/2〜9/12。#300 の GAS 打ち切りや #299 のエラー）。
-- くろさんの「全部解決済」に含める。#300 のデプロイより前に流しても後に流しても結果は同じ（解決済みの友だちは判定の対象外）。
-- 実行前の確認: SELECT friend_id, status FROM chats WHERE friend_id IN ('c28683b3-331f-46a7-9487-94d846f7498b','5255275b-6011-4084-b5e7-147f0d206318','66f2aa77-959c-43e4-8544-02a103e7ea67','a9b8e5f7-0666-49e4-8a2e-c3af53ac69de','b2ab1365-4e17-41e6-9c77-bd092b0e81ed','e6e88056-65b1-42b1-acb6-181aff7e2b3f','f33b27aa-2877-4cd3-9968-a191b76c6ddf');
--   → 1 行（c28683b3… の in_progress）だけ
UPDATE chats SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = '46a38369-3811-46b0-baf7-1fe95a66f0f4' AND status != 'resolved'
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'c28683b3-331f-46a7-9487-94d846f7498b' AND direction = 'incoming' AND created_at > '2026-09-12T01:38:28.733+09:00');  -- 友紀
INSERT OR IGNORE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
SELECT 'c1a0e2b4-5d6f-4a7b-8c9d-0e1f2a3b4c09', '5255275b-6011-4084-b5e7-147f0d206318', 'resolved',
       (SELECT MAX(created_at) FROM messages_log WHERE friend_id = '5255275b-6011-4084-b5e7-147f0d206318' AND (delivery_type IS NULL OR delivery_type != 'test')),
       strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = '5255275b-6011-4084-b5e7-147f0d206318')
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '5255275b-6011-4084-b5e7-147f0d206318' AND direction = 'incoming' AND created_at > '2026-09-12T01:53:15.851+09:00');  -- みのる
INSERT OR IGNORE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
SELECT 'c1a0e2b4-5d6f-4a7b-8c9d-0e1f2a3b4c10', '66f2aa77-959c-43e4-8544-02a103e7ea67', 'resolved',
       (SELECT MAX(created_at) FROM messages_log WHERE friend_id = '66f2aa77-959c-43e4-8544-02a103e7ea67' AND (delivery_type IS NULL OR delivery_type != 'test')),
       strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = '66f2aa77-959c-43e4-8544-02a103e7ea67')
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = '66f2aa77-959c-43e4-8544-02a103e7ea67' AND direction = 'incoming' AND created_at > '2026-09-13T15:06:07.526+09:00');  -- めぐみ（66f2aa77）
INSERT OR IGNORE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
SELECT 'c1a0e2b4-5d6f-4a7b-8c9d-0e1f2a3b4c11', 'a9b8e5f7-0666-49e4-8a2e-c3af53ac69de', 'resolved',
       (SELECT MAX(created_at) FROM messages_log WHERE friend_id = 'a9b8e5f7-0666-49e4-8a2e-c3af53ac69de' AND (delivery_type IS NULL OR delivery_type != 'test')),
       strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = 'a9b8e5f7-0666-49e4-8a2e-c3af53ac69de')
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'a9b8e5f7-0666-49e4-8a2e-c3af53ac69de' AND direction = 'incoming' AND created_at > '2026-09-15T10:33:42.227+09:00');  -- Keishi/なるやん
INSERT OR IGNORE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
SELECT 'c1a0e2b4-5d6f-4a7b-8c9d-0e1f2a3b4c12', 'b2ab1365-4e17-41e6-9c77-bd092b0e81ed', 'resolved',
       (SELECT MAX(created_at) FROM messages_log WHERE friend_id = 'b2ab1365-4e17-41e6-9c77-bd092b0e81ed' AND (delivery_type IS NULL OR delivery_type != 'test')),
       strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = 'b2ab1365-4e17-41e6-9c77-bd092b0e81ed')
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'b2ab1365-4e17-41e6-9c77-bd092b0e81ed' AND direction = 'incoming' AND created_at > '2026-09-03T09:38:02.652+09:00');  -- けんた
INSERT OR IGNORE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
SELECT 'c1a0e2b4-5d6f-4a7b-8c9d-0e1f2a3b4c13', 'e6e88056-65b1-42b1-acb6-181aff7e2b3f', 'resolved',
       (SELECT MAX(created_at) FROM messages_log WHERE friend_id = 'e6e88056-65b1-42b1-acb6-181aff7e2b3f' AND (delivery_type IS NULL OR delivery_type != 'test')),
       strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = 'e6e88056-65b1-42b1-acb6-181aff7e2b3f')
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'e6e88056-65b1-42b1-acb6-181aff7e2b3f' AND direction = 'incoming' AND created_at > '2026-08-21T12:49:31.800+09:00');  -- Syun Shiratori
INSERT OR IGNORE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
SELECT 'c1a0e2b4-5d6f-4a7b-8c9d-0e1f2a3b4c14', 'f33b27aa-2877-4cd3-9968-a191b76c6ddf', 'resolved',
       (SELECT MAX(created_at) FROM messages_log WHERE friend_id = 'f33b27aa-2877-4cd3-9968-a191b76c6ddf' AND (delivery_type IS NULL OR delivery_type != 'test')),
       strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = 'f33b27aa-2877-4cd3-9968-a191b76c6ddf')
  AND NOT EXISTS (SELECT 1 FROM messages_log WHERE friend_id = 'f33b27aa-2877-4cd3-9968-a191b76c6ddf' AND direction = 'incoming' AND created_at > '2026-08-27T11:22:12.500+09:00');  -- 真央

INSERT INTO furim_ops_log (id, acted_at, actor, action, target, target_count, goal, note)
VALUES ('0917a001-0000-4000-8000-000000000005', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', '権限管理課', 'mark_resolved', 'chats', 7, 'Capsec #300',
        '#300 の判定（bot の送信記録が無い押下は未返信に残す）で新たに未返信に戻る 7 件（過去の bot の無返信・エラー）を、くろさんの「全部解決済」に含めて解決済みに');

INSERT INTO furim_ops_log (id, acted_at, actor, action, target, target_count, goal, note)
VALUES ('0917a001-0000-4000-8000-000000000001', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', '権限管理課', 'mark_resolved', 'chats', 39, 'Capsec #295',
        'くろさん指示「未返信は今 0 だから全部解決済に」。判定の修正（38b4ece）後に残る 39 件を friend_id 指定で解決済みに（行あり 31 更新・行なし 8 作成）。一覧作成後に新着があった友だちは除外');

-- ── 実行後の期待値 ──────────────────────────────────────────────
-- SELECT COUNT(*) FROM chats WHERE status = 'resolved' AND friend_id IN (
--   '067c2e67-1c25-4b59-bf6b-8eb55dc3650e','9fa4585f-4d2d-4cef-bbc3-3dc78661b6c3','354310ff-237f-4cef-8a27-4520057ed752',
--   'c2160fd7-37db-4547-8d84-14249930edd4','54d42104-d1b9-4da4-8d2a-2c2fef5b467f','bd96079c-11e7-4269-a671-17f08940c33f',
--   '776fa598-d929-449a-b48d-d9ce4c8404f6','62749a15-1110-423b-a4c3-efb0734c1850','32c95222-b50a-45dc-9a15-6f0e8c35d1da',
--   'cd863727-99fc-4e97-9573-0dcc7f7a00c8','cf0f3537-b224-4640-890a-70313d23e9fe','24073f62-a124-4bc5-b1f5-e294072124a9',
--   '7c97c335-e3a6-49c3-9bc3-ba6abf4dab89','3477d26b-08ad-4944-b0ad-951e095fc802','7b11d2a9-88b0-4dc6-8ad6-879201a0e3f3',
--   'fc7ff2d2-dfeb-40b6-8fe3-c4404042e7a0','47ed2cc2-ab61-43f5-9db4-4cf2e1daa5fa','07d2c9a9-952b-4ff2-90c0-b7491d74fc91',
--   '75f48792-bc50-4331-900a-33a1a8f1a757','c6ada4f7-8631-40e0-9689-95675b811890','52653693-5cdf-45be-a4b7-49d700ed10a9',
--   '95da2c07-0f57-4bf5-81bd-86664e5fc171','ef932123-cd97-4870-86ef-772f388a78cb','d89949d8-7cc9-4862-b0ff-32f2088d85f8',
--   'ae54f95f-d3d9-4c96-81ca-1e30d596430b','d8525c3f-999b-42a2-a744-aec9b3a4ca38','8fdfde6f-cec1-4bb6-8f18-320df3924840',
--   '3f0e57f7-31f5-4898-b257-7f18324e8cd0','50d16780-e08d-4c70-8678-62a00072d81b','690bfd7f-0927-464e-a5f9-8076e981b525',
--   '064907de-ae17-4146-8796-4f2f912175ca','2de0d12f-cbea-40c7-a986-2e13980b27bb','cd84e9f4-1c4e-4a00-8d81-07cd3539593b',
--   '43d83399-e20f-4774-8abd-ea4a0a1afb9e','48bc5464-3fae-4c4d-90ea-217ab179878c','8a6c225d-74ae-4d45-b471-5db511964d4a',
--   'ff27176a-454a-4c28-9af4-8291c56af69d','91b14aec-a9bf-46e9-8d08-4f1cfb3915bc','e25671ff-42e3-4898-9e10-a5f384250655');
-- → 39（一覧作成後に新着があって飛ばした友だちがいれば、その数だけ少ない）
-- トップの異常区画から「未返信 N 件」が消え、チャット画面の「未対応のみ」も 0 件になる（新着分を除く）


-- ════════════════════════════════════════════════════════════════════
-- 2. PB-321DC7（ウツミさん）の未反映の警告を外す（Capsec #288）
-- ════════════════════════════════════════════════════════════════════
--
-- ■ 誤検知の中身: 9/15 07:41 の PB-321DC7（upgrade）を、4 分後の PB-6E70D0 が同じサブスク
--   sub_1UFRgXF2C7KcCkFfZQLpVyQj で上書きした。Stripe の今の構成は PB-6E70D0 に合っているので正しい。
-- ■ なぜ 9cead62 の直しで消えなかったか:
--   監視は notified_at が空の intent だけを検査する。PB-321DC7 の警告は 9/15 08:15 に出ていて、
--   9cead62（9/16 22:50）の「上書きされていたら検査しない」を通る前に notified_at が埋まっていた。
--   警告を出した後に上書きされた場合も同じ穴になる。
-- ■ 穴の直し: このファイルと同じコミットで、監視の毎回の見回りに「開いている警告を見直し、上書きが
--   あれば stage を superseded:<新しいコード> にする」処理を足した（plan-change-watch.ts の clearSupersededAlerts）。
--   デプロイ後 5 分以内の cron で、PB-321DC7 は自動で superseded:PB-6E70D0 になる。
--   その場合、下の UPDATE は条件（stage LIKE 'watch:alert:%'）に当たらず 0 行で終わる。どちらでも結果は同じ。
--
-- ── 実行前の確認 ────────────────────────────────────────────────
--   SELECT id, used_at, stage, notified_at FROM plan_builder_intents WHERE id IN ('PB-321DC7', 'PB-6E70D0');
--   → PB-321DC7: stage が 'watch:alert:Stripe の items に新プランが無い（1件不足）' か、デプロイ後なら 'superseded:PB-6E70D0'
--   → PB-6E70D0: used_at あり（2026-09-15T07:45:25）、stage 'replied'
UPDATE plan_builder_intents
SET stage = 'manual:superseded:PB-6E70D0 に上書き済みの誤検知（#288 で確認）',
    updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
WHERE id = 'PB-321DC7' AND stage LIKE 'watch:alert:%';

INSERT INTO furim_ops_log (id, acted_at, actor, action, target, target_count, goal, note)
VALUES ('0917a001-0000-4000-8000-000000000002', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', '権限管理課', 'mark_manual', 'plan_builder_intents', 1, 'Capsec #288',
        'PB-321DC7 は 4 分後の PB-6E70D0 に上書きされた誤検知。警告が 9cead62 より前に出ていたため自動で外れなかった');

-- ── 実行後の期待値 ──────────────────────────────────────────────
--   SELECT COUNT(*) FROM plan_builder_intents WHERE stage LIKE 'watch:alert:%';   -- 期待値 0
--   トップの異常区画から「未反映のプラン変更」が消える


-- ════════════════════════════════════════════════════════════════════
-- 3. シートと D1 の差分 3 件（9/14 10:45〜）→ どれも D1 が正しい。シート側の誤りとして受け入れる
-- ════════════════════════════════════════════════════════════════════
--
-- ■ 判断
--   (a) e21603ef…  Ue4941a0…（あじゃぱー・くろさんのテスト用アカウント）row_missing_in_d1
--       9/14 09:55 のテストリセット（3729a0c・#257）で D1 の行を消した。シートは凍結で消さないので行が残っている。
--       → D1 が正しい（行が無いのが正しい状態）
--   (b) 52e3166e…  Ua238c85…（鈴木明浩・2026-05-21 追加）stripe_customer_id: D1 空・シート cus_SSWEsjgl1UUrXh
--       cus_SSWEsjgl1UUrXh は Stripe の顧客メタデータが lineUserId=U3d122688…（表示名 mz）で、名前も mz さん。
--       D1 でもその顧客は U3d122688… に付いていて、支払い 8 件（〜2025-11-16）も同じ。シートの行に他人の ID が入っている
--       → D1 が正しい
--   (c) 9a47599e…  U47dcda30…（常盤 諒・2025-06-09 追加）stripe_customer_id: D1 空・シート cus_TumHYr79ZtCPtv
--       cus_TumHYr79ZtCPtv は Stripe の顧客名が 鈴木明浩 さんで、購読 sub_1T1RcsF2… のメタデータは
--       lineUserId=Uf8042fb7…（鈴木明浩・2026-02-04 追加）。D1 もその顧客を Uf8042fb7… に付けていて、支払い 4 件（〜2026-05-16）も同じ。
--       顧客のメタデータだけ U47dcda30… を指しているが、名前・購読・支払いの 3 つが Uf8042fb7… で一致する。シートの行が誤り
--       → D1 が正しい（D1 は直さない）
-- ■ 解決の仕方: resolved_at を入れ、notified_at を 'accepted:sheet_side:…' にする。
--   解決済みにするだけだと、シートの値が残る限り次の突き合わせで新しい行として出直す。このファイルと同じコミットで、
--   突き合わせ（customer-sync.ts）が「accepted: の差分と、シートの値が同じもの」を数え直さないようにした。
--   シートの値が変われば、別の差分として出る。
-- ■ 順番: 必ずデプロイの後に流す（前に流すと旧コードが作り直す）。
--
-- ── 実行前の確認 ────────────────────────────────────────────────
--   SELECT id, line_user_id, field, d1_value, sheet_value, notified_at, resolved_at FROM furim_sync_diffs
--   WHERE id IN ('e21603ef-118b-4d4d-8109-e3afc5092d0c', '52e3166e-4c4a-43bb-9081-e130313dc76c', '9a47599e-48f4-44e7-b704-e9bc28143597');
--   → 3 行、resolved_at は NULL、sheet_value が上の (a)(b)(c) と同じ（2weektrial_8jzn5u65 / cus_SSWEsjgl1UUrXh / cus_TumHYr79ZtCPtv）
--   SELECT COUNT(*) FROM furim_sync_diffs WHERE resolved_at IS NULL;   -- 期待値 3（ほかに増えていたら止めて統括に連絡）
UPDATE furim_sync_diffs
SET resolved_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00',
    notified_at = 'accepted:sheet_side:テストリセット後にシートだけ行が残った（あじゃぱー・#257）'
WHERE id = 'e21603ef-118b-4d4d-8109-e3afc5092d0c' AND resolved_at IS NULL AND sheet_value = '2weektrial_8jzn5u65';
UPDATE furim_sync_diffs
SET resolved_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00',
    notified_at = 'accepted:sheet_side:シートに他人（U3d122688 mz）の Stripe 顧客 ID。Stripe メタデータ・支払いで D1 が正しいと確認'
WHERE id = '52e3166e-4c4a-43bb-9081-e130313dc76c' AND resolved_at IS NULL AND sheet_value = 'cus_SSWEsjgl1UUrXh';
UPDATE furim_sync_diffs
SET resolved_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00',
    notified_at = 'accepted:sheet_side:シートに他人（Uf8042fb7 鈴木明浩）の Stripe 顧客 ID。顧客名・購読メタデータ・支払いで D1 が正しいと確認'
WHERE id = '9a47599e-48f4-44e7-b704-e9bc28143597' AND resolved_at IS NULL AND sheet_value = 'cus_TumHYr79ZtCPtv';

INSERT INTO furim_ops_log (id, acted_at, actor, action, target, target_count, goal, note)
VALUES ('0917a001-0000-4000-8000-000000000003', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', '権限管理課', 'accept_sheet_side', 'furim_sync_diffs', 3, 'Capsec #289',
        '差分 3 件はどれも D1 が正しい（テストリセット後のシート残り 1・シートに他人の Stripe 顧客 ID 2）。元の notified_at は 9/14 11:45 と 20:15');

-- ── 実行後の期待値 ──────────────────────────────────────────────
--   SELECT COUNT(*) FROM furim_sync_diffs WHERE resolved_at IS NULL;   -- 期待値 0
--   次のシート突き合わせのあとも 0 のまま（同じ 3 件が作り直されないこと）
--   トップの異常区画から「シートと D1 の差分」が消える


-- ════════════════════════════════════════════════════════════════════
-- 4. 広告 CV 送信の失敗 3 件（8/9〜8/10）→ 送信を諦めた状態（abandoned）にする
-- ════════════════════════════════════════════════════════════════════
--
-- ■ 中身: 3 件とも、くろさんの友だち行（2d7cd532…）に付けたテスト用の架空 gclid
--   （TESTGCLID_MANUAL_0809 / TESTGCLID_DM_0809）。Data Manager API への切り替えを試したときの失敗（旧 API の新規利用制限・
--   API 未有効・event_source 欠落）。実在のクリックではないので、何度送っても成立しない。
-- ■ アップロード期限: Google 広告のオフライン CV は、クリックから 90 日以内にアップロードしないと取り込まれない
--   （Google 広告ヘルプ「Set up offline conversions using Google Click ID (GCLID)」）。8/9 のクリックなら 11/7 が期限で、
--   日数の上ではまだ間に合うが、上のとおり架空の gclid なので期限とは関係なく送らない。
-- ■ 9 月以降の再発: なし。9 月の広告 CV は 6 件すべて sent（実在の gclid）。失敗は上の 3 件だけ。
-- ■ status は制約なしの TEXT。送信処理（services/ad-conversion.ts）は 'sent' / 'failed' しか書かず、'sent' 以外を再送しないので、
--   'abandoned' にしても再送は起きない。異常区画の集計は、このファイルと同じコミットで status IN ('failed', 'pending') に変えた。
--
-- ── 実行前の確認 ────────────────────────────────────────────────
--   SELECT id, click_id, status, created_at FROM ad_conversion_logs WHERE status <> 'sent';
--   → 3 行（下の id）、click_id がすべて TESTGCLID_ で始まる
UPDATE ad_conversion_logs SET status = 'abandoned'
WHERE id = '0d4bfbf3-0234-41ae-8e37-075967fed942' AND status = 'failed' AND click_id = 'TESTGCLID_MANUAL_0809';
UPDATE ad_conversion_logs SET status = 'abandoned'
WHERE id = '59513be5-0322-401a-8532-c302d65d5df8' AND status = 'failed' AND click_id = 'TESTGCLID_DM_0809';
UPDATE ad_conversion_logs SET status = 'abandoned'
WHERE id = '18f9dbc7-c880-44f3-a72a-dd5675970ac5' AND status = 'failed' AND click_id = 'TESTGCLID_DM_0809';

INSERT INTO furim_ops_log (id, acted_at, actor, action, target, target_count, goal, note)
VALUES ('0917a001-0000-4000-8000-000000000004', strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00', '権限管理課', 'mark_abandoned', 'ad_conversion_logs', 3, 'Capsec #289',
        '8/9〜8/10 の Data Manager API 切り替え試験で付けた架空の gclid（TESTGCLID_*）。実在のクリックではないため送信を諦める。9 月以降の再発なし');

-- ── 実行後の期待値 ──────────────────────────────────────────────
--   SELECT status, COUNT(*) FROM ad_conversion_logs GROUP BY status;   -- abandoned 3・sent 13（作成時点）・failed なし
--   トップの異常区画から「広告 CV 送信の失敗」が消える（デプロイ後）


-- ════════════════════════════════════════════════════════════════════
-- 5. 初回課金を特定できない 12 人 → 埋め戻す SQL は無い（dryRun で 0 行）。数え方をコードで直した
-- ════════════════════════════════════════════════════════════════════
--
-- ■ dryRun の結果（Stripe は読み取りのみ・2026-09-17 16:00）
--   - 12 人の D1 の行は 285 件。Stripe の請求 285 件と 1 件ずつ突き合わせて、billing_reason の食い違い 0・金額の食い違い 0
--   - furim_payments 全 2,961 行で billing_reason が空の行は 0（異常区画の「billing_reason が空の古い行」という説明が誤っていた）
--   - 12 人は全員、2023-05〜2024-02 に Stripe の無料試用付きで契約していた。最初の請求（subscription_create）は 0 円で
--     D1 には入っておらず（0 円の請求は取り込み対象外）、初めての入金は 1 週間後の subscription_cycle だった
--     例: cus_ODOgESM19JrYBw  in_1NScTRF2…（subscription_create・0 円・2023-07-11）→ in_1NV9q2F2…（subscription_cycle・3,980 円・2023-07-18）
-- ■ つまり欠けているデータは無く、「初回課金 = subscription_create の請求」という数え方が試用開始の人を取りこぼしていた。
--   0 円の請求を D1 に埋め戻しても、数え方（入金 > 0）には効かない。
-- ■ 直し（このファイルと同じコミット・furim-dashboard.ts）
--   - 有料転換の日 = その人の最初の入金（actual_paid_amount > 0）の日。billing_reason は subscription_create / cycle / update のどれでもよい。
--     manual（チケットの単発購入）は定期の契約ではないので除く（manual が最初の入金の人は 0 人）
--   - 「初回課金を特定できない N 人」の異常の項目は、定義上もう起きないので外した
--   - 影響: 2023〜2024 年の月別「有料転換」が、この 12 人ぶん（試用終了の月）増える。2026 年の数字は変わらない
--
-- ── デプロイ後の確認（読み取りのみ・SQL の実行は無し） ────────────────
--   トップの異常区画から「初回課金を特定できない人」が消えていること
