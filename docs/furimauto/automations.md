# FurimAuto — オートメーション仕様

> 最終更新: 2026-04-02
> OSS汎用仕様（`docs/wiki/`）に加えて、FurimAutoでの実装・拡張内容を記述する。

---

## アーキテクチャ

```
イベント発生（follow, message, tag_change 等）
    ↓
event-bus.ts の fireEvent()
    ↓
processAutomations()
    ↓（各オートメーションを優先度順に実行）
    └── executeAction() × n（automation_actions テーブルのアクションを step_order 順に実行）
```

---

## データモデル

### automations テーブル

```sql
CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  event_type TEXT NOT NULL,
  conditions TEXT NOT NULL DEFAULT '{}',  -- JSON: オートメーション全体のマッチ条件
  actions TEXT NOT NULL DEFAULT '[]',     -- JSON: 後方互換用（実際は automation_actions を使う）
  line_account_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,    -- 大きい方が先に実行
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### automation_actions テーブル（FurimAutoで追加）

アクションを1行1レコードで管理。`automations.actions` JSON配列ではなくこちらが正。

```sql
CREATE TABLE automation_actions (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL DEFAULT 0,     -- 実行順序（昇順）
  action_type TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',         -- JSON: アクション固有パラメータ
  condition_json TEXT,                       -- JSON: このアクション固有の実行条件
  on_error TEXT NOT NULL DEFAULT 'continue', -- 'continue' | 'abort'
  is_active INTEGER NOT NULL DEFAULT 1,      -- 0=GUI表示するが実行しない（code_managed等）
  label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### automation_logs テーブル

```sql
CREATE TABLE automation_logs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES friends(id) ON DELETE SET NULL,
  event_data TEXT,       -- JSON
  actions_result TEXT,   -- JSON: [{action, success, error?}, ...]
  status TEXT NOT NULL DEFAULT 'success',  -- 'success' | 'partial' | 'failed'
  created_at TEXT NOT NULL
);
```

---

## イベントタイプ

| event_type | 発生タイミング | eventData に含まれるデータ |
|---|---|---|
| `friend_add` | 友だち追加 | `displayName`, `isNewUser`（bool） |
| `message_received` | テキストメッセージ受信 | `text`, `matched` |
| `tag_change` | タグ付与/削除 | `tagId` |
| `score_threshold` | スコア閾値到達 | `currentScore` |
| `cv_fire` | コンバージョン発生 | 任意 |
| `calendar_booked` | カレンダー予約 | 任意 |
| `incoming_webhook.*` | 外部Webhook受信 | `webhookId`, `source`, `payload` |

### friend_add の isNewUser

```typescript
// webhook.ts
const isNewUser = !existingFriend
await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName, isNewUser } }, ...)
```

同一オートメーション内で新規フォロー／リフォローを分岐させるために使用。

---

## アクションタイプ（全種）

### 基本系

| type | params | 説明 |
|---|---|---|
| `add_tag` | `{ tagId }` | タグ付与 |
| `remove_tag` | `{ tagId }` | タグ削除 |
| `start_scenario` | `{ scenarioId }` | シナリオ登録 |
| `send_message` | `{ content, messageType?, altText? }` | メッセージ1通 |
| `send_messages` | `{ messages: [{type, content, altText?}] }` | メッセージ最大5通（LINE API上限） |
| `send_webhook` | `{ url }` | 外部URLにPOST |
| `switch_rich_menu` | `{ richMenuId }` | リッチメニュー切替 |
| `remove_rich_menu` | `{}` | リッチメニュー解除 |
| `set_metadata` | `{ data }` | friends.metadataにJSONをマージ |
| `create_stripe_customer` | `{ save_to_metadata? }` | Stripe顧客作成・メタデータに保存 |

### GAS連携系

| type | params | 説明 |
|---|---|---|
| `call_gas_post` | `{ method, args? }` | GASにPOST。返値不要 |
| `call_gas_get` | `{ method, args?, response_field?, operator?, compare_value?, set_variable }` | GASにGET → レスポンス評価 → boolをeventDataに保存 |
| `call_gas` | `call_gas_post` と同じ | 後方互換エイリアス |

#### call_gas_get の詳細

```typescript
// params の例
{
  method: "getStripeIDwithLINEID",
  args: { lineId: "{{line_user_id}}" },
  response_field: "stripeId",           // レスポンスのどのフィールドを評価するか
  operator: "not_empty",                // not_empty | empty | equals | not_equals | truthy | falsy
  compare_value: "xxx",                 // equals/not_equals 時に使用
  set_variable: "hasStripeId"           // payload.eventData[set_variable] = bool で保存
}
```

後続アクションの `condition_json: { "hasStripeId": true }` で分岐できる。

### 可視化専用

| type | params | 説明 |
|---|---|---|
| `code_managed` | `{ description? }` | 実行エンジンでは no-op。コード管理ステップをGUIに可視化する用途 |

---

## テンプレート変数（call_gas系）

GASへの引数 `args` 内で以下の変数が展開される：

| 変数 | 展開値 |
|---|---|
| `{{friend_id}}` | friends.id（内部UUID） |
| `{{line_user_id}}` | friends.line_user_id（LINE UID） |
| `{{display_name}}` | friends.display_name |
| `{{stripe_customer_id}}` | friends.metadata.stripeCustomerId |
| `{{now_jst}}` | 現在時刻（JST文字列） |
| `{{trial_end_jst}}` | 試用期間終了日時（JST文字列） |

---

## アクション内分岐（conditionJson）

各 automation_action に `condition_json` を設定することで、同一オートメーション内でアクションを条件分岐させられる。

```json
// 新規フォローのときだけ実行
{ "isNewUser": true }

// リフォローのときだけ実行
{ "isNewUser": false }

// call_gas_get の結果で分岐
{ "hasStripeId": true }
```

`matchConditions()` は `payload.eventData` を参照する。`call_gas_get` でeventDataに値を書き込むことで動的分岐が実現できる。

---

## GUI（管理画面）

- `apps/web/src/app/automations/page.tsx`
- アクションフローを視覚的に表示
- 分岐の自動検出: `detectBranchVar()` がすべてのアクションの conditionJson をスキャンし、true/false 両方の値を持つキーを分岐変数として検出
- 分岐があれば2列横並びで表示（各列 32rem、横スクロール対応）
- `is_active=0` のアクション（code_managed等）もGUIには表示する（実行エンジンはスキップ）

---

## FurimAuto 本番オートメーション

### 友だち追加フロー（friend_add）

| step | action_type | 条件 | 内容 |
|---|---|---|---|
| 0 | remove_tag | なし | ブロックタグ削除 |
| 1 | add_tag | なし | 無料試用期間中タグ付与 |
| 2 | add_tag | なし | セグメント1タグ付与 |
| 3 | switch_rich_menu | なし | デフォルトリッチメニュー設定 |
| 4 | create_stripe_customer | isNewUser=true | Stripe顧客作成 |
| 5 | call_gas_post | isNewUser=true | GAS setCustomerData 登録 |
| 6 | start_scenario | isNewUser=true | ウェルカムシナリオ開始 |
| 7 | code_managed | なし | [code] GASリフォロー判定（`getStripeIDwithLINEID`） |
| 8 | code_managed | isNewUser=false | [code] リフォローユーザーへ返信 |
| 9 | code_managed | isNewUser=true | [code] ウェルカム5通送信（シナリオ経由） |

step 7-9 は `code_managed`（コード管理）のため実行エンジンでは no-op。
実際の処理は `apps/worker/src/routes/webhook.ts` のハードコードで動作している。

---

## ソースコード参照

| 機能 | ファイル |
|---|---|
| APIルート | `apps/worker/src/routes/automations.ts` |
| DBクエリ | `packages/db/src/automations.ts` |
| イベントバス・実行エンジン | `apps/worker/src/services/event-bus.ts` |
| 管理画面 | `apps/web/src/app/automations/page.tsx` |
| 型定義 | `packages/shared/src/types.ts`（`AutomationActionItem`） |
