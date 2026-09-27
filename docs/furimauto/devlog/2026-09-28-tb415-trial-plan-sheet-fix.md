# TB-415 試用プランの mSoldCSV・rSoldCSV を本番で実際に効かせる

担当: LHarness課 決済・顧客マスター担当 / 2026-09-28 / 実作業は 権限管理課（本番 D1）・開発部統括（prod デプロイ）

親: TB-412（本番 D1 の UPDATE。実行案は `2026-09-28-tb412-trial-plan-features.md`）

---

## 【方針転換】2026-09-28 くろさん回答後の結論（ここが最新）

スプシ修正の依頼に対するくろさんの回答:

> スプシでの管理は旧体制であり、D1での顧客管理にほぼ移れた！ あとは顧客の拡張機能でバージョンが
> まだ古いのだとD1への接続になってないはずだから、そこだけ解決したらスプシGASとの連携は全部
> いらなくなる！ スプシとGASはコードの資産として残しておくが、もう使わなくなる予定
> （D1 の実行順は）先にD1を実行しておく

→ **スプシは直さない。** よって下の「スプシ作業」節は実施しない。代わりに **差分 cron が試用プランの
機能フラグをシートから取り込むのをやめる**コード変更で効かせる。

### 決まったこと

1. スプシ「プラン一覧」「マスター」は触らない
2. `customer-sync.ts` の 2 経路で、試用プラン（`key_code` が `2weektrial_`）の機能フラグ取り込みをやめる
   → パッチ `PATCH-2026-09-28-tb415-skip-sheet-flags-for-trial.diff`（実装・テスト済み）
3. TB-412 STEP 0〜2 の本番 D1 実行は先に流してよい（くろさん承認済み）。ただし **2 をデプロイするまでは
   `mSoldCSV` / `rSoldCSV` は 30 分で戻る**。戻らないのは `mDraftScheduledListing` だけ（シートに列が無い）
4. `furim_master`（プランマスタ）は cron の取り込み対象外（書き込みは管理画面 `furim-masters.ts` だけ）。
   **STEP 1 は 1 回入れれば戻らない**

### 実装したコード変更（TB-425 で `furim/upstream-rebase` にコミット済み）

`apps/worker/src/furim/customer-sync.ts` の 2 箇所。`TRIAL_KEYCODE_PREFIX`（`customer-store.ts:117`）で判定する。

| 経路 | 変更 | なぜ |
|---|---|---|
| 30 分毎の差分 cron（`reconcileFurimCustomers` の「1'.」分岐） | `&& !(cur.key_code ?? '').startsWith(TRIAL_KEYCODE_PREFIX)` を追加 | シートの FALSE が 30 分毎に D1 の true を潰すのを止める |
| `pullFeatureFlagsFromSheet`（`setKeyCode` 直後の即時取り込み） | 先頭で `key_code` を引き、試用プランなら GAS も叩かず `false` を返す | **TB-300 をデプロイしても、friend add のシナリオで `setKeyCode` が走った直後にここでシートの FALSE に潰される。cron 側だけ直しても効かない** |

- `apps/worker/src/furim/customer-sync.test.ts` に 2 ケース追加。`npx vitest run src/furim/customer-sync.test.ts` → **35 passed**
- `npx tsc -p tsconfig.json --noEmit` → 私の変更による型エラーなし（`stripe-processor.test.ts(357,38)` は変更前から出ている既存エラー）
- **TB-425 で `furim/upstream-rebase` にコミット・push 済み**（2026-09-28）。TB-422 で「未コミットのままだと
  TB-376 の worktree ビルドに載らない」と指摘されたため、デプロイ前に先に積んだ。
  `PATCH-2026-09-28-tb415-skip-sheet-flags-for-trial.diff` は同じ差分の控えなので、以後はコミットが正
- worker 全体テストは `1 failed | 1365 passed`。落ちているのは `line-actions-d1.test.ts` の
  「登録 1 週間以内は半額クーポン」1 件で、テストが `created_at: 2026-09-12` を固定しつつ実時刻と比較しているため
  9/19 を過ぎて 20%OFF 判定になった**日付依存の既存失敗**。本パッチとは無関係（TB-426 に切り出し）

