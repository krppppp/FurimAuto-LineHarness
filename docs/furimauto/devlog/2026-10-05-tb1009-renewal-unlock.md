# TB-1009 更新 7 日前の全機能開放（dev 実装）

親 TB-25 の方針コメント a2e08173（くろさん回答 76dc8b19: プラン・価格は変えない／下位プランの有料会員に更新日 1 週間前に全機能を開放し、多販路の利益と在庫管理の楽さを訴求）。

## 何をしたか

- migration `089_furim_renewal_unlocks.sql`: 期限付き開放の記録。`UNIQUE(line_user_id, cycle)`、cycle = `subscription_id:更新日(YYYY-MM-DD)`。上乗せするフラグは開放時点の trial パッケージを JSON で固定。案内 3 通の送信印（msg1〜3_sent_at）
- `furim/renewal-unlock.ts`（新規）
  - 対象: `subscription_source='plan-builder'`・`plan_label` が `PBプラン:` 始まり・subscription_id あり・packages が空でなく premium/trial を含まない・試用キーコード（2weektrial_）でない
  - 更新日時 = `subscription_end_at − 24h`（stripe-processor の +1 日バッファを戻す）
  - 開放の窓: 更新の 7 日前〜2 日前（2 日を切った人には開けない）。cron では毎時 :00 の tick だけ開放判定（解約予約の人を 5 分ごとに Stripe へ聞き直さない）。1 回 10 人まで
  - 解約予約: 開放の直前に Stripe `GET /v1/subscriptions/{id}` を読み、`status=active` かつ `cancel_at_period_end`/`cancel_at` なしだけ通す（D1 に解約予約の印が無いため）。Stripe キーが無ければ開けない
  - 案内: 開放時に 1 通目、4 日前に 2 通目（1 通目から 1 日以上空ける）、前日に 3 通目。9〜23 時 JST のみ。送る前に印を取って二重送信を防ぐ。送れなかったら `error:` 印で再送しない。messages_log に source='renewal-unlock'
  - cron は `FURIM_RENEWAL_UNLOCK=on` の環境だけ動く（dev/prod とも未設定＝止まっている）
- `furim/ext-auth.ts`: furim_feature_flags を読んだあと、期限内の開放があれば上乗せ（ON にするだけ・OFF にはしない）。フラグ本体は書かない。KV 60 秒の写しにはそのまま乗る。開放時は該当キーコードの KV を消す
- `index.ts`: 5 分 cron に runRenewalUnlock。Env に FURIM_RENEWAL_UNLOCK / PLAN_BUILDER_LIFF_URL。FORK_OVERLAY に 1 行追記
- `routes/furim.ts`: `POST /api/furim/renewal-unlock/run`（管理 API キー）。既定は dryRun=true・push=false。`lineUserId` で 1 人だけ、`skipStripeCheck` は dev 確認用
- テスト: `renewal-unlock.test.ts`（対象・窓・時間帯・上乗せ・段階・ゲート）、`ext-api.test.ts` に上乗せ 1 件。worker 全体 121 ファイル / 1439 件 pass

## dev での確認（line-crm-rebase・Worker version 4616494a）

- dev D1 に migration 089 を適用
- テスト顧客 `U_tb1009_test`（実在しない LINE ID・m_full・更新 10/12 18:01）を作成
- 開放前の key-code-set: funcObject 4 キー（rChangePrice=false・InventorySheet=false・AutoMultiChannel=''）
- run dryRun → granted。Stripe 確認あり → 架空の sub なので `stripe404` で弾かれる（解約予約チェックの経路が生きている）
- 本実行（skipStripeCheck・push なし）→ granted、2 回目は何もしない（冪等）
- 開放後の key-code-set: 49 キー（m/ms/r/yf の全機能・InventorySheet=true・AutoMultiChannel=全 5 販路）。furim_feature_flags の 4 行は変わらず
- until を過去にすると、KV の 60 秒が切れた時点（20:02:30）で元の 4 キーに戻った
- テスト行（furim_customers / furim_feature_flags / furim_renewal_unlocks）は確認後に削除済み
- 案内の push は dev でも送っていない（push=false。黒岩さんテストは文面案の OK 後）
- コードはブランチ `furim/tb1009-renewal-unlock` に未コミットで置いている（コミットは依頼があってから）

## 未決・注意

- 3 通目の「使った販路にチェック済みで開く」プランビルダーの prefill はまだ無い。今はプランビルダーの URL だけ
- 2 通目のイベント（ラクマのポイント還元・ヤフフリのクーポン等）の具体は入れていない。LINE導線担当・マーケと合わせる
- packages が空の PB 有料（本番 33 人・機能単品の契約）は対象外にしている。入れるかは F事業リーダー判断
- 本番に出すには: 本番 D1 に migration 089 → deploy:prod → 文面 OK 後に `FURIM_RENEWAL_UNLOCK=on`（wrangler.toml の env.prod.vars か secret）。デプロイだけでは何も起きない

## 次のアクション

- 文面 3 通の案を親 TB-25 に出す → 黒岩さんへテスト → くろさん OK
- 本番デプロイ（migration 089 + deploy:prod）は F事業リーダーの決定をもらってから。`FURIM_RENEWAL_UNLOCK=on` は文面 OK のあと
