#!/usr/bin/env bash
# upstream(Shudesu/line-harness-oss) を取り込む際の補助スクリプト。
# FORK_OVERLAY.md に列挙した「独自フック入り共有ファイル」を自動参照し、
# 今回 upstream 側でも変更された＝コンフリクト確定のファイルを事前警告する。
#
# 使い方:
#   scripts/merge-upstream.sh            # upstream/main を取り込む（既定）
#   scripts/merge-upstream.sh v0.16.0    # 特定 ref を取り込む
#   scripts/merge-upstream.sh --check    # マージせず差分プレビューだけ
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
OVERLAY="docs/furimauto/FORK_OVERLAY.md"
UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"

REF="upstream/main"
CHECK_ONLY=0
for a in "$@"; do
  case "$a" in
    --check) CHECK_ONLY=1 ;;
    *) REF="$a" ;;
  esac
done

if [[ ! -f "$OVERLAY" ]]; then
  echo "ERROR: $OVERLAY が無い。先にレジストリを用意すること。" >&2
  exit 1
fi

echo "==> fetch $UPSTREAM_REMOTE"
git fetch "$UPSTREAM_REMOTE" --tags

# FORK_OVERLAY.md の "- <path> — ..." 行から共有ファイルのパスを抽出
OVERLAY_FILES=()
while IFS= read -r line; do OVERLAY_FILES+=("$line"); done \
  < <(grep -oE '^- (apps|packages)/[^ ]+' "$OVERLAY" | sed 's/^- //')

echo
echo "==> 独自フック入り共有ファイル（FORK_OVERLAY.md 登録）: ${#OVERLAY_FILES[@]}件"
printf '   %s\n' "${OVERLAY_FILES[@]}"

# 分岐点(merge-base)以降に upstream 側が変更したファイル＝コンフリクトの真因
MERGE_BASE="$(git merge-base HEAD "$REF" || true)"
DIFF_FROM="${MERGE_BASE:-HEAD}"
UPSTREAM_CHANGED=()
while IFS= read -r line; do UPSTREAM_CHANGED+=("$line"); done \
  < <(git diff --name-only "$DIFF_FROM" "$REF")

echo
echo "==> 今回 $REF 側でも変更され、コンフリクトしやすいファイル:"
CONFLICT_RISK=()
for f in "${OVERLAY_FILES[@]}"; do
  for u in "${UPSTREAM_CHANGED[@]+"${UPSTREAM_CHANGED[@]}"}"; do
    if [[ "$f" == "$u" ]]; then
      CONFLICT_RISK+=("$f")
      break
    fi
  done
done
if [[ ${#CONFLICT_RISK[@]} -eq 0 ]]; then
  echo "   （なし。独自フック入りファイルはupstream側で変更されていない）"
else
  for f in "${CONFLICT_RISK[@]}"; do
    echo "   ⚠ $f"
    # FORK_OVERLAY.md の該当行（再適用方針）を表示
    grep -F "- $f —" "$OVERLAY" | sed 's/^- /     ↳ /'
  done
fi

if [[ $CHECK_ONLY -eq 1 ]]; then
  echo
  echo "==> --check のためマージは実行しない。"
  exit 0
fi

echo
read -r -p "==> git merge $REF を実行する？ [y/N] " ans
[[ "${ans:-N}" =~ ^[yY]$ ]] || { echo "中止。"; exit 0; }

set +e
git merge --no-ff "$REF"
MERGE_RC=$?
set -e

if [[ $MERGE_RC -ne 0 ]]; then
  echo
  echo "==> コンフリクト発生。独自フックの再適用方針:"
  for f in $(git diff --name-only --diff-filter=U); do
    echo "   ⚠ $f"
    grep -F "- $f —" "$OVERLAY" | sed 's/^- /     ↳ /' || echo "     ↳ (FORK_OVERLAY.md 未登録。新規の独自改変なら解決後に登録する)"
  done
  echo
  echo "解決後: docs/furimauto/FORK_OVERLAY.md のマージ後チェックリストを実行する。"
  exit $MERGE_RC
fi

echo
echo "==> マージ成功（自動コンフリクトなし）。"
echo "   FORK_OVERLAY.md のマージ後チェックリスト（ビルド/フック残存/型境界）を必ず実行する。"
