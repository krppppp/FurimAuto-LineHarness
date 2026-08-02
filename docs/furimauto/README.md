# FurimAuto — LineHarness 固有ドキュメント

FurimAuto に特化した仕様・運用ドキュメント。OSS（フォーク元）汎用仕様は `docs/wiki/`。

> **次セッションはここから読む。** 最新の作業ログは `.claude-company/departments/engineering/FurimAuto-LineHarness/`（日付順）。

---

## いまの状態（2026-06-12 更新）

- **アクティブブランチ**: `furim/upstream-rebase`（upstream最新ベース＋FurimAuto独自を再適用した版）。origin(SSH)にpush済み。
- **DEV**: worker `line-harness`（`https://line-harness.furimuato.workers.dev`）。検証用DB `line-crm-rebase`。管理UI `https://furim-dev.line-harness-admin-7je.pages.dev/`（key: `dev-furimauto-key`）。
- **本番**: worker `line-harness-prod`（rebaseコード適用済み）／DB `line-crm-prod`（実顧客643・タグ28・シナリオ14・automation8）／管理UI `https://line-harness-admin-prod-6mo.pages.dev/`（Pages本番ブランチは **FurimAuto**）。本番反映は **差分前進**で完了（破壊なし）。
- **MCPサーバー**: `packages/mcp-server` を `claude mcp add` で登録済み（`line-harness-dev` / `line-harness-prod`、各29ツール）。次回claude起動から自然言語でLINE運用（配信/タグ/分析）可能。**本番broadcastは実顧客に飛ぶので実行前に対象・本文確認**。

### このセッション(2026-06-12)でやったこと
1. rebase版をDEV検証→本番反映（worker差分前進＋web＋スキーマ同期）。
2. friend_add顧客登録バグ修正（create_stripe_customer→GAS setCustomerData。本番にも無かったので追加）。
3. 管理UIクロスサイトCORS修正（ADMIN_ORIGIN/ADMIN_ALLOW_CROSS_SITE）。
4. 「改造を検知」バナー→フォーク元更新通知バナーに差し替え（`components/furim/upstream-update-banner.tsx`）。
5. フォーク差分レジストリ `FORK_OVERLAY.md` ＋ `scripts/merge-upstream.sh` ＋ CLAUDE.md（upstream取り込み運用）。
6. タグ管理画面新設（`app/tags/page.tsx`＋`components/furim/tag-timing.ts`）。
7. シナリオ再構築（14本。video対応 migration 047 ＋ step-delivery video分岐）。
8. closing_daily 配信新設（旧kaisetsu_daily。試用終盤クロージング5通。`scripts/seed-furimauto-closing.mjs`、`closing-scenario.md`）。
9. 未活用機能の調査提案（`.claude-company/departments/research/2026-06-12-line-harness-unused-features.md`）＋MCP導入。

---

## 次にやること（P0→P1。くろさん「P1までやって」）

> MCPツールは claude 再起動後に使える。次セッションでは `line-harness-prod` のツール（broadcast/list_friends/manage_auto_replies/create_tracked_link 等）で自然言語実行できる。

**P0 — 分析×広告/SNS計測**（本命。中身の決めごとはくろさんと）
1. tracked-links: 広告/SNS チャネル別リンク作成→流入元タグ自動付与（どのチャネルが登録・課金に繋がったか）。
2. CV計測: Stripe決済をconversion_pointに定義→広告ROIを実数化。
3. スコアリング: 行動別スコアルール→ホットリード可視化（closing_daily強化に接続）。

**P1 — 顧客対応＆解約抑止**
4. キーワード自動返信（auto_replies）: FAQ（料金/解約/使い方等）を機械応答。`manage_auto_replies`。
5. リマインダー（reminders）: 試用終盤・解約者の復帰を日付基準で自動化。

