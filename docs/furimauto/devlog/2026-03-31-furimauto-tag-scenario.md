# 開発ログ: FurimAuto タグ設計・シナリオ整備（2026-03-31）

## 概要

FurimAutoのステップ配信シナリオ12本の構築・DEV DB登録と、
友達分類用タグ24種の設計・DB登録を実施した。

---

## 実施内容

### 1. シナリオ12本の構築（前セッション〜）

通常×6 + 紹介×6 の計12シナリオを `scripts/generate-scenarios-sql.mjs` で生成、
`wrangler d1 execute line-crm --remote` でDEV DBに登録。

- `delay_minutes` は前ステップ配信時刻からの相対分（同日companionは `0`）
- D1はBEGIN/COMMITをサポートしないため除去済み

### 2. `POST /api/furim/scenario-switch` エンドポイント追加

`routes/furim.ts` に新設。GASの `sendStepMessages.js` から毎日定期呼び出しされ、
ユーザーのセグメントに応じたシナリオに切り替える。

```
Body: { lineUserId, segment: 1-6, isReferral: boolean }
→ completeFriendActiveScenarios + enrollFriendInScenario
```

### 3. video message typeサポート追加

`scenario_steps.message_type` のCHECK制約に `video` を追加（`013_video_message_type.sql`）。
SQLiteはCHECK制約変更にテーブル再作成が必要。

### 4. GAS sendStepMessages.js 更新

旧CloudFunctions呼び出しをLineHarness APIに移行。
`LINE_HARNESS_API_KEY` をスクリプトプロパティで管理。

### 5. タグ24種をDB登録

DEV D1の `tags` テーブルに24タグを `INSERT OR IGNORE` で登録。

| カテゴリ | タグ |
|---------|------|
| 状態 | 無料試用期間中 |
| ファネル | セグメント1〜6 |
| 流入/アクション | 紹介経由, Furimanです, 解説見た |
| 課金 | 月額会員, 月額3000/5000/8000/10000/15000/19800, サブアカウント, キャンセル済み |
| アンバサダー | アンバサダーLv.1/5/10 |
| 試用終了後 | 未使用ユーザー, 見込客 |

### 6. セグメント判定ロジック修正（GAS sheetHelper.js）

**変更前の問題**:
- seg5/6 に端末判定文字列・メルカリURLの累積条件チェックが抜けていた
- seg6 = 「試用期間終了」だったが不要と判断

**変更後**:
- seg5: Free30取得済み && Youtubeクーポンなし && 試用期間内 && 未課金
- seg6: Free30取得済み && **Youtubeクーポンあり** && 試用期間内 && 未課金（アクティブ上級ユーザー）
- seg5/6 どちらも `端末判定文字列 && メルカリURL` を明示的にチェック

```javascript
// 修正後
const Youtubeクーポン = row[masterColIdx['Youtubeクーポン']];
if (端末判定文字列 && メルカリURL && Youtubeクーポン && !プラン名.includes('プラン') && サブスク終了日時 > now) return 6;
if (端末判定文字列 && メルカリURL && !プラン名.includes('プラン') && サブスク終了日時 > now) return 5;
```

---

## タグ付与タイミング設計（実装待ち）

詳細は `docs/wiki/FurimAuto-Tags.md` 参照。

主要な付与ポイント:

| タグ | トリガー | ファイル |
|------|---------|---------|
| 無料試用期間中 | follow イベント | `routes/webhook.ts` |
| セグメントN | scenario-switch呼び出し時 | `routes/furim.ts` |
| 紹介経由 | 友達紹介コード処理完了 | `furim/keyword-actions.ts` |
| Furimanです | actionFurimanCoupon成功 | `furim/actions.ts` |
| 解説見た | actionExtendTrial (extended1w/3d) | `furim/actions.ts` |
| 月額会員/金額 | Stripe subscription.created | `routes/stripe.ts` |
| キャンセル済み | Stripe subscription.deleted | `routes/stripe.ts` |
| アンバサダーLv | 紹介完了後 getAmbassadorInfo | `furim/keyword-actions.ts` |
| 未使用ユーザー | 試用終了 + seg1〜3 | kaisetsu-delivery / furim.ts |
| 見込客 | 試用終了 + seg4〜6 | kaisetsu-delivery / furim.ts |

月額タグのティア判定ロジック:
```
[3000, 5000, 8000, 10000, 15000, 19800].find(t => amount <= t)
```

---

## ハマりポイント・注意事項

| 問題 | 原因 | 解決 |
|------|------|------|
| Stripe webhookの`subscription_cancelled`タグ検索が動かない | タグ名が`キャンセル済み`だが旧コードは`subscription_cancelled`で検索 | `routes/stripe.ts` 修正要（未対応） |
| seg5/6の条件が不完全だった | 旧コードはseg4の累積条件を引き継いでいなかった | `sheetHelper.js` 修正済み |
| D1にBEGIN/COMMITが使えない | D1は `state.storage.transaction()` API が別途必要 | SQLから除去 |
| ローカルD1とリモートD1は別物 | `wrangler dev` はローカルSQLiteを使う | `--remote` フラグを明示的に付ける |

---

## 残作業

1. タグ付与コード実装（各トリガーポイント）
2. 流し込みスクリプト（GASシート→LineHarness LINE UserID + 初期タグ付与）
3. Stripe webhook タグ名バグ修正 + subscription.created ハンドラー追加
4. GAS `dist/` のビルド（sendStepMessages.js 変更反映）
5. GASスクリプトプロパティに `LINE_HARNESS_API_KEY` 設定（本番デプロイ時）
