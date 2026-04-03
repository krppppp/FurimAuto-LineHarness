# FurimAuto シナリオ設計・運用ガイド

FurimAutoに特化したステップ配信シナリオの設計・登録・本番構築手順。

---

## シナリオ体系（2026-04-02 統合済み）

**6シナリオ構成（通常/紹介を統合）**

通常・紹介ともに同じシナリオを使用。1日=1ステップ、毎朝9時配信。
試用期間の差（7日/14日）はGAS側のセグメント切り替えタイミングで吸収する。

| シナリオ名 | trigger_type | ステップ数 |
|-----------|-------------|-----------|
| FurimAuto セグメント1: アンケート未回答 | `friend_add` | 7（Day0〜6） |
| FurimAuto セグメント2: アンケート回答済み | `manual` | 7（Day0〜6） |
| FurimAuto セグメント3: キーコード発行済み | `manual` | 8（Day0〜7） |
| FurimAuto セグメント4: 拡張インストール済み | `manual` | 8（Day0〜7） |
| FurimAuto セグメント5: Free30取得済み | `manual` | 7（Day0〜6） |
| FurimAuto セグメント6: 試用期間終了 | `manual` | 1（Day0のみ） |

---

## セグメント判定ロジック（GAS側）

GASの `getSegment()` による判定（`sheetHelper.js`）:

| セグメント | 判定条件 |
|-----------|---------|
| 1 | アンケート未回答 && キーコード未発行 |
| 2 | アンケート回答済み && キーコード未発行 |
| 3 | キーコード発行済み && 拡張機能未インストール |
| 4 | 拡張機能インストール済み && Free30チケット未取得 |
| 5 | Free30取得済み && Youtubeクーポンなし && 試用期間内 && 未課金（seg4条件も満たす） |
| 6 | Free30取得済み && Youtubeクーポンあり && 試用期間内 && 未課金（アクティブ上級ユーザー） |

**seg5・seg6 の注意**: 両方とも端末判定文字列（拡張インストール済み）とメルカリURL（Free30取得済み）の条件を同時に満たす必要がある。旧仕様ではこのチェックが抜けていたため `sheetHelper.js` で修正済み（2026-03-31）。

`isReferral` = `(subscriptionEndDate - subscriptionStartDate) === 14 * 24 * 60 * 60 * 1000`

---

## シナリオ切り替えフロー

```
GAS (sendStepMessages) ─→ POST /api/furim/scenario-switch
  body: { lineUserId, segment, isReferral }
  ↓
LineHarness Worker:
  1. getFriendByLineUserId(lineUserId)
  2. scenarios テーブルからシナリオ名で検索
  3. completeFriendActiveScenarios(friendId)  ← 現在のシナリオを完了
  4. enrollFriendInScenario(friendId, scenarioId)  ← 新シナリオに切り替え
```

GASのスクリプトプロパティに `LINE_HARNESS_API_KEY` の設定が必要。

---

## 完全解説動画キーワード（kaisetsu）フロー

```
ユーザーが「解説見た」キーワード送信
  ↓
actionExtendTrial() in furim/actions.ts
  ↓
GAS API で試用期間延長（extended1w または extended3d）
  ↓
friendsテーブル metadata に kaisetsu=true, trial_end=日付 を書き込み
completeFriendActiveScenarios() でシナリオ停止
  ↓
kaisetsu-delivery.ts (毎日cronで実行)
  残日数に応じて有料プランへの案内を送信:
  - >=5日: プランメリット案内
  - 2-4日: 申し込み方法
  - 1日: 最後のチャンス
  - <=0日: kaisetsuフラグをクリア
```

---

## step_delivery の delay_minutes ルール

**重要**: `delay_minutes` は「前ステップが配信された時刻からの加算分」

- 同日グループの最初のステップ: `(当日 - 前日) * 1440`
- 同日グループの2番目以降（companion）: **`0`** ← ここを間違えると翌日以降に送信される

例（通常セグメント1）:
```
stepOrder=0  delay=0     (Day0 image)
stepOrder=1  delay=0     (Day0 text)    ← 同日
stepOrder=2  delay=0     (Day0 flex)    ← 同日
stepOrder=3  delay=1440  (Day1 text)    ← 1日後
stepOrder=4  delay=0     (Day1 flex)    ← 同日
stepOrder=5  delay=1440  (Day2 image)   ← 1日後
```

---

## 本番デプロイ手順（Prodは未構築・今後用）

### 1. DB マイグレーション（remote）

