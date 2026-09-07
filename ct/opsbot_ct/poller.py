"""Workers ジョブキューのポーリング取得ループ（プル方式・§3.4.2）。

重要な制約：
  * CT102 はインバウンドの待受エンドポイントを一切持たない（§11-8）。
    ここから Workers へ「アウトバウンド HTTPS」で取りに行くだけ。
  * 認証は共有シークレット（Bearer）。
  * 適応的間隔：直近に処理があれば短間隔、アイドル時は長間隔（§3.4.2）。
  * 画像処理ジョブと Claude Code ジョブを同時に複数実行しない（§11-13）。

Phase 0 のスコープ：ループが起動し、Workers をポーリングし、ハートビートを
node-exporter の textfile collector へ書き出すところまで。
Phase 1 で追加：crafty_op（ホワイトリスト追加・削除）・crafty_whitelist_audit の実処理と
完了報告（/ct/jobs/complete）。
Phase 2 で追加：image_process（subkind="kaihatsu_set"）の実処理（opsbot_ct.image）。
Phase 6 で追加：LLM層（claude_code、subkind="detect_tasks"|"assignment_tiebreak"）の実処理
（opsbot_ct.llm）。シャドーモードのため、検出結果の解釈・通知はWorkers側（llm/detectionCompletion.ts）
が行う。CT側はClaude Code CLIのheadless呼び出しとJSON整形のみを担う。
"""

from __future__ import annotations

import logging
import os
import signal
import tempfile
import time
from typing import TYPE_CHECKING, Any

from .config import Config
from .crafty import CraftyClient, CraftyError
from .dynmap_ssh import DynmapSSHError
from .dynmap_sync import process_dynmap_sync_job
from .image import process_kaihatsu_set_batch_job, process_kaihatsu_set_job
from .llm import LlmError, run_assignment_tiebreak_job, run_detect_tasks_job
from .mojang import MojangError, resolve_profile

if TYPE_CHECKING:
    import httpx

log = logging.getLogger("opsbot_ct.poller")

_running = True


def _handle_sigterm(_signum: int, _frame: Any) -> None:
    global _running
    _running = False


def write_heartbeat(path: str, *, healthy: bool, last_poll_ts: float) -> None:
    """node-exporter textfile collector へ Prometheus 形式で書き出す（§3.4.6）。

    インバウンドの待受を作らずに死活・滞留を監視基盤へ渡す手段。
    """
    body = (
        "# HELP opsbot_ct_up OpsBot CT poller liveness\n"
        "# TYPE opsbot_ct_up gauge\n"
        f"opsbot_ct_up {1 if healthy else 0}\n"
        "# HELP opsbot_ct_last_poll_timestamp_seconds Unix time of last successful poll\n"
        "# TYPE opsbot_ct_last_poll_timestamp_seconds gauge\n"
        f"opsbot_ct_last_poll_timestamp_seconds {last_poll_ts:.0f}\n"
    )
    try:
        d = os.path.dirname(path)
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".opsbot_ct.", suffix=".prom")
        with os.fdopen(fd, "w") as f:
            f.write(body)
        # mkstemp は 0600 で作成するため、別ユーザーで動く node-exporter が
        # 読めるよう明示的に world-readable にする（textfile collector の前提）。
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)  # アトミックに差し替え
    except OSError as e:
        log.warning("ハートビート書き込み失敗: %s", e)


def poll_once(client: httpx.Client, cfg: Config) -> list[dict[str, Any]]:
    """Workers へ1回ポーリングし、取得したジョブ配列を返す。"""
    resp = client.post(
        f"{cfg.workers_base_url.rstrip('/')}/ct/jobs/poll",
        headers={"authorization": f"Bearer {cfg.ct_shared_secret}"},
        json={"capacity": {"image": cfg.max_image_jobs, "llm": cfg.max_llm_jobs, "crafty": cfg.max_crafty_jobs}},
        timeout=30.0,
    )
    resp.raise_for_status()
    data = resp.json()
    return list(data.get("jobs", []))


