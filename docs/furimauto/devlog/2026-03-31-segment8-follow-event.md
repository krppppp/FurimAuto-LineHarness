# 開発ログ: セグメント8段階化・フォローイベント実装（2026-03-31）

## 概要

FurimAutoのセグメント設計を6→8段階に拡張し、各アクション時の動的タグ切り替えを実装。
さらに旧 CloudFunctions の `eventFollow.ts` を Worker の `webhook.ts` に移植した。
シナリオも通常7本+紹介7本=計14本に再構築してDEV DBに登録。

---

## セグメント再定義（最終確定）

| セグメント | 定義 | シナリオあり? |
|-----------|------|--------------|
| seg1 | アンケート未回答 | ✅ |
| seg2 | アンケート回答済み | ✅ |
| seg3 | キーコード発行済み | ✅ |
| seg4 | 拡張インストール済み | ✅ |
| seg5 | メルカリURL登録済み（自動化が1度でも実行された） | ✅ |
| seg6 | FREEコピー出品チケット取得 | ✅ |
| seg7 | Youtubeクーポン取得（「Furimanです」キーワード送信済み） | ✅ |
| seg8 | 解説見た（完全解説動画のキーワード送信済み） | kaisetsu-delivery.ts で管理 |

**seg8 はシナリオなし。** kaisetsu-delivery.ts のcronが `kaisetsu: true` フラグを持つユーザーに日次メッセージを送る仕組みで管理される。

---

## 実施内容

### 1. フォローイベント移植（webhook.ts）

旧CloudFunctions `eventFollow.ts` の処理を `routes/webhook.ts` に完全移植。

**新規ユーザーのフロー:**
1. GAS `getStripeIDwithLINEID` で既存顧客か確認
2. 新規ならStripe Customer作成（`POST /v1/customers`）
3. GAS `setCustomerData` でシートに記録
4. replyToken で5通のウェルカムメッセージ送信
5. `セグメント1` + `無料試用期間中` タグを付与
6. seg1シナリオに登録（day0即時配信は `GAS_DEPLOY_ID` があるとスキップ）

**再フォロー（ブロック解除）ユーザーのフロー:**
- リッチメニュー復帰 + 再フォローテキスト送信

**重要な注意点:** `GAS_DEPLOY_ID` が設定されている場合、シナリオ step0 の即時配信をスキップする。理由: GASフローでreplyTokenを使って5通送るため、同じreplyTokenで重複送信するとエラーになる。

### 2. 動的セグメントタグ切り替え

各アクション実行時に `switchSegmentTag(db, friendId, newSeg)` を呼び出してタグを張り替える。

| アクション | 実装ファイル | 切り替え先 |
|-----------|------------|----------|
| アンケート回答 | `furim/button-actions.ts` | seg2 |
| キーコード発行 | `furim/actions.ts` actionKeycodeIssue | seg3 |
| コピー出品チケット30枚GET | `furim/button-actions.ts` | seg6 |
| Furimanです | `furim/actions.ts` actionFurimanCoupon | seg7 |
| 解説見た（延長キーワード） | `furim/actions.ts` actionExtendTrial | seg8 |

seg4（拡張インストール）・seg5（メルカリURL登録）はGAS側で検知して `/api/furim/scenario-switch` 経由で切り替わる。

`switchSegmentTag` の実装:
```typescript
async function switchSegmentTag(db: D1Database, friendId: string, newSeg: number): Promise<void> {
  // セグメント1〜8を全削除
  for (const name of ['セグメント1',...,'セグメント8']) {
    const t = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(name).first<{id:string}>();
    if (t) await db.prepare('DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ?').bind(friendId, t.id).run();
  }
  // 新しいセグメントタグを付与
  const newTag = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(`セグメント${newSeg}`).first<{id:string}>();
  if (newTag) await db.prepare('INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, datetime("now", "+9 hours"))').bind(friendId, newTag.id).run();
}
```

### 3. シナリオ再構築 (seed-furimauto-all-scenarios.mjs)

