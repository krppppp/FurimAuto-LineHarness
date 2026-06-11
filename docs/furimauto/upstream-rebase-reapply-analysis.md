# FurimAuto独自コード 再適用分析（upstream最新ベースへの載せ替え）

2026-06-11作成。フォーク元(Shudesu/line-harness-oss)最新へ載せ替える際に、**FurimAuto独自コードがどのフォーク元ファイルに混入しているか**を棚卸ししたもの。後の再適用・upstream取り込みの基準。

- フォーク分岐点: `b08f643`
- FurimAuto独自delta: **82ファイル / +14,271 / -1,258**
- upstream新規delta: **496ファイル / +91,908 / -3,192**
- バックアップ: tag `furim-backup-2026-06-11` / branch `furim/dev-backup-2026-06-11`
- 作業ブランチ: `furim/upstream-rebase`（upstream/main 起点）

## 方針
1. **FurimAuto-NEWファイル(45)** = `furim/`配下・seed・docs等。upstreamに無いのでクリーン移植。
2. **共有ファイル(37)** = upstreamにも在る。FurimAuto改変を「再適用 / 破棄(upstream採用)」に仕分けて手当て。
3. 今後: **FurimAuto独自は極力 `apps/worker/src/furim/` に閉じ込め、共有ファイルへのフックは最小化**（再取り込みを楽にする）。

---

## A. FurimAuto-NEWファイル（クリーン移植・45）
`apps/worker/src/furim/`（actions / ai-chat / button-actions / firebase-client / gas-client / keyword-actions / messages / rich-menu）、
`apps/worker/src/routes/furim.ts`（セグメント scenario-switch）、`apps/worker/src/routes/messages.ts`、
`apps/worker/src/services/kaisetsu-delivery.ts`、`apps/worker/src/utils/message-log.ts`、`packages/db/src/messages.ts`、
`scripts/seed-furimauto-*.mjs`・`seed-automations.mjs`・`import-customers.mjs`・`migrate-messages.mjs`・`generate-*.mjs`・`rename-migrated-templates.mjs`、
`docs/furimauto/`、`CLAUDE.md`、`.node-version`、`drizzle.config.ts`、`apps/web/src/app/entry-routes/page.tsx`、`apps/web/src/components/templates/create-template-modal.tsx`、
`packages/db/migrations/013〜019`（※下記「migration衝突」注意）。

> **migration衝突注意**: FurimAuto独自の 013〜019 は、upstream現行の同番号migrationと**番号衝突**する。upstreamエンジン採用なら、template/scenario系(014〜019の大半)はupstream側を使い、FurimAuto固有で残すもの（automation_actions等）は **020以降に振り直す**こと。

---

## B. 共有ファイルへのFurimAuto混入（再適用が要る・重要）

### B-1. 統合フック（**upstream版へ再適用する**）

| ファイル | FurimAutoが足したもの | 再適用方針 |
|---|---|---|
| `apps/worker/src/index.ts` (+32) | `furim`/`messagesRoute`/`entryRoutes` の import & `app.route` 追加。`processKaisetsuDeliveries` をcronジョブに。**毎時0分に GAS `sendStepMessages` を叩く**（セグメント判定・シナリオ切替＝funnelの心臓）。Env に `GAS_DEPLOY_ID` 等 | upstream index.ts に同フックを再追加。理想は `furim/mount.ts` に集約して1〜2行で差し込む |
| `apps/worker/src/routes/webhook.ts` (+86/-70) | import: handleRichMenuSwitch / handleFurimAction・actionFurimanCoupon・actionExtendTrial / handleButtonAction / handleKeywordAction / handleAIChat / getAiMode。`WebhookEnv` 型。**friend_add/unfollow で `fireEvent`**。メッセージ振り分け（【ボタン】【キーワード】リッチメニュー切替・AIチャット・Furimanクーポン） | upstream webhook の follow/message ハンドラに、FurimAuto handler呼び出しを再注入。env(WebhookEnv)を渡す形を維持 |
| `apps/worker/src/services/event-bus.ts` (+274) | **独自アクション**: `call_gas`/`call_gas_post`/`call_gas_get`・`send_messages`・`create_stripe_customer`・`add_tag_by_name`・`remove_tag_by_name`・`complete_active_scenarios`・`code_managed`。条件演算子: not_empty/empty/equals/not_equals/falsy。`processNotifications`＋`ActionEnv`(envをアクションに渡す) | upstream event-bus の `executeAction` switch にFurimAutoのcaseを追加。`ActionEnv`でenv(GAS/Stripe)を渡す仕組みを再適用 |
| `apps/worker/src/routes/stripe.ts` (+170/-36) | `gasGet`(LINE_ID↔Stripe_ID 変換)・`updateIntroductionCoupon`。`fireEvent` for `stripe_invoice_paid`/`stripe_payment_failed`/`stripe_subscription_deleted`/`stripe_ticket_purchased`/`cv_fire` | upstream stripe.ts の各イベント処理に、GAS連携＋fireEventを再注入 |
| `apps/worker/src/routes/friends.ts` (+30) | タグ付与時に **`on_tag_added` 待機ステップを起動**（trigger_condition機能） | upstreamが`offset_days`エンジンなら、on_tag_added相当が要るか要検討。要るなら再適用 |
| `apps/worker/src/routes/entry-routes.ts` (+147) | 流入経路CRUD（FurimAuto版） | upstream版entry-routesと突き合わせ。FurimAuto固有のref/redirect挙動を再適用 |
| `apps/worker/src/routes/liff.ts` (+128/-36) | 友だち追加LIFF動線（ref/redirect/segment） | upstream LIFFと突き合わせ、FurimAuto動線を再適用 |
| `apps/worker/src/middleware/auth.ts` (+1) | `/liff` をauth除外 | 1行再適用（upstreamは `/setup` 除外。両方残す） |
| `packages/shared/src/types.ts` (+16) | `AutomationEventType` に `kaisetsu_daily`。`actionType` 等 | 型に再追加 |
| `packages/db/src/index.ts` (+1) | messages等のexport追加 | 移植したdb関数のexport再追加 |
| `packages/db/src/friends.ts` (+2) | `createdAt` 引き継ぎ（UpsertFriendInput） | 8コミットの登録日引き継ぎ。upstream friends.tsに再適用 |
| `apps/worker/src/routes/automations.ts` (+115) | template_id対応等の管理API | upstream automations.tsと突き合わせ |

