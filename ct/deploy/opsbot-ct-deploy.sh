#!/usr/bin/env bash
# CT102 の自動デプロイ：GitHub の deploy ブランチを取得し、/opt/opsbot/ct へ反映して
# poller を再起動し、ハートビートで起動を確認する。失敗したら直前の状態へ戻す。
# opsbot-ct-deploy.timer から5分おきに opsbot-deploy ユーザーで起動される。
#
# 権限の分離（README「自動デプロイ」参照）：
#   * 本スクリプトは root 所有で /usr/local/bin/opsbot-ct-deploy に手作業で配置する。
#     リポジトリから自分自身を自動更新することはしない（deploy ブランチの内容が
#     このスクリプトの挙動を変えられないようにするため）。
#   * 実行ユーザー opsbot-deploy は /opt/opsbot/ct（コードと .venv）を所有するが root ではない。
#     pip install（パッケージのビルド処理が走る）も root では実行しない。
#   * root 権限が要るのは poller の再起動だけで、sudoers でその1コマンドに限定する
#     （opsbot-ct-deploy.sudoers）。
#   * poller を動かす opsbot ユーザーはコードを読めるが書けない。
#
# 設定は /etc/opsbot/deploy.env（deploy.env.example 参照）。

set -euo pipefail

REPO_URL="${OPSBOT_DEPLOY_REPO_URL:-https://github.com/Gorodrich/ops-bot.git}"
BRANCH="${OPSBOT_DEPLOY_BRANCH:-deploy}"
WEBHOOK="${OPSBOT_DEPLOY_DISCORD_WEBHOOK_URL:-}"
STATE_DIR="${OPSBOT_DEPLOY_STATE_DIR:-/var/lib/opsbot-deploy}"
TARGET="${OPSBOT_DEPLOY_TARGET:-/opt/opsbot/ct}"
SERVICE="opsbot-ct-poller"
HEARTBEAT="${OPSBOT_DEPLOY_HEARTBEAT:-/var/lib/node_exporter/textfile_collector/opsbot_ct.prom}"
HEALTH_TIMEOUT_SEC="${OPSBOT_DEPLOY_HEALTH_TIMEOUT_SEC:-120}"

CLONE="${STATE_DIR}/ops-bot"
BACKUP="${STATE_DIR}/backup"
DEPLOYED_FILE="${STATE_DIR}/deployed_sha"
FAILED_FILE="${STATE_DIR}/failed_sha"

# 本番側にしか無いもの（仮想環境・作業ディレクトリ・ビルド生成物）は触らない。
RSYNC_EXCLUDES=(--exclude='.venv/' --exclude='work/' --exclude='*.egg-info/' --exclude='__pycache__/')

log() { echo "[opsbot-ct-deploy] $*"; }

notify() {
  log "$1"
  [ -n "$WEBHOOK" ] || return 0
  python3 -c 'import json,sys; print(json.dumps({"content": sys.argv[1]}))' "$1" \
    | curl -fsS -m 10 -H 'Content-Type: application/json' -d @- "$WEBHOOK" >/dev/null || true
}

exec 9>"${STATE_DIR}/lock"
flock -n 9 || { log "別のデプロイが実行中のためスキップ"; exit 0; }

# ── 取得 ────────────────────────────────────────────────────────────
if [ ! -d "${CLONE}/.git" ]; then
  git clone --quiet --filter=blob:none --sparse --branch "$BRANCH" "$REPO_URL" "$CLONE"
  git -C "$CLONE" sparse-checkout set ct
fi
git -C "$CLONE" fetch --quiet origin "$BRANCH"
NEW="$(git -C "$CLONE" rev-parse FETCH_HEAD)"
SHORT="${NEW:0:7}"
DEPLOYED="$(cat "$DEPLOYED_FILE" 2>/dev/null || true)"
FAILED="$(cat "$FAILED_FILE" 2>/dev/null || true)"

[ "$NEW" = "$DEPLOYED" ] && exit 0
# 一度失敗して戻したコミットは、新しいコミットが来るまで再試行しない（失敗→復元の繰り返し防止）。
[ "$NEW" = "$FAILED" ] && exit 0

# ct/ に変更が無い（Workers や docs だけの変更）なら、記録だけ進めて再起動しない。
if [ -n "$DEPLOYED" ] && git -C "$CLONE" cat-file -e "${DEPLOYED}^{commit}" 2>/dev/null \
   && git -C "$CLONE" diff --quiet "$DEPLOYED" "$NEW" -- ct/; then
  echo "$NEW" > "$DEPLOYED_FILE"
  log "ct/ に変更なし（${SHORT}）"
  exit 0
fi

git -C "$CLONE" checkout --quiet --force --detach "$NEW"
SRC="${CLONE}/ct"

# 自動では反映しないファイル（systemd ユニット・CT104 用スクリプト等）の変更を通知に含める。
MANUAL_NOTE=""
if [ -n "$DEPLOYED" ] && git -C "$CLONE" cat-file -e "${DEPLOYED}^{commit}" 2>/dev/null; then
  changed_deploy="$(git -C "$CLONE" diff --name-only "$DEPLOYED" "$NEW" -- ct/deploy/ || true)"
  if [ -n "$changed_deploy" ]; then
    MANUAL_NOTE=$'\n'"⚠ 次のファイルは自動では反映されません。必要なら手作業で配置してください："$'\n'"${changed_deploy}"
  fi
