# 2026-04-02 テンプレートアーキテクチャ刷新 + シナリオ統合

## やったこと

### 1. テンプレート複数カテゴリ対応（migration 016）

- `templates.categories TEXT DEFAULT '[]'` カラム追加（JSON配列）
- カテゴリ値: `scenario` / `broadcast` / `automation`（固定）
- Worker の `serializeTemplate` で `JSON.parse` して `categories: string[]` を返すように修正
- フロントの `ApiTemplate` に `categories: string[]` 追加

### 2. messages / template_messages テーブル（migration 015）

- `messages`: メッセージ最小単位（text/image/flex/video）
- `template_messages`: template ↔ message の junction テーブル（step_order付き）
- `scenario_steps.template_id` FK 追加（後方互換で `message_content` は残す）
- `automation_actions.template_id` FK 追加

### 3. templates.message_type に video 追加（migration 017）

- 旧 CHECK 制約: `('text', 'image', 'flex', 'carousel')`
- 新 CHECK 制約: `('text', 'image', 'flex', 'carousel', 'video')`
- SQLite の制約変更はテーブル再作成で対応（`templates_v2` → rename）

### 4. シナリオ統合（通常/紹介 → 6本に統合）

**旧**: 12シナリオ（通常×6 + 紹介×6）、ステップ単位でメッセージを1:1保持  
**新**: 6シナリオ（Seg1〜6）、1日=1ステップ=1テンプレート（複数 messages は template_messages で管理）

| シナリオ名 | trigger_type | ステップ数 |
|-----------|-------------|-----------|
| FurimAuto セグメント1: アンケート未回答 | friend_add | 7 |
| FurimAuto セグメント2: アンケート回答済み | manual | 7 |
| FurimAuto セグメント3: キーコード発行済み | manual | 8 |
| FurimAuto セグメント4: 拡張インストール済み | manual | 8 |
| FurimAuto セグメント5: Free30取得済み | manual | 7 |
| FurimAuto セグメント6: 試用期間終了 | manual | 1 |

kaisetsu テンプレート3件（シナリオ非紐付け・cron配信用）も合わせて作成。

### 5. step-delivery.ts 更新

`template_id` があれば `getTemplateMessages` から全メッセージを取得して一括送信。
`template_id` が null のステップは旧コンパニオンバッチ方式にフォールバック。

```typescript
if (currentStep.template_id) {
  const templateMessages = await getTemplateMessages(db, currentStep.template_id);
  // template_messages の step_order 順に全メッセージを送信
} else {
  // 旧: delay_minutes=0 の後続ステップをバッチ送信
}
```

### 6. CLAUDE.md にローカル禁止ルール追記

- ローカル環境は使わない（`--local` フラグ禁止）
- 動作確認は https://furim-dev.line-harness-admin-7je.pages.dev/ のみ
- D1操作は必ず `--remote`

---

## 本番適用コマンド（Dev環境適用済み）

```bash
cd apps/worker

# migrations（未適用のもの順に）
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/014_automation_actions.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/015_messages_and_template_messages.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/016_template_categories.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/017_video_in_templates.sql

# シナリオ + テンプレート一括シード（旧データは自動削除される）
cd ../../
node scripts/generate-furimauto-templates-sql.mjs > /tmp/furimauto-templates.sql
cd apps/worker
npx wrangler d1 execute line-crm --remote --file=/tmp/furimauto-templates.sql
```

結果: テンプレート 53件（シナリオ38 + kaisetsu3 + オートメーション12）、シナリオ 6件、ステップ 38件（全件 template_id 紐付け済み）

---

## 新アーキテクチャの重要ルール

- 1日グループ = 1ステップ = 1テンプレート
- 複数メッセージは `template_messages` で管理（step_order 昇順で送信）
- テンプレートの `message_type` / `message_content` は先頭メッセージを代表値として保持（後方互換）
- `delay_minutes` = 前ステップからの差分日数 × 1440（Day0のみ0）
- 配信ウィンドウ: 朝9時〜夜11時 JST（step-delivery.ts の `enforceDeliveryWindow` で制御）
- kaisetsu は別cron、夜9時配信（`kaisetsu-delivery.ts`）

---

## 関連ファイル

| ファイル | 変更内容 |
|---------|---------|
| `packages/db/migrations/015_messages_and_template_messages.sql` | 新規 |
| `packages/db/migrations/016_template_categories.sql` | 新規 |
| `packages/db/migrations/017_video_in_templates.sql` | 新規 |
| `apps/worker/src/routes/templates.ts` | categories 対応・serializeTemplate刷新 |
| `apps/worker/src/routes/scenarios.ts` | steps に templateId 対応 |
| `apps/worker/src/services/step-delivery.ts` | template_id → getTemplateMessages 対応 |
| `apps/web/src/lib/api.ts` | ApiTemplate.categories 追加 |
| `apps/web/src/components/templates/create-template-modal.tsx` | 新規（共通作成モーダル） |
| `apps/web/src/app/templates/page.tsx` | カテゴリフィルタ・複数選択 |
| `apps/web/src/app/scenarios/detail/scenario-detail-client.tsx` | StepForm → テンプレート選択/作成 |
| `apps/web/src/app/automations/page.tsx` | ActionModal にテンプレート選択/作成 |
| `scripts/generate-furimauto-templates-sql.mjs` | 新規（統合シードスクリプト） |
| `CLAUDE.md` | ローカル環境禁止ルール追記 |