### B-2. エンジン系（**upstream採用＝FurimAuto版は破棄**。記録のみ）

| ファイル | FurimAutoが持っていたもの（参考） | 扱い |
|---|---|---|
| `packages/db/src/scenarios.ts` (+129/-31) | `trigger_condition`/`parseTriggerCondition`/`getScenarioByName`/`completeFriendActiveScenarios`、delay_minutesモデル | upstream（offset_days/delivery_time/computeNextDeliveryAt）を採用。**呼び出し側(furim/keyword-actions等)を upstream API に合わせて修正**（getScenarioByName→getScenarioById 等） |
| `apps/worker/src/services/step-delivery.ts` (+161/-49) | delay_minutes＋trigger_condition配信計算 | upstream採用（日数ベース＝乗り換えの目的） |
| `packages/db/src/templates.ts` (+107) / `apps/worker/src/routes/templates.ts` (+114) | template_messages/category/sort_order | upstream（usage tracking版）採用 |
| `packages/db/src/automations.ts` (+115) | automation_actions（FurimAuto版） | upstream版と統合。独自actionは event-bus 側で（B-1） |
| `apps/web` の templates/scenarios/automations/friends/broadcasts ページ等 | FurimAuto UI調整 | upstream UI採用（必要なら後で個別再適用） |

### B-3. 設定（**値を再適用**）
- `apps/worker/wrangler.toml`: account_id(f2b335f4…)・D1(line-crm / line-crm-prod 24650d0d…)・`[env.prod]`・`[vars]`(self-update)・nodejs_compat。
- `vite.config.ts`: `cloudflare({remoteBindings})` を残しつつ upstream の react/tailwind を併用。
- `package.json`/`apps/worker/package.json`: deploy script(`--config dist/line_harness/wrangler.json`)＋upstream新規deps。
- `.gitignore`: `.dev.vars` を維持。

---

## C. 既知の再適用時エラー（upstream API乖離）
過去の試行(typecheck)で出た境界エラー＝再適用時に直す箇所:
- `completeFriendActiveScenarios` → `completeFriendScenario`
- `getScenarioByName` → `getScenarioById`（or 名前引きを自前で）
- `parseTriggerCondition` / `resolveTemplateMessages` がupstreamに無い → on_tag_added/template_messagesをどう扱うか判断
- line-sdk: upstreamの新route群が要求する `getUnitInsight`/`pushImageMessage`/`getDefaultRichMenuId` 等 → line-sdkもupstream版に
- `@line-harness/update-engine` パッケージ導入（self-update使うなら）

## D. 今後の運用（フォーク差分最小化）
- FurimAuto独自ロジックは **`apps/worker/src/furim/` に集約**。
- 共有ファイルへのフックは **「1ファイル1〜数行 + furim/側の関数呼び出し」** に留める（理想は `furim/mount.ts` / `furim/webhook-hooks.ts` に集約し、index.ts/webhook.ts からは最小限の呼び出しのみ）。
- これで次回以降の `git merge upstream/main` のコンフリクトが激減する。
