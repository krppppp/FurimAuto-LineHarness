# FurimAuto LineHarness 本番(PROD)構築 Runbook

2026-06-10作成。`production-deploy.md` をこのリポジトリの実態（migrations 001〜019・seed群・登録日修正済みimport）に合わせて具体化した実行版。
**上から順にターミナルで実行する。** `{{...}}` は自分の値に置換。

前提（全て有る前提で記載）: 本番Messaging APIチャネル / 本番LINE Loginチャネル / 本番GASスプレッド / Stripe本番。
作業ディレクトリ: `cd ~/github/FurimAuto/LineHarness`
認証: 最初に `npx wrangler whoami` で確認（切れてたら `npx wrangler login`）。

---

## STEP 1: 本番D1作成

```bash
npx wrangler d1 create line-crm-prod
```
→ 出力の `database_id` をメモ（= `{{PROD_D1_ID}}`）。

## STEP 2: wrangler.toml に本番環境を追記

`apps/worker/wrangler.toml` の末尾に追記（既存DEV設定は残す）:

```toml
[env.production]
name = "line-harness-prod"
workers_dev = true

[[env.production.d1_databases]]
binding = "DB"
database_name = "line-crm-prod"
database_id = "{{PROD_D1_ID}}"
```

## STEP 3: 本番D1にスキーマ＋マイグレーション適用

DEVと同じ手順（schema.sql=80テーブル → migrations/ を番号順）。
```bash
cd apps/worker
# ベーススキーマ
npx wrangler d1 execute line-crm-prod --remote --file=../../packages/db/schema.sql
# 追加マイグレーション(001〜019)を順に
for f in ../../packages/db/migrations/*.sql; do
  echo "applying $f"
  npx wrangler d1 execute line-crm-prod --remote --file="$f"
done
cd ../..
```
**注意**: schema.sqlが一部カラムを先取りしているため、migration適用中に `duplicate column name` / `already exists` エラーが出ることがある。**これは想定内・無視してよい**（DEVも同じだった）。

確認:
```bash
npx wrangler d1 execute line-crm-prod --remote --command "SELECT count(*) AS tables FROM sqlite_master WHERE type='table'"
```

## STEP 3.5: 本番Loginチャネルに「友だち追加LIFF」を作成（DEV踏襲・新規）

DEVで作った友だち登録経路用LIFF（`1661091589-FAPZy1Xp`）が本番には未追加。本番Loginチャネル（Stripe決済LIFFがある所）に**もう1つLIFFアプリを追加**する。
本番Worker URLは予測可能（`https://line-harness-prod.furimuato.workers.dev`）なので、デプロイ前に作ってLIFF IDを先取りできる。

1. LINE Developers → 本番【LINE Loginチャネル】→ LIFF → 追加
   - サイズ: **Full**
   - エンドポイントURL: **`https://line-harness-prod.furimuato.workers.dev`**（Worker root）
   - スコープ: **profile / openid / email**
   - **ボットリンク機能: On (Aggressive)**（必須＝友だち登録経路の肝）
   - → 発行された **LIFF ID = `{{PROD_LIFF_ID}}`**（`{本番LoginチャネルID}-xxxx`）をメモ
2. 同チャネル →「LINEログイン設定」→「リンクされたボット」→ 本番Messaging APIチャネルを選択（未リンクだと友だち判定が壊れる）

→ この `{{PROD_LIFF_ID}}` を STEP4 の `VITE_LIFF_ID`、STEP5 の `LIFF_URL` に使う。

## STEP 3.6: 本番OAにリッチメニュー4種を作成（RICHMENU_* 用）

リッチメニューは**OAごとに別ID**でDEV値流用不可。本番OAに4種作って各 `richmenu-xxxx` を取得 → STEP5の `RICHMENU_*` に入れる。

