#!/usr/bin/env bash
# CT104に配置する、Dynmap配信ディレクトリ書き込み専用の強制コマンド（open-items #41・
# decisions.md #53・phase-3-checklist.md C-5）。
#
# セットアップ（CT104側）：
#   1. 専用ユーザーを作成する（例：useradd -r -m -s /bin/bash opsbot-dynmap）。
#      sshdはauthorized_keysのcommand=で指定した文字列を「ユーザーのログインシェル -c」で
#      実行するため、シェルをnologinにすると強制コマンド自体が動かなくなる（sshdがnologinを
#      execしてしまい"This account is currently not available."で終了する）。対話ログインの
#      禁止はno-pty（＋パスワード認証を無効化）で行う。
#   2. 本スクリプトを 0700 opsbot-dynmap:opsbot-dynmap で /opt/opsbot/dynmap_deploy.sh に配置する。
#   3. CT102側で生成した公開鍵を ~opsbot-dynmap/.ssh/authorized_keys に以下の形式で1行登録する：
#        command="/opt/opsbot/dynmap_deploy.sh",no-pty,no-port-forwarding,no-X11-forwarding,\
#        no-agent-forwarding,no-user-rc ssh-ed25519 AAAA... opsbot-ct102
#      command= により、CT102から送られたコマンド文字列は無視され本スクリプトが必ず実行される。
#      CT102から実際に送信したかった文字列は $SSH_ORIGINAL_COMMAND に入る（sshd の仕様）。
#   4. sudoers 等でMinecraftサーバーのファイル所有者（例：minecraft ユーザー）宛への書き込み権限を
#      ACLで付与する（chmod/chownの追加設定はサーバー構成に応じて調整。setgid＋グループ書き込み等）。
#   5. Minecraftサーバープロセス自体には触れない（C-7）。書き込み対象はDynmap配信ディレクトリの
#      画像・regions.jsのみに限定する（下記 DYNMAP_WEB_DIR 配下から一切出ない）。
#
# 対応サブコマンド（$SSH_ORIGINAL_COMMAND の先頭トークンで判別。ペイロードは常に標準入力）：
#   read-regions          regions.jsの内容を標準出力へ。存在しなければ終了コード3。
#   write-regions         標準入力の内容でregions.jsを原子的に置き換える（tmp+mv）。
#   write-image <name>    標準入力の内容を images/indiv/<name>.png として原子的に書き込む。
#                          <name> は英数字とアンダースコアのみ（Minecraftユーザー名の制約）。
#
# パストラバーサル対策：<name> をホワイトリスト正規表現で検証し、ディレクトリ区切りやドットを含む
#値は拒否する。DYNMAP_WEB_DIR 配下の固定ファイル名以外には一切書き込まない。

set -euo pipefail

# ★配置先のサーバー構成に合わせて必ず書き換える。<crafty-server-uuid> は Crafty の
# 管理画面のサーバー URL、または GET /api/v2/servers で確認できる UUID。
DYNMAP_WEB_DIR="/home/minecraft/crafty/servers/<crafty-server-uuid>/plugins/dynmap/web"
IMAGES_SUBDIR="images/indiv"
REGIONS_JS_PATH="js/custom_overlay.js"

images_dir="${DYNMAP_WEB_DIR}/${IMAGES_SUBDIR}"
regions_file="${DYNMAP_WEB_DIR}/${REGIONS_JS_PATH}"

cmd="${SSH_ORIGINAL_COMMAND:-}"
sub="${cmd%% *}"

case "$sub" in
  read-regions)
    if [ ! -f "$regions_file" ]; then
      exit 3
    fi
    cat "$regions_file"
    ;;

  write-regions)
    tmp="$(mktemp "${regions_file}.tmp.XXXXXX")"
    cat > "$tmp"
    chmod 644 "$tmp"
    mv -f "$tmp" "$regions_file"
    ;;

  write-image)
    name="${cmd#write-image }"
    if ! [[ "$name" =~ ^[A-Za-z0-9_]{1,16}$ ]]; then
      echo "invalid mc_name: $name" >&2
      exit 1
    fi
    mkdir -p "$images_dir"
    tmp="$(mktemp "${images_dir}/${name}.png.tmp.XXXXXX")"
    cat > "$tmp"
    chmod 644 "$tmp"
    mv -f "$tmp" "${images_dir}/${name}.png"
    ;;

  *)
    echo "unknown subcommand: $sub" >&2
    exit 2
    ;;
esac
