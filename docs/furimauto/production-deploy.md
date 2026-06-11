# FurimAuto 本番環境デプロイ手順書

DEVとPRODを完全に分離した構成で本番環境を構築する手順。
一切ハマらないために、前提確認から動作確認まで順番どおりに実行すること。

---

## 前提確認

- [ ] Cloudflare アカウントにログイン済み（`npx wrangler whoami` で確認）
- [ ] LINE Developersで本番用Official Account（Messaging APIチャネル）が作成済み
- [ ] LINE Developersで本番用LINE Loginチャネルが作成済み
- [ ] GAS の本番スプレッドシートが存在する
- [ ] Stripe の本番アカウントが存在する（使う場合）

---

## STEP 1: 本番用D1データベース作成

```bash
npx wrangler d1 create line-crm-prod
```

出力される `database_id` をメモする。

```
✅ Successfully created DB 'line-crm-prod'
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  ← これをメモ
```

---

## STEP 2: wrangler.toml に本番環境設定を追加

`apps/worker/wrangler.toml` に以下を追記する（既存の設定はDEVのまま残す）:

```toml
[env.production]
name = "line-harness-prod"
workers_dev = true

[[env.production.d1_databases]]
binding = "DB"
database_name = "line-crm-prod"
database_id = "STEP1でメモしたID"
```

---

## STEP 3: 本番D1にスキーマ適用

```bash
cd /path/to/LineHarness

# メインスキーマ
npx wrangler d1 execute line-crm-prod --remote --file=packages/db/schema.sql

# 追加マイグレーション（番号順に全部実行）
npx wrangler d1 execute line-crm-prod --remote --file=packages/db/001_round2.sql
npx wrangler d1 execute line-crm-prod --remote --file=packages/db/002_round3.sql
npx wrangler d1 execute line-crm-prod --remote --file=packages/db/003_entry_routes.sql
npx wrangler d1 execute line-crm-prod --remote --file=packages/db/004_friend_metadata.sql
npx wrangler d1 execute line-crm-prod --remote --file=packages/db/005_step_branching.sql
npx wrangler d1 execute line-crm-prod --remote --file=packages/db/006_tracked_links.sql
npx wrangler d1 execute line-crm-prod --remote --file=packages/db/007_forms.sql
npx wrangler d1 execute line-crm-prod --remote --file=packages/db/008_multi_account.sql
npx wrangler d1 execute line-crm-prod --remote --file=packages/db/009_delivery_type.sql
npx wrangler d1 execute line-crm-prod --remote --file=packages/db/009_token_expiry.sql
npx wrangler d1 execute line-crm-prod --remote --file=packages/db/010_ad_conversions.sql
npx wrangler d1 execute line-crm-prod --remote --file=packages/db/011_staff_members.sql
npx wrangler d1 execute line-crm-prod --remote --file=packages/db/012_alt_text.sql
npx wrangler d1 execute line-crm-prod --remote --file=packages/db/013_video_message_type.sql
```

確認:
```bash
npx wrangler d1 execute line-crm-prod --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

---

## STEP 4: 本番Workerをデプロイ

```bash
cd apps/worker

# LIFF ビルド用の環境変数を指定してデプロイ
VITE_LIFF_ID=本番のLIFF_ID VITE_BOT_BASIC_ID=@本番のBotID npm run deploy -- --env production
```

デプロイ後のURL:
```
https://line-harness-prod.{accountサブドメイン}.workers.dev
```

---

## STEP 5: wrangler secrets を本番Workerに設定

以下を全て設定する。`--env production` を忘れずに。

```bash
cd apps/worker

# LINE Messaging API（本番チャネルのもの）
npx wrangler secret put LINE_CHANNEL_ID          --env production
npx wrangler secret put LINE_CHANNEL_SECRET      --env production
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN --env production

# LINE Login（本番チャネルのもの）
npx wrangler secret put LINE_LOGIN_CHANNEL_ID     --env production
npx wrangler secret put LINE_LOGIN_CHANNEL_SECRET --env production

# LIFF URL（本番）
npx wrangler secret put LIFF_URL                  --env production
# 値: https://line-harness-prod.{account}.workers.dev

# API認証キー（任意の強いランダム文字列。GASのスクリプトプロパティと合わせる）
npx wrangler secret put API_KEY                   --env production
# 値例: prod-furimauto-XXXXXXXXXXXXXXXX

# GAS デプロイID（GASのウェブアプリURLからDeploymentIDを取得）
npx wrangler secret put GAS_DEPLOY_ID             --env production

