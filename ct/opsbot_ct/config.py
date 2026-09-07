"""CT102 側の設定読み込み。

秘密情報（Workers 共有シークレット、Discord トークン、Crafty API トークン）は
CT102 のローカルにのみ保持し、CT102 外へ出さない（§3.4.2）。
環境変数、または systemd の EnvironmentFile（/etc/opsbot/ct.env）から読む。
値はここでハードコードしない（ルールc）。
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    # Workers のポーリング先（アウトバウンド HTTPS のみ・§3.4.2）
    workers_base_url: str
    ct_shared_secret: str

    # 適応的ポーリング間隔（§3.4.2）
    active_interval_sec: float = 4.0
    idle_interval_sec: float = 45.0

    # 同時実行数（§11-13：画像処理用・LLM用で各1、合計2まで）
    max_image_jobs: int = 1
    max_llm_jobs: int = 1
    # Crafty操作は軽量なHTTP呼び出しのため、画像処理・LLMほど厳しく制限しない
    max_crafty_jobs: int = 3

    # node-exporter textfile collector 用のハートビート出力先（§3.4.6）
    # インバウンドの待受は作らず、ファイル経由で死活を監視基盤へ渡す。
    heartbeat_path: str = "/var/lib/node_exporter/textfile_collector/opsbot_ct.prom"

    # Crafty API（Vnet 内直接・§3.4.3）。証明書はピン留め前提。
    # 既定値は例示。実際の値は OPSBOT_CRAFTY_BASE_URL で環境ごとに設定する。
    crafty_base_url: str = "https://192.168.100.2:8443"
    crafty_cert_fingerprint_sha256: str = ""  # 空なら未設定（起動時に警告）
    crafty_api_token: str = ""
    crafty_server_id: str = ""  # CraftyのサーバーUUID（GET /api/v2/servers で確認可能）

    # 個人開発領マスク画像の保存先（Phase 2・§6.3）。claims.mask_ref はこの配下の
    # ファイル名を指す。Dynmap配信ディレクトリへの配置はPhase 3（§3.4.4）。
    masks_dir: str = "/var/lib/opsbot/masks"

    # Dynmap自動反映（Phase 3・§6.3.4・decisions.md #31・#53・open-items #41）。
    # CT104側の配信ディレクトリ内の相対パス（配置スクリプト`dynmap_deploy.sh`が解決する）。
    # 例：Dynmapプラグインの配信ディレクトリが <サーバー>/plugins/dynmap/web の場合、
    # dynmap_web_relative_dir="plugins/dynmap/web" とする。
    dynmap_web_relative_dir: str = "plugins/dynmap/web"
    dynmap_images_subdir: str = "images/indiv"
    dynmap_overlay_js_path: str = "js/custom_overlay.js"  # dynmap_web_relative_dir からの相対パス

    # CT104へのSSH接続（Crafty API経由の非公開エンドポイント依存を避けるため採用・
    # phase-3-checklist.md C-5）。CT102→CT104方向のみ（§3.4.4）。
    dynmap_ssh_host: str = ""  # Dynmap配信ホスト（CT104）のVnet内アドレス。Craftyのホストとは別
    dynmap_ssh_port: int = 22
    dynmap_ssh_user: str = "opsbot-dynmap"
    dynmap_ssh_identity_file: str = "/etc/opsbot/dynmap_ssh_id_ed25519"
    dynmap_ssh_known_hosts_file: str = "/etc/opsbot/dynmap_known_hosts"
    dynmap_sync_enabled: bool = False  # CT104側のSSHセットアップ確認が済むまでは無効のまま運用する

    # LLM層（Phase 6・§7）。Claude Pro利用枠（開発者個人のログインセッション）を使う。
    # CT102で事前に `claude login` 済みであること（README「Phase 6 セットアップ手順」参照）。
    # CLIのサブコマンド名・フラグは実際にインストールされたバージョンで要確認（§14.1 #32と同種の注意）。
    anthropic_cli_path: str = "claude"
    # CLIの既定モデルに委ねず明示指定する（値はCLIが解釈するエイリアス／モデルIDそのまま）。
    # 空文字なら --model を付与せずCLI既定に委ねる（後方互換）。
    anthropic_model: str = "sonnet"
    claude_timeout_sec: int = 120
    # 根拠条文のgrep先（§7.3）。未設定なら該当抜粋なしで動作する（あると便利な機能・必須ではない）。
    rules_dir: str = ""

    @staticmethod
    def from_env() -> Config:
        def req(name: str) -> str:
            v = os.environ.get(name)
            if not v:
                raise SystemExit(f"環境変数 {name} が未設定です（/etc/opsbot/ct.env を確認）")
            return v

        def opt(name: str, default: str) -> str:
            return os.environ.get(name, default)

        return Config(
            workers_base_url=req("OPSBOT_WORKERS_BASE_URL"),
            ct_shared_secret=req("OPSBOT_CT_SHARED_SECRET"),
            active_interval_sec=float(opt("OPSBOT_ACTIVE_INTERVAL_SEC", "4")),
            idle_interval_sec=float(opt("OPSBOT_IDLE_INTERVAL_SEC", "45")),
            max_crafty_jobs=int(opt("OPSBOT_MAX_CRAFTY_JOBS", "3")),
            heartbeat_path=opt(
                "OPSBOT_HEARTBEAT_PATH",
                "/var/lib/node_exporter/textfile_collector/opsbot_ct.prom",
            ),
            crafty_base_url=opt("OPSBOT_CRAFTY_BASE_URL", "https://192.168.100.2:8443"),
            crafty_cert_fingerprint_sha256=opt("OPSBOT_CRAFTY_CERT_FINGERPRINT_SHA256", ""),
            crafty_api_token=opt("OPSBOT_CRAFTY_API_TOKEN", ""),
            crafty_server_id=opt("OPSBOT_CRAFTY_SERVER_ID", ""),
            masks_dir=opt("OPSBOT_MASKS_DIR", "/var/lib/opsbot/masks"),
            dynmap_web_relative_dir=opt("OPSBOT_DYNMAP_WEB_RELATIVE_DIR", "plugins/dynmap/web"),
            dynmap_images_subdir=opt("OPSBOT_DYNMAP_IMAGES_SUBDIR", "images/indiv"),
            dynmap_overlay_js_path=opt("OPSBOT_DYNMAP_OVERLAY_JS_PATH", "js/custom_overlay.js"),
            dynmap_ssh_host=opt("OPSBOT_DYNMAP_SSH_HOST", ""),
            dynmap_ssh_port=int(opt("OPSBOT_DYNMAP_SSH_PORT", "22")),
            dynmap_ssh_user=opt("OPSBOT_DYNMAP_SSH_USER", "opsbot-dynmap"),
            dynmap_ssh_identity_file=opt(
                "OPSBOT_DYNMAP_SSH_IDENTITY_FILE", "/etc/opsbot/dynmap_ssh_id_ed25519"
            ),
            dynmap_ssh_known_hosts_file=opt(
                "OPSBOT_DYNMAP_SSH_KNOWN_HOSTS_FILE", "/etc/opsbot/dynmap_known_hosts"
            ),
            dynmap_sync_enabled=opt("OPSBOT_DYNMAP_SYNC_ENABLED", "false").lower() == "true",
            anthropic_cli_path=opt("OPSBOT_ANTHROPIC_CLI_PATH", "claude"),
            anthropic_model=opt("OPSBOT_ANTHROPIC_MODEL", "sonnet"),
            claude_timeout_sec=int(opt("OPSBOT_CLAUDE_TIMEOUT_SEC", "120")),
            rules_dir=opt("OPSBOT_RULES_DIR", ""),
        )
