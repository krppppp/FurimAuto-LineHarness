-- 自動生成: seed-furimauto-unified-scenario.mjs (2026-08-24 シナリオ一本化)
-- シナリオ本体＋39ステップ。冪等ではないので二重実行しないこと。

INSERT INTO scenarios (id, name, description, trigger_type, is_active, delivery_mode)
VALUES ('2278b486-b03a-4da1-9b94-fb6565fd0e63', 'FurimAuto ステップ配信 統合版', 'Day0=無料リサーチで完結(+30分/+2h/+6h)、Day1-6=朝9時の全自動化教育+昼13時の15大特典への道+Day1夜20時。全セグメント・通常/紹介共通の1本(2026-08-24一本化)。Day0+0分のウェルカムはfriend_add automationが送る。', 'manual', 1, 'elapsed');

-- Day0+30分 導入した瞬間から、変わります
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('09037c3e-131c-4eda-a5b0-9c974f9885d1', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 0, 0, 'text', '【導入した瞬間から、変わります】

FurimAutoです。
拡張機能は導入できましたか？

導入すると、無料のリサーチ機能が
あなたのメルカリですぐに動き始めます。

試しに、メルカリで何か検索してみてください🔍

検索結果のカードに
・出品者の評価/本人確認
・出品日時/更新日時
・SOLD商品の"売れた日時"
が自動で追加されます。
（↓導入前と導入後の画面です）

設定も操作もいりません。
「いつ・何が・どれだけ売れているか」が
見えるだけで、仕入れの精度は大きく変わります。

まだの方は、1分で導入できます👇
https://furimauto.com/install', 0, 30, NULL);
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('c1208bb2-45f2-4049-99da-ee13f065f9ed', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 1, 0, 'image', '{"originalContentUrl":"https://furimauto.com/howto/images/freeFeature_mercari_search_before.png","previewImageUrl":"https://furimauto.com/howto/images/freeFeature_mercari_search_before.png"}', 0, 30, NULL);
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('96c8242e-fad0-4559-ba5b-b03e8b335119', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 2, 0, 'image', '{"originalContentUrl":"https://furimauto.com/howto/images/freeFeature_mercari_search_after.png","previewImageUrl":"https://furimauto.com/howto/images/freeFeature_mercari_search_after.png"}', 0, 30, NULL);
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('198f342e-0302-46c5-885c-85e0a2e3f44b', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 3, 0, 'text', '最後に、30秒だけください。

あなたに合ったご案内をお届けするため、
1問だけアンケートにご協力お願いします👇', 0, 30, NULL);
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('7863659d-ea38-4029-ac62-94f8f7a2b21c', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 4, 0, 'flex', '{"type":"flex","altText":"▼ 1問アンケートはこちら ▼","contents":{"type":"bubble","hero":{"type":"image","url":"https://storage.googleapis.com/furimauto_line/images/messageEvent/follow_event_img3.png","size":"full","aspectRatio":"16:9","aspectMode":"cover"},"body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"▼ 1問アンケートはこちら ▼","weight":"bold","size":"lg","wrap":true,"align":"center"}]},"footer":{"type":"box","layout":"vertical","spacing":"sm","contents":[{"type":"button","style":"primary","height":"sm","action":{"type":"message","label":"開始する","text":"【ボタン】アンケート開始"}}]}}}', 0, 30, NULL);

-- Day0+2時間 リサーチ5通セット
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('7842d7e3-4b33-4c60-8abf-242e4790c7dd', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 5, 0, 'text', '【何が売れるかは、"事実"で分かります】

勘で仕入れると、在庫が残ります。

売れている人は「売れた事実」から
逆算して仕入れています。

FurimAutoの無料リサーチなら、
その事実が、ぜんぶ見えます👇', 0, 120, NULL);
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('3fe6c2eb-8c04-4b75-aa55-0d6ae2d1b4e3', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 6, 0, 'flex', '{"type":"flex","altText":"🔍 商品ページでできるリサーチ","contents":{"type":"bubble","hero":{"type":"image","url":"https://furimauto.com/howto/images/freeToolCard_overview.png","size":"full","aspectRatio":"1420:1536","aspectMode":"cover"},"body":{"type":"box","layout":"vertical","spacing":"md","contents":[{"type":"text","text":"🔍 商品ページでできるリサーチ","weight":"bold","size":"lg","wrap":true,"color":"#D94A3D"},{"type":"box","layout":"vertical","backgroundColor":"#FFF1EC","cornerRadius":"8px","paddingAll":"12px","spacing":"xs","contents":[{"type":"text","text":"💰 出品者の\"期間別売上金額\"が見える","weight":"bold","size":"md","color":"#D94A3D","wrap":true},{"type":"text","text":"直近90日の販売実績を自動表示。期間別に何個・いくら売れたかが丸わかりです。","size":"sm","color":"#555555","wrap":true}]},{"type":"box","layout":"vertical","backgroundColor":"#FFF6E5","cornerRadius":"8px","paddingAll":"12px","spacing":"xs","contents":[{"type":"text","text":"📤 ワンクリックでコピー出品","weight":"bold","size":"md","color":"#E8730C","wrap":true},{"type":"text","text":"メルカリの商品を、そのまま他のフリマサイトへ。出品し直しの手間がなくなります。","size":"sm","color":"#555555","wrap":true}]},{"type":"text","text":"ほかにも、8サイト横断リサーチ・商品画像の一括保存がこのカードから使えます。","size":"xs","color":"#888888","wrap":true}]}}}', 0, 120, NULL);
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('180b48b9-632b-48cd-902f-dd4e36eea606', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 7, 0, 'flex', '{"type":"flex","altText":"🏪 出品者ページでできるリサーチ","contents":{"type":"bubble","hero":{"type":"image","url":"https://furimauto.com/howto/images/shopResearch_panels.png","size":"full","aspectRatio":"2874:1630","aspectMode":"cover"},"body":{"type":"box","layout":"vertical","spacing":"md","contents":[{"type":"text","text":"🏪 出品者ページでできるリサーチ","weight":"bold","size":"lg","wrap":true,"color":"#D94A3D"},{"type":"text","text":"参考にしたいアカウント、競合アカウントの\"戦略\"を丸裸にします。","size":"sm","color":"#555555","wrap":true},{"type":"box","layout":"vertical","backgroundColor":"#FFF1EC","cornerRadius":"8px","paddingAll":"12px","spacing":"xs","contents":[{"type":"text","text":"⚡ 数百ページを、数分で分析","weight":"bold","size":"md","color":"#D94A3D","wrap":true},{"type":"text","text":"出品傾向・価格帯を自動で集計。手作業では追い切れない量を一気に分析できます。","size":"sm","color":"#555555","wrap":true}]},{"type":"box","layout":"vertical","backgroundColor":"#FFF6E5","cornerRadius":"8px","paddingAll":"12px","spacing":"xs","contents":[{"type":"text","text":"⭐ 評価も、その場で確認","weight":"bold","size":"md","color":"#E8730C","wrap":true},{"type":"text","text":"購入者からの評価一覧をページ内に表示。\"信頼される売り方\"まで研究できます。","size":"sm","color":"#555555","wrap":true}]}]}}}', 0, 120, NULL);
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('9de9e398-2edd-4140-b81c-fb900996bc1a', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 8, 0, 'text', 'そして、リサーチと一緒に
受け取ってほしいものがあります🎁

無料期間中に段階的に解放される
【15大特典】です。

物販ロードマップから撮影マニュアルまで。
まずは"今すぐもらえる特典"からどうぞ👇', 0, 120, NULL);
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('926c55dc-bea6-49d7-ada1-e8234d12057b', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 9, 0, 'flex', '{"type":"flex","altText":"🎁 無料期間中に15大特典をGETしよう！","contents":{"type":"bubble","hero":{"type":"image","url":"https://furimauto.com/service/images/special_offer.png","size":"full","aspectRatio":"1:1","aspectMode":"cover"},"body":{"type":"box","layout":"vertical","spacing":"md","contents":[{"type":"text","text":"🎁 無料期間中に15大特典をGETしよう！","weight":"bold","size":"lg","wrap":true,"color":"#FF6B35"},{"type":"text","text":"友達登録から1週間の無料試用期間中に、段階的に15種類の特典をプレゼントします！","size":"sm","color":"#555555","wrap":true,"margin":"sm"},{"type":"separator","margin":"md"},{"type":"box","layout":"vertical","margin":"md","spacing":"xs","contents":[{"type":"text","text":"📦 今すぐもらえる特典","weight":"bold","size":"sm","color":"#333333"},{"type":"button","style":"link","height":"sm","margin":"xs","action":{"type":"uri","label":"① ロードマップ❶ ダウンロード","uri":"https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B81%E3%83%AD%E3%83%BC%E3%83%88%E3%82%99%E3%83%9E%E3%83%83%E3%83%95%E3%82%9A%E2%9D%B6.pdf"}},{"type":"button","style":"link","height":"sm","action":{"type":"uri","label":"② ロードマップ❷ ダウンロード","uri":"https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B82%E3%83%AD%E3%83%BC%E3%83%88%E3%82%99%E3%83%9E%E3%83%83%E3%83%95%E3%82%9A%E2%9D%B7.pdf"}}]},{"type":"box","layout":"vertical","margin":"md","spacing":"xs","contents":[{"type":"text","text":"🔓 使うほどもらえる特典（リッチメニューから）","weight":"bold","size":"sm","color":"#333333","wrap":true},{"type":"text","text":"③ ロードマップ❸","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"④ ロードマップ❹","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑤ 撮影方法マニュアル前編","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑥ 撮影方法マニュアル後編","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑦ 外注化マニュアル前編","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑧ 外注化マニュアル後編","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑨ 外注募集テンプレート","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑩ 外注先業務委託契約書テンプレ","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑪ コメントセールの手法と効果の解説","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑫ 売れるブランドリスト","size":"sm","color":"#444444","margin":"xs","wrap":true},{"type":"text","text":"⑬ 売れるアカウント説明&プロフィール解説","size":"sm","color":"#444444","margin":"xs","wrap":true}]},{"type":"box","layout":"vertical","margin":"md","spacing":"xs","contents":[{"type":"text","text":"🎬 YouTubeを視聴の上キーワード入力でもらえる特典","weight":"bold","size":"sm","color":"#333333","wrap":true},{"type":"text","text":"⑭ 初月半額クーポン","size":"sm","color":"#444444","margin":"xs"},{"type":"text","text":"⑮ 無料試用期間1週間延長","size":"sm","color":"#444444"}]},{"type":"separator","margin":"md"},{"type":"text","text":"リッチメニューの「限定特典GET」をタップすると、あなたの利用状況に応じて次の特典が届きます！","size":"xs","color":"#888888","wrap":true,"margin":"md"}]}}}', 0, 120, NULL);

-- Day0+6時間 出品もラクに＋存在意義
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('0ec55cc1-b76b-4e75-a39f-f819828be054', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 10, 0, 'text', '【出品作業も、無料機能でラクになります】

リサーチで「売れるもの」が見えたら、次は出品です。
FurimAutoには出品まわりの無料機能もあります。

📸 商品画像の一括保存（zipでまとめてDL）
ℹ️ 商品情報の追加表示
🔍 8サイト横断リサーチ（相場の比較に）

──ここまでが、ずっと無料で使える機能です。

ただ、正直にお伝えします。

リサーチと出品が整っても、
毎日の値下げ・コメント対応・取引メッセージは
消えません。商品数が増えるほど、手が止まります。

そこでFurimAutoの本体です。
いまの無料期間中は、
【自動化の全機能】もすべて使えます。

発行はリッチメニューの
「キーコード発行」をタップするだけ。
クレジットカードの登録は不要、
期間が終わっても勝手に課金されることはありません👇', 0, 360, NULL);
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('1a88735e-4fcf-437c-8ab4-94b1fc325156', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 11, 0, 'text', '【FurimAutoが、リサーチを無料で配る理由】

少しだけ、私たちの話をさせてください。

FurimAutoは、現役のフリマ物販プレイヤーが
作っている自動化ツールです。

先に、身も蓋もない事実からお伝えします。

フリマ物販に適したジャンルは、
すでに世の中に出きっています。

そして、いま売上が立っているアカウントこそが
"答え合わせの済んだ成功例"です。

だから、自分に合ったジャンルの
トッププレイヤーを丸ごと真似する。
それだけの、シンプルな事業です。

オリジナリティは、むしろ邪魔になります。

その上で。
私たちが「今のフリマサイトでの成功の順番」だと
確信しているのが、この5段階です。
重要度も、①から順になっています。

① 何が売れるかを、事実で知る
② 売れる商品を仕入れて、
　いい写真・丁寧な情報を添えて出品する
③ 毎日の作業を自動化して、売上を継続させる
④ 販路を広げて、売上の上限を外す
⑤ 増えた在庫を、事故なく回す

リサーチせずに仕入れた在庫は残ります。
1つのサイトだけの運用には、天井が来ます。

FurimAutoはこの5段階を、
ぜんぶ1つの拡張機能に入れました。

そして──
入り口の①と②は、無料です。
無料期間が終わっても、ずっと無料のままです。

なぜそんなことをするのか。

お金をお支払いいただいて活用してほしいのは、
「商品が増えて、手が回らなくなった時」
その時だけだからです。

お客様のニーズは、百種百様です。
商材・戦略・資金力・お使いのPCスペックまで、
すべて異なります。

そのニーズに応えられるように、
FurimAutoは様々なサービス・機能を
用意しています。

"人手が欲しくなった作業"から、
少しずつ任せてください。

あなたが売れる。忙しくなる。
「もう手作業には戻れない」と感じる。
その時はじめて、次の段が目の前に現れる。

FurimAutoは、そういう順番で
使ってもらえるように作られています。

さて、いまのあなたは、どの段にいますか？👇', 0, 360, NULL);
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('a2e7cd10-b671-48df-9083-d9a7290e6772', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 12, 0, 'image', '{"originalContentUrl":"https://furimauto.com/line_images/roadmap_5steps.png","previewImageUrl":"https://furimauto.com/line_images/roadmap_5steps.png"}', 0, 360, NULL);

-- Day1朝 1分で分かる全自動化
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('3d4412d4-1f14-456e-b873-544d9b80322e', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 13, 0, 'text', 'おはようございます☀
FurimAutoです。

今日はまず、この動画だけ見てください。

FurimAutoが目指す「全自動化」──
新規出品と梱包発送以外の毎日の作業を
ぜんぶ任せる、という世界が1分で分かります👇', 1, NULL, '09:00');
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('fd8e1945-e420-43b4-89b7-efd261dc57e5', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 14, 0, 'flex', '{"type":"flex","altText":"FurimAuto紹介動画","contents":{"type":"bubble","hero":{"type":"image","url":"https://img.youtube.com/vi/uQjheVeAuww/maxresdefault.jpg","size":"full","aspectRatio":"16:9","aspectMode":"cover","action":{"type":"uri","uri":"https://www.youtube.com/watch?v=uQjheVeAuww"}},"body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"FurimAuto紹介動画","weight":"bold","size":"xl","wrap":true},{"type":"text","text":"1番初めに見るべき動画はコレ👆👆👆\n\n長ったらしい説明はナシ！です🙅‍♀️\n\nFurimAutoの使い方と\n他者ツールと比べた特徴を\n1分でまとめました!!\n\n断言しますが\nこのツールより簡単で\n全局面での自動化を実現した\n自動化ツールはこの世にはないです🤫","size":"sm","color":"#666666","margin":"md","wrap":true}]},"footer":{"type":"box","layout":"vertical","spacing":"sm","contents":[{"type":"button","style":"primary","height":"sm","action":{"type":"uri","label":"YouTubeで見る","uri":"https://www.youtube.com/watch?v=uQjheVeAuww"},"color":"#FF0000"}]}}}', 1, NULL, '09:00');

-- Day1昼 特典への道1/6
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('315f8d77-1388-485e-957d-8a170889232e', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 15, 0, 'text', '【15大特典への道 1/6】

FurimAutoです🎁

無料期間中に集められる15大特典、
①②のロードマップは受け取りましたか？

今日のミッション🎯
▶ 1問アンケートに回答（30秒）

クリアでもらえる特典
📘 ③ ロードマップ❸
📘 ④ ロードマップ❹

物販で稼ぐ道筋の"続き"です。
今朝の動画とセットでどうぞ。

回答と受け取りは、リッチメニューの
「限定特典GET」をタップ👇', 1, NULL, '13:00');

-- Day1夜 今夜のうちに準備だけ
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('3da50e83-d33c-43c8-a37f-dc58b99974db', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 16, 0, 'text', '【今夜のうちに、準備だけ】

FurimAutoです。

フリマサイトの運用には、
"自動化すべきページ"が3つあります。

📋 出品一覧ページ
　→ 値下げ・再出品・コメント管理 などなど

🔔 お知らせページ
　→ いいねした人へのセールコメント

💬 取引中ページ
　→ 取引メッセージの自動送信

明日から1日1ページずつ、
この3つの"手作業が消える体験"を
ご案内していきます。

キーコードの発行がまだの方は、
今夜のうちに済ませておくのがおすすめです。
（リッチメニュー「キーコード発行」→ 拡張機能に入力するだけ）

発行済みの方は、明日の朝をお楽しみに😊', 1, NULL, '20:00');
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('7232dc4e-f160-4a0d-9ed9-4db840054350', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 17, 0, 'image', '{"originalContentUrl":"https://furimauto.com/line_images/pages3_all.png","previewImageUrl":"https://furimauto.com/line_images/pages3_all.png"}', 1, NULL, '20:00');

-- Day2朝 値下げと再出品は何のため
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('328c7192-5102-4f74-9d7b-a859fffcf357', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 18, 0, 'image', '{"originalContentUrl":"https://furimauto.com/line_images/pages3_day2.png","previewImageUrl":"https://furimauto.com/line_images/pages3_day2.png"}', 2, NULL, '09:00');
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('41bd4d0a-fcb0-4d6e-b001-f681fb519754', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 19, 0, 'text', '【値下げと再出品は、何のためにやるのか】

先に言い切ります。
値下げや再出品を"するだけ"で
売れるわけではありません。

でも、フリマサイトにははっきりした傾向があります。

値下げ・再出品をした商品は
検索結果の上位に戻り、
閲覧数が増え、いいねが集まる。

つまりこれは
【フリマサイト内のSEO対策】です。

問題は、それを毎日
手作業で続けられるか、です。

FurimAutoなら、出品一覧ページの作業──
値下げ・再出品・コメント管理・底値設定──を
日時指定でまとめて予約することができ
継続的に自動化することが可能です。

たとえば毎日の値段変更の予約の合間に
再出品を「朝10品・夜10品」で予約するだけで、
1日20商品×30日、
1ヶ月で約600品を
フレッシュな商品ページとして回せます。

今日はまず、自動値下げか自動再出品を
どちらか1つだけ予約してみてください😊', 2, NULL, '09:00');
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('f589713c-f9a8-4769-8ad8-77b6cc4921cb', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 20, 0, 'image', '{"originalContentUrl":"https://furimauto.com/line_images/seo_cycle.png","previewImageUrl":"https://furimauto.com/line_images/seo_cycle.png"}', 2, NULL, '09:00');

-- Day2昼 特典への道2/6
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('06f30a67-ce04-4f82-9d94-c3d498791658', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 21, 0, 'text', '【15大特典への道 2/6】

いい商品も、写真が悪いと売れません📷

今日のミッション🎯
▶ キーコードを発行する（無料・30秒）

クリアでもらえる特典
📕 ⑤ 撮影方法マニュアル 前編
📕 ⑥ 撮影方法マニュアル 後編

"売れる写真"の撮り方を体系化した教材です。
出品の質が、今日から変わります。

発行はリッチメニューの
「キーコード発行」をタップ。
特典は「限定特典GET」から受け取れます👇', 2, NULL, '13:00');

-- Day3朝 売る側は高く買う側は安く
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('979bcedd-e86e-42db-91a1-55c1f901e787', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 22, 0, 'image', '{"originalContentUrl":"https://furimauto.com/line_images/pages3_day3.png","previewImageUrl":"https://furimauto.com/line_images/pages3_day3.png"}', 3, NULL, '09:00');
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('ab8429c6-0c09-403c-9ec2-228365229a77', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 23, 0, 'text', '【売る側は高く、買う側は安くのギャップがチャンス】

物販の売上は、突き詰めるとこの綱引きです。

売る側は、できるだけ高く売りたい。
買う側は、できるだけ安く買いたい。

この"価格のギャップ"をどれだけ上手に
詰められるかが、フリマサイトで
売上を伸ばすいちばん大事な施策です。

そして、昨日お伝えしたSEOで
閲覧といいねを集めた"その先"にあるのが
【価格交渉】です。

いいねを付けた人は、
「気になっているけど、あと一歩」の人。

その人に向けてセールコメントを投稿し、
こちらから能動的に
"交渉の場"へお客さんを連れてくる──
それがFurimAutoの【自動いいね対応】です。

商品にいいねが付いたら、
その人に向けたセールコメントを自動で投稿。

買い手は少し安く買えて、
あなたの在庫は現金に変わる。

ギャップが縮まる瞬間を、体験してみてください😊', 3, NULL, '09:00');
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('fd8c91ac-3992-406f-86da-5c2d14eaba03', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 24, 0, 'image', '{"originalContentUrl":"https://furimauto.com/line_images/price_gap.png","previewImageUrl":"https://furimauto.com/line_images/price_gap.png"}', 3, NULL, '09:00');

-- Day3昼 特典への道3/6
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('3becd953-b041-4e4e-8580-c29190a6494c', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 25, 0, 'text', '【15大特典への道 3/6】

自動化、もう1つは動かしましたか？

今日のミッション🎯
▶ 発行したキーコードを拡張機能に入力して
　自動化を1つ実行する

クリアでもらえる特典
📗 ⑦ 外注化マニュアル 前編
📗 ⑧ 外注化マニュアル 後編

自分の作業を"人に任せる"仕組み化の教科書。
自動化と外注化で、稼働はさらに減らせます。

受け取りはリッチメニューの
「限定特典GET」をタップ👇', 3, NULL, '13:00');

-- Day4朝 売れるほど忙しくなる問題
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('f463a4b3-221e-4f5e-859b-7689f973d1dc', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 26, 0, 'image', '{"originalContentUrl":"https://furimauto.com/line_images/pages3_day4.png","previewImageUrl":"https://furimauto.com/line_images/pages3_day4.png"}', 4, NULL, '09:00');
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('b7853883-e2a1-416f-af7b-120b666887a1', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 27, 0, 'text', '【売れるほど、忙しくなる問題】

ここまでの自動化
（値段変更・セールコメント施策・再出品）が
うまく回り始めると、
閲覧が増え、いいねが増え、
月間の取引数も増えやすくなります。

すると、次に重くなるのが──
【取引メッセージのやり取り】です。

購入のお礼、発送のご連絡、受取確認。

メッセージ1通の処理は、
スマホでコピペしても1分〜1分半。
1つの取引で3〜4通やり取りするので、
取引1件あたり4〜5分かかる計算です。

取引が増えるほど、
これが毎日積み上がっていきます。

FurimAutoは、ここも自動化できます。

取引メッセージを自動で送信。
対応の早い出品者として
購入者からの印象・評価にもつながります。

売れるほど、ラクになる。
全自動化の完成が、近づいてきました。', 4, NULL, '09:00');
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('0a5c5124-a573-480c-b7fc-04a50246d98b', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 28, 0, 'image', '{"originalContentUrl":"https://furimauto.com/line_images/msg_workload.png","previewImageUrl":"https://furimauto.com/line_images/msg_workload.png"}', 4, NULL, '09:00');

-- Day4昼 特典への道4/6
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('8639157d-6ae9-4903-91bd-1c777026c4fa', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 29, 0, 'text', '【15大特典への道 4/6】

無料のコピー出品チケット30枚、
もう受け取りましたか？🎫

今日のミッション🎯
▶ 無料チケット30枚を受け取って
　コピー出品を試す

クリアでもらえる特典
📄 ⑨ 外注募集テンプレート
📄 ⑩ 外注先業務委託契約書テンプレ

昨日のマニュアルを"今日から実行"できる
実物のテンプレートです。

チケットも特典も、リッチメニューの
「限定特典GET」から👇', 4, NULL, '13:00');
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('f15a4270-ee32-4671-81da-27578de2521a', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 30, 0, 'flex', '{"type":"flex","altText":"コピー出品チケット30枚無料！","contents":{"type":"bubble","hero":{"type":"image","url":"https://storage.googleapis.com/furimauto_line/images/messageEvent/copy_function.png","size":"full","aspectRatio":"16:9","aspectMode":"cover"},"body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"コピー出品チケット30枚無料でプレゼント！","weight":"bold","size":"xl","wrap":true},{"type":"text","text":"🎉【30枚のコピー出品チケットを無料でプレゼント！】🎉\n\nメルカリShops・ラクマ・ヤフオク・Yahoo!フリマへのコピー出品が可能！\n\n商品をコピー出品完了したら1枚消費するチケット制度で、コピー出品だけならサブスクプランへの加入は不要🙅‍♀️\n\n💬下のボタンをタップした後、\nキーコードの入力ボタンを押すだけですぐにご利用いただけます！","size":"sm","color":"#666666","margin":"md","wrap":true}]},"footer":{"type":"box","layout":"vertical","spacing":"sm","contents":[{"type":"button","style":"primary","height":"sm","action":{"type":"message","label":"GETする","text":"【ボタン】コピー出品チケット30枚GET"}}]}}}', 4, NULL, '13:00');

-- Day5朝 次のステージへ（販路拡大）
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('5656210c-c3ff-4549-8c60-e6d5d0d6d833', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 31, 0, 'text', '【1つのサイトで回ったら、次のステージへ】

メルカリの運用が自動で回るようになったら、
次にやるべきは【販路拡大】です。

同じ商品でも、サイトが違えばお客さんも違う。
出す場所を増やすだけで、
売れるチャンスは単純に増えます。

「でも、他のサイトに
　出品し直すのは面倒…」

FurimAutoなら、メルカリの商品データをもとに
他のフリマサイトへ一気にコピー出品できます。

・無料でも、ワンクリックの手動コピーが使えます
・有料なら、1品あたり10〜15円のチケット制で
　全自動の連続出品

販路拡大は、思っているよりずっと簡単です。
まずは1品だけ、試しにコピーしてみてください😊', 5, NULL, '09:00');
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('d1f21164-54fa-4707-802b-691f91f6a7b4', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 32, 0, 'image', '{"originalContentUrl":"https://furimauto.com/line_images/copy_compare.png","previewImageUrl":"https://furimauto.com/line_images/copy_compare.png"}', 5, NULL, '09:00');

-- Day5昼 特典への道5/6
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('710828e6-0c4e-4747-a815-28a8647f9136', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 33, 0, 'text', '【15大特典への道 5/6】

今日のミッション🎯
▶ YouTube動画講座を見て、
　動画内のキーワードをこのLINEに送る

クリアでもらえる特典
📙 ⑪ コメントセールの手法と効果の解説

先日ご紹介した"セールコメント"を
深掘りした資料です。
値引き幅の考え方まで分かります。

動画はリッチメニューの
「Youtube動画講座」からどうぞ👇', 5, NULL, '13:00');
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('374d5fd2-d0b8-4b55-901c-bacbacd2a0a8', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 34, 0, 'image', '{"originalContentUrl":"https://storage.googleapis.com/furimauto_line/images/messageEvent/youtube_coupon.png","previewImageUrl":"https://storage.googleapis.com/furimauto_line/images/messageEvent/youtube_coupon.png"}', 5, NULL, '13:00');
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('27db2a8e-f4ca-4db0-88d4-d44c65db9139', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 35, 0, 'text', '【お得に使えるクーポンをGET!!】

動画内のキーワードをLINEに送っていただいた方には、

・友達登録から1週間以内 → 月額半額クーポン
・それ以外 → 月額20%引きクーポン

をそれぞれプレゼントいたします！', 5, NULL, '13:00');

-- Day6朝 最後の壁は在庫管理
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('1d285058-6508-417e-b3c8-56023781f752', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 36, 0, 'text', '【最後の壁は、在庫管理】

販路を広げると、
最後にぶつかる壁があります。

「メルカリで売れたのに、
　ラクマにも出したままだった…」

複数サイトでの在庫管理は地味で、
そしてミスが命取りです。

FurimAutoの【自動併売在庫管理】は、
どこかのサイトで売れたら、
他のサイトの同じ商品を自動で取り下げます。

売り違いの恐怖から解放されて、
あなたがやるのは
仕入れて、出品して、発送するだけ。

リサーチ → 出品 → 自動化 → 販路拡大 → 在庫管理。

この1週間でご案内した階段をのぼり切ると、
"片手間なのに、ちゃんと伸びる物販"が完成します。

その形、このまま続けませんか？

今夜、継続してご利用になりたい方へ向けた
ご案内をお送りします😊', 6, NULL, '09:00');
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('9617a06d-9c5e-4b45-91f1-f8e8cf54c6a1', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 37, 0, 'image', '{"originalContentUrl":"https://furimauto.com/line_images/inventory_sync.png","previewImageUrl":"https://furimauto.com/line_images/inventory_sync.png"}', 6, NULL, '09:00');

-- Day6昼 特典への道6/6
INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, offset_days, offset_minutes, delivery_time)
VALUES ('4d1900ac-2b59-44b4-8fb5-56005d7e5669', '2278b486-b03a-4da1-9b94-fb6565fd0e63', 38, 0, 'text', '【15大特典への道 6/6】

最終日。いちばん大きい特典です。

今日のミッション🎯
▶ 完全解説動画を見て、動画内で案内される
　キーワードをこのLINEに送る

クリアでもらえる特典
📒 ⑫ 売れるブランドリスト
📒 ⑬ 売れるアカウント説明&プロフィール解説

さらに──
🎁 無料試用期間が1週間延長されます

「まだ試し切れていない」という方も、
これでもう1週間、じっくり使えます。

動画はリッチメニューからどうぞ👇', 6, NULL, '13:00');
