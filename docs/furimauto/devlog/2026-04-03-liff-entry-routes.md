# 2026-04-03 LIFF 友だち追加フロー + 流入経路設定

## やったこと

### 1. migration 003 / 010 をリモートに適用

`entry_routes` / `ref_tracking` テーブルと `friends.ref_code` カラムが未作成だったため適用。

```bash
cd apps/worker
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/003_entry_routes.sql
npx wrangler d1 execute line-crm --remote --file=../../packages/db/migrations/010_ad_conversions.sql
```

### 2. Worker に /api/entry-routes エンドポイント追加

`apps/worker/src/routes/entry-routes.ts` 新規作成。CRUD + stats。
`apps/worker/src/index.ts` に import & mount 追加。

### 3. 管理 UI に流入経路設定ページ追加

`apps/web/src/app/entry-routes/page.tsx` 新規作成。
- ref コード / 経路名 / タグ / シナリオ / リダイレクト先を CRUD
- URL コピーボタン付き

サイドバーに「流入経路設定」メニュー追加（設定セクション）。

### 4. LIFF セットアップ（ハマりポイント多数）

#### 必要な手順

1. LINE Developers → **LINE Login チャネル**（Messaging API ではない）→ LIFF → 追加
   - サイズ: Full
   - エンドポイントURL: `https://line-harness.furimuato.workers.dev`（Worker root）
   - スコープ: profile / openid / email
   - ボットリンク機能: **On (Aggressive)** ← 必須
2. LINE Login チャネル → 「LINEログイン設定」タブ → 「リンクされたボット」→ Messaging API チャネルを選択
3. `apps/worker/.env` に VITE 変数を設定してリビルド
4. `LIFF_URL` を wrangler secret に登録

```bash
# apps/worker/.env
VITE_LIFF_ID=1661091589-FAPZy1Xp   # Dev用LIFF ID
VITE_BOT_BASIC_ID=@763qrmnv         # Dev用 Bot basic ID
```

```bash
echo "https://liff.line.me/1661091589-FAPZy1Xp" | npx wrangler secret put LIFF_URL
```

#### ハマりポイント

| エラー | 原因 | 解決 |
|--------|------|------|
| Internal Server Error | `LIFF_URL` が未設定 → `liffUrl.match()` でクラッシュ | `LIFF_URL` secret 登録 + コードに null ガード追加 |
| 読み込み中で止まる | `VITE_LIFF_ID` 未設定のまま LIFF SPA がビルドされていた | `apps/worker/.env` 作成してリビルド |
| Unauthorized | `/liff` エンドポイントが auth middleware に引っかかっていた | auth.ts に `/liff` を除外追加 |
| There is no login bot linked to this channel | LINE Login チャネルに Messaging API ボットが未リンク | 「LINEログイン設定」→「リンクされたボット」で設定 |
| `liff.getFriendship()` エラー | ボットリンク未設定時に例外を throw する | try/catch で握りつぶして `friendFlag: false` にフォールバック |

### 5. LIFF フロー（完成後の動作）

```
スマホでLP上のボタンタップ
  ↓
liff.line.me/{LIFF_ID}?ref=lp0_dev_test
  ↓
LINE アプリが開く
  ↓
LINE Login 同意画面（ボットリンク機能: Aggressive で友だち追加ダイアログ）
  ↓
LIFF SPA が起動（Worker root から配信）
  ↓
liff.getProfile() → /api/liff/link POST（ref + idToken を送信）
  ↓
liff.getFriendship() で友だち確認
  未追加 → 友だち追加ボタン表示（line.me/R/ti/p/@763qrmnv）
  追加済み → 完了画面 → 2秒後にトーク画面へ遷移
```

### 6. LP への組み込み方

```html
<!-- スマホ: LINE アプリが直接開く / PC: QR コードページ表示 -->
<a id="line-btn" href="https://line-harness.furimuato.workers.dev/auth/line?ref=lp0">
  <img src="https://scdn.line-apps.com/n/line_add_friends/btn/ja.png" height="36">
</a>

<script>
  // クエリパラメータ（fbclid, gclid 等）を引き継ぐ場合
  const p = new URLSearchParams(window.location.search);
  const url = new URL('https://line-harness.furimuato.workers.dev/auth/line');
  ['ref','gclid','fbclid','utm_source','utm_medium','utm_campaign'].forEach(k => {
    const v = p.get(k); if (v) url.searchParams.set(k, v);
  });
  if (!p.get('ref')) url.searchParams.set('ref', 'lp0');
  document.getElementById('line-btn').href = url.toString();
</script>
```

---

## 関連ファイル

| ファイル | 変更内容 |
|---------|---------|
| `apps/worker/src/routes/entry-routes.ts` | 新規：流入経路 CRUD API |
| `apps/worker/src/routes/liff.ts` | `/liff` エンドポイント追加（後に不要）、mobile LIFF null ガード追加 |
| `apps/worker/src/client/main.ts` | `getFriendship()` を try/catch でオプション化 |
| `apps/worker/src/middleware/auth.ts` | `/liff` を認証スキップ対象に追加 |
| `apps/worker/.env` | `VITE_LIFF_ID` / `VITE_BOT_BASIC_ID` 設定（gitignore 対象） |
| `apps/web/src/app/entry-routes/page.tsx` | 新規：流入経路設定管理画面 |
| `apps/web/src/components/layout/sidebar.tsx` | 「流入経路設定」メニュー追加 |
| `apps/web/src/lib/api.ts` | `EntryRouteItem` 型 + `api.entryRoutes` 追加 |
| `packages/db/migrations/003_entry_routes.sql` | remote D1 に適用済み |
| `packages/db/migrations/010_ad_conversions.sql` | remote D1 に再適用済み |
