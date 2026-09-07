"""Dynmap配信ディレクトリへのSSH経由配置クライアント（open-items #41・decisions.md #53）。

Crafty Controller File Manager APIへの経路は以下の理由により見送り、CT104上の配置スクリプトへの
SSH実行方式へ切り替えた（2026-09-05・phase-3-checklist.md C-5）。
  - 「既存ファイルの読み取り」用エンドポイントはCrafty公式ドキュメント（docs.craftycontrol.com）に
    記載がなく、GitLab上のソースコード（Crafty 4系）でのみ確認できる非公開の実装詳細だった。
    バージョン間の後方互換が保証されない外部依存になる。
  - Bot用APIトークンのFILES権限は対象Minecraftサーバーの全ファイルに及び、Dynmap配信ディレクトリ
    だけに絞れない（最小権限の原則に反する）。
  - 旧実装（`crafty_files.py`、削除済み）は`httpx.Client(verify=False)`でTLS検証を無条件に
    無効化しており、`ct/CLAUDE.md`の「検証の無条件無効化はしない」に反していた
    （`crafty.py`のコンソールコマンド送信はフィンガープリントピン留めを別途行っているが、
    `crafty_files.py`はそれを行っていなかった）。

代わりにCT104側へ、単一の固定コマンドのみ実行可能なSSH専用ユーザーを用意する
（`authorized_keys`に`command="/opt/opsbot/dynmap_deploy.sh",no-pty,no-port-forwarding,...`で
強制コマンドを設定）。CT102からのSSHコマンド文字列は`$SSH_ORIGINAL_COMMAND`として強制コマンド側に
渡るため、これをサブコマンドの選択にのみ使う（`ct/deploy/dynmap_deploy.sh`参照）。ペイロード本体
（画像バイナリ・regions.jsテキスト）は標準入力経由で渡し、コマンドライン引数には含めない。

接続はCT102→CT104方向のみ（§3.4.4）。ホスト鍵は`known_hosts`ファイルによる検証を必須とし、
`StrictHostKeyChecking=yes`を用いる（無条件無効化はしない）。
"""

from __future__ import annotations

import logging
import re
import subprocess
from dataclasses import dataclass

from .config import Config

log = logging.getLogger("opsbot_ct.dynmap_ssh")

_MC_NAME_RE = re.compile(r"^[A-Za-z0-9_]{1,16}$")


class DynmapSSHError(RuntimeError):
    pass


def _validate_mc_name(mc_name: str) -> None:
    if not _MC_NAME_RE.match(mc_name):
        raise DynmapSSHError(f"不正なMinecraftユーザー名です（配置スクリプトへは渡しません）: {mc_name!r}")


@dataclass
class DynmapSSHClient:
    cfg: Config

    def _run(self, subcommand: str, stdin_bytes: bytes = b"") -> bytes:
        cmd = [
            "ssh",
            "-i", self.cfg.dynmap_ssh_identity_file,
            "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=yes",
            "-o", f"UserKnownHostsFile={self.cfg.dynmap_ssh_known_hosts_file}",
            "-o", "ConnectTimeout=10",
            "-p", str(self.cfg.dynmap_ssh_port),
            f"{self.cfg.dynmap_ssh_user}@{self.cfg.dynmap_ssh_host}",
            "--",
            subcommand,
        ]
        try:
            res = subprocess.run(cmd, input=stdin_bytes, capture_output=True, timeout=30, check=False)
        except subprocess.TimeoutExpired as e:
            raise DynmapSSHError(f"SSH実行がタイムアウトしました（subcommand={subcommand}）: {e}") from e
        except OSError as e:
            raise DynmapSSHError(f"SSHコマンドの起動に失敗しました: {e}") from e
        if res.returncode != 0:
            raise DynmapSSHError(
                f"SSH実行失敗 subcommand={subcommand} returncode={res.returncode} "
                f"stderr={res.stderr.decode('utf-8', 'replace')[:300]}"
            )
        return res.stdout

    def read_regions_js(self) -> str | None:
        """regions.jsの現在の内容を読む。CT104側に未配置なら`None`を返す（配置スクリプトの規約：
        終了コード3＝ファイル無し。それ以外の非0終了コードは異常としてDynmapSSHErrorにする）。
        """
        try:
            out = self._run("read-regions")
        except DynmapSSHError as e:
            if "returncode=3" in str(e):
                return None
            raise
        return out.decode("utf-8")

    def write_regions_js(self, content: str) -> None:
        self._run("write-regions", content.encode("utf-8"))

    def write_image(self, mc_name: str, content: bytes) -> None:
        _validate_mc_name(mc_name)
        self._run(f"write-image {mc_name}", content)
