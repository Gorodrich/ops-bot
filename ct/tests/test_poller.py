"""poller のハートビート書き込みの単体テスト（Phase 0 範囲）。"""

from __future__ import annotations

import os

import opsbot_ct.poller as poller_module
from opsbot_ct.config import Config
from opsbot_ct.mojang import MojangError, MojangProfile
from opsbot_ct.poller import dispatch, write_heartbeat

_CFG = Config(workers_base_url="https://example.invalid", ct_shared_secret="secret")


def test_write_heartbeat_atomic(tmp_path):
    path = tmp_path / "sub" / "opsbot_ct.prom"
    write_heartbeat(str(path), healthy=True, last_poll_ts=1_700_000_000.0)
    body = path.read_text()
    assert "opsbot_ct_up 1" in body
    assert "opsbot_ct_last_poll_timestamp_seconds 1700000000" in body
    # 一時ファイルが残っていない
    assert [p for p in os.listdir(path.parent) if p.startswith(".opsbot_ct.")] == []


def test_write_heartbeat_unhealthy(tmp_path):
    path = tmp_path / "opsbot_ct.prom"
    write_heartbeat(str(path), healthy=False, last_poll_ts=1.0)
    assert "opsbot_ct_up 0" in path.read_text()


def test_dispatch_mojang_lookup_found(monkeypatch):
    monkeypatch.setattr(
        poller_module,
        "resolve_profile",
        lambda username: MojangProfile(uuid="uuid-1", name=username),
    )
    status, result, error = dispatch({"kind": "mojang_lookup", "payload": {"username": "TestPlayer01"}}, None, _CFG)
    assert status == "done"
    assert result == {"found": True, "uuid": "uuid-1", "name": "TestPlayer01"}
    assert error is None


def test_dispatch_mojang_lookup_not_found(monkeypatch):
    monkeypatch.setattr(poller_module, "resolve_profile", lambda username: None)
    status, result, error = dispatch({"kind": "mojang_lookup", "payload": {"username": "nobody"}}, None, _CFG)
    assert status == "done"
    assert result == {"found": False}
    assert error is None


def test_dispatch_mojang_lookup_api_error(monkeypatch):
    def raise_error(username):
        raise MojangError("Mojang API エラー: status=403")

    monkeypatch.setattr(poller_module, "resolve_profile", raise_error)
    status, result, error = dispatch({"kind": "mojang_lookup", "payload": {"username": "TestPlayer01"}}, None, _CFG)
    assert status == "failed"
    assert result is None
    assert "403" in error


def test_dispatch_mojang_lookup_missing_username():
    status, result, _error = dispatch({"kind": "mojang_lookup", "payload": {}}, None, _CFG)
    assert status == "failed"
    assert result is None


def test_dispatch_claude_code_detect_tasks(monkeypatch):
    monkeypatch.setattr(poller_module, "run_detect_tasks_job", lambda payload, **kw: {"tasks": []})
    status, result, error = dispatch(
        {"kind": "claude_code", "payload": {"subkind": "detect_tasks", "messages": []}}, None, _CFG
    )
    assert status == "done"
    assert result == {"tasks": []}
    assert error is None


def test_dispatch_claude_code_assignment_tiebreak(monkeypatch):
    monkeypatch.setattr(
        poller_module,
        "run_assignment_tiebreak_job",
        lambda payload, **kw: {"selected_staff_id": "111", "positive_note": None},
    )
    status, result, _error = dispatch(
        {"kind": "claude_code", "payload": {"subkind": "assignment_tiebreak", "candidates": [{"staff_id": "111"}]}},
        None,
        _CFG,
    )
    assert status == "done"
    assert result["selected_staff_id"] == "111"


def test_dispatch_claude_code_unknown_subkind():
    status, _result, error = dispatch({"kind": "claude_code", "payload": {"subkind": "bogus"}}, None, _CFG)
    assert status == "failed"
    assert "bogus" in error


def test_dispatch_claude_code_llm_error_is_failed(monkeypatch):
    from opsbot_ct.llm import LlmError

    def raise_error(payload, **kw):
        raise LlmError("Claude Code CLI が見つかりません")

    monkeypatch.setattr(poller_module, "run_detect_tasks_job", raise_error)
    status, result, error = dispatch(
        {"kind": "claude_code", "payload": {"subkind": "detect_tasks", "messages": []}}, None, _CFG
    )
    assert status == "failed"
    assert result is None
    assert "見つかりません" in error


# ── process_jobs：ジョブ単位の例外ガード（監査指摘・2026-10-07） ─────────────


def _record_reports(monkeypatch):
    reports: list[tuple[int, str, str | None]] = []

    def fake_report(_client, _cfg, job_id, *, status, result=None, error=None):
        reports.append((job_id, status, error))

    monkeypatch.setattr(poller_module, "report_complete", fake_report)
    return reports


def test_process_jobs_reports_failed_on_unexpected_error_and_continues(monkeypatch):
    reports = _record_reports(monkeypatch)

    def fake_dispatch(job, _crafty, _cfg):
        if job["id"] == 1:
            raise ConnectionError("[Errno 111] Connection refused")  # httpx の通信エラー相当（型付き例外に包まれない）
        return "done", {"ok": True}, None

    monkeypatch.setattr(poller_module, "dispatch", fake_dispatch)
    jobs = [{"id": 1, "kind": "crafty_op"}, {"id": 2, "kind": "crafty_op"}, {"id": 3, "kind": "mojang_lookup"}]
    poller_module.process_jobs(None, _CFG, None, jobs)

    assert [(r[0], r[1]) for r in reports] == [(1, "failed"), (2, "done"), (3, "done")]
    assert "Connection refused" in (reports[0][2] or "")


def test_process_jobs_stops_starting_new_jobs_after_sigterm(monkeypatch):
    reports = _record_reports(monkeypatch)

    def fake_dispatch(job, _crafty, _cfg):
        poller_module._running = False  # 1件目の処理中に停止要求を受けた想定
        return "done", None, None

    monkeypatch.setattr(poller_module, "dispatch", fake_dispatch)
    monkeypatch.setattr(poller_module, "_running", True)
    poller_module.process_jobs(None, _CFG, None, [{"id": 1}, {"id": 2}])

    assert [r[0] for r in reports] == [1]
