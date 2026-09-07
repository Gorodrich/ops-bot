"""個人開発領マップ処理ライブラリの単体テスト（Phase 2・§6.3／07-nonfunctional.md §11-5）。

面積計算・+1補正・重複判定は機械判定の中核であり、必ずユニットテストを書く（§11-5）。
"""

from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from opsbot_ct.image import (
    ExistingClaim,
    ProtectedArea,
    WorldBBox,
    ZONES,
    ZONE_SIZE,
    build_composite_alpha,
    check_file,
    crop_and_measure,
    evaluate_kaihatsu_set,
    evaluate_kaihatsu_set_batch,
    parse_filename,
    pixel_overlap_count,
)


def _zone_png(opaque_box: tuple[int, int, int, int] | None, size: int = ZONE_SIZE) -> bytes:
    """size x size のRGBA PNGバイト列。opaque_boxは (left, upper, right, lower)、両端含む。"""
    arr = np.zeros((size, size, 4), dtype=np.uint8)
    if opaque_box is not None:
        left, upper, right, lower = opaque_box
        arr[upper : lower + 1, left : right + 1] = (255, 255, 255, 255)
    buf = io.BytesIO()
    Image.fromarray(arr, "RGBA").save(buf, format="PNG")
    return buf.getvalue()


# ── ファイル名解析（別紙7章） ────────────────────────────────────────────


@pytest.mark.parametrize(
    "filename,expected_zone,expected_player",
    [
        ("06_Test_Player1.png", "06", "Test_Player1"),
        ("01_alice.png", "01", "alice"),
        ("16_bob.PNG", "16", "bob"),
    ],
)
def test_parse_filename_valid(filename, expected_zone, expected_player):
    reason, parsed = parse_filename(filename)
    assert reason is None
    assert parsed.zone == expected_zone
    assert parsed.player == expected_player


@pytest.mark.parametrize(
    "filename",
    ["alice.png", "17_alice.png", "ab_alice.png", "06_.png", "06_alice.jpg"],
)
def test_parse_filename_invalid(filename):
    reason, parsed = parse_filename(filename)
    assert reason is not None
    assert parsed is None


# ── ファイル単位バリデーション（条件①②③） ────────────────────────────


def test_check_file_valid():
    result = check_file("01_alice.png", _zone_png((100, 100, 199, 199)))
    assert result.ok
    assert result.alpha is not None
    assert int(np.count_nonzero(result.alpha)) == 100 * 100


def test_check_file_wrong_size():
    result = check_file("01_alice.png", _zone_png((0, 0, 9, 9), size=4000))
    assert not result.ok
    assert any("条件②" in e for e in result.errors)


def test_check_file_mid_alpha_value():
    arr = np.zeros((ZONE_SIZE, ZONE_SIZE, 4), dtype=np.uint8)
    arr[0:10, 0:10] = (255, 255, 255, 128)  # 中間値
    buf = io.BytesIO()
    Image.fromarray(arr, "RGBA").save(buf, format="PNG")
    result = check_file("01_alice.png", buf.getvalue())
    assert not result.ok
    assert any("条件③" in e and "100ピクセル" in e for e in result.errors)


def test_check_file_not_png():
    result = check_file("01_alice.png", b"not a png file")
    assert not result.ok
    assert any("条件①" in e for e in result.errors)
    assert any("条件②" in e and "判定不可" in e for e in result.errors)


# ── 合成キャンバス・クロップ・+1補正（別紙4.2章・5.2章） ────────────────


def test_build_composite_alpha_single_zone():
    alpha = np.zeros((ZONE_SIZE, ZONE_SIZE), dtype=np.uint8)
    alpha[0:10, 0:10] = 255
    canvas, cx_min, cz_min = build_composite_alpha([("01", alpha)])
    assert (cx_min, cz_min) == ZONES["01"]
    assert canvas is alpha


def test_build_composite_alpha_multi_zone_adjacent():
    # ゾーン01(x:-10000,z:-10000) とゾーン02(x:-5000,z:-10000) は隣接。
    a1 = np.zeros((ZONE_SIZE, ZONE_SIZE), dtype=np.uint8)
    a1[:, ZONE_SIZE - 1] = 255  # ゾーン01の右端列
    a2 = np.zeros((ZONE_SIZE, ZONE_SIZE), dtype=np.uint8)
    a2[:, 0] = 255  # ゾーン02の左端列（ゾーン01の右端と隣接）
    canvas, cx_min, cz_min = build_composite_alpha([("01", a1), ("02", a2)])
    assert cx_min == -10000
    assert cz_min == -10000
    assert canvas.shape == (ZONE_SIZE, ZONE_SIZE * 2)
    # 2本の隣接した列が合成キャンバス上でも隣接していること
    assert np.count_nonzero(canvas[:, ZONE_SIZE - 1]) == ZONE_SIZE
    assert np.count_nonzero(canvas[:, ZONE_SIZE]) == ZONE_SIZE


