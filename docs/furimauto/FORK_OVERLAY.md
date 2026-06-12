# FORK_OVERLAY — FurimAuto がフォーク元の既存ファイルに入れている改変レジストリ

**これは「今この瞬間の状態(state)」。upstream をマージ/取り込みする前に必ず読む。**
ここに挙がっているファイルは upstream(Shudesu/line-harness-oss) にも存在し、FurimAuto が独自フックを注入しているため **マージでコンフリクトしやすい**。各行の「再適用方針」に従って手当てする。

- フォーク隔離の原則: 独自ロジックは `apps/worker/src/furim/` ・ `apps/web/src/components/furim/` に閉じ込め、共有ファイルへの注入は「数行 + furim/側の関数呼び出し」に留める。
- 新規ファイル（`apps/worker/src/furim/`・`apps/web/src/components/furim/`・`docs/furimauto/`・`scripts/seed-*` 等）は upstream に無いので **コンフリクトしない**。本レジストリは「共有ファイル」だけを扱う。
- マージ手順は `scripts/merge-upstream.sh` を使う（このファイルを自動表示する）。
- 履歴・載せ替え経緯は `docs/furimauto/upstream-rebase-reapply-analysis.md`（2026-06-11 時点の分析）を参照。本ファイルはその state 版で、常に最新に保つ。

---

## 共有ファイル改変レジストリ

> 形式: `- <path> — <注入内容> | 再適用方針`
> （`scripts/merge-upstream.sh` はこの `- ` 行からパスを抽出してコンフリクト判定に使う）

### worker
- apps/worker/src/index.ts — furim/messages/entry-routes の import & `app.route` 追加。`processKaisetsuDeliveries` を cron に。毎時0分 GAS `sendStepMessages`（セグメント判定の心臓）。Env Bindings に GAS_DEPLOY_ID / FIREBASE_DATABASE_URL / STRIPE_SECRET_KEY / GEMINI_API_KEY / GITHUB_PAT / RICHMENU_* 追加 | upstream index.ts に同フックを再注入。理想は furim/mount.ts に集約し1〜2行で差し込む
- apps/worker/src/routes/webhook.ts — follow/unfollow で `fireEvent`。メッセージ振り分け（【ボタン】【キーワード】・リッチメニュー切替・AIチャット・Furimanクーポン・解説見た）。handler は全て furim/ 側。WebhookEnv 型 | upstream の follow/message ハンドラに furim handler 呼び出しを再注入
- apps/worker/src/services/event-bus.ts — 独自アクション: call_gas / call_gas_post / call_gas_get / send_messages / create_stripe_customer / add_tag_by_name / remove_tag_by_name / complete_active_scenarios / code_managed。条件演算子 not_empty/empty/equals/not_equals/falsy。resolveGasArgs（{{line_user_id}}/{{display_name}}/{{stripe_customer_id}}/{{now_jst}}/{{trial_end_jst}}）。ActionEnv で env を action へ | upstream の executeAction switch に独自 case を追加
- apps/worker/src/routes/stripe.ts — gasGet(LINE_ID↔Stripe_ID 変換)・updateIntroductionCoupon。stripe_invoice_paid / stripe_payment_failed / stripe_subscription_deleted / stripe_ticket_purchased / cv_fire で fireEvent | upstream stripe.ts の各イベント処理に GAS連携＋fireEvent を再注入
- apps/worker/src/middleware/auth.ts — `/liff` を auth 除外に追加（upstream は `/setup` 除外。両方残す） | 1行再適用
- apps/worker/src/services/step-delivery.ts — `buildMessage` に video 分岐を追加（ステップ配信に解説動画を含むため。upstreamは text/image/flex のみ）。DB側は migration 047_scenario_steps_allow_video.sql で `scenario_steps.message_type` CHECK に 'video' を追加 | video case を再適用。schema.sql は無改変、video許可は 047 migration が担う

### db / shared
- packages/db/src/scenarios.ts — getScenarioByName / completeFriendActiveScenarios を追記（upstream は getScenarioById / completeFriendScenario）。**呼び出し側(furim/)を upstream API に寄せる方針なので、ここは将来削除候補** | upstream採用。乖離が出たら furim/ 側を upstream API に合わせる
- packages/db/src/friends.ts — UpsertFriendInput に `createdAt`（顧客import時の登録日引き継ぎ）。INSERT で `input.createdAt ?? now` | upstream friends.ts に再適用
- packages/db/src/index.ts — `export * from './messages'` ・ `export * from './furim'`（移植した独自db関数のexport） | export 2行を再追加
- packages/shared/src/types.ts — AutomationEventType に `closing_daily`（旧 kaisetsu_daily。試用終盤クロージング配信イベント） | 型に再追加

### web
- apps/web/src/components/app-shell.tsx — upstream の `UpdateBanner`(改造検知) を furim の `UpstreamUpdateBanner`(フォーク元更新通知のみ) に差し替え（import + タグの2行） | upstream UpdateBanner は無改変で残す。差し替え2行を再適用
- apps/web/src/components/layout/sidebar.tsx — メインセクションに `/tags`「タグ管理」項目を1行追加（FurimAuto独自ページ。ページ実体は app/tags/・components/furim/tag-timing.ts） | メニュー配列に1行再追加
- apps/web/next.config.ts — `typescript.ignoreBuildErrors:true` ・ `eslint.ignoreDuringBuilds:true`（upstream管理UIの型strict起因のビルド停止を回避する暫定） | 暫定措置。upstream側の型が直れば外す

### 設定
- apps/worker/wrangler.toml — account_id(f2b335f4…)・D1(line-crm / line-crm-prod 24650d0d… / 検証中は line-crm-rebase)・[env.prod]・[vars](self-update)・nodejs_compat・[assets]・ADMIN_ORIGIN / ADMIN_ALLOW_CROSS_SITE（管理UIクロスサイトCORS+cookie） | FurimAuto値を再適用。upstream のキー追加があればマージ

---

## マージ後チェックリスト
- [ ] worker ビルド: `pnpm --filter './packages/*' run build && pnpm --filter worker run build`
- [ ] web ビルド: `NEXT_PUBLIC_API_URL=… pnpm --filter web run build`
- [ ] 上記レジストリの各フックが残っているか grep 確認（fireEvent / furim import / 独自action case / ADMIN_ORIGIN）
- [ ] 型エラー境界（completeFriendActiveScenarios→completeFriendScenario / getScenarioByName→getScenarioById 等、reapply-analysis C節）
- [ ] `apps/web/src/components/furim/upstream-update-banner.tsx` のベースライン(APP_VERSION=package.json version)が新upstream版に追従しているか