### くろさんの質問「旧バージョンの拡張にLINEでアップデート要請を出さないといけないか」への回答

**必要。対象は 7 人**（有効契約 181 人中）。全員有料プランで、試用者は 0 人。

`furim_customers` の `ext_last_seen_at`（Worker 経由の認証）と `gas_last_seen_at`（旧 GAS 経路の認証）で切り分けた。

| 区分 | 人数 |
|---|---|
| どちらも無し（拡張を使っていない） | 24 |
| **GAS のみ（= 旧バージョン。アップデート要請の対象）** | **7** |
| Worker のみ（新） | 30 |
| 両方（アップデート済み） | 120 |
| 両方で直近が GAS（旧に戻っている） | 0 |

対象 7 人の `key_code` と最終 GAS 認証:

```
pb_qmfsyncl          2026-09-28 05:45
pb_k231w72h          2026-09-28 04:00
pb_lb25cc6q          2026-09-27 23:27
pb_ur8gzmvj          2026-09-27 14:45
pb_x1y93a1f          2026-09-27 14:12
pb_x7ik01wl          2026-09-27 09:06
m898-multi_ksxpmmwt  2026-09-21 21:10
```

- 「両方」の 120 人は GAS の最終認証が 9/21〜9/26 で止まり、その後は ext だけが続いている。
  **9/26 21:54 以降に GAS を叩いたのは上の 7 人だけ**。移行はほぼ終わっている
- 試用中 19 人の内訳は Worker のみ 9・未使用 6・両方 4・**GAS のみ 0**。
  → 旧バージョン問題と TB-415（試用プラン）は無関係。アップデート要請を待たずに進めてよい

### 試用プランの現況（2026-09-28 時点・TB-412 は未実行）

親 TB-412 は done になっているが、**本番 D1 はまだ何も変わっていない**。

- `furim_master` の試用プラン: `mSoldCSV=0` / `rSoldCSV=0` / `mDraftScheduledListing` 欠落・`fetched_at` は `2026-09-14T08:57:22.399+09:00` のまま・`false_count=2`
- 試用中 19 人のフラグ: `mSoldCSV` は 18 人が `0`（`source=sheet`）、`rSoldCSV` は 19 人とも `0`（`source=sheet`）

### 順番

1. 権限管理課 → TB-412 STEP 0〜2 を本番 D1 に実行（くろさん承認済み。先に流してよい）
2. 開発部統括 → 上のパッチ＋TB-300 を **セットで** prod デプロイ（`furim/upstream-rebase` の rebase 検証後）
   - パッチだけ先に出すと、試用者の機能フラグを書く人がいなくなる（TB-300 が follow 時に書く前提）
   - TB-300 だけ先に出しても `pullFeatureFlagsFromSheet` に潰されるので効かない
3. デプロイ 30 分後に本番 D1 を確認（下の「完了の確認手順」の SQL）
4. LINE導線担当 → 旧バージョン 7 人へアップデート要請

---

## 以下は方針転換前の記録（スプシを直す前提。実施しない）

## 結論

- TB-412 の前提は本日あらためて本番で裏取りした。**全部そのとおり**。D1 だけ直すと 30 分で戻る。
- **必須なのはスプシ側の修正の 1 本だけ。** prod デプロイ（TB-300）は「新規友だちが登録直後から使えるか、
  最大 30 分待つか」の差しか生まない。恒久対応にはならないので、スプシの代替にはできない。
- TB-412 実行案に書いた**列名が実物と違っていた**。正しくは見出しに機能キーが括弧で入る形式で、
  `メルカリ売上CSV機能 (mSoldCSV)`。探すときは括弧の中のキー（`(mSoldCSV)` / `(rSoldCSV)`）で検索するのが確実。

## 本日（2026-09-28）確認した事実

### 1. 本番 Worker はいまも TB-300 より前

`npx wrangler deployments list --env prod` の最新 3 件:

```
2026-09-26T22:01:03Z
2026-09-26T22:10:10Z
2026-09-26T22:15:11Z   ← 最新（= 09-27 07:15 JST）
```

TB-300（`ebe0662` follow 直後に試用プランの機能フラグを D1 へ書く）は 09-27 10:40 JST のコミットで、
`furim/upstream-rebase` と `tb-322` にしか無く `main` にも無い。**最新 prod はこれより前**で確定。

