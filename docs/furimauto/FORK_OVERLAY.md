# FORK_OVERLAY — FurimAuto がフォーク元の既存ファイルに入れている改変レジストリ

**これは「今この瞬間の状態(state)」。upstream をマージ/取り込みする前に必ず読む。**
ここに挙がっているファイルは upstream(Shudesu/line-harness-oss) にも存在し、FurimAuto が独自フックを注入しているため **マージでコンフリクトしやすい**。各行の「再適用方針」に従って手当てする。

- フォーク隔離の原則: 独自ロジックは `apps/worker/src/furim/` ・ `apps/web/src/components/furim/` に閉じ込め、共有ファイルへの注入は「数行 + furim/側の関数呼び出し」に留める。
- 新規ファイル（`apps/worker/src/furim/`・`apps/web/src/components/furim/`・`docs/furimauto/`・`scripts/seed-*` 等）は upstream に無いので **コンフリクトしない**。本レジストリは「共有ファイル」だけを扱う。
- マージ手順は `scripts/merge-upstream.sh` を使う（このファイルを自動表示する）。
- 直近のマージ: 2026-09-05 upstream v0.24.0 (83コミット/36ファイル競合)。経緯は `docs/furimauto/devlog/2026-09-05-upstream-merge-v0.24.md`。
- 履歴・載せ替え経緯は `docs/furimauto/upstream-rebase-reapply-analysis.md`（2026-06-11 時点の分析）を参照。本ファイルはその state 版で、常に最新に保つ。

---

## 共有ファイル改変レジストリ

> 形式: `- <path> — <注入内容> | 再適用方針`
> （`scripts/merge-upstream.sh` はこの `- ` 行からパスを抽出してコンフリクト判定に使う）

