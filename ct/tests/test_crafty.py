"""crafty.py のログパース単体テスト（Phase 1 範囲。ネットワークI/Oは含まない）。"""

from __future__ import annotations

from opsbot_ct.crafty import parse_whitelist_list


def test_parse_whitelist_list_with_players():
    logs = "\n".join(
        [
            "[12:00:00] [Server thread/INFO]: something else",
            "[12:00:01] [Server thread/INFO]: There are 2 whitelisted players: Steve, Alex",
        ]
    )
    assert parse_whitelist_list(logs) == ["Steve", "Alex"]


def test_parse_whitelist_list_with_player_s_notation():
    # 実機（Paper系）は "players" ではなく "player(s)" と表記する（Phase 1 E-6テストで判明）。
    logs = "[17:56:32 INFO]: There are 2 whitelisted player(s): Steve, Alex"
    assert parse_whitelist_list(logs) == ["Steve", "Alex"]


def test_parse_whitelist_list_empty():
    logs = "[12:00:01] [Server thread/INFO]: There are 0 whitelisted players:"
    assert parse_whitelist_list(logs) == []


def test_parse_whitelist_list_uses_most_recent_match():
    logs = "\n".join(
        [
            "[11:00:00] [Server thread/INFO]: There are 1 whitelisted players: Old",
            "[12:00:00] [Server thread/INFO]: unrelated line",
            "[12:00:01] [Server thread/INFO]: There are 1 whitelisted players: New",
        ]
    )
    assert parse_whitelist_list(logs) == ["New"]


def test_parse_whitelist_list_no_match_returns_none():
    logs = "[12:00:00] [Server thread/INFO]: unrelated line"
    assert parse_whitelist_list(logs) is None
