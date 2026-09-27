# TB-413 顧客の機能一覧で「メルカリ下書き予約出品」をメルカリ群の最後に並べる

## 何をしたか

`FEATURE_FLAG_ORDER`（`apps/worker/src/furim/admin-schema.ts:68-79`）に
`mDraftScheduledListing` を `mCopyYahooFleamarketListing` の直後・`msChangePrice` の前に追加。

並べ替えは `loadFeatureColumns`（`apps/worker/src/routes/furim-admin.ts:257-279`）。
`FEATURE_FLAG_ORDER.indexOf(key)` が `-1` だと rank が配列長になり、機能マスタの
rowid 順（`mDraftScheduledListing` は 2026-09-15 追加で最後）で一覧の最下段に落ちていた。

順を保証するテストを `apps/worker/src/routes/feature-column-order.test.ts` に 2 本追加。
定数の並びと、マスタ rowid が最後でも `loadFeatureColumns` が正しい位置に置くことを見る。

## 結論・判断

- 2 画面（データページの行ドロワー「機能」／個別チャットの顧客パネル）は同じ
  `FeaturePanel`・同じ `GET /api/furim/admin/furim_customers/:id/feature-flags` を使うため、
  修正は 1 か所で両方に効く
- 顧客DB一覧の機能列と CSV 出力（`_flag_*`・`attachFeatureFlags`）も同じ `loadFeatureColumns` を
  通るので**列の並びが同じく変わる**。意図どおりなので直さない（CSV を機械で読んでいる場合は列位置に注意）
- 定数のコメントに「シートより後に増えた機能は同じサイト群の最後に手で足す」を明記。
  シート由来の並びという前提が変わったため
- 既存テストで `FEATURE_FLAG_ORDER` の件数・順に依存しているものは無し（grep 済み）
- `tsc --noEmit` は `services/stripe-processor.test.ts(357,38)` で落ちるが、本変更を戻しても同じ**既存エラー**

## 検証

- `npx vitest run src/routes/feature-column-order.test.ts` — 2 passed
- `npx vitest run src/furim/feature-flags.test.ts src/furim/person-audit.test.ts` — 26 passed
- 見た目の確認は dev を使わない方針のため未実施（API の返す順まで確認）

## 次のアクション

- 本番反映は未実施。コミット `b248fd3`（`furim/upstream-rebase` に push 済み）。
  対象は Worker `line-harness`（`apps/worker`）のデプロイのみ。D1 マイグレーション不要
- TB-376（braid の反映）と同じ Worker なので、デプロイ枠をまとめられるなら秘書がまとめる
