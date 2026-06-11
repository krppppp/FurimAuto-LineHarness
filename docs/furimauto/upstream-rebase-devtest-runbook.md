# upstream-rebase DEVテスト Runbook

`furim/upstream-rebase` ブランチ（upstream最新＋FurimAuto独自再適用）をDEVで動かして検証する手順。
worker/web 両方ビルド通過済み。残りはDB用意＋デプロイ＋動作確認（くろさんの環境で実行）。

前提: `git checkout furim/upstream-rebase`

## 1. ビルド（monoregoはpackagesを先に）
```bash
cd ~/github/FurimAuto/LineHarness
pnpm install
pnpm --filter './packages/*' run build      # ← 先にpackages（update-engine等）
pnpm --filter worker run build               # → ✓ built
NEXT_PUBLIC_API_URL=https://line-harness.furimuato.workers.dev NEXT_PUBLIC_API_KEY=dev-furimauto-key pnpm --filter web run build  # → 43ページ
```

## 2. 検証用DB作成（既存 line-crm は汚さず新規）
rebaseは upstreamスキーマ＋FurimAuto独自テーブル。既存line-crm(FurimAutoスキーマ)とは別物なので新規DBで:
```bash
cd apps/worker
npx wrangler d1 create line-crm-rebase    # → database_id をメモ
# スキーマ＋migration（番号順。046_furim_tables.sql が FurimAuto独自テーブル）
npx wrangler d1 execute line-crm-rebase --remote --file=../../packages/db/schema.sql
for f in ../../packages/db/migrations/*.sql; do echo "applying $f"; npx wrangler d1 execute line-crm-rebase --remote --file="$f"; done
# ※ duplicate column 等の警告は想定内（schema先取り分）。046は最後に適用される
# 確認
npx wrangler d1 execute line-crm-rebase --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('automation_actions','messages','template_messages','scenario_steps','automations','templates')"
```

## 3. wrangler.toml のDBを検証用に向ける（テスト中だけ）
`apps/worker/wrangler.toml` の top-level `[[d1_databases]]` の `database_id` を **line-crm-rebase のID** に一時変更（テスト後に戻す）。
※ secretsはDEV worker(line-harness)に既存のものを流用。

## 4. 初期データ（最小）
```bash
# タグ28（本番構築runbookのINSERT流用、line-crm-rebase 宛に）
# オートメーション（automation_actions テーブルに入る）
cd ~/github/FurimAuto/LineHarness
# seed-automations は DB名を line-crm-rebase に変える必要がある（スクリプト内 DB_NAME）。
# 簡易には seed-automations.mjs をコピーして DB_NAME='line-crm-rebase' に。
# シナリオは「後で再構築」方針なので一旦スキップ可。
```

## 5. デプロイ（DEV）
```bash
cd apps/worker
# rebase worker（DEV名 line-harness のまま検証DBに向く）
pnpm run build && npx wrangler deploy --config dist/line_harness/wrangler.json
# web
cd ../web
NEXT_PUBLIC_API_URL=https://line-harness.furimuato.workers.dev NEXT_PUBLIC_API_KEY=dev-furimauto-key pnpm build
npx wrangler pages deploy out --project-name=line-harness-admin --branch=furim/dev --commit-dirty=true
```

## 6. 動作確認チェックリスト（DEVチャネルで）
- [ ] 友だち追加 → friend が作られる（webの friends に出る）＋ friend_add automation 発火（タグ/リッチメニュー）
- [ ] 【ボタン】【キーワード】メッセージ → 各 handler 応答
- [ ] リッチメニュー切替（ホーム/ガイド/Q&A）
- [ ] AIチャット（Q&Aタブ → 質問）
- [ ] Stripeテスト決済 → webhook → タグ/クーポン
- [ ] cron（毎時0分）→ GAS sendStepMessages が叩かれる
- [ ] 管理UI(web)が rebase worker に接続して各ページ表示

## 7. 既知の残課題（テストで出たら対応）
- **シナリオ/日数配信**: upstream版エンジン(offset_days/delivery_time)。seedは新モデルで再構築が必要（CloudFunction参照）。
- friends(on_tag_added)・entry-routes・liff の細部は upstream版のまま（FurimAuto独自挙動が要るなら再適用）。
- web の FurimAuto独自調整（friends件数セレクタ等）は未再適用（upstream UI）。
- next.config は型エラー無視（暫定）。

## 8. 問題なければ本番へ
DEVで全部OK確認後、本番(line-crm-prod)に同様（schema+migrations+046適用、CLOUDFLARE_ENV=prodデプロイ）。
※ 本番は既にFurimAutoスキーマで稼働準備済みなので、upstreamスキーマへの移行は別途慎重に（offset列追加等）。
