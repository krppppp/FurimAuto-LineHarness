# FurimAuto — LineHarness 固有ドキュメント

このフォルダは FurimAuto に特化した仕様・運用ドキュメントをまとめる。
OSS（フォーク元）の汎用仕様は `docs/wiki/` にある。

---

## ファイル一覧

| ファイル | 内容 |
|---------|------|
| [production-deploy.md](production-deploy.md) | 本番環境構築手順（STEP1〜9）。Prod未構築時はここから始める |
| [scenarios.md](scenarios.md) | 14シナリオ体系・セグメント判定ロジック・kaisetsuフロー・seed手順 |
| [tags.md](tags.md) | 28タグ一覧・付与/削除タイミング・switchSegmentTag実装箇所 |
| [devlog/](devlog/) | 作業ログ（日付ごと。何をいつどう実装したか） |

---

## 現状（2026-04-01 時点）

- **Dev環境**: 稼働中 (`https://line-harness.furimuato.workers.dev`)
- **Prod環境**: 未構築。`production-deploy.md` の STEP1〜9 を順番に実施する
- **GAS**: Dev 確認済み。本番反映は `make prod-deploy`（`GAS/CRM_GAS/` から実行）

### 実装済み（Dev確認済み）

| 機能 | ファイル |
|------|---------|
| LINE Webhook受信・ハンドラー振り分け | `apps/worker/src/routes/webhook.ts` |
| 【ボタン】処理（チケット購入・アンケート等） | `apps/worker/src/furim/button-actions.ts` |
| 【キーワード】処理（登録URL・紹介コード等） | `apps/worker/src/furim/keyword-actions.ts` |
| AIチャット（Gemini 2.0 Flash） | `apps/worker/src/furim/ai-chat.ts` |
| リッチメニュー切り替え | `apps/worker/src/furim/actions.ts` |
| Stripe Webhook全イベント | `apps/worker/src/routes/stripe.ts` |
| scenario-switch（月額会員ガード付き） | `apps/worker/src/routes/furim.ts` |
| セグメント8段階・フォローイベント | `apps/worker/src/routes/webhook.ts` |
| kaisetsu-delivery cron | `apps/worker/src/services/kaisetsu-delivery.ts` |

### 残作業（次のセッションで着手）

優先度高（本番稼働に必要）:
1. **Prod DB構築** — `production-deploy.md` STEP1〜9
2. **Stripeダッシュボード** — `payment_intent.succeeded` をWebhookイベントに追加（手動）
3. **GAS Prodデプロイ** — `make prod-deploy`（`GAS/CRM_GAS/` から）
4. **本番Stripe Webhook URL確認** — `https://line-harness-prod.*.workers.dev` を向いているか

優先度中:
5. **`import-customers.mjs` 本番実行** — `--dry-run` で確認後に実施
6. **シナリオseed本番実行** — `scripts/seed-furimauto-all-scenarios.mjs`
7. **CloudFunctions廃止判断** — Chrome拡張APIをLineHarnessに移行するか判断

優先度低:
8. **友達紹介コード→GASシート書き込み動作確認**
9. **E2E動作確認チェックリスト**

---

## よく使うコマンド

```bash
# デプロイ（リポジトリルートから）
pnpm deploy

# Worker ローカル起動（apps/worker/ で）
npx wrangler dev --remote

# D1 直接操作（dev）
npx wrangler d1 execute line-crm --remote --command "SELECT ..."

# GAS デプロイ
cd /Users/kurow/github/FurimAuto/GAS/CRM_GAS
make deploy        # dev
make prod-deploy   # prod
```

---

## 他のドキュメントの場所

| 場所 | 内容 |
|------|------|
| `docs/wiki/` | OSS汎用仕様（フォーク元。基本変更しない） |
| `.claude-company/projects/furim-auto/overview.md` | プロジェクト全体像（Chrome拡張・GAS・LineHarness） |
| `.claude-company/projects/furim-auto/knowledge.md` | ハマりポイント・設計判断メモ |
| `.claude-company/departments/engineering/furim-auto/` | 作業ログ（日付ごと） |