def test_crop_and_measure_plus_one_correction():
    canvas = np.zeros((100, 100), dtype=np.uint8)
    canvas[10:20, 30:50] = 255  # 行10-19・列30-49 が不透明（両端含む）
    cropped, bbox, area = crop_and_measure(canvas, canvas_x_min=0, canvas_z_min=0)
    assert area == 10 * 20
    # loc1（最小側）は無補正、loc2（最大側）は+1
    assert bbox == WorldBBox(x1=30, z1=10, x2=50, z2=20)
    assert cropped.shape == (10, 20)


def test_crop_and_measure_no_opaque_pixels():
    canvas = np.zeros((10, 10), dtype=np.uint8)
    cropped, bbox, area = crop_and_measure(canvas, 0, 0)
    assert cropped is None
    assert bbox is None
    assert area == 0


# ── ピクセル単位の重複判定（決定#5：bbox交差では判定しない） ──────────────


def test_pixel_overlap_count_no_bbox_intersection():
    mask = np.full((10, 10), 255, dtype=np.uint8)
    a_bbox = WorldBBox(0, 0, 10, 10)
    b_bbox = WorldBBox(100, 100, 110, 110)
    assert pixel_overlap_count(mask, a_bbox, mask, b_bbox) == 0


def test_pixel_overlap_count_bbox_overlaps_but_pixels_dont():
    # bboxは重なるが、不透明ピクセル自体は互いに素（bbox交差だけを重複と誤判定しないことの確認）。
    a = np.zeros((10, 10), dtype=np.uint8)
    a[0:5, 0:5] = 255
    b = np.zeros((10, 10), dtype=np.uint8)
    b[5:10, 5:10] = 255
    bbox = WorldBBox(0, 0, 10, 10)
    assert pixel_overlap_count(a, bbox, b, bbox) == 0


def test_pixel_overlap_count_actual_overlap():
    a = np.zeros((10, 10), dtype=np.uint8)
    a[0:6, 0:6] = 255
    b = np.zeros((10, 10), dtype=np.uint8)
    b[4:10, 4:10] = 255
    bbox = WorldBBox(0, 0, 10, 10)
    assert pixel_overlap_count(a, bbox, b, bbox) == 4  # [4:6, 4:6]


# ── evaluate_kaihatsu_set：申請評価の全体フロー（§5.7.2） ─────────────────


def test_evaluate_approves_single_zone_submission():
    png = _zone_png((0, 0, 99, 99))  # 100x100 = 10,000ブロック
    result = evaluate_kaihatsu_set(
        requester_mc_name="alice",
        attachments=[("01_alice.png", png)],
        existing_claims=[],
        protected_areas=[],
        previous_own_claim=None,
    )
    assert result["outcome"] == "approved"
    assert result["area_blocks"] == 100 * 100
    assert result["added_pixels"] == 100 * 100
    assert result["removed_pixels"] == 0
    assert result["had_previous_claim"] is False
    assert "confirmation_image_base64" in result
    assert "output_image_bytes" in result


def test_evaluate_rejects_area_over_limit():
    png = _zone_png((0, 0, 600, 600))  # 601x601 = 361,201 > 250,000
    result = evaluate_kaihatsu_set(
        requester_mc_name="alice",
        attachments=[("01_alice.png", png)],
        existing_claims=[],
        protected_areas=[],
        previous_own_claim=None,
    )
    assert result["outcome"] == "rejected"
    assert any("条件④" in r for r in result["reasons"])


def test_evaluate_rejects_other_player_filename_phase2():
    png = _zone_png((0, 0, 9, 9))
    result = evaluate_kaihatsu_set(
        requester_mc_name="alice",
        attachments=[("01_bob.png", png)],
        existing_claims=[],
        protected_areas=[],
        previous_own_claim=None,
    )
    assert result["outcome"] == "rejected"
    assert any("ご自身" in r for r in result["reasons"])


