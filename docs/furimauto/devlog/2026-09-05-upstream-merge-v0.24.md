# 2026-09-05 upstream v0.24.0 マージ（v0.18.1 → v0.24.0、83コミット）

ブランチ: `furim/merge-upstream-20260905`（`furim/upstream-rebase` から分岐、マージコミット `80bb8de`）。
本番反映は未実施。DEV（worker `line-harness` / D1 `line-crm-rebase` / Pages `furim-dev`）に反映済み。

## 規模
- upstream 側変更 492 ファイル / フォーク側 144 コミット / 競合 36 ファイル（マーカー 98 箇所）
- 新 migration 22 本（upstream 050〜072）。フォーク側 046〜065 と**番号は重複するがファイル名は別**なので共存する。手動 `d1 execute --file` 運用なので実害なし。upstream の update-engine は使っていない

## 取り込んだ upstream 機能（FurimAuto に関係あるもの）
- オートウェビナー一式（v0.19〜0.23）: `/webinars` 管理画面、動画アップロード(R2)、CTA、登録、ファネル計測、段階別追客、ライブCTA→個別相談の即時予約
- Google Calendar OAuth 接続 + Google Meet 個別相談リマインド
- マイル制度（v0.20）: 台帳・ルール・タグ別報酬・LIFF ウォレット。**テーブルは入れたがロジックは配線していない**（webhook / stripe でのマイル加算呼び出しは不採用）
- LINE プランクォータの監視・送信前ガード・通知（`broadcasts.last_error`、`QuotaBanner`）
- LINE Messaging API 互換プロキシ `/v2/bot/*`（外部エージェントの送信を messages_log に残す）
- auto_replies の `matchAndReply` 共通化、`postback_received` イベント（リッチメニュータップで IF-THEN 自動化が効く）
- リッチメニュー初期表示 ON/OFF、admin SSO、メディア問い合わせ、Instagram エンゲージメント
- 管理画面の Kumo デザインシステム移行

## コンフリクト解消の判断（FORK_OVERLAY.md にも反映済み）
| ファイル | 判断 |
|---|---|
| `routes/webhook.ts` | フォーク流儀を維持（friend_add Automation・furim handler 群・X口コミ・withOutgoingLog・notifyStaff）。auto_reply は upstream の `matchAndReply` + `proxyDispatch` へ置換。マイル加算は入れない |
| `routes/stripe.ts` | フォークの二相 durable 処理を維持。upstream のインライン処理は不採用 |
| `services/step-delivery.ts` | 同時刻バンドル配信を維持し、upstream の `{{form_url}}` liffId 解決 + `decorateForFriendPush` + `line_account_id` ログを取り込み |
| `services/broadcast.ts` / `routes/broadcasts.ts` | 複数メッセージ配信 (`messages` 列) と upstream の retryKey・クォータガード・Idempotency-Key を両立 |
| `routes/liff.ts` | upstream の account-scoped friend 解決の直後にフォークの race 対策 upsert と `maybeProcessAmbassadorReferral` を再注入。utm_content/utm_term/sid 維持 |
| `index.ts` / `scheduled.ts` | scheduled() は upstream の `scheduled.ts` へ。FurimAuto 独自 cron は新設 `furim/cron.ts` に集約し 3 行で注入 |
| `wrangler.toml` | フォーク設定を全面維持。**TenantScheduler DO は不採用**（5分 cron のまま。`isFiveMinuteTick` が 5分足を通す）。トップレベルに自動マージで入った DO binding / `[[migrations]]` / 分足 cron を除去。`[cache]` は enabled=false |
| `line-sdk/client.ts` | upstream の位置引数 `pushMessage(to, messages, retryKey?, units?)` を採用。event-bus の呼び出しとテストを追従 |
| `web/chats/page.tsx` | **ours 固定**（upstream の 3 カラム改修は不採用、フォークのモバイル全画面版を維持） |
| `web/app-shell.tsx` / `sidebar.tsx` | フォークのスワイプメニュー・未読バッジ・SW 登録を維持。QuotaBanner だけ追加 |
| `web/tags/page.tsx` | upstream 版（友だち数・マイル列）に付与タイミング tooltip を再適用 |
| `web/api.ts` | 両立（`furimChats`/`furimCoupons` + `usage`）。'both' で構造が壊れたので手修正 |
| `openapi-coverage.test.ts` | フォーク独自 26 ルートを `CLIENT_ONLY` に登録（カバレッジ率の分母から外すため） |
| `profile-refresh.test.ts` | upstream 版を採用し、フォークの sweep テストを `profile-refresh.sweep.test.ts` に分離 |

## 検証
- worker typecheck: 既知の `stripe-processor.test.ts` 1 件のみ（マージ前から）
- worker vitest: **131 ファイル / 1450 テスト全 PASS**
- worker vite build / web next build（51 ルート）通過
- FORK_OVERLAY のフック残存 grep: 全項目ヒット
- dev D1 `line-crm-rebase` に 22 migration 適用（全 ok）
- dev worker / dev Pages デプロイ（下記 Version ID）

## 落とし穴メモ
- `pnpm install` は `better-sqlite3`（packages/db・update-engine の devDependency）の native build が node-gyp で失敗する → `--ignore-scripts` で回避。worker/web のビルド・テストには不要
- resolver の 'both' は import 文や `export const api = {` のような**構造を持つ行**では壊れる（api.ts / friend-list-table.tsx / globals.css / broadcast-detail.tsx で手修正）
- upstream は `awardActivityMileage` を webhook の非テキスト経路にも入れている（hunk 外で自動マージされる）。マイル不採用なら grep して外すこと

## 本番反映のときにやること
1. `line-crm-prod` に upstream migration 22 本を `d1 execute --file` で番号順に適用（`051_booking_recurring…` は `google_calendar_connections` テーブルが無いと ALTER で落ちる可能性 → dev では ok だった）
2. `furim/upstream-rebase` に fast-forward マージ → `CLOUDFLARE_ENV=prod ... pnpm run build` → deploy
3. 本番 Pages（`line-harness-admin-prod` / branch `FurimAuto`）を `NEXT_PUBLIC_API_URL=<Pages自身のオリジン>` でビルドして deploy
4. 反映後: リッチメニュータップ（postback_received）、友だち追加、ステップ配信、一斉配信（複数メッセージ）、チャット画面、Stripe webhook を順にスモーク