切替の仕組み（`furim/rich-menu.ts` で確認済み）: 各メニューのタブボタンに **`message` アクションで以下テキストを送る**よう仕込む必要がある（ただ画像を貼るだけではダメ）。
| 必要メニュー | env | タブが送るテキスト | 切替時の挙動 |
|---|---|---|---|
| デフォルトホーム（非会員/フォロー時） | `RICHMENU_DEFAULT_HOME` | `【リッチメニュー】ホームタブ` | 非会員はこれ |
| 会員ホーム | `RICHMENU_MEMBER_HOME` | `【リッチメニュー】ホームタブ` | 会員はこれ |
| ガイド | `RICHMENU_GUIDE` | `【リッチメニュー】ガイドタブ` | ガイドメニューへ |
| Q&A | `RICHMENU_QANDA` | `【リッチメニュー】Q&Aタブ` | Q&Aメニュー＋AIモードON |
| （AI終了ボタン） | — | `【リッチメニュー】AIチャットボットを終了する` | ホームに戻す＋AIモードOFF |

- フォロー直後は `RICHMENU_DEFAULT_HOME` が自動で貼られる（`linkDefaultRichMenuOnFollow`）。
- 会員判定は `friend_tags` の **タグ名 `'会員'`** を見る（`rich-menu.ts:19`）。※現状シード/importは `'月額会員'` を付けており不一致＝会員でも会員メニューが出ない可能性。**要修正**（`'会員'`付与 or 判定を`'月額会員'`に合わせる）。
- 作成方法（DEVの実績を確認して確定）: 管理UI `/rich-menus` か LINE Messaging API（`createRichMenu`＋画像アップロード＋`setDefaultRichMenu`）。← 別途詰める。

## STEP 4: 本番Workerデプロイ（buildとdeployを分ける）

**ハマり注意（実証済み）**: STEP2のwrangler.tomlは環境名を `[env.prod]` にし、`name=` は書かない（書くと二重化する）。
`pnpm run deploy`（build+deployを1コマンドで実行）に `CLOUDFLARE_ENV` を付けると、vite側で環境適用された名前(line-harness-prod)に wrangler側がさらに環境サフィックスを付けて `line-harness-prod-production` のように**二重化する**。
回避策＝**buildだけ `CLOUDFLARE_ENV=prod` で実行し、deployは環境変数なしで生成済みjsonをそのまま流す**:

```bash
cd apps/worker
# build（CLOUDFLARE_ENV=prod で prod設定の wrangler.json を生成）
CLOUDFLARE_ENV=prod VITE_LIFF_ID={{PROD_LIFF_ID}} VITE_BOT_BASIC_ID=@{{本番ベーシックID}} pnpm run build
# deploy（CLOUDFLARE_ENV なし＝サフィックス付与されない）
npx wrangler deploy --config dist/line_harness/wrangler.json
cd ../..
```
出力で必ず確認:
- `Uploaded line-harness-prod`（ちょうどこの名前。`-prod-production` や `-prod-prod` はNG）
- `env.DB (line-crm-prod)` ／ `schedule: */5 * * * *`

→ URL `https://line-harness-prod.furimuato.workers.dev`（= `{{PROD_WORKER_URL}}`）。name/cron/assets は top-level から自動継承される（検証済み）。
※ 二重名Workerを誤って作ったら `npx wrangler delete --name line-harness-prod-production` で削除。

## STEP 5: 本番Workerにsecrets設定

**必ず `printf 'VALUE' | npx wrangler secret put KEY --env prod` 形式**（インタラクティブ入力は空になるバグあり・dev-setup既知）。

**DEVデプロイ済みWorkerと同じ17 secretを揃える**（`npx wrangler secret list`(DEV) と `--env prod` の差分で確認）。値の出どころ別:
- **本番固有**（DEVと別物・新規取得）: LINE系5・LIFF_URL・GAS_DEPLOY_ID・Stripe2・RICHMENU×4
- **使い回し可**（同一アカウント/プロジェクト・DEV値でOK）: GEMINI_API_KEY・GITHUB_PAT・FIREBASE_DATABASE_URL
- **自分で決める**: API_KEY

