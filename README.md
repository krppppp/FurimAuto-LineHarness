# FurimAuto LINE Harness

LINE Harness OSSのFurimAutoフォーク。FurimAutoのLINE管理システムをCloudflare Workers + D1に移行するための独自実装を追加する。

大元OSS: https://github.com/Shudesu/line-harness-oss

---

## 環境構成

| | Dev | Prod（予定） |
|---|---|---|
| Worker | `https://line-harness.furimuato.workers.dev` | TBD |
| 管理UI | `https://furim-dev.line-harness-admin-7je.pages.dev` | TBD |
| D1 | `line-crm`（Cloudflare） | TBD |
| LINEチャネル | DEVチャネル（ID: 1661091589） | PRODチャネル |

---

## ローカル開発

```bash
cd ~/github/FurimAuto/LineHarness
pnpm dev
```

`localhost:3001` が開く。APIはデプロイ済みWorker（Dev）に接続するためDBはDev環境と共通。

---

## デプロイ

### Worker（API）

```bash
cd apps/worker
pnpm run deploy
```

→ `https://line-harness.furimuato.workers.dev`

### 管理UI（web）

```bash
cd apps/web
pnpm build && npx wrangler pages deploy out --project-name=line-harness-admin --commit-dirty=true
```

→ `https://furim-dev.line-harness-admin-7je.pages.dev`

---

## シークレット登録（初回 or 再登録）

必ず `printf` でパイプして登録する（インタラクティブ入力は値が空になるバグあり）。

```bash
cd apps/worker

printf 'VALUE' | npx wrangler secret put LINE_CHANNEL_SECRET
printf 'VALUE' | npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
printf 'VALUE' | npx wrangler secret put LINE_CHANNEL_ID
printf 'VALUE' | npx wrangler secret put LINE_LOGIN_CHANNEL_ID
printf 'VALUE' | npx wrangler secret put LINE_LOGIN_CHANNEL_SECRET
printf 'VALUE' | npx wrangler secret put API_KEY
```

登録確認:
```bash
npx wrangler secret list
```

---

## D1マイグレーション

```bash
# リモート（Dev環境）
npx wrangler d1 execute line-crm --file=packages/db/schema.sql --remote --config=apps/worker/wrangler.toml

# ローカル
npx wrangler d1 execute line-crm --file=packages/db/schema.sql --local --config=apps/worker/wrangler.toml
```

---

## Git構成

```
main          ← 大元(upstream)追跡専用・触らない
furim/main    ← 自社本番ブランチ
furim/dev     ← 日常開発ブランチ（デフォルト作業場所）
```

### 週次upstream同期

```bash
git fetch upstream
git checkout main
git merge upstream/main
git checkout furim/main
git merge main
```

### remote

```
origin   → https://github.com/krppppp/FurimAuto-LineHarness.git（自社フォーク）
upstream → https://github.com/Shudesu/line-harness-oss.git（大元OSS）
```

---

## 独自実装の方針

- 大元ファイルは原則直接編集しない
- 独自コードは `apps/worker/src/furim/` 以下に追加
- 大元ルーターへの変更は最小限のフック追加のみ

---

## FurimAutoとの移行状況

| 機能 | 現行 | LINE Harness | 移行状況 |
|------|------|-------------|---------|
| LINE Webhook | CloudFunctions | Cloudflare Workers | Phase 2 |
| 顧客DB | Google Sheets | Cloudflare D1 | Phase 3 |
| ステップ配信 | GAS | 内蔵シナリオ | Phase 3 |
| Stripe連携 | CloudFunctions | Workers（移植予定） | Phase 3 |
| AIチャットボット | Gemini + Firebase | Workers（移植予定） | Phase 3 |
| 15大特典 | GAS | IF-THEN（検証中） | Phase 3 |

---

## 注意事項

- `apps/worker/.dev.vars` にLINEシークレットを記載（.gitignore済み）
- `apps/web/.env.local` のAPIキーはワーカーのAPI_KEYと一致させる
- 既存友達（Google Sheets上）はD1に未移行のためWebhookを受信しても無視される（webhook.ts:196）
- `wrangler.toml` のR2設定はコメントアウト中（未使用）