def test_evaluate_rejects_overlap_with_existing_claim(tmp_path):
    # 既存claim（bobの領域）を tmp_path 上のマスクファイルとして用意する。
    existing_mask = np.zeros((100, 100), dtype=np.uint8)
    existing_mask[:, :] = 255
    mask_path = tmp_path / "bob.png"
    Image.fromarray(
        np.dstack([np.full((100, 100), 255, dtype=np.uint8)] * 3 + [existing_mask]), "RGBA"
    ).save(mask_path)

    zx, zz = ZONES["01"]
    existing = ExistingClaim(
        claim_id=1,
        owner_uuid="uuid-bob",
        owner_name="bob",
        mask_ref=str(mask_path),
        bbox=WorldBBox(zx, zz, zx + 100, zz + 100),
    )

    png = _zone_png((0, 0, 49, 49))  # aliceの申請（bobの領域と重複する）
    result = evaluate_kaihatsu_set(
        requester_mc_name="alice",
        attachments=[("01_alice.png", png)],
        existing_claims=[existing],
        protected_areas=[],
        previous_own_claim=None,
    )
    assert result["outcome"] == "rejected"
    assert any("条件⑥" in r and "bob" in r for r in result["reasons"])
    assert result["overlap_with"] == [{"owner_name": "bob", "pixels": 50 * 50}]


def test_evaluate_rejects_protected_area_overlap(tmp_path):
    protected_mask = np.full((100, 100), 255, dtype=np.uint8)
    mask_path = tmp_path / "protected.png"
    Image.fromarray(
        np.dstack([np.full((100, 100), 0, dtype=np.uint8)] * 3 + [protected_mask]), "RGBA"
    ).save(mask_path)

    zx, zz = ZONES["01"]
    area = ProtectedArea(area_id=1, name="聖域", mask_ref=str(mask_path), bbox=WorldBBox(zx, zz, zx + 100, zz + 100))

    png = _zone_png((0, 0, 49, 49))
    result = evaluate_kaihatsu_set(
        requester_mc_name="alice",
        attachments=[("01_alice.png", png)],
        existing_claims=[],
        protected_areas=[area],
        previous_own_claim=None,
    )
    assert result["outcome"] == "rejected"
    assert any("条件⑤" in r and "聖域" in r for r in result["reasons"])


def test_evaluate_computes_removed_and_added_pixels_against_previous(tmp_path):
    zx, zz = ZONES["01"]
    prev_mask = np.zeros((100, 100), dtype=np.uint8)
    prev_mask[0:100, 0:100] = 255  # 従前：(zx, zz)-(zx+100, zz+100) の全域
    mask_path = tmp_path / "alice_prev.png"
    Image.fromarray(
        np.dstack([np.full((100, 100), 255, dtype=np.uint8)] * 3 + [prev_mask]), "RGBA"
    ).save(mask_path)
    previous = ExistingClaim(
        claim_id=1, owner_uuid="uuid-alice", owner_name="alice",
        mask_ref=str(mask_path), bbox=WorldBBox(zx, zz, zx + 100, zz + 100),
    )

    # 新規申請：半分だけ（左半分50x100）を再宣言 → 右半分は削除扱い、新規追加分はなし
    png = _zone_png((0, 0, 49, 99))
    result = evaluate_kaihatsu_set(
        requester_mc_name="alice",
        attachments=[("01_alice.png", png)],
        existing_claims=[],
        protected_areas=[],
        previous_own_claim=previous,
    )
    assert result["outcome"] == "approved"
    assert result["removed_pixels"] == 50 * 100
    assert result["added_pixels"] == 0
    assert result["had_previous_claim"] is True


# ── §5.7.5：confirmed以外（provisional/reserved）との重複は却下ではなく保留 ──


def test_evaluate_holds_instead_of_rejects_on_provisional_overlap(tmp_path):
    existing_mask = np.full((100, 100), 255, dtype=np.uint8)
    mask_path = tmp_path / "carol_provisional.png"
    Image.fromarray(
        np.dstack([np.full((100, 100), 255, dtype=np.uint8)] * 3 + [existing_mask]), "RGBA"
    ).save(mask_path)

    zx, zz = ZONES["01"]
    provisional = ExistingClaim(
        claim_id=2,
        owner_uuid="uuid-carol",
        owner_name="carol",
        mask_ref=str(mask_path),
        bbox=WorldBBox(zx, zz, zx + 100, zz + 100),
        kind="provisional",
        ref_type="application",
        ref_id=42,
    )

    png = _zone_png((0, 0, 49, 49))
    result = evaluate_kaihatsu_set(
        requester_mc_name="alice",
        attachments=[("01_alice.png", png)],
        existing_claims=[provisional],
        protected_areas=[],
        previous_own_claim=None,
    )
    assert result["outcome"] == "held"
    assert result["held_blocking_ref_type"] == "application"
    assert result["held_blocking_ref_id"] == 42


