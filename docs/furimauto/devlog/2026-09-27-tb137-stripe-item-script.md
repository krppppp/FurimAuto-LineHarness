# TB-137 重複 item の除去スクリプト（決済・顧客マスター担当）

2026-09-27

## 状況

TB-137 のコード修正（9b28c90）と本番デプロイ（line-harness-prod 42ed42c5）は 9/25 に完了。
新規の申し込みでの二重課金は止まっている。残っていたのは既存 2 名の Stripe live サブスクの item 除去で、
9/25 のくろさんの決定は「くろさんが自分の端末でスクリプトを実行する（鍵は画面入力・チャットに出さない）」。
そのスクリプトを用意した。

## 読み取りで確かめた現況（本番 D1 line-crm-prod）

| | 中村航さん | あおいさん |
|---|---|---|
| subscription_id | sub_1NOIaAF2C7KcCkFfgwQUHq2t | sub_1UF5NbF2C7KcCkFf9FysLUR1 |
| stripe_customer_id | cus_O645GI71VQLRoK | cus_VFaYEpApjKlGlO |
| packages | m_full（8,980） | m_semi（5,980） |
| features（重複ぶん） | mRelist 1,980・mDeleteProduct 980・mSoldCSV 480 | mAttributeCheckbox 980 |
| subscription_price | 12,420 → 正しくは 8,980 | 6,960 → 正しくは 5,980 |

price ID は furim_master から取得（feature: mRelist=price_1TqutYF2C7KcCkFfT4OJ4ItP /
mDeleteProduct=price_1TqutZF2C7KcCkFf505ObCor / mSoldCSV=price_1TqutbF2C7KcCkFfqivf7IPx /
mAttributeCheckbox=price_1TqutZF2C7KcCkFfRskvdFtL、package: m_full=price_1TquuPF2C7KcCkFflMqbM8ZU /
m_semi=price_1TquuPF2C7KcCkFfVBOCqZCA）。1,980+980+480=3,440 と 8,980 の和が 12,420 で事象の金額と一致する。

## 作ったもの

`scripts/stripe-fix-duplicate-items.mjs`（1413b62）。Node 標準のみ、依存なし。

```
node scripts/stripe-fix-duplicate-items.mjs           # 下読みだけ（既定）
node scripts/stripe-fix-duplicate-items.mjs --apply   # APPLY と打つ確認のあと実行
```

- 鍵は画面入力（エコーなし）。保存せず、表示は下 4 桁のみ。伏字（`*` 混じり）・test の鍵・live 以外は弾く
- **先に読んでから判定する**: status が active/trialing、顧客 ID 一致、パッケージ item がある、
  現在の月額が想定どおり、外したあとの月額が想定どおり、サブスクが空にならない。
  1 つでも外れたら**そのサブスクは触らず理由を出す**（既に修正済みなら「対象の item が無い」と出る）
- 除去は `DELETE /v1/subscription_items/{id}` に `proration_behavior=none`（日割りなし・即時請求は立たない）
- `metadata[features]` も空に直す。ここが古いと次回請求の webhook が D1 の features を誤った値で書き戻す
  （stripe-processor は items ではなく subscription metadata を見る）。LIFF の現契約復元もここを読む
- 実行後に読み直して item・合計・metadata・次回請求額を表示する

## 検証

127.0.0.1 の偽 Stripe（本物の live には一切触っていない）で 6 通り:
下読み（GET 2 本だけ）・実行（3 件＋1 件の削除と metadata 更新、合計 8,980/5,980・次回請求 8,980/5,980）・
想定外の item がある（合計が合わず両方スキップ）・既に修正済み（対象なしでスキップ）・
確認に APPLY 以外を打つ（GET 2 本だけで中止）・鍵の検証（伏字と test キーで中止）。
削除時に `proration_behavior=none` が付いていない場合は偽サーバ側が 400 を返す作りにして、付いていることを確かめた。

## 会員への影響

即時請求書が立たないので、item を外した時点で会員に通知は飛ばない（キーコード再発行 push は
invoice.payment_succeeded かつ billingReason=subscription_cycle|subscription_update のときだけ）。
次回請求（中村さん 10/6・あおいさん 10/13）でプラン名の表示が変わった通知が 1 通飛ぶ見込み（通常動作）。
返金は 9/25 にくろさんが手動で実施済み（中村さん 約1,512円・あおいさん 約1,076円）。

## 残り

1. **くろさん**: 上のスクリプトを `--apply` で実行する（請求額が下がる変更なので実行者はくろさん本人）
2. **権限管理課**: Stripe の除去が済んだあと、本番 D1 の表示を合わせる（下の SQL）。
   放っておいても次回請求の webhook で正しい値に書き戻るが、それまで管理画面が 12,420 / 6,960 のままになる

```sql
UPDATE furim_customers SET subscription_price = 8980, features = '',
  plan_label = 'PBプラン:メルカリ 全自動化プラン', updated_at = datetime('now','+9 hours')
  WHERE subscription_id = 'sub_1NOIaAF2C7KcCkFfgwQUHq2t';
UPDATE furim_customers SET subscription_price = 5980, features = '',
  plan_label = 'PBプラン:メルカリ 半自動化プラン', updated_at = datetime('now','+9 hours')
  WHERE subscription_id = 'sub_1UF5NbF2C7KcCkFf9FysLUR1';
```

GAS の顧客シートは admin 経由の編集では同期されないので、シート側は次回請求の webhook で揃う。

## 追記（同日・B事業のリーダーの依頼を受けた前提の再確認）

「前提が変わっていないか」を読み取りだけで確かめた。3 点すべて 9/25 のままで変化なし。

1. **会員への通知**: キーコード再発行 push は `stripe-processor.ts:240`
   `billingReason === 'subscription_cycle' || billingReason === 'subscription_update'` のときだけ。
   `proration_behavior=none` は即時請求書を立てないので、item を外した時点では何も飛ばない
2. **plan-change-watch の誤検知**: `plan_builder_intents` の 9/25 以降の新規は PB-F6967A（9/27 12:49）1 件のみ。
   パッケージ無しの単機能（mSetBottomPrice・1,980 円）なので包含の除外対象外。中村航さんの PB-BDDC28 は notified_at 済み
3. **被害は本当に 2 名だけか**: 本番 D1 の packages と features が両方入っている契約 15 件を全件突き合わせ
   （パッケージの features 列・`=` の前で切る）。重複は中村航さん（mRelist・mDeleteProduct・mSoldCSV）と
   あおいさん（mAttributeCheckbox）の 2 件のみ。他の 13 件は m_semi+mDraftScheduledListing・
   m_full+InventorySheet/AutoMultiChannel・premium+AutoMultiChannel のようにパッケージに含まれない機能だけで、
   正しく別課金。D1 は鏡写しなので最終確定は Stripe 側（鍵が要る）だが、洗い出しの範囲としてはこれで足りる

## 実行後の確認手順（くろさんが流したあと）

- **Stripe 側**: 同じスクリプトを引数なしで再実行する。両方が「外す対象の item が無い（既に修正済み）」で
  スキップされ、合計が 8,980 / 5,980 と出れば完了
- **D1 側**（読み取り）: 次回請求までは古い値のままなのが正常

```sql
SELECT subscription_id, subscription_price, packages, features, plan_label
  FROM furim_customers
 WHERE subscription_id IN ('sub_1NOIaAF2C7KcCkFfgwQUHq2t','sub_1UF5NbF2C7KcCkFf9FysLUR1');
```
