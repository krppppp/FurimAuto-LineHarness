# FurimAuto シナリオ設計・運用ガイド

FurimAutoに特化したステップ配信シナリオの設計・登録・本番構築手順。

---

## シナリオ体系（2026-08-24 一本化）

**「FurimAuto ステップ配信 統合版」1本のみ。** セグメント・通常/紹介による分岐は廃止した。

- 文面の正: Vault `.claude-company/departments/marketing/furim-auto/2026-08-20-scenario-drafts.md`（全25通FIX済み）
- 設計の正: 同 `2026-08-20-scenario-redesign.md`
- 投入スクリプト: `scripts/seed-furimauto-unified-scenario.mjs`（SQL生成 → `wrangler d1 execute --remote --file`）
- 旧14本（`FurimAuto 通常/紹介 ステップ配信（セグメントN: ...）`）は `is_active=0` で残置

| 項目 | 値 |
|------|----|
| name | `FurimAuto ステップ配信 統合版` |
| trigger_type | `manual`（enrollはfriend_add automationとGAS scenario-switchが行う） |
| delivery_mode | `elapsed`（deliveryTime付きステップは時刻固定になる拡張あり・後述） |
| ステップ数 | 39（16配信セット） |

### 配信スケジュール

Day0の起点は**enroll時刻**（≒友だち追加時刻）。Day1以降はJSTの時刻固定（±5分のジッターあり）。

| タイミング | 内容 | 通数 |
|-----------|------|-----|
| Day0 +0分 | ようこそ＋導入動画（**friend_add automationが送る**。シナリオ外） | 2 |
| Day0 +30分 | 導入した瞬間から変わります＋ビフォアフ画像＋1問アンケート | 5 |
| Day0 +2時間 | リサーチ5通セット（商品ページFlex・出品者ページFlex・15大特典Flex） | 5 |
| Day0 +6時間 | 出品もラクに＋無料の限界→キーコード誘導＋存在意義長文＋5段階画像 | 3 |
| Day1 9:00 | YouTube紹介動画（1分で分かる全自動化） | 2 |
| Day1 13:00 | 15大特典への道 1/6（アンケート回答→③④） | 1 |
| Day1 20:00 | 自動化すべき3ページ＋キーコード後押し | 2 |
| Day2 9:00 | 値下げ・再出品=フリマSEO（出品一覧ページ） | 3 |
| Day2 13:00 | 特典への道 2/6（キーコード発行→⑤⑥） | 1 |
| Day3 9:00 | 価格ギャップ＝自動いいね対応（お知らせページ） | 3 |
| Day3 13:00 | 特典への道 3/6（拡張で自動化実行→⑦⑧） | 1 |
| Day4 9:00 | 取引メッセージの重荷＝自動取引対応（取引中ページ） | 3 |
| Day4 13:00 | 特典への道 4/6（Free30受け取り→⑨⑩）＋チケットFlex | 2 |
| Day5 9:00 | 販路拡大＝コピー出品 | 2 |
| Day5 13:00 | 特典への道 5/6（Youtube動画講座→⑪。**キーワードは配信文で開示しない**） | 3 |
| Day6 9:00 | 自動併売在庫管理＋その先の未来 | 2 |
| Day6 13:00 | 特典への道 6/6（完全解説動画→⑫⑬＋試用1週間延長。**キーワード非開示**） | 1 |

**鉄則**: クーポン・延長のキーワード（「Furimanです」「解説見た」）は**配信文に一切書かない**。動画内でのみ案内する。

### スケジューリングの仕組み（elapsed拡張）

`delivery_mode='elapsed'` のシナリオで、ステップに `delivery_time` があるときだけ
`absolute_time` と同じ「enroll + offset_days 日後のHH:MM」計算に切り替わる
（`packages/db/src/scenario-schedule.ts`）。Day0=経過分・Day1以降=時刻固定を1本で組むための拡張。
DBの `delivery_mode` CHECK制約は変えていない。

**バンドル**: 同一スケジュール（offset_days / offset_minutes / delivery_time が完全一致）の
連続ステップは1回のpushにまとまる（最大5通・`step-delivery.ts`）。relativeモードは従来どおり
`delay_minutes=0` でバンドル。

---

## enroll経路（Day0が発火する条件）

1. **friend_add automation**（主経路）: 友だち追加の瞬間に `start_scenario` アクション（step_order=10・isNewUser=true）が統合版へenroll。Day0の起点=友だち追加時刻になる
2. **GAS `sendStepMessages`（毎時）**: 全試用ユーザーのセグメントを判定して `POST /api/furim/scenario-switch` を呼ぶ。**安全網**。セグメントが何であれ統合版の名前が返るため、在籍中は `alreadyEnrolled` でスキップされ進捗は保持される

`scenario-switch` のガード（`routes/furim.ts`）:
- 在籍中（active/delivering）→ スキップ（毎時のDay0リセットを防ぐ）
- **完走済み（completed）→ スキップ**（統合版はDay6で完走するため、これが無いと毎時Day0から無限再スタートする）
- 月額会員・キャンセル済みタグ → スキップ
- seg8（解説見た）も本編を継続する（旧実装はシナリオ停止していた）
- 掘り起こし配信は管理画面の手動enroll（`dayZeroAt` 指定）で行う

セグメントタグ（セグメント1〜8）の付け替えは従来どおり毎時行われる（分析用）。

---

## セグメント判定ロジック（GAS側・変更なし）

