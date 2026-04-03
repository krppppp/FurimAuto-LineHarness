# FurimAuto — LineHarness 固有ドキュメント

このフォルダは FurimAuto に特化した仕様・運用ドキュメントをまとめる。
OSS（フォーク元）の汎用仕様は `docs/wiki/` にある。

---

## ファイル一覧

| ファイル | 内容 |
|---------|------|
| [production-deploy.md](production-deploy.md) | 本番環境構築手順（STEP1〜9）。Prod未構築時はここから始める |
| [automations.md](automations.md) | オートメーション仕様（automation_actions, 全アクションタイプ, 分岐, テンプレート変数） |
| [scenarios.md](scenarios.md) | 14シナリオ体系・セグメント判定ロジック・kaisetsuフロー・seed手順 |
| [tags.md](tags.md) | 28タグ一覧・付与/削除タイミング・switchSegmentTag実装箇所 |
| [devlog/](devlog/) | 作業ログ（日付ごと。何をいつどう実装したか） |

---

## 現状（2026-04-03 時点）

- **Dev環境**: 稼働中 (`https://line-harness.furimuato.workers.dev`)
- **管理UI Dev**: https://furim-dev.line-harness-admin-7je.pages.dev/
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
| automation_actions テーブル＋CRUD API | `apps/worker/src/routes/automations.ts` |
| オートメーション管理画面（分岐表示） | `apps/web/src/app/automations/page.tsx` |
| **messages / template_messages テーブル** | `packages/db/migrations/015〜017` |
| **テンプレート複数カテゴリ（scenario/broadcast/automation）** | `apps/worker/src/routes/templates.ts` |
| **シナリオ統合（通常/紹介→6本）＋1ステップ=1テンプレート** | `scripts/generate-furimauto-templates-sql.mjs` |
| **step-delivery: template_messages 対応** | `apps/worker/src/services/step-delivery.ts` |

### 残作業

優先度高（本番稼働に必要）:
1. **Prod DB構築** — `production-deploy.md` STEP1〜9
2. **Stripeダッシュボード** — `payment_intent.succeeded` をWebhookイベントに追加（手動）
3. **GAS Prodデプロイ** — `make prod-deploy`（`GAS/CRM_GAS/` から）
4. **本番Stripe Webhook URL確認** — Worker URL を向いているか確認

優先度中:
5. **`import-customers.mjs` 本番実行** — `--dry-run` で確認後に実施
6. **本番シナリオseed** — `scripts/generate-furimauto-templates-sql.mjs` を使用（`seed-furimauto-all-scenarios.mjs` は廃止）
7. **CloudFunctions廃止判断** — Chrome拡張APIをLineHarnessに移行するか判断

優先度低:
8. **友達紹介コード→GASシート書き込み動作確認**
9. **E2E動作確認チェックリスト**（新規登録→試用→キーコード→月額登録→継続→解約）

---

## よく使うコマンド

```bash
# デプロイ（リポジトリルートから）
pnpm deploy

# D1 直接操作（--remote 必須。--local は使わない）
npx wrangler d1 execute line-crm --remote --command "SELECT ..."

# シナリオ+テンプレート再シード
node scripts/generate-furimauto-templates-sql.mjs > /tmp/furimauto-templates.sql
cd apps/worker && npx wrangler d1 execute line-crm --remote --file=/tmp/furimauto-templates.sql

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
