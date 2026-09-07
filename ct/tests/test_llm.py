"""llm.py の単体テスト（Claude Code CLI呼び出し自体はサブプロセスのためモックする）。"""

from __future__ import annotations

import pytest

import opsbot_ct.llm as llm_module
from opsbot_ct.llm import (
    LlmError,
    _extract_json_object,
    grep_rule_excerpts,
    run_assignment_tiebreak_job,
    run_detect_tasks_job,
)


def test_extract_json_object_plain():
    assert _extract_json_object('{"a": 1}') == {"a": 1}


def test_extract_json_object_with_preamble():
    # モデルが前置きを付けてしまった場合でも、最終防御として抽出できる（§7.3）
    text = "以下がJSONです:\n{\"a\": 1}\nよろしくお願いします"
    assert _extract_json_object(text) == {"a": 1}


def test_extract_json_object_invalid_raises():
    with pytest.raises(LlmError):
        _extract_json_object("これはJSONではありません")


def test_grep_rule_excerpts_no_dir_returns_empty():
    assert grep_rule_excerpts("何か条文について", "") == []
    assert grep_rule_excerpts("何か条文について", "/no/such/dir") == []


def test_grep_rule_excerpts_matches_keyword(tmp_path):
    rules_dir = tmp_path / "rules"
    rules_dir.mkdir()
    (rules_dir / "basic.md").write_text("第1条 参加者は届け出なければなりません\n第2条 無関係の条文\n", encoding="utf-8")
    excerpts = grep_rule_excerpts("参加者からの届け出について", str(rules_dir))
    assert any("届け出" in e for e in excerpts)


def test_run_detect_tasks_job_empty_messages_short_circuits():
    result = run_detect_tasks_job({"messages": []}, cli_path="claude", model="sonnet", rules_dir="", timeout_sec=30)
    assert result == {"tasks": []}


def test_run_detect_tasks_job_uses_invoke_and_parses(monkeypatch):
    captured = {}

    def fake_invoke(prompt, *, cli_path, model, timeout_sec):
        captured["prompt"] = prompt
        captured["model"] = model
        return (
            '{"tasks": [{"source_message_url": "https://example.invalid/1", "type": "T-B", "title": "t", "summary": "s", "confidence": 0.9}]}',
            {"model": model, "usage": {"input_tokens": 10, "output_tokens": 5}, "total_cost_usd": 0.01},
        )

    monkeypatch.setattr(llm_module, "_invoke_claude_headless", fake_invoke)
    payload = {"messages": [{"source_message_url": "https://example.invalid/1", "channel_kind": "ticket", "body": "困っています"}]}
    result = run_detect_tasks_job(payload, cli_path="claude", model="sonnet", rules_dir="", timeout_sec=30)
    assert result["tasks"][0]["type"] == "T-B"
    assert "困っています" in captured["prompt"]
    assert captured["model"] == "sonnet"
    assert result["_llm_meta"]["usage"]["input_tokens"] == 10


def test_run_detect_tasks_job_bad_schema_raises(monkeypatch):
    monkeypatch.setattr(llm_module, "_invoke_claude_headless", lambda *a, **kw: ('{"not_tasks": []}', {}))
    with pytest.raises(LlmError):
        run_detect_tasks_job({"messages": [{"body": "x"}]}, cli_path="claude", model="sonnet", rules_dir="", timeout_sec=30)


def test_run_assignment_tiebreak_job_no_candidates_raises():
    with pytest.raises(LlmError):
        run_assignment_tiebreak_job({"candidates": []}, cli_path="claude", model="sonnet", timeout_sec=30)


def test_run_assignment_tiebreak_job_parses_result(monkeypatch):
    monkeypatch.setattr(
        llm_module,
        "_invoke_claude_headless",
        lambda *a, **kw: ('{"selected_staff_id": "111", "positive_note": "この種の業務に慣れています"}', {"model": "sonnet"}),
    )
    result = run_assignment_tiebreak_job(
        {"candidates": [{"staff_id": "111", "tags": [], "notes": "some private notes"}]},
        cli_path="claude",
        model="sonnet",
        timeout_sec=30,
    )
    assert result["selected_staff_id"] == "111"


def test_run_assignment_tiebreak_job_missing_field_raises(monkeypatch):
    monkeypatch.setattr(llm_module, "_invoke_claude_headless", lambda *a, **kw: ("{}", {}))
    with pytest.raises(LlmError):
        run_assignment_tiebreak_job({"candidates": [{"staff_id": "111"}]}, cli_path="claude", model="sonnet", timeout_sec=30)
