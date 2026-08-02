# LineHarness — FurimAuto 開発ガイド

このリポジトリは LINE Harness OSS のフォーク。FurimAuto 用にカスタマイズして運用している。

## 作業開始前に必ず読む

1. **`docs/furimauto/README.md`** — 現状・残作業・よく使うコマンド
2. **`docs/furimauto/scenarios.md`** — シナリオ体系・セグメント判定ロジック
3. **`docs/furimauto/tags.md`** — 28タグ定義・付与タイミング

OSS汎用仕様は `docs/wiki/` にある（基本触らない）。

## フォーク元(upstream)を取り込む時は必ず

1. **`docs/furimauto/FORK_OVERLAY.md`** を読む — FurimAuto が upstream の既存共有ファイルに入れている独自フックの生きたレジストリ。コンフリクトしやすい箇所と再適用方針が載っている。
2. マージは手動 `git merge` ではなく **`scripts/merge-upstream.sh`** を使う — FORK_OVERLAY を自動参照し、今回 upstream 側でも変更された＝コンフリクト確定のファイルを事前警告し、コンフリクト時は該当フックの再適用方針を表示する。
3. **共有ファイルに新しい独自フックを足したら、必ず `FORK_OVERLAY.md` のレジストリに1行追記する**（state を最新に保つ。これを怠ると次回マージで見落とす）。
4. 独自ロジックは極力 `apps/worker/src/furim/` ・ `apps/web/src/components/furim/` に隔離し、共有ファイルへの注入は「数行＋furim/側の呼び出し」に留める。

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
# 内部: vite build && wrangler deploy --config dist/line_harness/wrangler.json

# フロントエンド（apps/web）を変更した場合
cd apps/web && npm run build
npx wrangler pages deploy out --project-name=line-harness-admin --branch=furim/dev

# 両方変更した場合は両方実行する
```

```bash
# NG: vite buildをスキップして古いコードが使われる
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

### automation_actions.template_id の二重管理

`automation_actions` テーブルに `template_id` カラムがあるが、フォームは `params` JSON側に保存する。
古いデータはカラムにのみ値がある。**2箇所でparamsにマージが必要:**

1. `routes/automations.ts` の `mapAction()` — UIレスポンス用
2. `services/event-bus.ts` の `actionRows.map` — 実行時

どちらか片方だと「UIは直ったが送信は古いテキスト」になる。

### send_messages はテンプレートをライブ取得

`template_id` があれば `resolveTemplateMessages()` でDBから毎回最新を取得。
テンプレートを編集すれば即反映。`params.messages` の再保存は不要。

### cron の時間制限

| 処理 | 実行時間 |
|------|---------|
| シナリオステップ配信 | 9:00〜23:00 JST のみ |
| kaisetsu_daily 発火 | 21:00 JST のみ |
| その他（broadcast / reminder） | 制限なし |

### kaisetsu_daily オートメーション

`meta.kaisetsu=true` のユーザーに毎日21時に `remaining_days` 付きでイベント発火。
条件 `remaining_days_gte` / `remaining_days_lte` でアクション振り分け。
オートメーション3本: `auto-kaisetsu-5plus` / `auto-kaisetsu-2to4` / `auto-kaisetsu-1day`

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
