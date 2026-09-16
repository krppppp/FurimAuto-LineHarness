-- Capsec #287: 1 か月止まっていた継続課金メッセージの後始末（権限管理課が本番 D1 で実行）。
--
-- ■ なぜ再送しないのか
-- 失敗の中身は LINE の 409「その再送キーはすでに受理済み」だった。つまり LINE は当該の
-- 送信をすでに受理している。いま同じ内容を送ると二重送信になる（再送キーの重複排除は
-- 24 時間で切れるため、日をまたいだ今の再送は必ず新しい配信として届く）。
-- 秘書が対象 11 名を読み取りで確認し、課金後も自動化を使えていること、契約期限・キーコード・
-- 端末の認証が正常であることを確かめている（実害なし）。落ちていたのは「課金完了のお知らせ＋
-- クーポンの告知」だけで、同じ告知は次回の課金で届く。よって**送り直さず、記録だけを直す**。
-- 会員への連絡もしない（くろさん決定 2026-09-16）。
--
-- ■ 再発防止はすでに入っている
-- 9cead62 で、再送キー付きの 409 を成功として扱うようにした（packages/line-sdk）。
-- sweep が 4 回で打ち切るときはスタッフの LINE に 1 通出る。
--
-- ■ 対象
-- 保留のアクション 11 件（stripe_processed_actions）と、失敗イベント 10 件（stripe_events）。
-- 件数が違うのは、8/20 の evt_1U6O0i… だけイベント側が failed になっていないため。
-- どちらも id で 1 件ずつ指定する。範囲での一括更新はしない。

-- ── 実行前の確認 ───────────────────────────────────────────────
-- 1) 保留アクションが 11 件であること
--   SELECT COUNT(*) FROM stripe_processed_actions WHERE status = 'pending';            -- 期待値 11
-- 2) 失敗イベントが 10 件であること
--   SELECT COUNT(*) FROM stripe_events WHERE status = 'failed';                        -- 期待値 10
-- 3) 下の id 以外に保留・失敗が無いこと（あれば止めて統括に連絡）
--   SELECT stripe_event_id, action_key FROM stripe_processed_actions WHERE status = 'pending' ORDER BY created_at;
--   SELECT stripe_event_id FROM stripe_events WHERE status = 'failed' ORDER BY processed_at;

-- ── 1. 保留のアクション 11 件を完了にする ──────────────────────
UPDATE stripe_processed_actions SET status = 'done'
WHERE status = 'pending' AND (stripe_event_id, action_key) IN (
  ('evt_1U6O0iF2C7KcCkFfVqHWBBve', '72f7c59a-63af-4f0a-a250-88e0918c9019:6'),  -- 08-20 13:55 ONO
  ('evt_1U8f1pF2C7KcCkFfVJTkn07c', '72f7c59a-63af-4f0a-a250-88e0918c9019:6'),  -- 08-26 20:30 奥村真帆
  ('evt_1U94dQF2C7KcCkFf3v1r3diS', '72f7c59a-63af-4f0a-a250-88e0918c9019:5'),  -- 08-27 23:51 みく
  ('evt_1UAWjwF2C7KcCkFfvAgIqJX4', '72f7c59a-63af-4f0a-a250-88e0918c9019:6'),  -- 09-01 00:03 ありさ
  ('evt_1UBuXVF2C7KcCkFf8DX7wb3T', '72f7c59a-63af-4f0a-a250-88e0918c9019:6'),  -- 09-04 19:40 山村 浩章
  ('evt_1UDWxBF2C7KcCkFfQISAtuAZ', '3fc2e28e-7559-4f30-b307-a1c33fc55016:19'), -- 09-09 06:53 よっしー（新規登録3通）
  ('evt_1UDaoaF2C7KcCkFfYxnGUJEp', '72f7c59a-63af-4f0a-a250-88e0918c9019:5'),  -- 09-09 11:01 きな粉餅
  ('evt_1UDl7gF2C7KcCkFfopjosshG', '72f7c59a-63af-4f0a-a250-88e0918c9019:6'),  -- 09-09 22:01 林 玲奈
  ('evt_1UE932F2C7KcCkFf2eP51XXL', '72f7c59a-63af-4f0a-a250-88e0918c9019:6'),  -- 09-10 23:34 松田
  ('evt_1UE9tLF2C7KcCkFf6jyMCZnR', '72f7c59a-63af-4f0a-a250-88e0918c9019:6'),  -- 09-11 00:28 Manami
  ('evt_1UEKe4F2C7KcCkFflYCCHIyw', '72f7c59a-63af-4f0a-a250-88e0918c9019:6')   -- 09-11 11:57 MM
);

-- ── 2. 失敗イベント 10 件を完了にする ─────────────────────────
UPDATE stripe_events
SET status = 'completed',
    completed_at = '2026-09-17T09:00:00.000+09:00',
    last_error = COALESCE(last_error, '') || ' / 2026-09-17 手で完了扱い（#287・再送なし）'
WHERE status = 'failed' AND stripe_event_id IN (
  'evt_1U8f1pF2C7KcCkFfVJTkn07c',  -- 08-26 20:30
  'evt_1U94dQF2C7KcCkFf3v1r3diS',  -- 08-27 23:50
  'evt_1UAWjwF2C7KcCkFfvAgIqJX4',  -- 09-01 00:03
  'evt_1UBuXVF2C7KcCkFf8DX7wb3T',  -- 09-04 19:40
  'evt_1UDWxBF2C7KcCkFfQISAtuAZ',  -- 09-09 06:53
  'evt_1UDaoaF2C7KcCkFfYxnGUJEp',  -- 09-09 11:00
  'evt_1UDl7gF2C7KcCkFfopjosshG',  -- 09-09 22:01
  'evt_1UE932F2C7KcCkFf2eP51XXL',  -- 09-10 23:33
  'evt_1UE9tLF2C7KcCkFf6jyMCZnR',  -- 09-11 00:28
  'evt_1UEKe4F2C7KcCkFflYCCHIyw'   -- 09-11 11:56
);

-- ── 3. 片づけた記録を残す（migration 080 の適用が先に要る） ────
INSERT INTO furim_ops_log (id, acted_at, actor, action, target, target_count, goal, note) VALUES
 (lower(hex(randomblob(8))), '2026-09-17T09:00:00.000+09:00', '権限管理課', 'mark_completed', 'stripe_processed_actions', 11, 'Capsec #287',
  'LINE の 409「再送キーは受理済み」で止まっていた配信アクション。LINE は受理済みで、対象 11 名に実害なし。二重送信を避けるため再送せず記録のみ更新。くろさん決定 2026-09-16'),
 (lower(hex(randomblob(8))), '2026-09-17T09:00:00.000+09:00', '権限管理課', 'mark_completed', 'stripe_events', 10, 'Capsec #287',
  '同上。sweep が 4 回で打ち切って failed のまま残っていたイベント。再発防止は 9cead62（409 を成功として扱う・打ち切り時のスタッフ通知）');

-- ── 実行後の期待値 ────────────────────────────────────────────
--   SELECT COUNT(*) FROM stripe_processed_actions WHERE status = 'pending';  -- 0
--   SELECT COUNT(*) FROM stripe_events WHERE status = 'failed';              -- 0
--   SELECT COUNT(*) FROM furim_ops_log;                                      -- 2（初回実行なら）
-- 管理画面トップの異常区画から「同期の保留」「送信が確認できていない配信」「Stripe イベントの滞留」が消える。