### worker
- apps/worker/src/index.ts — furim/messages/entry-routes/furim-coupons/furim-chats の import & `app.route` 追加。`processKaisetsuDeliveries`・`processPendingCouponNotifications`（クーポン付与LINE通知）を cron に。毎時0分 GAS `sendStepMessages`（セグメント判定の心臓）。Env Bindings に GAS_DEPLOY_ID / FIREBASE_DATABASE_URL / STRIPE_SECRET_KEY / GEMINI_API_KEY / GITHUB_PAT / RICHMENU_* 追加 | upstream index.ts に同フックを再注入。理想は furim/mount.ts に集約し1〜2行で差し込む
- apps/worker/src/routes/webhook.ts — follow/unfollow で `fireEvent`。メッセージ振り分け（【ボタン】【キーワード】・リッチメニュー切替・AIチャット・Furimanクーポン・解説見た）。handler は全て furim/ 側。WebhookEnv 型 | upstream の follow/message ハンドラに furim handler 呼び出しを再注入
- apps/worker/src/services/event-bus.ts — 独自アクション: call_gas / call_gas_post / call_gas_get / send_messages / create_stripe_customer / add_tag_by_name / remove_tag_by_name / complete_active_scenarios / code_managed。条件演算子 not_empty/empty/equals/not_equals/falsy。resolveGasArgs（{{line_user_id}}/{{display_name}}/{{stripe_customer_id}}/{{now_jst}}/{{trial_end_jst}}）。ActionEnv で env を action へ | upstream の executeAction switch に独自 case を追加
- apps/worker/src/routes/stripe.ts — gasGet(LINE_ID↔Stripe_ID 変換)・updateIntroductionCoupon。stripe_invoice_paid / stripe_payment_failed / stripe_subscription_deleted / stripe_ticket_purchased / cv_fire で fireEvent | upstream stripe.ts の各イベント処理に GAS連携＋fireEvent を再注入
- apps/worker/src/middleware/auth.ts — `/liff` を auth 除外に追加（upstream は `/setup` 除外。両方残す） | 1行再適用
- apps/worker/src/scheduled.ts — (2026-09-05 upstream v0.24 マージで scheduled() が index.ts からここへ分離) FurimAuto 独自 cron を `furim/cron.ts` の `furimCronPrelude / furimCronJobs / furimCronSixHourly` 呼び出し3行で注入 | 3行を再注入。中身は furim/cron.ts 側なのでコンフリクトしない
- apps/worker/src/routes/openapi-coverage.test.ts — upstream の OpenAPI カバレッジゲート。フォーク独自26ルート (/api/furim/*, /api/push/*, /api/messages*, /api/lp-beacon, /api/analytics/lp-*, /api/chats/search, /api/admin/sweep-stale-profiles) を `CLIENT_ONLY` に「FurimAuto fork 独自」ブロックとして登録 | 新しい fork ルートを足したらこのブロックにも追記。ブロックごと再適用
- apps/worker/src/routes/chats.test.ts — フォークの引用返信テスト。upstream v0.24 で send ハンドラが `resolveDefaultAccessToken` を使うようになったため vi.mock に追加 | mock に足りない export が出たら追記
- apps/worker/src/routes/profile-refresh.ts — フォークの `sweepStalePictureUrls` (プロフィール画像404スイープ) と upstream の reset-to-draft ルートが同居。テストは upstream版 `profile-refresh.test.ts` と分けて `profile-refresh.sweep.test.ts` に置く | sweep 関数を再適用
- apps/worker/src/routes/liff.ts — `/auth/line` state と QR params に utm_content / utm_term / sid を追加。`/api/liff/link` は upstream の account-scoped friend 解決の直後にフォークの race 対策 upsert (`let friend` + pendingFollow) と `maybeProcessAmbassadorReferral` を再注入 | 各所を再適用
- apps/worker/src/services/broadcast.ts / routes/broadcasts.ts — 複数メッセージ配信 (`messages` 列・migration 053)。upstream の retryKey / クォータガード / Idempotency-Key と両立させる形で `messages` 配列を送る。routes 側は `CreateBroadcastBody.messages` と create 後の UPDATE | 各所を再適用
- apps/worker/src/routes/stripe.ts — フォークは二相 durable 処理 (`stripe-processor.ts` + sweep)。upstream のインライン処理 (applyScoring / mileage / タグ付け) は**不採用** | ours を採用
- apps/worker/src/index.ts — `TENANT_SCHEDULER` (upstream の DO) を optional にしている。DO は使わない | optional 化を再適用
- apps/worker/src/services/step-delivery.ts — `buildMessage` に video 分岐を追加（ステップ配信に解説動画を含むため。upstreamは text/image/flex のみ）。DB側は migration 047_scenario_steps_allow_video.sql で `scenario_steps.message_type` CHECK に 'video' を追加 | video case を再適用。schema.sql は無改変、video許可は 047 migration が担う

### db / shared
- packages/db/src/scenarios.ts — getScenarioByName / completeFriendActiveScenarios を追記（upstream は getScenarioById / completeFriendScenario）。**呼び出し側(furim/)を upstream API に寄せる方針なので、ここは将来削除候補** | upstream採用。乖離が出たら furim/ 側を upstream API に合わせる
- packages/db/src/friends.ts — UpsertFriendInput に `createdAt`（顧客import時の登録日引き継ぎ）。INSERT で `input.createdAt ?? now` | upstream friends.ts に再適用
- packages/db/src/index.ts — `export * from './messages'` ・ `export * from './furim'`（移植した独自db関数のexport） | export 2行を再追加
- packages/shared/src/types.ts — AutomationEventType に `closing_daily`（旧 kaisetsu_daily。試用終盤クロージング配信イベント） | 型に再追加

### web
- apps/web/src/app/chats/page.tsx — **マージ時は常に ours (`git checkout --ours`)**。upstream v0.23 で3カラム全画面に全面改修されたが、本フォークはモバイル全画面・pull-to-refresh 等の独自版を維持している (2026-09-05 判断)
- apps/web/src/app/tags/page.tsx — upstream にもタグ管理画面ができた (マイル列付き)。フォークは TagBadge セルに `getTagTiming` のホバーtooltipを足し、description を差し替え | tooltip ブロックを再適用
- apps/web/src/app/globals.css — iOS 自動ズーム防止の @media ブロック (upstream の @theme と併存) | ブロック再追加
- apps/web/src/components/flex-preview.tsx — useMemo 内で `{type:'flex',contents}` 形式を unwrap | 3行再適用
- apps/web/src/components/app-shell.tsx — upstream の `UpdateBanner`(改造検知) を furim の `UpstreamUpdateBanner`(フォーク元更新通知のみ) に差し替え。加えて SW 登録 + アプリバッジ同期の useEffect、/chats のフォーク独自レイアウト (upstream の isFullBleed / pt-[72px] は不採用) | ファイルごと ours ベースで再構成し QuotaBanner 等 upstream の追加だけ足す
- apps/web/src/components/layout/sidebar.tsx — メインセクションに `/tags`「タグ管理」項目を1行追加（FurimAuto独自ページ）。加えて2026-07-16: upstream の `/notifications`「未対応」メニュー項目を**削除**し、バッジを「個別チャット(/chats)」に移設＝意味を「未対応(messages_log計算)」→「未読(chats.status='unread')」に変更。カウント取得を `api.inbox.unanswered.count()`→`api.furimChats.unreadCount()` に差し替え、ポーリング 5分→60秒 | メニュー配列の /tags 1行再追加＋/notifications 削除＋バッジの href='/chats'・unreadCount 化を再適用。upstream が /notifications を残す場合は本フォークでは非表示のまま
- apps/web/next.config.ts — `typescript.ignoreBuildErrors:true` ・ `eslint.ignoreDuringBuilds:true`（upstream管理UIの型strict起因のビルド停止を回避する暫定） | 暫定措置。upstream側の型が直れば外す
- apps/web/src/app/chats/page.tsx — モバイルUX一式（2026-07-14〜: タイトル削除・全画面固定・5s/15sポーリング・LINE準拠描画・入力欄・pull-to-refresh）。upstream改修が入ると競合大 | 差分が大きいのでマージ時は git diff で当該コミット群を個別再適用
- apps/web/src/components/friends/friend-list-table.tsx — 展開パネル内に `<CouponManager>`（Stripeクーポン付与）を1ブロック追加。実体は components/friends/coupon-manager.tsx（fork独自） | import + JSX 1ブロックを再適用
- apps/web/src/components/friends/friend-list-row.tsx — ボタンラベル「タグ編集」→「タグ・クーポン」（1語） | 1行再適用
- apps/web/src/lib/api.ts — `api.furimCoupons`（list/get/apply/remove）+ StripeCouponItem/FriendCouponState 型を追加。`api.furimChats.unreadCount()`（サイドバー未読バッジ用）を追加 | 各ブロック再適用
- packages/db/schema.sql — coupon_notifications テーブル追記（migration 051 と対）。migration 番号は upstream が同番号を採番する可能性あり（046-048で衝突実績） | テーブル定義を再追記

### 設定
- apps/worker/wrangler.toml — トップレベル(=deploy:dev が使う)から upstream の `[[durable_objects.bindings]]`/`[[migrations]]`/分足 cron を外し `*/5` のまま。`[cache]` は enabled=false。account_id(f2b335f4…)・D1(line-crm / line-crm-prod 24650d0d… / 検証中は line-crm-rebase)・[env.prod]・[vars](self-update)・nodejs_compat・[assets]・ADMIN_ORIGIN / ADMIN_ALLOW_CROSS_SITE（管理UIクロスサイトCORS+cookie） | FurimAuto値を再適用。upstream のキー追加があればマージ

---

## マージ後チェックリスト
- [ ] worker ビルド: `pnpm --filter './packages/*' run build && pnpm --filter worker run build`
- [ ] web ビルド: `NEXT_PUBLIC_API_URL=… pnpm --filter web run build`
- [ ] 上記レジストリの各フックが残っているか grep 確認（fireEvent / furim import / 独自action case / ADMIN_ORIGIN）
- [ ] 型エラー境界（completeFriendActiveScenarios→completeFriendScenario / getScenarioByName→getScenarioById 等、reapply-analysis C節）
- [ ] `apps/web/src/components/furim/upstream-update-banner.tsx` のベースライン(APP_VERSION=package.json version)が新upstream版に追従しているか