def report_complete(
    client: httpx.Client,
    cfg: Config,
    job_id: int,
    *,
    status: str,
    result: Any = None,
    error: str | None = None,
) -> None:
    """ジョブ完了報告（アウトバウンドのみ・§3.4.2）。失敗してもポーリングループは止めない。"""
    try:
        resp = client.post(
            f"{cfg.workers_base_url.rstrip('/')}/ct/jobs/complete",
            headers={"authorization": f"Bearer {cfg.ct_shared_secret}"},
            json={"id": job_id, "status": status, "result": result, "error": error},
            # image_process の result には確認画像（base64）が含まれうるため、
            # crafty_op/mojang_lookup 用の既定より長めのタイムアウトを取る。
            timeout=90.0,
        )
        resp.raise_for_status()
    except Exception as e:  # noqa: BLE001
        log.error("ジョブ完了報告に失敗: job_id=%s error=%s", job_id, e)


def dispatch(job: dict[str, Any], crafty: CraftyClient | None, cfg: Config) -> tuple[str, Any, str | None]:
    """ジョブ種別ごとの処理。戻り値は (status, result, error)。"""
    kind = job.get("kind")
    payload = job.get("payload") or {}

    if kind == "image_process":
        subkind = payload.get("subkind")
        if subkind == "kaihatsu_set":
            try:
                result = process_kaihatsu_set_job(payload, masks_dir=cfg.masks_dir)
                return "done", result, None
            except Exception as e:
                log.exception("kaihatsu_set 処理に失敗: job_id=%s", job.get("id"))
                return "failed", None, f"画像処理エラー: {e}"
        if subkind in ("kaihatsu_set_batch", "kaihatsu_group"):
            # 代表者による一括申請（§5.7.3）・同時処理グループのset側（§5.7.4）。
            # 評価ロジックは共通（グループのdelete先行評価はWorkers側がジョブ投入前に済ませる）。
            try:
                result = process_kaihatsu_set_batch_job(payload, masks_dir=cfg.masks_dir)
                return "done", result, None
            except Exception as e:
                log.exception("%s 処理に失敗: job_id=%s", subkind, job.get("id"))
                return "failed", None, f"画像処理エラー: {e}"
        log.info("ジョブ受信（未実装のsubkindのためスキップ）: subkind=%s id=%s", subkind, job.get("id"))
        return "failed", None, f"未実装のsubkind: {subkind}"

    if kind == "dynmap_sync":
        # Dynmap自動反映（§6.3.4・decisions.md #31）。画像処理・Crafty操作とは別枠で直列化する
        # 必要は薄い（軽量なファイル書き込みのため）が、Crafty API呼び出しである点はcrafty_op同様。
        try:
            result = process_dynmap_sync_job(payload, cfg=cfg)
            return "done", result, None
        except DynmapSSHError as e:
            return "failed", None, str(e)
        except Exception as e:
            log.exception("dynmap_sync 処理に失敗: job_id=%s", job.get("id"))
            return "failed", None, f"Dynmap反映エラー: {e}"

    if kind == "crafty_op":
        if crafty is None:
            return "failed", None, "Crafty未設定（APIトークン未設定）"
        op = payload.get("op")
        mc_name = payload.get("mc_name")
        try:
            if op == "add":
                crafty.whitelist_add(mc_name)
            elif op == "remove":
                crafty.whitelist_remove(mc_name)
            else:
                return "failed", None, f"未知の op: {op}"
            return "done", {"op": op, "mc_name": mc_name}, None
        except CraftyError as e:
            return "failed", None, str(e)

    if kind == "mojang_lookup":
        username = payload.get("username")
        if not username:
            return "failed", None, "usernameが指定されていません"
        try:
            profile = resolve_profile(username)
            if profile is None:
                return "done", {"found": False}, None
            return "done", {"found": True, "uuid": profile.uuid, "name": profile.name}, None
        except MojangError as e:
            return "failed", None, str(e)

    if kind == "crafty_whitelist_audit":
        if crafty is None:
            return "failed", None, "Crafty未設定（APIトークン未設定）"
        try:
            names = crafty.whitelist_list()
            if names is None:
                return "failed", None, "whitelist list の応答を解析できませんでした"
            return "done", {"whitelisted_names": names}, None
        except CraftyError as e:
            return "failed", None, str(e)

    if kind == "claude_code":
        # LLM層（Phase 6・§7・§11-13：画像処理と同時に複数実行しない。capacity.llm=1で担保）。
        subkind = payload.get("subkind")
        try:
            if subkind == "detect_tasks":
                result = run_detect_tasks_job(
                    payload,
                    cli_path=cfg.anthropic_cli_path,
                    model=cfg.anthropic_model,
                    rules_dir=cfg.rules_dir,
                    timeout_sec=cfg.claude_timeout_sec,
                )
                return "done", result, None
            if subkind == "assignment_tiebreak":
                result = run_assignment_tiebreak_job(
                    payload, cli_path=cfg.anthropic_cli_path, model=cfg.anthropic_model, timeout_sec=cfg.claude_timeout_sec
                )
                return "done", result, None
        except LlmError as e:
            log.error("claude_code(%s) 処理に失敗: job_id=%s error=%s", subkind, job.get("id"), e)
            return "failed", None, str(e)
        except Exception as e:
            log.exception("claude_code(%s) 処理で予期しない例外: job_id=%s", subkind, job.get("id"))
            return "failed", None, f"予期しないエラー: {e}"
        return "failed", None, f"未実装のsubkind: {subkind}"

    log.info("ジョブ受信（未実装のためスキップ）: kind=%s id=%s", kind, job.get("id"))
    return "failed", None, f"未実装のジョブ種別: {kind}"