```bash
cd apps/worker

# 必要なマイグレーションを順番に適用
npx wrangler d1 execute line-crm --remote --file=../../packages/db/schema.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/003_entry_routes.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/004_friend_metadata.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/005_step_branching.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/006_tracked_links.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/007_forms.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/008_multi_account.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/009_token_expiry.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/010_ad_conversions.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/011_staff_members.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/012_alt_text.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/013_video_message_type.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/014_automation_actions.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/015_messages_and_template_messages.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/016_template_categories.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/017_video_in_templates.sql
```

001_round2, 002_round3, 009_delivery_type は schema.sql と重複するためスキップでOK（重複カラムエラーが出る）。

### 2. シナリオ + テンプレート登録（remote D1 に直接SQL）

```bash
cd LineHarness  # リポジトリルート
node scripts/generate-furimauto-templates-sql.mjs > /tmp/furimauto-templates.sql
cd apps/worker
npx wrangler d1 execute line-crm --remote --file=/tmp/furimauto-templates.sql
```

このスクリプトは以下を一括処理する:
- 既存 FurimAuto シナリオ・ステップ・テンプレートを名前パターンで全削除
- 6シナリオ（通常/紹介統合）の再作成
- 各ステップ（1日=1ステップ）に対応する templates / messages / template_messages の作成（categories=["scenario"]）
- kaisetsu セクション7の3テンプレート作成（cronドリブン・シナリオには非紐付け）

注意: 実行するたびにUUIDが変わる。`--remote` のみ使用（`--local` は使わない）。

### 3. Worker デプロイ

```bash
cd apps/worker
npx wrangler deploy
```

### 4. Secrets 設定

```bash
npx wrangler secret put API_KEY          # Worker APIキー
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put GAS_DEPLOY_ID
npx wrangler secret put STRIPE_SECRET_KEY
```

### 5. GAS スクリプトプロパティ設定

- `LINE_HARNESS_API_KEY`: Worker の API_KEY と同じ値
- `sendStepMessages` 関数は `LINE_HARNESS_API_KEY` を使って `/api/furim/scenario-switch` を呼ぶ

---

## DEV セットアップ時にハマったこと（2026-03-31）

| 問題 | 原因 | 解決 |
|------|------|------|
| `pnpm --filter worker dev` が動かない | これはフロントエンドのdev。Workerは `npx wrangler dev` | `apps/worker` ディレクトリで `npx wrangler dev` を実行 |
| 401 Unauthorized | `X-API-Key` ヘッダーではなく `Authorization: Bearer {key}` が必要 | ヘッダー修正 |
| 500 on step creation | `005_step_branching.sql` 未適用 | `npx wrangler d1 execute --remote --file=...` で適用 |
| imageのJSONパースエラー | `messageContent` は `{"originalContentUrl":"...","previewImageUrl":"..."}` の形式が必要 | seed script の `imageContent()` 関数で対応 |
| video type が保存できない | `scenario_steps.message_type` のCHECK制約が `text/image/flex` のみ | `013_video_message_type.sql` で制約を拡張 |
| D1でBEGIN/COMMITが使えない | D1はexplicit transactionをサポートしない | `generate-scenarios-sql.mjs` から BEGIN/COMMIT を除去 |
| seed scriptがlocalにしか入らない | `wrangler dev` のD1はローカルファイル。DEV DBは `--remote` フラグで操作 | `wrangler d1 execute --remote` でSQL直接流す |
| `staff_members` テーブルなし | ローカルD1に `011_staff_members.sql` が未適用 | 全マイグレーション適用 |

---

## 関連ファイル

| ファイル | 役割 |
|---------|------|
| `scripts/seed-furimauto-all-scenarios.mjs` | API経由でシナリオ登録（APIキー必要） |
| `scripts/generate-scenarios-sql.mjs` | SQL生成 → `wrangler d1 execute` で流す |
| `apps/worker/src/routes/furim.ts` | `POST /api/furim/scenario-switch` エンドポイント |
| `apps/worker/src/furim/keyword-actions.ts` | 友達紹介コード処理・紹介seg1シナリオ切り替え |
| `apps/worker/src/furim/actions.ts` | `actionExtendTrial` - 解説見たキーワード処理 |
| `apps/worker/src/services/kaisetsu-delivery.ts` | 解説見たユーザーへの有料プラン案内cron |
| `apps/worker/src/services/step-delivery.ts` | ステップ配信メイン・video type対応 |
| `GAS/CRM_GAS/src/sendStepMessages.js` | GASからscenario-switchを呼ぶ処理 |
| `packages/db/migrations/013_video_message_type.sql` | video message typeを制約に追加 |