```bash
cd apps/worker
# --- LINE Messaging API（本番チャネル） ---
printf '{{本番LINE_CHANNEL_ID}}'           | npx wrangler secret put LINE_CHANNEL_ID --env prod
printf '{{本番LINE_CHANNEL_SECRET}}'       | npx wrangler secret put LINE_CHANNEL_SECRET --env prod
printf '{{本番LINE_CHANNEL_ACCESS_TOKEN}}' | npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN --env prod
# --- LINE Login（本番チャネル） ---
printf '{{本番LINE_LOGIN_CHANNEL_ID}}'     | npx wrangler secret put LINE_LOGIN_CHANNEL_ID --env prod
printf '{{本番LINE_LOGIN_CHANNEL_SECRET}}' | npx wrangler secret put LINE_LOGIN_CHANNEL_SECRET --env prod
printf 'https://liff.line.me/{{PROD_LIFF_ID}}' | npx wrangler secret put LIFF_URL --env prod   # ←Worker URLではなくliff.line.me/{LIFF_ID}（liff.tsが正規表現でID抽出）
# --- API認証・GAS ---
printf 'prod-furimauto-{{ランダム}}'        | npx wrangler secret put API_KEY --env prod   # = {{PROD_API_KEY}}。自分で決める
printf '{{本番GAS_DEPLOY_ID}}'             | npx wrangler secret put GAS_DEPLOY_ID --env prod
# --- Stripe（本番Live） ---
printf '{{whsec_本番}}'                     | npx wrangler secret put STRIPE_WEBHOOK_SECRET --env prod
printf '{{sk_live_本番}}'                   | npx wrangler secret put STRIPE_SECRET_KEY --env prod
# --- AIチャット（DEV値を使い回しOK） ---
printf '{{GEMINI_API_KEY}}'                | npx wrangler secret put GEMINI_API_KEY --env prod
printf '{{GITHUB_PAT}}'                     | npx wrangler secret put GITHUB_PAT --env prod
printf '{{https://xxxx-default-rtdb.firebaseio.com}}' | npx wrangler secret put FIREBASE_DATABASE_URL --env prod  # AIモード/会話履歴。同一Firebaseプロジェクト＝DEVと同値
# --- リッチメニュー（本番OAのメニューID。STEP3.6で作成 → そのIDを入れる） ---
printf '{{richmenu-本番デフォルトホーム}}'   | npx wrangler secret put RICHMENU_DEFAULT_HOME --env prod
printf '{{richmenu-本番会員ホーム}}'         | npx wrangler secret put RICHMENU_MEMBER_HOME --env prod
printf '{{richmenu-本番ガイド}}'             | npx wrangler secret put RICHMENU_GUIDE --env prod
printf '{{richmenu-本番Q&A}}'                | npx wrangler secret put RICHMENU_QANDA --env prod

npx wrangler secret list --env prod   # 確認＝DEVと同じ17個揃えばOK
cd ../..
```
**全17キー**: LINE_CHANNEL_ID / LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN / LINE_LOGIN_CHANNEL_ID / LINE_LOGIN_CHANNEL_SECRET / LIFF_URL / API_KEY / GAS_DEPLOY_ID / STRIPE_WEBHOOK_SECRET / STRIPE_SECRET_KEY / GEMINI_API_KEY / GITHUB_PAT / FIREBASE_DATABASE_URL / RICHMENU_DEFAULT_HOME / RICHMENU_MEMBER_HOME / RICHMENU_GUIDE / RICHMENU_QANDA
（`WORKER_URL`/`X_HARNESS_URL` はコード参照あるがDEVにも無い＝不要。cron配信の絶対URLが要る等あれば後で `WORKER_URL={{PROD_WORKER_URL}}` を追加）

> **RICHMENU×4** は本番OA固有のID。本番OAにリッチメニュー4種を作成して各 `richmenu-xxxx` を取得する必要がある（→ STEP3.6 参照）。

## STEP 6: 初期データ投入

### (a) タグ28件
```bash
cd apps/worker
npx wrangler d1 execute line-crm-prod --remote --command "
INSERT OR IGNORE INTO tags (id, name, color, created_at) VALUES
 (lower(hex(randomblob(16))),'無料試用期間中','#22C55E',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'セグメント1','#6366F1',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'セグメント2','#6366F1',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'セグメント3','#6366F1',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'セグメント4','#6366F1',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'セグメント5','#6366F1',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'セグメント6','#6366F1',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'セグメント7','#6366F1',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'セグメント8','#6366F1',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'紹介経由','#F59E0B',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'Furimanです','#F59E0B',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'解説見た','#F59E0B',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'月額会員','#3B82F6',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'月額3000','#3B82F6',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'月額5000','#3B82F6',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'月額8000','#3B82F6',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'月額10000','#3B82F6',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'月額15000','#3B82F6',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'月額19800','#3B82F6',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'サブアカウント','#3B82F6',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'サブ垢','#3B82F6',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'アンバサダーLv.1','#EC4899',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'アンバサダーLv.5','#EC4899',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'アンバサダーLv.10','#EC4899',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'キャンセル済み','#EF4444',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'ブロック','#EF4444',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'未使用ユーザー','#6B7280',datetime('now','+9 hours')),
 (lower(hex(randomblob(16))),'見込客','#F97316',datetime('now','+9 hours'))
"
npx wrangler d1 execute line-crm-prod --remote --command "SELECT COUNT(*) FROM tags"  # 28
cd ../..
```