def run() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    signal.signal(signal.SIGTERM, _handle_sigterm)
    signal.signal(signal.SIGINT, _handle_sigterm)

    import httpx

    cfg = Config.from_env()
    if not cfg.crafty_cert_fingerprint_sha256:
        log.warning("Crafty 証明書フィンガープリント未設定（§3.4.3：ピン留めを設定すること）")

    crafty: CraftyClient | None = None
    if cfg.crafty_api_token and cfg.crafty_server_id:
        crafty = CraftyClient(cfg)
        if not crafty.verify_pin():
            log.error("Crafty証明書ピン留め確認に失敗したため、Crafty連携を無効化します")
            crafty = None
    else:
        log.warning("Crafty APIトークン／サーバーIDが未設定のため、Crafty連携は無効です")

    log.info("OpsBot CT poller 起動: workers=%s", cfg.workers_base_url)
    interval = cfg.idle_interval_sec

    with httpx.Client(http2=True) as client:
        while _running:
            healthy = True
            try:
                jobs = poll_once(client, cfg)
                if jobs:
                    for job in jobs:
                        status, result, error = dispatch(job, crafty, cfg)
                        report_complete(client, cfg, job["id"], status=status, result=result, error=error)
                    interval = cfg.active_interval_sec
                else:
                    interval = min(interval * 1.5, cfg.idle_interval_sec)
            except Exception as e:  # noqa: BLE001  ループを絶対に止めない
                healthy = False
                log.error("ポーリング失敗: %s", e)
                interval = cfg.idle_interval_sec

            write_heartbeat(cfg.heartbeat_path, healthy=healthy, last_poll_ts=time.time())

            # SIGTERM に素早く反応するため小刻みに sleep
            slept = 0.0
            while _running and slept < interval:
                time.sleep(min(1.0, interval - slept))
                slept += 1.0

    log.info("OpsBot CT poller 停止")


if __name__ == "__main__":
    run()
