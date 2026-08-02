# FurimAuto タグ設計・付与タイミング

FurimAutoに特化したタグ定義と、各タグが付与・削除されるタイミングの設計ドキュメント。

---

## タグ一覧（28タグ）

| タグ名 | 色 | カテゴリ |
|--------|-----|---------|
| 無料試用期間中 | #22C55E 緑 | 状態 |
| セグメント1〜8 | #6366F1 紫 | ファネル位置 |
| 紹介経由 | #F59E0B 黄 | 流入元 |
| Furimanです | #F59E0B 黄 | アクション |
| 解説見た | #F59E0B 黄 | アクション |
| 月額会員 | #3B82F6 青 | 課金状態 |
| 月額3000〜19800 | #3B82F6 青 | 課金プラン |
| サブアカウント | #3B82F6 青 | アカウント種別 |
| サブ垢 | #3B82F6 青 | アカウント種別 |
| アンバサダーLv.1/5/10 | #EC4899 ピンク | アンバサダー |
| キャンセル済み | #EF4444 赤 | 課金状態 |
| ブロック | #EF4444 赤 | 状態 |
| 未使用ユーザー | #6B7280 グレー | 試用終了後分類 |
| 見込客 | #F97316 オレンジ | 試用終了後分類 |

---

## セグメント定義（8段階）

セグメントはユーザーのファネル進行度を表す。数字が大きいほど上位のアクティブユーザー。
**常に1つだけが付与される**（切り替え時は古いセグメントタグを全削除してから新規付与）。

| セグメント | 定義 | 切り替えトリガー |
|-----------|------|----------------|
| seg1 | アンケート未回答 | フォロー時（新規ユーザー） |
| seg2 | アンケート回答済み | アンケートボタン回答完了 |
| seg3 | キーコード発行済み | actionKeycodeIssue 成功 |
| seg4 | 拡張インストール済み | GAS 検知 → /api/furim/scenario-switch |
| seg5 | メルカリURL登録済み（自動化1度でも実行） | GAS 検知 → /api/furim/scenario-switch |
| seg6 | FREEコピー出品チケット取得 | コピー出品チケットボタン押下 |
| seg7 | Youtubeクーポン取得（Furimanですキーワード） | actionFurimanCoupon 成功 |
| seg8 | 解説見た（完全解説動画のキーワード送信） | actionExtendTrial 成功 |

**seg8 専用:** シナリオなし。kaisetsu-delivery.ts のcronが `metadata.kaisetsu: true` ユーザーに日次メッセージを送る。試用期間終了後は seg4〜8 なら「見込客」、seg1〜3 なら「未使用ユーザー」に分類される。

---

## 付与タイミング詳細

### 無料試用期間中（緑）
- **付与**: `routes/webhook.ts` follow イベント → 新規ユーザーのみ
- **削除**: 以下のいずれか
  - `services/kaisetsu-delivery.ts` 残日数 <=0 の処理時
  - Stripe `customer.subscription.deleted` 時

---

### セグメント1〜8（紫）

実装: `switchSegmentTag(db, friendId, newSeg)` ヘルパー関数（`furim/button-actions.ts` と `furim/actions.ts` に定義）

- **付与/切り替え場所**:
  - `routes/webhook.ts`: フォロー時 → seg1
  - `furim/button-actions.ts`: アンケート回答 → seg2
  - `furim/actions.ts` (actionKeycodeIssue): キーコード発行 → seg3
  - `routes/furim.ts` (/api/furim/scenario-switch): GAS から seg4/seg5
  - `furim/button-actions.ts`: コピーチケットGET → seg6
  - `furim/actions.ts` (actionFurimanCoupon): Furimanです → seg7
  - `furim/actions.ts` (actionExtendTrial): 延長キーワード → seg8
- **削除**: 試用期間終了時に全削除（kaisetsu-delivery.ts）

---

### 紹介経由（黄）
- **付与**: `furim/keyword-actions.ts` 友達紹介コード処理完了時
- **削除**: しない（永続）

---

### Furimanです（黄）
- **付与**: `furim/actions.ts` actionFurimanCoupon 成功時（GAS Youtubeクーポン付与後）
- **削除**: しない

---

### 解説見た（黄）
- **付与**: `furim/actions.ts` actionExtendTrial（延長キーワード）成功時
- **削除**: しない

---

### 月額会員 / 月額金額タグ（青）
- **付与**: `routes/stripe.ts` `customer.subscription.created` or `updated`
  - 金額ティア: `[3000, 5000, 8000, 10000, 15000, 19800].find(t => amount <= t)`
- **削除**: `routes/stripe.ts` `customer.subscription.deleted`

---

### キャンセル済み（赤）
- **付与**: `routes/stripe.ts` `customer.subscription.deleted`
- **削除**: 再購読時

---

### アンバサダーLv.1/5/10（ピンク）
- **付与**: `furim/keyword-actions.ts` 紹介完了後 `getAmbassadorInfo` 応答に基づく
- **削除**: Lv アップ時に旧タグを削除して新 Lv 付与

---

### 未使用ユーザー / 見込客（グレー/オレンジ）
- **付与**: `services/kaisetsu-delivery.ts` 試用期間終了時
  - seg4〜8 を持っていた → 「見込客」
  - seg1〜3 のみ → 「未使用ユーザー」
- **削除**: しない