**通常（7日間試用）:**
- seg5: "メルカリURL登録済み"（コピーチケット取得促進）day0/1/2/3/4/5/6
- seg6: "FREEコピー出品チケット取得"（Furimanですキーワード促進）day0/1/2/3/4/5
- seg7: "Youtubeクーポン取得"（完全解説動画→解説見たキーワード）day0/1/2

**紹介（14日間試用）:**
- seg5: "メルカリURL登録済み" day0/1/2/3/4/12/13
- seg6: "FREEコピー出品チケット取得" day0/1/2/3/4/12
- seg7: "Youtubeクーポン取得" day0/1/12

旧シナリオ（"Free30取得済み", "試用期間終了"）はDEV DBから削除後、14本を一括登録。

### 4. GAS sheetHelper.js セグメント判定更新

8段階対応に変更。GASカラム名の確認で `Free30チケット` が正式名称と判明（`setFree30CopyTickets.js` を読んで確認）。

```javascript
const Free30チケット = row[masterColIdx['Free30チケット']];
const 延長キーワード  = row[masterColIdx['延長キーワード']];
if (端末 && URL && Free30 && Youtube && 延長) return 8;
if (端末 && URL && Free30 && Youtube)         return 7;
if (端末 && URL && Free30)                    return 6;
if (端末 && URL)                              return 5;
```

### 5. import-customers.mjs セグメント判定更新

GAS sheetHelper.js と同じロジックをインポートスクリプトにも適用。

### 6. kaisetsu-delivery.ts 更新

`wasHighSeg` の判定対象を seg4〜6 → **seg4〜8** に拡張。
削除ループの配列に `セグメント7`, `セグメント8` を追加。

### 7. furim.ts SCENARIO_NAME_MAP 更新

`/api/furim/scenario-switch` が参照するマップを8段階対応に更新。
seg8 は kaisetsu 管理のためシナリオなし（マップエントリなし）。

---

## DEV DB の状態（セッション終了時点）

### タグ
セグメント1〜8 は登録済みを確認。その他24タグも前セッションで登録済み。

### シナリオ（14本）
| ID | 名前 |
|----|------|
| 4201c65c | 通常 seg1 アンケート未回答（17steps） |
| 5e73ce79 | 通常 seg2 アンケート回答済み（10steps） |
| dd773578 | 通常 seg3 キーコード発行済み（12steps） |
| 97d4b0ae | 通常 seg4 拡張インストール済み（11steps） |
| 09a40d55 | 通常 seg5 メルカリURL登録済み（10steps） |
| c31c1a0a | 通常 seg6 FREEコピー出品チケット取得（8steps） |
| d7a11e9b | 通常 seg7 Youtubeクーポン取得（4steps） |
| 230e7d60 | 紹介 seg1 アンケート未回答（18steps） |
| ffc3ee39 | 紹介 seg2 アンケート回答済み（11steps） |
| af282f02 | 紹介 seg3 キーコード発行済み（11steps） |
| eb888adb | 紹介 seg4 拡張インストール済み（10steps） |
| d96bb16e | 紹介 seg5 メルカリURL登録済み（10steps） |
| e404c5c5 | 紹介 seg6 FREEコピー出品チケット取得（8steps） |
| 5ede4292 | 紹介 seg7 Youtubeクーポン取得（4steps） |

---

## ハマりポイント・注意事項

| 問題 | 原因 | 解決策 |
|------|------|--------|
| replyToken conflict | GASフローがreplyTokenを使う直後にWorkerも使おうとすると2回目は無効 | `GAS_DEPLOY_ID` 有りの時はシナリオ即時配信をスキップ |
| GASカラム名の誤認識 | `setFree30CopyTickets.js` を読まずに命名すると間違える | 必ず実装ファイルを読んで確認する |
| seg5の定義ミス | "Free30取得済み"だったが正しくは"メルカリURL登録=自動化実行済み" | GASシートの実態に合わせて再定義 |
| 全14シナリオ再登録 | 旧名称がDBに残ると名前で引けないシナリオが出る | DELETE → 再登録を一括で行う（ON DELETE CASCADEがある） |

---

## デプロイ済み

- Worker: `line-harness` (`7ec4d723`) → `https://line-harness.furimuato.workers.dev`
- DB: `line-crm` DEV（remote, `4b46e187-36e2-467f-87d4-24d07953d802`）
