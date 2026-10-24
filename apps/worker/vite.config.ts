import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

// React + Tailwind は salon-booking ページ (?page=salon-book) でのみ使う。
// main.ts から動的 import するので React チャンクは別ファイルに分離され、
// 既存の form / Google Calendar booking 利用者には load されない。
//
// LIFF ID の環境取り違え対策（2026-07-20・2026-08-18 に本番全断の実績あり）:
// `vite build` は常に mode=production で走るため、DEV値が入った `.env` が読まれる。
// シェルで `VITE_LIFF_ID=...` を渡しても .env が勝つので、prod ビルドに DEV の
// LIFF ID が焼かれ、友だち追加が「Invalid LIFF ID」で全断する。
// CLOUDFLARE_ENV=prod のときは `.env.prod` を明示的に読み込んで上書きし、
// さらに DEV 値のまま通り抜けないようビルド前に落とす。
// 新 LINE（CLOUDFLARE_ENV=fmb・TB-2209）も同じ形で `.env.fmb` を読み、新 LINE の LINE ログインチャネルの LIFF ID 以外なら落とす。
const LIFF_ID_PREFIX: Record<string, string> = { prod: "1660804123-", fmb: "2012165991-" };
const buildEnv = process.env.CLOUDFLARE_ENV ?? "";
const isPinnedBuild = buildEnv in LIFF_ID_PREFIX;
const pinnedEnv = isPinnedBuild ? loadEnv(buildEnv, __dirname, "VITE_") : {};

if (isPinnedBuild) {
  const liffId = pinnedEnv.VITE_LIFF_ID;
  if (!liffId) {
    throw new Error(`${buildEnv} ビルドなのに .env.${buildEnv} の VITE_LIFF_ID がありません`);
  }
  if (!liffId.startsWith(LIFF_ID_PREFIX[buildEnv])) {
    throw new Error(`${buildEnv} ビルドに ${buildEnv} 以外の LIFF ID が指定されています: ${liffId}`);
  }
}

export default defineConfig({
  plugins: [cloudflare(), react(), tailwindcss()],
  define: isPinnedBuild
    ? {
        "import.meta.env.VITE_LIFF_ID": JSON.stringify(pinnedEnv.VITE_LIFF_ID),
        "import.meta.env.VITE_BOT_BASIC_ID": JSON.stringify(pinnedEnv.VITE_BOT_BASIC_ID ?? ""),
      }
    : {},
});
