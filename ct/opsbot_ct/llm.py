"""LLM層（§7・Phase 6：シャドーモード）。Claude Code CLIをheadless実行して呼び出す。

重要な制約：
  * Claude Pro利用枠（開発者個人のログインセッション）を使う。API課金は行わない（§7.4）。
    CT102で事前に `claude login` 済みであることが前提（README参照）。
  * headless実行（`claude -p`）とし、対話履歴を持ち越さない。常駐デーモンにしない（§7.5）。
  * ルール全文は投入しない。根拠条文が必要な場合のみ `_rules/` 相当のディレクトリ（config.rules_dir）
    をキーワードでgrepし、該当しそうな行だけを抜粋して添える（§7.3）。ディレクトリが無ければ
    黙って空扱いにする（あると便利な機能。無くても検出自体は動く）。
  * 割当フォールバック時のみ、候補運営者の notes（staff.yaml。開発者の個人的な評価等の機微情報を
    含みうる）をプロンプトに含める。プロセスの引数一覧（`ps` 等）に機微情報が residual に残らない
    よう、プロンプトは標準入力経由でCLIに渡す（引数には渡さない）。
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
from pathlib import Path
from typing import Any

log = logging.getLogger("opsbot_ct.llm")


class LlmError(RuntimeError):
    pass


_SYSTEM_PREAMBLE = (
    "あなたはDiscord運営支援Botの検出補助として動いています。"
    "出力は必ずJSONのみとし、前置き・説明文・Markdown装飾（コードフェンス等）を一切含めないでください。"
    "指示された以外の情報（他ユーザーの機微情報の要約や評価コメント等）を新たに作り出さないでください。"
)


def _invoke_claude_headless(prompt: str, *, cli_path: str, model: str, timeout_sec: int) -> tuple[str, dict[str, Any]]:
    """`claude -p` をheadless実行し、(モデルの最終出力テキスト, 利用状況メタ情報) を返す。

    プロンプトは標準入力で渡す（引数に載せない：notesを扱うジョブでの機微情報の残留防止）。
    `--output-format json` はCLI自体の実行結果エンベロープ（session_id・usage・total_cost_usd等を
    含む）を返す仕様のため、その `result` フィールド（モデルの最終出力文字列）を取り出しつつ、
    `model`・`usage`（input/output tokens等）・`total_cost_usd`（Pro利用枠でも参考値として返る）を
    メタ情報として呼び出し元へ持ち帰る（§7.4：利用枠消費状況の可視化）。エンベロープ形式が想定と
    異なる場合は、標準出力全体をモデル出力とみなすフォールバックを行う（CLIバージョン差異への耐性）。
    """
    cmd = [cli_path, "-p", "--output-format", "json", "--max-turns", "1"]
    if model:
        cmd += ["--model", model]
    try:
        proc = subprocess.run(
            cmd,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
        )
    except FileNotFoundError as e:
        raise LlmError(f"Claude Code CLI が見つかりません（{cli_path}）: {e}") from e
    except subprocess.TimeoutExpired as e:
        raise LlmError(f"Claude Code CLI がタイムアウトしました（{timeout_sec}秒）") from e

    if proc.returncode != 0:
        raise LlmError(f"Claude Code CLI が異常終了しました（code={proc.returncode}）: {proc.stderr[:500]}")

    stdout = proc.stdout.strip()
    try:
        envelope = json.loads(stdout)
        if isinstance(envelope, dict) and "result" in envelope:
            meta = {
                "model": envelope.get("model") or model or None,
                "usage": envelope.get("usage"),
                "total_cost_usd": envelope.get("total_cost_usd"),
                "num_turns": envelope.get("num_turns"),
                "duration_ms": envelope.get("duration_ms"),
            }
            return str(envelope["result"]), meta
    except (json.JSONDecodeError, TypeError):
        pass
    return stdout, {"model": model or None, "usage": None, "total_cost_usd": None}  # フォールバック


def _extract_json_object(text: str) -> dict[str, Any]:
    """モデル出力からJSONオブジェクトを取り出す。前置き文が混入した場合の最終防御。"""
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise LlmError("モデル出力からJSONを抽出できませんでした")
    return json.loads(text[start : end + 1])


_ASCII_WORD_RE = re.compile(r"[A-Za-z0-9_]{2,}")
_CJK_SPAN_RE = re.compile(r"[一-龠ぁ-んァ-ヶー]{2,}")


def _extract_keywords(body: str) -> set[str]:
    """本文からgrep用のキーワード集合を作る。

    日本語は分かち書きされていないため、単純な単語抽出（\\w等）では文全体が1トークンに
    なってしまい実用にならない。CJK連続部分は2文字の重なりありbigramに分解することで、
    形態素解析ライブラリを追加せずに実用的な部分一致検索を行う（ベストエフォート機能）。
    """
    keywords: set[str] = set(_ASCII_WORD_RE.findall(body))
    for span in _CJK_SPAN_RE.findall(body):
        keywords.update(span[i : i + 2] for i in range(len(span) - 1))
    return keywords


def grep_rule_excerpts(body: str, rules_dir: str, *, max_lines: int = 5) -> list[str]:
    """§7.3：根拠条文が必要な場合、rules_dir配下をキーワードでgrepして該当行だけを抜粋する。

    rules_dir が未設定／存在しない場合は空リストを返す（ルール全文の投入は行わないという方針の
    範囲内でのベストエフォート機能。無くても検出自体の動作は妨げない）。
    """
    if not rules_dir:
        return []
    root = Path(rules_dir)
    if not root.is_dir():
        return []

    keywords = _extract_keywords(body)
    if not keywords:
        return []

    excerpts: list[str] = []
    for path in sorted(root.rglob("*.md")):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if any(kw in stripped for kw in keywords):
                excerpts.append(stripped)
                if len(excerpts) >= max_lines:
                    return excerpts
    return excerpts


def run_detect_tasks_job(
    payload: dict[str, Any], *, cli_path: str, model: str, rules_dir: str, timeout_sec: int
) -> dict[str, Any]:
    """§7.3：タスク検出ジョブ。入力はフィルタ通過済みメッセージのみ（発言者ロール相当・チャンネル種別・本文・URL）。"""
    messages = payload.get("messages") or []
    max_tokens = int(payload.get("max_tokens") or 1024)
    if not messages:
        return {"tasks": []}

    enriched = []
    for m in messages:
        body = str(m.get("body") or "")
        enriched.append(
            {
                "source_message_url": m.get("source_message_url"),
                "channel_kind": m.get("channel_kind"),  # ticket=T-B相当 / ops=T-C相当
                "body": body,
                "rule_excerpts": grep_rule_excerpts(body, rules_dir),
            }
        )

    prompt = (
        _SYSTEM_PREAMBLE
        + "\n\n以下のDiscordメッセージ群から、運営タスクとして起票すべきものを検出してください。"
        + "各メッセージは0個または1個のタスクに対応します（同一メッセージから複数タスクを作らない）。"
        + "channel_kind='ticket'はT-B（参加者からの問い合わせ）、channel_kind='ops'はT-C（運営内の作業・宿題）として扱ってください。"
        + "rule_excerptsは参考情報（ルール条文の抜粋の可能性がある行）であり、必ずしも該当条文とは限りません。"
        + f"出力トークン数は{max_tokens}以内に収めてください。"
        + "\n\n出力は次のJSONスキーマのみ："
        + '{"tasks":[{"source_message_url":"...","type":"T-B|T-C","title":"20字以内",'
        + '"summary":"80字以内","required_tags":["..."],"suggested_priority":"高|中|低",'
        + '"suggested_rule":"該当条文 or null","confidence":0.0}]}'
        + "\n\n入力メッセージ：\n"
        + json.dumps(enriched, ensure_ascii=False)
    )

    raw, meta = _invoke_claude_headless(prompt, cli_path=cli_path, model=model, timeout_sec=timeout_sec)
    parsed = _extract_json_object(raw)
    if not isinstance(parsed.get("tasks"), list):
        raise LlmError("出力スキーマが不正です（tasksが配列ではありません）")
    parsed["_llm_meta"] = meta  # §7.4：利用状況（Workers側のllm_usage.detailへ記録される）
    return parsed


def run_assignment_tiebreak_job(payload: dict[str, Any], *, cli_path: str, model: str, timeout_sec: int) -> dict[str, Any]:
    """§4.5・§7.3：割当スコアが同点／閾値未満の場合のみ、候補のnotesを渡して適任者を選ばせる。

    notesの内容そのものや評価の出所は、モデルの出力（positive_note）に一切反映させないよう
    プロンプトで強く指示するが、最終的な安全性はWorkers側（llm/safety.ts）の機械的フィルタで担保する
    （このCT側の指示だけを信用しない多層防御。§4.4の追加指示）。
    """
    candidates = payload.get("candidates") or []
    max_tokens = int(payload.get("max_tokens") or 512)
    required_tags = payload.get("required_tags") or []
    if not candidates:
        raise LlmError("候補が0件です")

    prompt = (
        _SYSTEM_PREAMBLE
        + "\n\n複数の運営者候補が割当スコアで同点、または全員のタグ一致度が閾値未満のため、"
        + "以下の候補のnotes（自由記述）を参考に、このタスクに最も適した1名を選んでください。"
        + f"必要タグ：{json.dumps(required_tags, ensure_ascii=False)}"
        + f"出力トークン数は{max_tokens}以内に収めてください。"
        + "\n\npositive_noteは、選んだ理由を前向きな一般論（例：『この種の業務に慣れています』）として"
        + "20〜30文字程度で書いてください。ただし次を厳守してください："
        + "(1) notesの原文・評価の出所（『notesに書かれている』『staff.yamlの評価』等）に一切言及しない、"
        + "(2) マイナス面・懸念・不安・苦手といった否定的表現を一切含めない、"
        + "(3) 前向きに言えることが無ければ null にする。"
        + "\n\n出力は次のJSONスキーマのみ："
        + '{"selected_staff_id":"...","positive_note":"string or null"}'
        + "\n\n候補：\n"
        + json.dumps(candidates, ensure_ascii=False)
    )

    raw, meta = _invoke_claude_headless(prompt, cli_path=cli_path, model=model, timeout_sec=timeout_sec)
    parsed = _extract_json_object(raw)
    if "selected_staff_id" not in parsed:
        raise LlmError("出力スキーマが不正です（selected_staff_idがありません）")
    parsed["_llm_meta"] = meta  # §7.4：利用状況（Workers側のllm_usage.detailへ記録される）
    return parsed
