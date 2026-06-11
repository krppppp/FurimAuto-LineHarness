# 開発ログ: 顧客データ一括インポート（2026-03-31）

## 概要

GASスプレッドシートの顧客マスター（555件）をLineHarness DEV DBに流し込むパイプラインを構築した。
LINE APIでプロフィール画像・表示名を取得し、タグ判定（26タグ）まで自動で行う。

---

## 実施内容

### 1. `POST /api/furim/upsert-friend` エンドポイント追加

`routes/furim.ts` に新設。`lineUserId` をキーに友だちを INSERT or UPDATE し、内部UUIDを返す。

```
Body: { lineUserId, displayName?, pictureUrl?, statusMessage? }
→ upsertFriend() → { id, lineUserId, displayName, pictureUrl }
```

### 2. `scripts/import-customers.mjs` 新規作成

TSVパース → LINE API プロフィール取得 → タグ判定 → LineHarness API への一括登録。

**主なフラグ:**
- `--master=<path>`: 顧客マスターTSV
- `--referrals=<path>`: LINE紹介履歴TSV（1ファイルで introducedIds + ambassadorCounts を両方集計）
- `--enrich`: LINE APIでプロフィール取得（LINE_CHANNEL_ACCESS_TOKEN 必須）
- `--dry-run`: 判定結果出力のみ、DBへの書き込みなし
- `--offset=N --limit=N`: 分割実行用

**実行コマンド（100件ずつ）:**
```bash
WORKER_URL=https://line-harness.furimuato.workers.dev \
API_KEY=dev-furimauto-key \
LINE_CHANNEL_ACCESS_TOKEN=<Prodトークン> \
node scripts/import-customers.mjs \
  --master=/Users/kurow/Desktop/master.tsv \
  --referrals=/Users/kurow/Desktop/referrals.tsv \
  --enrich --offset=0 --limit=100
```

### 3. 新規タグ2件を DEV D1 に登録

| タグ名 | 色 | 判定条件 |
|--------|-----|---------|
| サブ垢 | #3B82F6 青 | `プラン名.includes('2台目以降')` |
| ブロック | #EF4444 赤 | `--enrich` 時に LINE API プロフィール取得失敗（404） |

---

## マスターTSVのカラム一覧（実測）

```
友達登録日時 LINE表示名 LINE_ID Stripe顧客ID Email
メルカリURL ShopsURL ラクマURL ヤフフリURL TwitterURL
プラン名 サブスクID サブスク登録日時 サブスク終了日時 サブスク価格
トライアル 支払い金額 通算支払い回数 通算支払い総額 Youtubeクーポン
延長キーワード アンケート回答 初回発行 キーコード 端末判定文字列
Free30チケット コピー出品チケット
```

**重要: 月額金額という列はない → 正しくは `サブスク価格`**

---

## タグ判定ロジック（import-customers.mjs）

| タグ | 判定条件 |
|------|---------|
| 無料試用期間中 | `!hasPlan && !isCancelled && サブスク終了日時 > now` |
| セグメント1〜6 | `!hasPlan && !isCancelled && !isSubAccount` → getSegment() |
| 月額会員 | `プラン名.includes('プラン') && サブスク価格 > 0` |
| 月額NNNN | `[3000,5000,8000,10000,15000,19800].find(t => price <= t)` |
| キャンセル済み | `プラン名.includes('キャンセル済み')` |
| サブ垢 | `プラン名.includes('2台目以降')` |
| サブアカウント | `アンケート回答 === 'サブアカウント'` |
| 紹介経由 | LINE_IDが referrals.tsv の LINE_ID(友) に含まれる |
| Furimanです | `Youtubeクーポン` 列に値あり |
| 解説見た | `延長キーワード` 列に値あり |
| アンバサダーLv.N | referrals.tsv の LINE_ID(ア) 出現回数で判定（最高Lvのみ付与） |
| 未使用ユーザー | 試用終了 && `端末判定文字列` なし |
| 見込客 | 試用終了 && `端末判定文字列` あり |
| ブロック | `--enrich` 時に LINE API 404 |

**セグメント判定の注意:** インポートスクリプトでは `サブスク終了日時 > now` チェックを外している（試用終了済みユーザーにも到達したセグメントを付与するため）。GASの `getSegment()` とは異なる。

---

## referrals.tsv のカラム構造

```
日時    LINE表示名(ア)    LINE_ID(ア)    LINE表示名(友)    LINE_ID(友)
String  String            String         String             String
```

2行目の `String` 型情報行は自動スキップ。アンバサダー紹介数はこのファイルの `LINE_ID(ア)` 出現回数から集計（別途アンバサダーシート不要）。

---

## ハマりポイント

| 問題 | 原因 | 解決 |
|------|------|------|
| 全員 `upsertFriend: Not found` | `wrangler deploy` が古い dist を使っていた | `npm run deploy`（vite build込み）で再デプロイ |
| 正しい Worker URL がわからない | `.dev.vars` に URL なし | `npx wrangler deployments list` でも取れない → `npx wrangler deploy` の出力で確認 |
| `月額会員` タグが誰にも付かない | 列名 `月額金額` → 実際は `サブスク価格` | カラム名を修正 |
| 全員 `ブロック` になる | コマンドのトークンが `QNj2JT43...` と省略されたまま | フルトークンで再実行 |
| Dev環境でプロフィール取得できない | DevチャネルにProdユーザーが友達登録されていない | Prodチャネルのアクセストークンを使用 |
| LINE APIが途中でエラー | ネット環境による接続断 | `--offset --limit` で分割実行 |
| DEV DB のスキーマが `wrangler dev` と別物 | ローカルはSQLiteファイル、リモートは別 | `--remote` フラグを使用 |

---

## 残作業

- [ ] 101〜555件目のインポート完了（100件ずつ分割実行）
- [ ] タグ付与コード実装（各トリガーポイント）← 前回ログ参照