### 2. 拡張に返る funcObject は「顧客ごとのフラグ行」だけを見ている

`apps/worker/src/furim/ext-auth.ts:214` — `funcObject: flagsToFuncObject(flags)`。
`flags` は `furim_feature_flags` の行。**プランマスタ（`furim_master` kind=plan）は参照していない。**
よって TB-412 STEP 1（マスタ修正）単体では既存顧客にも新規友だちにも届かない。STEP 1 は
「TB-300 デプロイ後の新規友だち」と「今後の setKeyCode 経由の転写元」のための前提でしかない。

### 3. 試用中 19 人の該当フラグ（本日の本番 D1）

| feature_key | source | value | 人数 |
|---|---|---|---|
| `mSoldCSV` | sheet | `0` | 18 |
| `mSoldCSV` | sheet | `1` | 1 |
| `rSoldCSV` | sheet | `0` | **19** |
| `mDraftScheduledListing` | worker | `1` | 1（他 18 人は行なし） |

- `mSoldCSV` / `rSoldCSV` は **19 人全員 `source='sheet'`**。つまり「マスター」シートに列が実在し、FALSE が入っている。
  → 差分 cron（`customer-sync.ts:449` の `subscription_source <> 'plan-builder'` 分岐）が 30 分毎に D1 を FALSE へ引き戻す。
- `mDraftScheduledListing` は `source='sheet'` が **0 件**。スプシに列が無いことの裏付け。D1 だけで完結する。
- ついでに確認: `msRelist` `yfSoldCSV` `yfProfileOptions` も `source='sheet'`。9/15 以降の追加列は
  スプシ側に入っている（`yfSoldCSV` / `yfProfileOptions` は古い 2 人だけ `0`）。
  Vault の `DATA-2026-07-07-customer-sheet-row3-headers.tsv` は 7/7 時点のもので、
  `rSoldCSV` / `msRelist` / `yfSoldCSV` / `yfProfileOptions` が載っていない。**列位置の参照には使えない。**

### 4. 試用中 19 人（LINE_ID・期限順）

`2weektrial_cdzyuonx` `U54f4a1cee33e32dbcf5f24adfcfe42fd` 09-28 12:12
`2weektrial_kh64l7n5` `U712df605e20b2e93ec2afd50a398eae5` 09-28 12:56
`2weektrial_y9gu2vvo` `U60887372e3bdf4dd6dc7080bccac173e` 09-28 19:12
`2weektrial_urs5kmse` `Ud7236abbc1275585698fed0d2fe2b292` 09-29 10:30
`2weektrial_ncuy988j` `U4e426ea1a863f544c9c5d3648a5c5e5f` 09-29 10:53
`2weektrial_n6bv861q` `Ue5c2186ec1b9bd83e64dfae4cea8630d` 09-29 12:12
`2weektrial_r1wpuwha` `Uc1da8e60f6428d68461190e0bced4e27` 09-29 13:02
`2weektrial_0p6nw66q` `U0d20f3f836d80fb60af508403bb67677` 10-01 11:39
`2weektrial_djz91fd0` `Ue4941a030cb2ec8758095fb0fffff344` 10-01 16:07 ← `mSoldCSV` は既に TRUE
`2weektrial_7hpq7wkj` `Uc9108ae180ba5b8b71db00f643aa0888` 10-03 21:05
`2weektrial_6rkp6pl3` `Uc39ba8ee4546aad709661e706b4b7c59` 10-03 22:58
`2weektrial_o0jsq6qx` `U171dfc494f607a507da82fef175e0623` 10-06 23:11
`2weektrial_45kf4dn7` `U2bf6944aefe818513b70548acc48796d` 10-08 22:29
`2weektrial_hmzz0emq` `U8259e00080b4b7d53c8a8a4f98d4868d` 10-09 12:49
`2weektrial_wg7z4zpa` `Uc33e19c05f98e2f4d5909f96f119286f` 10-09 14:58
`2weektrial_23f3jzwm` `U0579b0ec9206dea603efdca3582115b7` 10-10 23:10
`2weektrial_cwbhum7o` `Uc8003f1babe6873241d1bbd3092bd3f8` 10-11 17:57
`2weektrial_yw6u9k5p` `Ue15fc280c597918e893186bc66c292ce` 10-14 21:16
`2weektrial_0lfq0rq8` `U3d9bdb5b38f9fa05d29c1184a21c4287` 10-14 22:06

