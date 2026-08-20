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
const isProdBuild = process.env.CLOUDFLARE_ENV === "prod";
const prodEnv = isProdBuild ? loadEnv("prod", __dirname, "VITE_") : {};

if (isProdBuild) {
  const liffId = prodEnv.VITE_LIFF_ID;
  if (!liffId) {
    throw new Error("prod ビルドなのに .env.prod の VITE_LIFF_ID がありません");
  }
  if (!liffId.startsWith("1660804123-")) {
    throw new Error(`prod ビルドに本番以外の LIFF ID が指定されています: ${liffId}`);
  }
}

export default defineConfig({
  plugins: [cloudflare(), react(), tailwindcss()],
  define: isProdBuild
    ? {
        "import.meta.env.VITE_LIFF_ID": JSON.stringify(prodEnv.VITE_LIFF_ID),
        "import.meta.env.VITE_BOT_BASIC_ID": JSON.stringify(prodEnv.VITE_BOT_BASIC_ID ?? ""),
      }
    : {},
});
