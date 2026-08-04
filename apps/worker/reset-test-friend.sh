#!/usr/bin/env bash
# 検証用: 指定LINEユーザーを「新規友達」状態に戻す。
# 正規の test-reset エンドポイントを叩き、D1・マスターシート(GAS)・Stripe・Firebase を一括削除する。
# 使い方:
#   ./reset-test-friend.sh                 # デフォルト=あじゃぱー
#   ./reset-test-friend.sh Uxxxxxxxx...    # 任意のline_user_id
#   ./reset-test-friend.sh Uxxxx... force  # 月額会員タグ付きでも強制削除
# 削除後、スマホでブロック→解除すると isNewUser=true の新規登録フローが再現される。
set -euo pipefail

LUID="${1:-Ue4941a030cb2ec8758095fb0fffff344}"   # 既定: あじゃぱー
FORCE="false"; [ "${2:-}" = "force" ] && FORCE="true"

URL="https://line-harness-prod.furimuato.workers.dev/api/furim/test-reset"
# prod API key は ~/.claude.json (MCP設定) から実行時に読む（スクリプトに秘密を埋め込まない）
KEY=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['line-harness-prod']['env']['LINE_HARNESS_API_KEY'])")

echo "== test-reset: $LUID (force=$FORCE) =="
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"lineUserId\":\"$LUID\",\"confirmProd\":true,\"force\":$FORCE}" \
  | python3 -m json.tool

echo ""
echo "== 完了。スマホでブロック→解除して再登録してください =="
echo "   (409で止まった場合は月額会員タグ付き → 'force' を付けて再実行)"