def test_evaluate_rejects_when_confirmed_overlap_present_even_if_provisional_also_overlaps(tmp_path):
    # confirmedとの重複がある場合は、provisionalとの重複が同時にあっても却下を優先する。
    confirmed_mask = np.full((100, 100), 255, dtype=np.uint8)
    confirmed_path = tmp_path / "bob_confirmed.png"
    Image.fromarray(
        np.dstack([np.full((100, 100), 255, dtype=np.uint8)] * 3 + [confirmed_mask]), "RGBA"
    ).save(confirmed_path)
    provisional_mask = np.full((100, 100), 255, dtype=np.uint8)
    provisional_path = tmp_path / "carol_provisional.png"
    Image.fromarray(
        np.dstack([np.full((100, 100), 255, dtype=np.uint8)] * 3 + [provisional_mask]), "RGBA"
    ).save(provisional_path)

    zx, zz = ZONES["01"]
    confirmed = ExistingClaim(
        claim_id=1, owner_uuid="uuid-bob", owner_name="bob",
        mask_ref=str(confirmed_path), bbox=WorldBBox(zx, zz, zx + 100, zz + 100),
    )
    provisional = ExistingClaim(
        claim_id=2, owner_uuid="uuid-carol", owner_name="carol",
        mask_ref=str(provisional_path), bbox=WorldBBox(zx, zz, zx + 100, zz + 100),
        kind="provisional", ref_type="application", ref_id=42,
    )

    png = _zone_png((0, 0, 49, 49))
    result = evaluate_kaihatsu_set(
        requester_mc_name="alice",
        attachments=[("01_alice.png", png)],
        existing_claims=[confirmed, provisional],
        protected_areas=[],
        previous_own_claim=None,
    )
    assert result["outcome"] == "rejected"
    assert any("条件⑥" in r and "bob" in r for r in result["reasons"])


# ── evaluate_kaihatsu_set_batch：代表者による一括申請（§5.7.3・§5.7.1後段） ──


def test_batch_evaluates_multiple_players_independently():
    alice_png = _zone_png((0, 0, 49, 49))
    bob_png = _zone_png((100, 100, 149, 149))  # aliceと重ならない範囲
    result = evaluate_kaihatsu_set_batch(
        attachments=[("01_alice.png", alice_png), ("01_bob.png", bob_png)],
        resolved_owners={"alice": None, "bob": None},
        existing_claims=[],
        protected_areas=[],
    )
    assert result["players"]["alice"]["outcome"] == "approved"
    assert result["players"]["bob"]["outcome"] == "approved"
    assert result["unresolved_players"] == []


def test_batch_rejects_unresolved_player_without_processing():
    png = _zone_png((0, 0, 9, 9))
    result = evaluate_kaihatsu_set_batch(
        attachments=[("01_dave.png", png)],
        resolved_owners={},  # daveはaccount_links未紐づけ（条件⑦）
        existing_claims=[],
        protected_areas=[],
    )
    assert result["players"] == {}
    assert result["unresolved_players"] == ["dave"]


def test_batch_treats_earlier_approved_participant_as_existing_for_later_one():
    # §5.7.1後段：同一バッチ内で先に評価され承認された申請は、後続の評価では
    # 「既存の個人開発領」として扱う（自己重複除外の対象にはならない）。
    same_area = (0, 0, 49, 49)
    alice_png = _zone_png(same_area)
    bob_png = _zone_png(same_area)  # aliceと全く同じ範囲を後から申請
    result = evaluate_kaihatsu_set_batch(
        attachments=[("01_alice.png", alice_png), ("01_bob.png", bob_png)],
        resolved_owners={"alice": None, "bob": None},
        existing_claims=[],
        protected_areas=[],
    )
    assert result["players"]["alice"]["outcome"] == "approved"
    assert result["players"]["bob"]["outcome"] == "rejected"
    assert any("条件⑥" in r and "alice" in r for r in result["players"]["bob"]["reasons"])
