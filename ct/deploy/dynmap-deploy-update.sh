#!/usr/bin/env bash
# CT104 の自動更新：GitHub の deploy ブランチにある ct/deploy/dynmap_deploy.sh を取得し、
# 内容が変わっていれば /opt/opsbot/dynmap_deploy.sh を差し替える。
# dynmap-deploy-update.timer から5分おきに root で起動される。取得したファイルは
# 文法チェック（bash -n）以外では実行しない。
#
# 本スクリプト自体は root 所有で /usr/local/sbin/dynmap-deploy-update に手作業で配置し、
# リポジトリから自動更新はしない。設定は /etc/opsbot/dynmap-update.env。

set -euo pipefail

RAW_URL="${OPSBOT_DYNMAP_UPDATE_URL:-https://raw.githubusercontent.com/Gorodrich/ops-bot/deploy/ct/deploy/dynmap_deploy.sh}"
WEBHOOK="${OPSBOT_DEPLOY_DISCORD_WEBHOOK_URL:-}"
DEST="/opt/opsbot/dynmap_deploy.sh"
CONF="/etc/opsbot/dynmap_deploy.conf"
# 同じ内容のファイルで失敗し続けても通知は1回にするための記録。
FAILED_MARK="/opt/opsbot/.dynmap-deploy-update.failed"

log() { echo "[dynmap-deploy-update] $*"; }

notify() {
  log "$1"
  [ -n "$WEBHOOK" ] || return 0
  # CT104 に python3/jq が無くても動くよう、JSON 文字列のエスケープは bash で行う。
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"
  curl -fsS -m 10 -H 'Content-Type: application/json' -d "{\"content\":\"${s}\"}" "$WEBHOOK" >/dev/null || true
}

fail() {
  local sum
  sum="$(sha256sum "$tmp" | cut -d' ' -f1)"
  if [ "$(cat "$FAILED_MARK" 2>/dev/null || true)" != "$sum" ]; then
    notify "$1"
    echo "$sum" > "$FAILED_MARK"
  else
    log "$1（通知済み）"
  fi
  exit 1
}

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

curl -fsS -m 30 -o "$tmp" "$RAW_URL"

cmp -s "$tmp" "$DEST" && exit 0

# 取得内容の最低限の検証。失敗したら差し替えない（現行版で動き続ける）。
if [ ! -s "$tmp" ] || [ "$(head -c 19 "$tmp")" != "#!/usr/bin/env bash" ]; then
  fail "❌ CT104 dynmap_deploy.sh 更新中止：取得したファイルが想定と異なります（${RAW_URL}）"
fi
if ! bash -n "$tmp"; then
  fail "❌ CT104 dynmap_deploy.sh 更新中止：取得したファイルに文法エラーがあります"
fi
# 新しい版は配信先の設定を設定ファイルから読む。設定ファイルが無いまま差し替えると
# Dynmap 反映が全て失敗するため、その場合は差し替えない。
if grep -q "dynmap_deploy.conf" "$tmp" && [ ! -r "$CONF" ]; then
  fail "❌ CT104 dynmap_deploy.sh 更新中止：${CONF} がありません。README の手順で作成してください"
fi

[ -f "$DEST" ] && cp -p "$DEST" "${DEST}.prev"
install -o root -g root -m 0755 "$tmp" "$DEST"
rm -f "$FAILED_MARK"
notify "✅ CT104 dynmap_deploy.sh を更新しました（直前の版は ${DEST}.prev）"