GASの `getSegment()` による判定（`sheetHelper.js`）:

| セグメント | 判定条件 |
|-----------|---------|
| 1 | アンケート未回答 && キーコード未発行 |
| 2 | アンケート回答済み && キーコード未発行 |
| 3 | キーコード発行済み && 拡張機能未インストール |
| 4 | 拡張機能インストール済み && メルカリURL未登録 |
| 5 | 端末判定文字列 && メルカリURL && !Free30チケット |
| 6 | 端末判定文字列 && メルカリURL && Free30チケット && !Youtubeクーポン |
| 7 | 端末判定文字列 && メルカリURL && Free30チケット && Youtubeクーポン && !延長キーワード |
| 8 | 端末判定文字列 && メルカリURL && Free30チケット && Youtubeクーポン && 延長キーワード（kaisetsu） |

`isReferral` は scenario-switch に送られてくるが、一本化後はシナリオ解決に使っていない。

---

## クロージング配信（closing_daily・毎晩21時）

`kaisetsu-delivery.ts` が21:00 JSTに発火し、対象者の残日数を計算して
`closing_daily` オートメーションに委譲する。文面はオートメーションの
`automation_actions`（send_messages×4）に入っている。

- 対象: `metadata.kaisetsu=true`（解説見た組）または `metadata.closing=true`（GAS `listActiveTrials` から毎晩同期される一般試用者）
- 配信は**残5日・残3日・残2日・残1日**の4通（2026-08-24 v2。旧・残7日は削除）
- 全文が「解説動画を見ていない人」にも成立する文面。残5日=Youtube再生リストURL、残3日=動画講座→クーポン導線（画像＋クーポン案内＋プラン診断Flex）、残1日=完全解説動画URL
- **closing_sentガード**: 発火した残日数を `metadata.closing_sent`（例 `["5","3"]`）に記録し、同じ残日数では再発火しない。「解説見た」で試用延長すると remaining_days が巻き戻るため、これが無いと延長組に同じ文面が二重に届く
- 21:00の二重cron（`*/5` と `0 */6`）対策として `kaisetsu_last_sent` のclaim-first UPDATEで日次1回に制御
- 期限切れ（残0日）: closing組はフラグクリアのみ。kaisetsu組はタグ整理（見込客/未使用ユーザーへ分類）

---

## 完全解説動画キーワード（kaisetsu）フロー

```
ユーザーが延長キーワード送信（動画内で案内・配信文には書かない）
  ↓
actionExtendTrial() in furim/actions.ts
  ↓
GAS API で試用期間延長（extended1w または extended3d）
  ↓
friendsテーブル metadata に kaisetsu=true, trial_end=日付 を書き込み
  ↓
kaisetsu-delivery.ts（毎晩21時）が残日数に応じて closing_daily を発火
（closing_sent に記録済みの残日数はスキップ＝延長時の再送なし）
```

---

## 投入・変更手順

```bash
# 1. SQL生成（scenarioIdを固定したい場合は SCENARIO_ID=xxx を付ける）
node scripts/seed-furimauto-unified-scenario.mjs
# → scripts/data/unified-scenario.gen.sql / unified-automations.gen.sql

# 2. 適用（DEV: line-crm-rebase / PROD: line-crm-prod）
npx wrangler d1 execute line-crm-rebase --remote --file scripts/data/unified-scenario.gen.sql
npx wrangler d1 execute line-crm-rebase --remote --file scripts/data/unified-automations.gen.sql

# 3. worker デプロイ（elapsed+deliveryTime対応のコードが必要）
pnpm --filter worker deploy:dev   # or deploy:prod
```

- 生成SQLは**冪等ではない**。流す前に同名シナリオの有無を確認する
- 文面の修正は原則ドラフト（Vault）を直してからSQL再生成（旧シナリオ削除→再投入）または管理画面/D1で該当ステップをピンポイント更新し、ドラフトにも反映する
- **本番有効化（旧14本のis_active=0化・新シナリオの本番投入）はくろさんの明示指示が必要**（マーケ憲法）

---

## 関連ファイル

| ファイル | 役割 |
|---------|------|
| `scripts/seed-furimauto-unified-scenario.mjs` | 統合版シナリオ＋オートメーション更新SQL生成 |
| `apps/worker/src/routes/furim.ts` | `POST /api/furim/scenario-switch`・統合版名の解決とenrollガード |
| `apps/worker/src/services/step-delivery.ts` | ステップ配信・同一スケジュールバンドル・video対応 |
| `packages/db/src/scenario-schedule.ts` | 配信時刻計算（elapsed+delivery_time拡張） |
| `apps/worker/src/services/kaisetsu-delivery.ts` | 21時クロージング・closing_sentガード |
| `apps/worker/src/furim/actions.ts` | `actionExtendTrial` - 延長キーワード処理 |
| `GAS/CRM_GAS/src/sendStepMessages.js` | GASからscenario-switchを呼ぶ処理（毎時） |
| `GAS/CRM_GAS/src/listActiveTrials.js` | クロージング対象（試用終盤の一般ユーザー）の同期元 |

## 旧構成からの変更履歴

- 2026-04-03: 8段階セグメント対応（7シナリオ構成）
- 2026-07-15: 14本命名（通常/紹介×seg1-7）に修正（scenario-switch 404の全停止障害対応）
- 2026-08-24: **統合版1本に一本化**。ウェルカム5通→2通、アンケートはDay0+30分へ、クロージング4通v2＋closing_sentガード