**運用の宿題（小）**
- DEV worker `line-harness` の top-level DB は検証用 `line-crm-rebase` 向きのまま。DEVを元の `line-crm`(4b46e187…) に戻すか、rebaseをDEV正にするか要判断（`apps/worker/wrangler.toml`）。
- 実機テスト（LINE実フォロー→ウェルカム5通＋スプレッドシート行追加 / closing_daily 21時cron / Stripeテスト決済 / リッチメニュー / AIチャット）はくろさん操作。
- 本番admin各ページの最終スモーク（friends ✓ 解消済。tags/scenarios/automations/broadcasts等）。

---

## フォーク元(upstream)を取り込む時（重要）
1. `FORK_OVERLAY.md` を読む（独自フック入り共有ファイルの生きたレジストリ＋再適用方針）。
2. `scripts/merge-upstream.sh` を使う（コンフリクト確定ファイルを事前警告）。
3. 共有ファイルに独自フックを足したら FORK_OVERLAY.md に1行追記。
4. 独自ロジックは `apps/worker/src/furim/`・`apps/web/src/components/furim/` に隔離。

---

## ファイル一覧
| ファイル | 内容 |
|---------|------|
| [FORK_OVERLAY.md](FORK_OVERLAY.md) | 独自フック入り共有ファイルのレジストリ（マージ時に必読） |
| [closing-scenario.md](closing-scenario.md) | closing_daily（試用終盤クロージング配信）の設計 |
| [scenarios.md](scenarios.md) | シナリオ体系・セグメント判定 |
| [tags.md](tags.md) | 28タグ・付与/削除タイミング（タグ管理画面のtooltip元ネタ） |
| [automations.md](automations.md) | オートメーション仕様 |
| [prod-build-runbook.md](prod-build-runbook.md) / [production-deploy.md](production-deploy.md) | 本番構築手順（参考。本番は差分前進で構築済み） |
| [upstream-rebase-devtest-runbook.md](upstream-rebase-devtest-runbook.md) / [upstream-rebase-reapply-analysis.md](upstream-rebase-reapply-analysis.md) | rebase載せ替えの経緯・DEV検証手順 |

---

## よく使うコマンド
```bash
# wrangler はClaudeのBashから実行可（OAuth有効、外向き通信はsandbox無効化）
# worker デプロイ（DEV）
cd apps/worker && pnpm run build && npx wrangler deploy --config dist/line_harness/wrangler.json
# worker デプロイ（本番）
cd apps/worker && CLOUDFLARE_ENV=prod pnpm run build && npx wrangler deploy --config dist/line_harness/wrangler.json
# web デプロイ（本番。本番ブランチは FurimAuto）
cd apps/web && NEXT_PUBLIC_API_URL=https://line-harness-prod.furimuato.workers.dev pnpm build && npx wrangler pages deploy out --project-name=line-harness-admin-prod --branch=FurimAuto

# シナリオ/automation seed（--rebase=line-crm-rebase / --prod=line-crm-prod）
node scripts/seed-furimauto-all-scenarios.mjs          # 14シナリオ（要 WORKER_URL/API_KEY）
node scripts/seed-automations.mjs --prod               # automation（friend_addは素体INSERT後 --friend-add-only）
node scripts/seed-furimauto-closing.mjs --prod         # closing_daily

# D1（--remote 必須）
npx wrangler d1 execute line-crm-prod --remote --command "SELECT ..."
```

---

## 他ドキュメント
| 場所 | 内容 |
|------|------|
| `docs/wiki/` | OSS汎用仕様（フォーク元。基本変更しない） |
| `.claude-company/projects/furim-auto/{overview,features,business}.md` | プロジェクト全体像・3サービス・ビジネス |
| `.claude-company/departments/engineering/FurimAuto-LineHarness/` | 作業ログ（日付順。最新を読む） |
| `.claude-company/departments/research/2026-06-12-line-harness-unused-features.md` | 未活用機能の活用提案（P0-P2） |
