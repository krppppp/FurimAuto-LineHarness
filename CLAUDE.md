# LineHarness — FurimAuto 開発ガイド

このリポジトリは LINE Harness OSS のフォーク。FurimAuto 用にカスタマイズして運用している。

## 作業開始前に必ず読む

1. **`docs/furimauto/README.md`** — 現状・残作業・よく使うコマンド
2. **`docs/furimauto/scenarios.md`** — シナリオ体系・セグメント判定ロジック
3. **`docs/furimauto/tags.md`** — 28タグ定義・付与タイミング

OSS汎用仕様は `docs/wiki/` にある（基本触らない）。

---

## ドキュメント構成

```
docs/
├── wiki/          ← OSS仕様（フォーク元。変更しない）
└── furimauto/     ← FurimAuto固有（ここを読み書きする）
    ├── README.md             ← 次セッションの出発点
    ├── production-deploy.md  ← 本番構築手順 STEP1〜9
    ├── scenarios.md          ← シナリオ設計・seed手順
    ├── tags.md               ← タグ定義・実装箇所
    └── devlog/               ← 作業ログ（日付ごと）
```

作業ログは `docs/furimauto/devlog/YYYY-MM-DD-{task}.md` に記録する。
合わせて `.claude-company/departments/engineering/furim-auto/` にも同内容を記録（仮想会社側）。

---

## 重要な落とし穴

### デプロイ

**コードを変更したら必ず該当レイヤーをデプロイまで完結させる。**

```bash
# バックエンド（apps/worker）を変更した場合
cd apps/worker && npm run deploy

# フロントエンド（apps/web）を変更した場合
cd apps/web && npm run build
wrangler pages deploy out --project-name line-harness-admin --commit-message "..." --commit-dirty=true

# 両方変更した場合は両方実行する
```

```bash
# NG: wrangler.toml 経由になり古いコードが使われる
npx wrangler deploy
```

### 認証ヘッダー
```
Authorization: Bearer {API_KEY}   ← 正しい
X-API-Key: {API_KEY}              ← 不正解
```

### image メッセージの messageContent
URLを直接入れるとパースエラー。必ずJSON文字列で:
```json
{"originalContentUrl": "https://...", "previewImageUrl": "https://..."}
```

### 動作確認環境

**ローカル環境は使わない。** 全ての動作確認は Dev 環境（リモート）で行う。

- フロントエンド: https://furim-dev.line-harness-admin-7je.pages.dev/
- Worker: https://line-harness.furimuato.workers.dev
- D1: `--remote` フラグ必須

`wrangler d1 execute` は必ず `--remote` を付ける。`--local` は絶対に使わない。

### D1マイグレーション
`packages/db/migrations/` を全て順番に適用する。`--remote` フラグを忘れずに。

---

## wrangler secrets（Dev登録済み）

`API_KEY` / `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` /
`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `GAS_DEPLOY_ID` /
`RICHMENU_MEMBER_HOME` / `RICHMENU_DEFAULT_HOME` / `GEMINI_API_KEY` / `GITHUB_PAT`

---

## Dev / Prod 対応

| 項目 | Dev | Prod |
|------|-----|------|
| Worker URL | `https://line-harness.furimuato.workers.dev` | 未構築（`production-deploy.md` 参照） |
| D1 | `line-crm` | `line-crm-prod`（未作成） |
| デプロイ | `pnpm deploy` | `npm run deploy -- --env production` |

---

## 関連リポジトリ・ファイル

| パス | 内容 |
|------|------|
| `/Users/kurow/github/FurimAuto/GAS/CRM_GAS/` | 顧客管理ロジック（GAS） |
| `.claude-company/projects/furim-auto/overview.md` | プロジェクト全体像 |
| `.claude-company/projects/furim-auto/knowledge.md` | ハマりポイント集 |
