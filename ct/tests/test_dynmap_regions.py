"""regions配列テキスト更新の単体テスト（§6.3.4・decisions.md #31）。"""

from __future__ import annotations

import pytest

from opsbot_ct.dynmap_regions import remove_region_from_js, upsert_region_in_js

SAMPLE = """(function() {
    var territories = [
        { name: "someNation", loc1: { x: 0, y: 64, z: 0 }, loc2: { x: 1, y: 64, z: 1 } }
    ];

    var regions = [
        {
            name: "alice",
            imageUrl: 'images/indiv/alice.png',
            loc1: { x: 0, y: 64, z: 0 },
            loc2: { x: 100, y: 64, z: 100 }
        },
        {
            name: "bob",
            imageUrl: 'images/indiv/bob.png',
            loc1: { x: 200, y: 64, z: 200 },
            loc2: { x: 300, y: 64, z: 300 }
        }
    ];
})();
"""


def test_upsert_updates_existing_entry_by_name():
    out = upsert_region_in_js(
        SAMPLE,
        name="alice",
        image_rel_path="images/indiv/alice.png",
        loc1={"x": 1, "y": 64, "z": 2},
        loc2={"x": 3, "y": 64, "z": 4},
    )
    assert 'name: "alice"' in out
    assert "x: 1, y: 64, z: 2" in out
    assert 'name: "bob"' in out  # 他のエントリは無傷
    assert out.count('name: "alice"') == 1  # 重複追加されていない


def test_upsert_appends_new_entry_when_name_not_found():
    out = upsert_region_in_js(
        SAMPLE,
        name="carol",
        image_rel_path="images/indiv/carol.png",
        loc1={"x": 9, "y": 64, "z": 9},
        loc2={"x": 19, "y": 64, "z": 19},
    )
    assert out.count('name: "carol"') == 1
    assert 'name: "alice"' in out and 'name: "bob"' in out


def test_remove_deletes_matching_entry_only():
    out = remove_region_from_js(SAMPLE, name="alice")
    assert 'name: "alice"' not in out
    assert 'name: "bob"' in out


def test_territories_array_untouched_by_regions_edit():
    out = upsert_region_in_js(
        SAMPLE, name="alice", image_rel_path="images/indiv/alice.png",
        loc1={"x": 1, "y": 64, "z": 2}, loc2={"x": 3, "y": 64, "z": 4},
    )
    assert 'name: "someNation"' in out


def test_roundtrip_on_real_custom_overlay_js():
    import pathlib
    import re

    path = pathlib.Path(__file__).resolve().parents[2] / "dynmap" / "web" / "js" / "custom_overlay.js"
    if not path.exists():
        # 実運用中のカスタムオーバーレイJSは参加者名・座標を含む運用データのため
        # リポジトリには含めていない（.gitignore の dynmap/）。手元に配置されている
        # 環境でのみ実データに対する回帰確認を行う。
        pytest.skip("dynmap/web/js/custom_overlay.js が無い環境ではスキップする")
    original = path.read_text(encoding="utf-8")

    # 対象名は実ファイルの既存エントリから取る（テスト側に実在の参加者名を書かない）。
    regions_section = original.split("var regions = [", 1)
    assert len(regions_section) == 2, "regions配列が実ファイルに見つからなかった"
    match = re.search(r'name:\s*"([^"]+)",\s*\n\s*imageUrl:', regions_section[1])
    assert match is not None, "regions配列のエントリを実ファイルから特定できなかった"
    existing = match.group(1)

    updated = upsert_region_in_js(
        original, name=existing, image_rel_path=f"images/indiv/{existing}.png",
        loc1={"x": 1, "y": 64, "z": 2}, loc2={"x": 3, "y": 64, "z": 4},
    )
    assert "x: 1, y: 64, z: 2" in updated
    assert updated.count(f'name: "{existing}"') == 1
    # 他の既存エントリ数は変わらない
    assert updated.count("imageUrl:") == original.count("imageUrl:")

    removed = remove_region_from_js(original, name=existing)
    assert f'name: "{existing}"' not in removed
    assert removed.count("imageUrl:") == original.count("imageUrl:") - 1
