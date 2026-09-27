# TB-363: Google braid の保存とオフライン CV

結論: gbraid / wbraid を入口から ref_tracking まで引き継ぎ、line_friend_add の Data Manager payload を作れるようにした。本番反映は未実施。

## 変更

- migration `086_ref_tracking_braid.sql`: nullable TEXT 2 列。既存行は NULL のまま。
- `/auth/line`、`/auth/oauth`、QR、`/r/:ref`、OAuth state、LIFF ブラウザー転送、`/api/liff/link` の新規／既存両分岐を gclid と同じ形式で拡張。
- DB INSERT、最新クリック取得、cron catch-up の対象条件を拡張。
- `gclid > gbraid > wbraid` の優先順で 1 個だけ payload に設定。成功／失敗ログの click_id_type と click_id も選択値に一致させる。
- request_body 許可リストに braid を追加。userData・メール・電話・customVariables は送らない。
- StaticHP と follower-insight は変更なし。tb-363 ブランチを furim/upstream-rebase の c01560a から分離して作業。

## API 一次資料（実装前に Issue に記録済み）

- https://developers.google.com/google-ads/api/docs/conversions/legacy_oci_guide — 公式サンプルはクリック識別子を 1 個選ぶ。
- https://developers.google.com/google-ads/api/docs/conversions/upload-online — braid を持つ CV は enhanced conversions for web 非対応。全 API に一律の制約とは解釈しない。
- https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest — 実コードの送信先は既に Data Manager。adIdentifiers は gbraid / wbraid に対応する。現在の builder はハッシュ化個人情報を含まず、併用制約に当たらない。今回も追加しない。

## ローカル検証

1. `pnpm --filter @line-crm/shared --filter @line-crm/line-sdk --filter @line-harness/update-engine build`
2. `pnpm --filter worker test src/services/ad-conversion-furim.test.ts src/routes/liff-braid-attribution.test.ts src/routes/liff-affiliate-friend-add.test.ts src/routes/liff-offer-attribution.test.ts` — 25 件成功。既存 affiliate テストには従来のモック不足 stderr がある。今回の 16 件は不足スタブを補いエラー出力なしで再確認。
3. `pnpm --dir packages/db test test/ref-tracking-braid.test.ts` — 7 件成功。
   - `/auth/line?ref=ad_google_search&gbraid=TEST123` → QR の LIFF URL → `/api/liff/link` → 実 SQLite の `ref_tracking.gbraid=TEST123` → CV payload。同じ検証を wbraid でも実施。
   - LINE ID token 検証のみモック。Google 送信もすべて fetch モックで実ネットワークには出さない。
   - braid だけの保存行を cron catch-up が拾い、line_friend_add と識別子をログへ保存。2 回目は再送しない。
4. `pnpm --dir packages/db typecheck` 成功。
5. Worker 全体の型チェックは既存の `stripe-processor.test.ts:357 TS2698` 1 件。変更前 c01560a の本体でも同じ結果。該当する既存テスト 1 ファイルのみ除いた Worker 本体＋他テストの型チェックは成功。
6. `git diff --check` 成功。

既存 DB テストは migration 全件再生時に `friend_scenarios_new has 8 columns but 9 values were supplied` で止まる。今回の SQL は関連 migration を実 SQLite に適用して独立検証した。bootstrap は従来 049 までの状態であり、全件再生成の修正はこの小変更に混ぜない。

## 権限管理課／くろさん同席枠への本番依頼

環境: prod。根拠: TB-363 の依頼。自動実行しない。同席枠が確定してから権限管理課が実施する。

対象: この TB-363 コミットだけ（レビュー時に `git log --oneline --grep='TB-363'` でハッシュを確定）。HEAD が進んでいたら、このコミットを指定した一時 worktree でビルドする。依存パッケージを導入・ビルドし、既存の本番用 `apps/worker/.env.prod` を権限管理側で用意する。secret は成果物へ書かない。

未適用 migration: 本変更で追加する 086 は担当側では本番未適用。本番の他 migration 状態は未確認のため、最初に列を照合する。全件 apply はしない。

以下は `apps/worker` から、1 コマンドずつ実行する。これは依頼用であり、この作業では実行していない。

```sh
pnpm exec wrangler d1 execute line-crm-prod --env prod --remote --command "PRAGMA table_info(ref_tracking)"
```

両列なしなら 086 を適用。両列ありなら再適用せず型を照合。片方のみなら部分適用として止めて相談する。

```sh
pnpm exec wrangler d1 execute line-crm-prod --env prod --remote --file ../../packages/db/migrations/086_ref_tracking_braid.sql
pnpm exec wrangler d1 execute line-crm-prod --env prod --remote --command "PRAGMA table_info(ref_tracking)"
CLOUDFLARE_ENV=prod pnpm run build
pnpm exec wrangler deploy --config dist/line_harness/wrangler.json --dry-run
```

生成 config の Worker 名が `line-harness-prod`、DB が `line-crm-prod`、LIFF ID が本番値であることを照合してから実デプロイする。

```sh
pnpm exec wrangler deploy --config dist/line_harness/wrangler.json
```

期待値:
- `ref_tracking` に nullable TEXT の gbraid / wbraid が存在する。既存値の更新・削除はない。
- 本番 `/auth/line?ref=ad_google_search&gbraid=TEST123` の入口 HTML／リダイレクト／QR URL に braid が残る（認証・友だち追加は完了させず、架空クリックで本番 CV を発生させない）。
- 自然流入で braid が得られたら SELECT で保存値、ad_conversion_logs の click_id_type / request_body / status を読む。実 Google 受理はローカルテストでは未確認。
- 086 → Worker が完了した後に TB-362（StaticHP）をリリースする。TB-363 の開発完了だけでは TB-362 を解放しない。
- 問題があれば Worker のみ直前バージョンへ戻す。追加 2 列は残し、削除 migration は流さない。

dryRun: migration は SQLite で実施済み。本番 D1 に dryRun は無い。Worker は上記 --dry-run を権限管理課で先行実施する。
終わったら: 本番実行用の子 Issue に commit・Worker version・列の確認・入口の確認結果を記録し、TB-363 と TB-354 へ返す。

次から固定したいこと: クリック ID の追加ではサーバーの引き継ぎだけでなく、LIFF client の転送表・DB の読み出し・再試行も一緒に検証する。
