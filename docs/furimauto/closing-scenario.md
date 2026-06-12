# closing_daily — 試用終盤クロージング配信

解説見た(seg8)ユーザー＝最も見込み度が高い層への、試用終盤の日次クロージング配信。
旧名 `kaisetsu_daily` を `closing_daily` にリネーム。

## 仕組み
- トリガー: 「解説見た」キーワード → `actionExtendTrial` が `metadata.kaisetsu=true` + 試用延長(extended1w=+7 / extended3d=+3) をセット。seg8 は通常14シナリオから外れる。
- 配信: `services/kaisetsu-delivery.ts` の cron（毎日21時JST）が対象ユーザーの残日数を計算し、`closing_daily` イベントを `eventData.remaining_days` 付きで発火。
- 出し分け: `closing_daily` automation の各 step に `condition_json {remaining_days_gte:N, remaining_days_lte:N}`（= 残N日ちょうど）。event-bus の matchConditions が評価。
- 残日数<=0: cron は配信せず「見込客(seg4-8保持)／未使用ユーザー(seg1-3)」に分類しフラグクリア。**よって最終送信は残1日**。

## 配信設計（5ステップ / 残7・5・3・2・1日）
当日(残0)は分類処理のため送れないので、締切前日とラストコールを残1日に統合（実質5通）。
クーポン案内(残3)は7日延長・3日延長の両セグメントが必ず通過する。

| step | 残日数 | テーマ | 狙い |
|---|---|---|---|
| 0 | 7 | 成果証明＋「毎日1通お届け」宣言 | 掴み・開封習慣 |
| 1 | 5 | ROI可視化（毎日の手作業が消える/時間価値） | 価値想起 |
| 2 | 3 | 割引クーポンの取り方（「Furimanです」/1週間以内50%・以降20%） | オファー投下 |
| 3 | 2 | 登録は簡単（説明会不要・プランKWコピペ→フォーム→決済） | 障壁除去 |
| 4 | 1 | 締切＋ラストコール（損失明示＋簡単さ＋プラン確認） | 緊急性・即決 |

## seed
```bash
node scripts/seed-furimauto-closing.mjs --rebase   # DEV(line-crm-rebase)
node scripts/seed-furimauto-closing.mjs --prod     # 本番
```

## 関連
- クーポン: seg7「Furimanです」キーワード = `furim/actions.ts` actionFurimanCoupon。
- 登録フロー: プランごとのキーワードをコピペ送信 → 自動返信で登録フォーム → Stripe決済。
- コピー・訴求の元ネタ: `.claude-company/projects/furim-auto/features.md`（3サービスの成り立ち）・LP https://furimauto.com/lp0/ 。
