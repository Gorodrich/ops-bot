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
#   2. 配信先の設定を /etc/opsbot/dynmap_deploy.conf に root:root 0644 で置く
#      （dynmap_deploy.conf.example 参照）。本スクリプトは root:root 0755 で
#      /opt/opsbot/dynmap_deploy.sh に配置する（/opt/opsbot も root 所有・他者書き込み不可）。
#      強制コマンドで動く opsbot-dynmap 自身が、本スクリプトや設定を書き換えられないようにするため。
#      以後の更新は dynmap-deploy-update.timer が GitHub の deploy ブランチから自動で行う
#      （README「自動デプロイ」参照）。
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
#   read-regions              regions.jsの内容を標準出力へ。存在しなければ終了コード3。
#   write-regions             標準入力の内容でregions.jsを原子的に置き換える（tmp+mv）。
#   write-tile <name> <r> <c> 標準入力の内容を images/indiv/<name>/tile_<r>_<c>.png として
#                              原子的に書き込む（decisions.md #63・Dynmapオーバーレイ軽量化の
#                              タイル分割）。<r>/<c>は0〜9999の数字のみ。
#   write-preview <name>      標準入力の内容を images/indiv/<name>/preview.png として原子的に
#                              書き込む（ホバー当たり判定専用の縮小画像）。
#                              <name> はいずれも英数字とアンダースコアのみ（Minecraftユーザー名の制約）。
#
# 終了コード：0=成功 1=引数不正 2=未知のサブコマンド 3=regions.js無し（read-regions） 4=設定不備
#
# 2026-09-21変更：decisions.md #63により旧`write-image <name>`（images/indiv/<name>.pngへの
# 単一画像書き込み）を廃止し、`write-tile`/`write-preview`に置き換えた。旧サブコマンドで既に
# 配置済みの images/indiv/<name>.png は削除しない（open-items #38と同様、誤削除防止のため
# 既存ファイルは残す。新形式の regions 配列からは参照されなくなるだけ）。
#
# パストラバーサル対策：<name> をホワイトリスト正規表現で検証し、ディレクトリ区切りやドットを含む
#値は拒否する。DYNMAP_WEB_DIR 配下の固定ファイル名以外には一切書き込まない。

set -euo pipefail

# 配信先の設定は環境ごとに異なるため本スクリプトには書かず、設定ファイルから読む
# （2026-10-06変更：リポジトリのファイルをそのまま自動配置できるようにするため）。
CONF="/etc/opsbot/dynmap_deploy.conf"
DYNMAP_WEB_DIR=""
IMAGES_SUBDIR="images/indiv"
REGIONS_JS_PATH="js/custom_overlay.js"
if [ ! -r "$CONF" ]; then
  echo "config not found: $CONF" >&2
  exit 4
fi
# shellcheck source=/dev/null
. "$CONF"
if [ -z "$DYNMAP_WEB_DIR" ] || [ ! -d "$DYNMAP_WEB_DIR" ]; then
  echo "invalid DYNMAP_WEB_DIR: $DYNMAP_WEB_DIR" >&2
  exit 4
fi

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

  write-tile)
    rest="${cmd#write-tile }"
    name="${rest%% *}"
    rc="${rest#* }"
    row="${rc%% *}"
    col="${rc#* }"
    if ! [[ "$name" =~ ^[A-Za-z0-9_]{1,16}$ ]]; then
      echo "invalid mc_name: $name" >&2
      exit 1
    fi
    if ! [[ "$row" =~ ^[0-9]{1,4}$ ]] || ! [[ "$col" =~ ^[0-9]{1,4}$ ]]; then
      echo "invalid tile coords: row=$row col=$col" >&2
      exit 1
    fi
    tile_dir="${images_dir}/${name}"
    mkdir -p "$tile_dir"
    tile_file="${tile_dir}/tile_${row}_${col}.png"
    tmp="$(mktemp "${tile_file}.tmp.XXXXXX")"
    cat > "$tmp"
    chmod 644 "$tmp"
    mv -f "$tmp" "$tile_file"
    ;;

  write-preview)
    name="${cmd#write-preview }"
    if ! [[ "$name" =~ ^[A-Za-z0-9_]{1,16}$ ]]; then
      echo "invalid mc_name: $name" >&2
      exit 1
    fi
    tile_dir="${images_dir}/${name}"
    mkdir -p "$tile_dir"
    preview_file="${tile_dir}/preview.png"
    tmp="$(mktemp "${preview_file}.tmp.XXXXXX")"
    cat > "$tmp"
    chmod 644 "$tmp"
    mv -f "$tmp" "$preview_file"
    ;;

  *)
    echo "unknown subcommand: $sub" >&2
    exit 2
    ;;
esac