### (b) シナリオ14本
```bash
WORKER_URL={{PROD_WORKER_URL}} API_KEY={{PROD_API_KEY}} node scripts/seed-furimauto-all-scenarios.mjs
# 確認
npx wrangler d1 execute line-crm-prod --remote --command "SELECT name FROM scenarios ORDER BY name" --config apps/worker/wrangler.toml
```

### (c) オートメーション（friend_add時のタグ付与・Stripe顧客作成 等）
```bash
node scripts/seed-automations.mjs --prod
```

### (d) 顧客データ投入（643件・登録日修正済みスクリプト）
master.tsv / referrals.tsv は `~/github/FurimAuto/` にある最新版を使用。本番は実友だちなので `--enrich`（プロフィール画像取得・ブロック判定）推奨。
```bash
WORKER_URL={{PROD_WORKER_URL}} API_KEY={{PROD_API_KEY}} \
LINE_CHANNEL_ACCESS_TOKEN={{本番LINE_CHANNEL_ACCESS_TOKEN}} \
node scripts/import-customers.mjs \
  --master=/Users/kurow/github/FurimAuto/master.tsv \
  --referrals=/Users/kurow/github/FurimAuto/referrals.tsv \
  --enrich
# fetch failed等で取りこぼしたら、出力の [error][N] の N を見て該当だけ再実行:
#   ... node scripts/import-customers.mjs --master=... --referrals=... --enrich --offset=$((N-1)) --limit=1
```

## STEP 7: LINE Developers Console（本番チャネル）

- Messaging API: Webhook URL = `{{PROD_WORKER_URL}}/webhook` ／ Webhook利用ON ／ 応答メッセージOFF ／ あいさつメッセージOFF
- LINE Login: LIFF Endpoint URL = `{{PROD_WORKER_URL}}` ／ Scope=`profile,openid`

## STEP 8: 本番GASのスクリプトプロパティ

| キー | 値 |
|---|---|
| `LINE_HARNESS_WORKER_URL` | `{{PROD_WORKER_URL}}` |
| `LINE_HARNESS_API_KEY` | `{{PROD_API_KEY}}` |

## STEP 9: 動作確認

```bash
curl {{PROD_WORKER_URL}}/openapi.json | jq .info
curl -H "Authorization: Bearer {{PROD_API_KEY}}" {{PROD_WORKER_URL}}/api/friends/count   # 643付近
curl -H "Authorization: Bearer {{PROD_API_KEY}}" {{PROD_WORKER_URL}}/api/scenarios | jq '.data|length'  # 14
```
- [ ] LINEで本番OAをフォロー → ウェルカム配信が届く
- [ ] GASの sendStepMessages が本番Worker URLを叩いている
- [ ] Stripeテスト決済 → webhook受信OK（決済断が無いこと）
- [ ] 管理UI（Pagesに本番UIを別途デプロイする場合）から friends/scenarios が見える

## STEP 10: 切替後

- 一定期間（数日〜1週間）旧CloudFunctions/GASと並行監視 → 問題なければ CloudFunctions / 旧GASトリガー停止・廃止。
- 作業ブランチを `furim/main` にマージ。

---

## リスク・注意
- **Stripe決済断（深刻度高）**: STEP7のwebhook切替は低トラフィック帯に。切替直後にStripeテスト決済で疎通確認。
- secrets投入は必ず `printf | wrangler secret put`（対話入力は空になる）。
- 顧客import: `created_at` は `友達登録日時` 列から入る（1桁時刻も対応済み）。`--enrich` はレート制限で時間がかかる＆途中断あり→ `--offset/--limit` で分割/再実行。
- 管理UI(web)を本番でも見たい場合は別途 `apps/web` を Pages に本番ブランチでデプロイ（production-deploy.md外）。