fi

PYPROJECT_CHANGED=0
cmp -s "${SRC}/pyproject.toml" "${TARGET}/pyproject.toml" || PYPROJECT_CHANGED=1

# ── 反映 ────────────────────────────────────────────────────────────
mkdir -p "$BACKUP"
rsync -a --delete "${RSYNC_EXCLUDES[@]}" "${TARGET}/" "${BACKUP}/"

install_deps() {
  "${TARGET}/.venv/bin/pip" install --quiet --disable-pip-version-check -e "$TARGET"
}

# 退避した状態に完全に戻す（失敗したリリースで新規追加されたファイルも消す）。
# 除外対象（.venv・work 等）は --delete でも消されない。
restore() {
  rsync -a --delete --chmod=D755,F644 "${RSYNC_EXCLUDES[@]}" "${BACKUP}/" "${TARGET}/"
  if [ "$PYPROJECT_CHANGED" = 1 ]; then install_deps || true; fi
}

rsync -a --chmod=D755,F644 "${RSYNC_EXCLUDES[@]}" "${SRC}/" "${TARGET}/"
if [ "$PYPROJECT_CHANGED" = 1 ] && ! install_deps; then
  restore
  echo "$NEW" > "$FAILED_FILE"
  notify "❌ CT102 デプロイ失敗 \`${SHORT}\`：pip install に失敗したため元に戻しました。${MANUAL_NOTE}"
  exit 1
fi

# ── 再起動と起動確認 ────────────────────────────────────────────────
# 定期メンテナンス（opsbot-ct-poller-pause.timer）等で意図的に止められている間は
# 勝手に起動しない。ファイルだけ更新し、次回の起動時に反映される。
state="$(systemctl is-active "$SERVICE" || true)"
if [ "$state" = "inactive" ]; then
  echo "$NEW" > "$DEPLOYED_FILE"
  notify "⏸ CT102 ファイル更新 \`${SHORT}\`（poller 停止中のため再起動せず。次回起動時に反映）${MANUAL_NOTE}"
  exit 0
fi

heartbeat_ok_since() {
  local since="$1" up ts
  [ -r "$HEARTBEAT" ] || return 1
  up="$(awk '$1=="opsbot_ct_up"{print $2}' "$HEARTBEAT")"
  ts="$(awk '$1=="opsbot_ct_last_poll_timestamp_seconds"{print $2}' "$HEARTBEAT")"
  [ "$up" = "1" ] && [ -n "$ts" ] && [ "$ts" -ge "$since" ]
}

# 起動確認。戻り値 0=ハートビートで正常確認 / 2=時間内にハートビートは来なかったが
# プロセスは落ちずに動き続けている / 1=起動失敗（停止・クラッシュによる再起動）。
# poller は取得したジョブを処理し終えてからハートビートを書くため、再起動直後に
# 長時間の LLM ジョブを拾うとハートビートが遅れる。それだけで失敗扱いにはしない。
wait_healthy() {
  local since="$1" restarts0 deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SEC ))
  restarts0="$(systemctl show -p NRestarts --value "$SERVICE")"
  sleep 5
  while :; do
    if ! systemctl is-active --quiet "$SERVICE" \
       || [ "$(systemctl show -p NRestarts --value "$SERVICE")" != "$restarts0" ]; then
      return 1
    fi
    heartbeat_ok_since "$since" && return 0
    [ "$(date +%s)" -ge "$deadline" ] && return 2
    sleep 5
  done
}

started_at="$(date +%s)"
sudo -n /usr/bin/systemctl restart "$SERVICE"
rc=0; wait_healthy "$started_at" || rc=$?
if [ "$rc" = 0 ] || [ "$rc" = 2 ]; then
  echo "$NEW" > "$DEPLOYED_FILE"
  rm -f "$FAILED_FILE"
  note=""
  [ "$rc" = 2 ] && note="（${HEALTH_TIMEOUT_SEC}秒以内にポーリング成功は未確認。プロセスは稼働中。長時間ジョブ処理中か Workers への接続失敗の可能性があるので、念のため journalctl -u ${SERVICE} を確認してください）"
  notify "✅ CT102 デプロイ成功 \`${SHORT}\`${note}${MANUAL_NOTE}"
  exit 0
fi

restore
echo "$NEW" > "$FAILED_FILE"
rolled_at="$(date +%s)"
sudo -n /usr/bin/systemctl restart "$SERVICE"
rc=0; wait_healthy "$rolled_at" || rc=$?
if [ "$rc" != 1 ]; then
  notify "❌ CT102 デプロイ失敗 \`${SHORT}\`：poller が起動直後に停止したため元に戻しました（復元後は稼働中）。journalctl -u ${SERVICE} を確認してください。${MANUAL_NOTE}"
else
  notify "🚨 CT102 デプロイ失敗 \`${SHORT}\`：元に戻しましたが、復元後も poller が起動しません。至急 journalctl -u ${SERVICE} を確認してください。"
fi
exit 1