# Stripe（使う場合）
npx wrangler secret put STRIPE_WEBHOOK_SECRET     --env production
```

設定確認:
```bash
npx wrangler secret list --env production
```

---

## STEP 6: 初期データをDBに投入

### タグ登録

```bash
npx wrangler d1 execute line-crm-prod --remote --command "
INSERT OR IGNORE INTO tags (id, name, color, created_at) VALUES
  (lower(hex(randomblob(16))), '無料試用期間中',    '#22C55E', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), 'セグメント1',       '#6366F1', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), 'セグメント2',       '#6366F1', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), 'セグメント3',       '#6366F1', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), 'セグメント4',       '#6366F1', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), 'セグメント5',       '#6366F1', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), 'セグメント6',       '#6366F1', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), 'セグメント7',       '#6366F1', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), 'セグメント8',       '#6366F1', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), '紹介経由',          '#F59E0B', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), 'Furimanです',       '#F59E0B', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), '解説見た',          '#F59E0B', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), '月額会員',          '#3B82F6', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), '月額3000',          '#3B82F6', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), '月額5000',          '#3B82F6', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), '月額8000',          '#3B82F6', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), '月額10000',         '#3B82F6', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), '月額15000',         '#3B82F6', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), '月額19800',         '#3B82F6', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), 'サブアカウント',    '#3B82F6', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), 'サブ垢',            '#3B82F6', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), 'アンバサダーLv.1',  '#EC4899', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), 'アンバサダーLv.5',  '#EC4899', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), 'アンバサダーLv.10', '#EC4899', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), 'キャンセル済み',    '#EF4444', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), 'ブロック',          '#EF4444', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), '未使用ユーザー',    '#6B7280', datetime('now','+9 hours')),
  (lower(hex(randomblob(16))), '見込客',            '#F97316', datetime('now','+9 hours'))
"
```

確認:
```bash
npx wrangler d1 execute line-crm-prod --remote --command "SELECT COUNT(*) as cnt FROM tags"
# → 28 になること
```

### シナリオ登録

```bash
cd /path/to/LineHarness
WORKER_URL=https://line-harness-prod.{account}.workers.dev API_KEY=STEP5で設定したAPI_KEY node scripts/seed-furimauto-all-scenarios.mjs
```

確認:
```bash
npx wrangler d1 execute line-crm-prod --remote --command "SELECT name FROM scenarios ORDER BY name"
# → 14件が表示されること
```

---

## STEP 7: LINE Developers Console 設定

### Messaging API チャネル
1. Webhook URL を設定:
   ```
   https://line-harness-prod.{account}.workers.dev/webhook
   ```
2. Webhook の利用: ON
3. 応答メッセージ: OFF
4. あいさつメッセージ: OFF（Workerで処理するため）

### LINE Login チャネル
1. LIFF の Endpoint URL を設定:
   ```
   https://line-harness-prod.{account}.workers.dev
   ```
2. Scope: `profile`, `openid`

---

## STEP 8: GAS スクリプトプロパティ設定

本番GASスクリプトの「スクリプトのプロパティ」に以下を設定:

| キー | 値 |
|------|-----|
| `LINE_HARNESS_WORKER_URL` | `https://line-harness-prod.{account}.workers.dev` |
| `LINE_HARNESS_API_KEY` | STEP5で設定したAPI_KEY の値 |

---

## STEP 9: 動作確認チェックリスト

```bash
# 1. ヘルスチェック
curl https://line-harness-prod.{account}.workers.dev/openapi.json | jq .info

# 2. 認証テスト
curl -H "Authorization: Bearer <API_KEY>" \
  https://line-harness-prod.{account}.workers.dev/api/friends/count

# 3. シナリオ確認
curl -H "Authorization: Bearer <API_KEY>" \
  https://line-harness-prod.{account}.workers.dev/api/scenarios | jq '.[].name'
```

- [ ] `/openapi.json` が返る
- [ ] `/api/friends/count` が `{"count": 0}` を返す
- [ ] `/api/scenarios` が14件返る
- [ ] LINE でフォローすると5通のウェルカムメッセージが届く
- [ ] GAS の sendStepMessages が本番Worker URLを叩いている

---

## トラブルシューティング

| 症状 | 確認箇所 |
|------|---------|
| デプロイしたのにWebhookが動かない | LINE ConsoleのWebhook URLが本番Workerを向いているか確認 |
| 401 Unauthorized | wrangler secret の API_KEY と GAS のプロパティが一致しているか |
| フォローしても5通来ない | `GAS_DEPLOY_ID` が正しく設定されているか。GASデプロイIDはウェブアプリURLの末尾ではなくDeployment IDを使う |
| シナリオが動かない | `SELECT name FROM scenarios WHERE is_active=1` でDB確認。登録されていなければ seed スクリプトを再実行 |
| タグが付かない | `SELECT name FROM tags WHERE name LIKE 'セグメント%'` で28タグ確認 |
| D1マイグレーション漏れ | `SELECT name FROM sqlite_master WHERE type='table'` でテーブル一覧確認 |
| Cron が動いていない | Cloudflare Dashboard > Workers > line-harness-prod > Cron Triggers で確認 |

---

## DEV/PROD 対応表

| 項目 | DEV | PROD |
|------|-----|------|
| Worker名 | line-harness | line-harness-prod |
| Worker URL | line-harness.furimuato.workers.dev | line-harness-prod.{account}.workers.dev |
| D1名 | line-crm | line-crm-prod |
| D1 ID | 4b46e187-36e2-467f-87d4-24d07953d802 | STEP1で発行したID |
| API_KEY | dev-furimauto-key | prod-furimauto-XXXX |
| デプロイコマンド | `npm run deploy` | `npm run deploy -- --env production` |
| DB直接操作 | `--remote` (line-crm を指定) | `--remote` (line-crm-prod を指定) |
