-- 【下書き・本番に流さない】新 LINE のあいさつ・応答（キーワード）・特典受取タグ（TB-2209）
-- 文面は TB-2187 の design 4 節（器の段の一覧）を Worker に移した形。【原稿待ち: …】と {{特典ページの URL}} が残っている間は流さない。
-- 本番の文面は 10/27 の総務の再目検 第 1 段（TB-2187）の後に、この SQL の文字列だけを差し替えて確定する。
-- 流す先: D1 line-crm-fmb だけ。fmb-001-entry-routes.sql の後。
-- キーワードはリッチメニュー（TB-1386 richmenu-destinations）が送る言葉と同じ。管理画面の応答メッセージと同じ言葉なので、
-- 切り替えは TB-2187 3-2 の順（応答をオフ → Webhook をオン → あいさつをオフ）で、返事が 2 つ出る時間を作らない。
-- Worker に無いもの: 一律応答（TB-2187 の E・キーワードに当たらない言葉への返事）。今の Worker には「どれにも当たらないとき」の受け口が無い（コードの追加が要る）。
-- INSERT OR IGNORE なので 2 回流しても増えない

INSERT OR IGNORE INTO tags (id, name, color) VALUES
  ('fmb-tag-tokuten', '特典受取', '#F59E0B');

-- あいさつ（友だち追加・ブロック解除のたび。管理画面のあいさつと同じ扱い。replyToken で返すので送信数に入らない）
INSERT OR IGNORE INTO automations (id, name, description, event_type, conditions, actions, is_active, priority) VALUES
  ('fmb-auto-greeting', 'あいさつ（フリマ物販トレンド情報局）', 'TB-2187 design 4 節 B・TB-2209', 'friend_add', '{}', '[]', 1, 0);
INSERT OR IGNORE INTO automation_actions (id, automation_id, step_order, action_type, params, label) VALUES
  ('fmb-auto-greeting-1', 'fmb-auto-greeting', 0, 'send_messages', '{"messages": [{"messageType": "text", "content": "フリマ物販トレンド情報局の\nメルカリ調査員です。\nこの LINE は合同会社T4 が\n運営しています。\nメルカリ物販は、メルカリで\n物を売る副業です。\n家にある物から、少ないお金で\n始められます。\n売れているメルカリアカウントの\n調べ方から、仕入れ・出品・\n続け方までを、\nこの LINE でお送りします。"}, {"messageType": "text", "content": "動画「メルカリ調査員」を\nご覧になった方へ。\n動画で読み上げている金額は、\n調べた時点の推定売上です。\n経費を引いた額ではなく、\n同じ結果を約束するものでも\nありません。\nこの LINE でも、売れる額を\nお約束することはありません。\n\nまずは無料の特典\n「売れているメルカリアカウントの調べ方」\nを受け取ってください。\n下のメニューの「特典を受け取る」を\n押すか、「特典」と送ってください。"}]}', 'あいさつ 吹き出し 1・2');

-- 「特典」が届いたら 特典受取 タグ（特典を求めた人の数。開いた人の数は特典ページ側）
INSERT OR IGNORE INTO automations (id, name, description, event_type, conditions, actions, is_active, priority) VALUES
  ('fmb-auto-tokuten-tag', '特典受取タグ', 'TB-1358 design 2 節・TB-2209', 'message_received', '{"keyword_exact":"特典"}', '[]', 1, 0);
INSERT OR IGNORE INTO automation_actions (id, automation_id, step_order, action_type, params, label) VALUES
  ('fmb-auto-tokuten-tag-1', 'fmb-auto-tokuten-tag', 0, 'add_tag_by_name', '{"tagName":"特典受取"}', '特典受取');

-- 応答（完全一致）。D-◯ は TB-2187 design 4 節の番号
INSERT OR IGNORE INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active, created_at) VALUES
  ('fmb-reply-d-1', '特典', 'exact', 'text', '無料の特典「売れているメルカリアカウントの調べ方」です。
スマホでもパソコンでも読めます。
▼特典を開く
{{特典ページの URL}}', 1, '2026-10-24T00:00:00.000'),
  ('fmb-reply-d-2', '調べ方を学ぶ', 'exact', 'text', '【原稿待ち: TB-2078 の 1 通目（「1日目は」→「まずは」・末尾を「続きは、次の言葉を送ると届きます。仕入れ／出品／続け方」に）】', 1, '2026-10-24T00:00:01.000'),
  ('fmb-reply-d-3', '仕入れ', 'exact', 'text', '【原稿待ち: TB-2078 の 2 通目（「2日目は」「明日は「出品」です。」を外す）】', 1, '2026-10-24T00:00:02.000'),
  ('fmb-reply-d-4', '出品', 'exact', 'text', '【原稿待ち: TB-2090 の 3 通目・自社サービスの段落を外した版（「3日目は」「次は明後日、…」を外す）】', 1, '2026-10-24T00:00:03.000'),
  ('fmb-reply-d-5', '続け方', 'exact', 'text', '【原稿待ち: TB-2078 の 4 通目（「5日目は」「次は明後日の夜…」を外す）】', 1, '2026-10-24T00:00:04.000'),
  ('fmb-reply-d-6', '生配信', 'exact', 'text', '【原稿待ち: TB-2090 の 5 通目（生の間の版）＋日時「11/15（日）20:00〜」＋申込みの案内】', 1, '2026-10-24T00:00:05.000'),
  ('fmb-reply-d-7', '11/15 20:00 の生配信', 'exact', 'text', '【原稿待ち: TB-2090「申込みの返事」（参加の URL は道具が決まってから）】', 1, '2026-10-24T00:00:06.000'),
  ('fmb-reply-d-8', 'FurimAuto', 'exact', 'text', 'FurimAuto（フリマート）は、フリマ物販トレンド情報局を運営する合同会社T4の自社サービスです。
【原稿待ち: 短い紹介（配信文担当）】
▼くわしく見る
https://furimauto.com/r/fmb_line', 1, '2026-10-24T00:00:07.000'),
  ('fmb-reply-d-9', 'よくある質問', 'exact', 'text', 'よくあるご質問です。

Q. お金はかかりますか？
この LINE の配信と特典は無料です。
生配信も無料ですが、後半で有料の本と、
自社サービスのご案内があります。

Q. メルカリの公式アカウントですか？
いいえ。株式会社メルカリの公式アカウント
ではなく、同社とは関係ありません。

Q. 誰が運営していますか？
合同会社T4 が運営しています。

Q. 配信を止めたいときは？
このトークの右上のメニューから、
ブロックすると止まります。', 1, '2026-10-24T00:00:08.000'),
  ('fmb-reply-d-10', '運営会社', 'exact', 'text', 'この LINE は合同会社T4 が運営しています。
株式会社メルカリの公式アカウントではなく、同社とは関係ありません。
個人情報の扱い: https://t4-corp.com/privacy', 1, '2026-10-24T00:00:09.000');
