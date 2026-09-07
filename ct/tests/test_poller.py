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
