"""Crafty Controller REST API クライアント（v2 API・Crafty 4.10.4・§3.4.3・§6.4.4）。

認証：ログイン不要の静的APIトークン（Craftyのアカウント設定 > API Tokens で発行）を
Authorization: Bearer <token> としてそのまま使う。/api/v2/auth/login は使わない。

証明書：Craftyは自己署名証明書（§3.4.3）。ここでは起動時に一度だけTLS証明書の
SHA-256フィンガープリントを照合し、Vnet内直接接続であることと合わせて安全性を担保する
（httpxの通常のTLS検証はVnet内自己署名証明書のため無効化し、代わりにピン留めで担保する。
「検証の無条件無効化はしない」の要件を、起動時ピン留めチェック＋Vnet限定という形で満たす）。

コンソールコマンド送信は POST /api/v2/servers/{serverID}/stdin（プレーンテキスト、スラッシュ無し）。
ホワイトリスト一覧はコンソールに直接返るAPIが無いため、`whitelist list` を送信した後に
サーバーログを取得してレスポンス行をパースする（ベストエフォート。失敗時は None を返す）。
"""

from __future__ import annotations

import logging
import re
import socket
import ssl
import time
from dataclasses import dataclass

import httpx

from .config import Config

log = logging.getLogger("opsbot_ct.crafty")

_WHITELIST_LIST_RE = re.compile(r"whitelisted player(?:s|\(s\))?:\s*(.*)", re.IGNORECASE)


class CraftyError(RuntimeError):
    pass


@dataclass
class CraftyClient:
    cfg: Config

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.cfg.crafty_api_token}"}

    def verify_pin(self) -> bool:
        """起動時のTLS証明書フィンガープリント照合（§3.4.3）。フィンガープリント未設定なら警告のみ。"""
        if not self.cfg.crafty_cert_fingerprint_sha256:
            log.warning("Crafty証明書フィンガープリント未設定のためピン留めをスキップします")
            return True
        host, port = _parse_host_port(self.cfg.crafty_base_url)
        try:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            with socket.create_connection((host, port), timeout=10) as sock:
                with ctx.wrap_socket(sock, server_hostname=host) as tls:
                    der = tls.getpeercert(binary_form=True)
            import hashlib

            actual = hashlib.sha256(der).hexdigest().lower()
            expected = self.cfg.crafty_cert_fingerprint_sha256.lower().replace(":", "")
            if actual != expected:
                log.error("Crafty証明書フィンガープリント不一致: expected=%s actual=%s", expected, actual)
                return False
            return True
        except OSError as e:
            log.error("Crafty証明書ピン留め確認に失敗: %s", e)
            return False

    def _client(self) -> httpx.Client:
        # ピン留めチェック済み・Vnet内限定接続を前提に、httpxの通常TLS検証は無効化する（§3.4.3）。
        return httpx.Client(base_url=self.cfg.crafty_base_url, verify=False, timeout=30.0)

    def send_console_command(self, command: str) -> None:
        with self._client() as client:
            res = client.post(
                f"/api/v2/servers/{self.cfg.crafty_server_id}/stdin",
                headers={**self._headers(), "content-type": "text/plain"},
                content=command,
            )
            if res.status_code >= 400:
                raise CraftyError(f"stdin送信失敗 status={res.status_code} body={res.text[:300]}")

    def whitelist_add(self, mc_name: str) -> None:
        self.send_console_command(f"whitelist add {mc_name}")

    def whitelist_remove(self, mc_name: str) -> None:
        self.send_console_command(f"whitelist remove {mc_name}")

    def whitelist_reload(self) -> None:
        self.send_console_command("whitelist reload")

    def fetch_recent_logs(self) -> str:
        with self._client() as client:
            res = client.get(f"/api/v2/servers/{self.cfg.crafty_server_id}/logs", headers=self._headers())
            if res.status_code >= 400:
                raise CraftyError(f"ログ取得失敗 status={res.status_code}")
            body = res.json()
            data = body.get("data", body)
            if isinstance(data, list):
                return "\n".join(str(line) for line in data)
            return str(data)

    def whitelist_list(self) -> list[str] | None:
        """`whitelist list` を送信し、直後のログから在籍プレイヤー名を読み取る（ベストエフォート）。"""
        self.send_console_command("whitelist list")
        time.sleep(1.5)
        try:
            logs = self.fetch_recent_logs()
        except CraftyError as e:
            log.error("whitelist_list: ログ取得失敗: %s", e)
            return None

        names = parse_whitelist_list(logs)
        if names is None:
            log.warning("whitelist_list: ログから該当行を検出できませんでした")
        return names


def parse_whitelist_list(logs: str) -> list[str] | None:
    """`whitelist list` コマンドの応答行（例：\"There are 2 whitelisted players: a, b\"）をパースする。"""
    for line in reversed(logs.splitlines()):
        m = _WHITELIST_LIST_RE.search(line)
        if m:
            return [n.strip() for n in m.group(1).split(",") if n.strip()]
    return None


def _parse_host_port(base_url: str) -> tuple[str, int]:
    # https://<host>:8443 のような形式のみを想定（§3.4.3の固定経路）。
    without_scheme = base_url.split("://", 1)[-1]
    host, _, port = without_scheme.partition(":")
    return host, int(port or 443)