※ 上 3 人は本日中に期限切れ。作業が明日になるなら対象は 16 人になる。

## スプシ作業（くろさん）

対象は顧客管理スプレッドシートの 2 シート。**見出しは 3 行目**。

### A. 「プラン一覧」シート（新規友だちのため・1 行だけ）

1. `プラン名` 列が `友達登録2週間トライアルプラン` の行を探す
2. 見出し 3 行目を `(mSoldCSV)` で検索 → その列を **FALSE → TRUE**
3. 同じく `(rSoldCSV)` の列を **FALSE → TRUE**

### B. 「マスター」シート（試用中の既存 19 人のため）

1. 見出し 3 行目を `(mSoldCSV)` / `(rSoldCSV)` で検索して 2 列を特定
2. `キーコード` 列が `2weektrial_` で始まる行の、その 2 列を **TRUE** にする
   - 上の 19 人だけに絞ってもよいし、`2weektrial_` の全行（50 人）をまとめて TRUE にしてもよい。
     期限切れの人は `evaluateKeyCodeSet` が期限で先に弾くので、TRUE にしても機能は開かない
   - ここを直さないと TB-412 STEP 2b（D1 を 1 にする UPDATE）が 30 分以内に差分 cron に巻き戻される

### やってはいけないこと

- **`mDraftScheduledListing` の列を足さない。** `setKeyCode` は「プラン一覧」の `(mChangePrice)` 列から
  最終列までを**位置で**「マスター」へコピーしている（`setKeyCode.js:36,91`）。片方にだけ列を挿すと
  以降の転写が 1 列ずつズレて全機能が壊れる。この機能は D1 だけで完結させる
- 2 シートの機能列は**順番・数がそろっている前提**。列の挿入・削除・並べ替えをしない

## prod デプロイ（開発部統括）について

- TB-300 を含むビルドを prod に出すと、**新規友だちは follow 直後から 3 機能が有効**になる。
- 出さない場合でも、上の A をやれば `setKeyCode` が TRUE を「マスター」へ書き、**30 分以内に差分 cron が
  D1 へ入れる**ので新規友だちにも届く。つまりデプロイは「即時か最大 30 分か」の差でしかない。
- `furim/upstream-rebase` の rebase 検証中なので、**TB-415 を待たせてまで出す必要はない**。
  検証が終わってから通常の prod デプロイに載せればよい。

## 完了の確認手順

1. A・B を反映
2. TB-412 STEP 1・2（権限管理課）を実行
3. **30 分後**に本番 D1 で下を流し、3 キーとも `1` だけが並ぶこと

```sql
SELECT f.feature_key, f.value, f.source, count(*) n
FROM furim_customers c JOIN furim_feature_flags f ON f.line_user_id=c.line_user_id
WHERE c.key_code LIKE '2weektrial_%'
  AND c.subscription_end_at > strftime('%Y-%m-%dT%H:%M:%S','now','+9 hours')
  AND f.feature_key IN ('mSoldCSV','rSoldCSV','mDraftScheduledListing')
GROUP BY f.feature_key, f.value, f.source;
```

4. あじゃぱーで友だちリセット → 再追加 → キーコード発行 → `/api/ext/v1/key-code-set` の `funcObject` に
   `mSoldCSV` / `rSoldCSV` / `mDraftScheduledListing` が true。**その 30 分後にもう一度**叩いて true のまま
   （※ 未デプロイのうちは登録直後は false。差分 cron が回るまで待つ）

## 次のアクション

1. くろさん → スプシ A・B（TB-415 の質問カードで依頼済み）
2. 権限管理課 → TB-412 STEP 0〜2（スプシ反映後に実行するのが安全。先に実行しても 30 分で戻るだけ）
3. 開発部統括 → TB-300 を含む prod デプロイは rebase 検証の後で可（TB-415 の子タスクを backlog に置いた）
4. 反映 30 分後に LHarness課が上の SQL で確認 → TB-412 / TB-415 をクローズ
5. 訴求文言の追随は TB-296 の続きとして別件
