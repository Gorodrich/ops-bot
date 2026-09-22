"""マスク画像のタイル分割・プレビュー生成の単体テスト（decisions.md #63）。"""

from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from opsbot_ct.dynmap_tiles import build_preview_image, split_into_tiles, tile_filename


def _make_mask_png(w: int, h: int, opaque_boxes: list[tuple[int, int, int, int]]) -> bytes:
    """opaque_boxes: [(x0, y0, x1, y1), ...]（exclusive）の範囲だけ不透明にしたRGBA PNGを作る。"""
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    for x0, y0, x1, y1 in opaque_boxes:
        arr[y0:y1, x0:x1, 0] = 255  # 赤
        arr[y0:y1, x0:x1, 3] = 255  # 不透明
    buf = io.BytesIO()
    Image.fromarray(arr, "RGBA").save(buf, format="PNG")
    return buf.getvalue()


def test_split_into_tiles_skips_fully_transparent_tiles():
    # 1024x1024を512グリッドで割ると4タイル。右下(col=1,row=1)だけ不透明にする。
    png = _make_mask_png(1024, 1024, [(600, 600, 700, 700)])
    loc1 = {"x": 0, "y": 64, "z": 0}
    loc2 = {"x": 1024, "y": 64, "z": 1024}

    tiles = split_into_tiles(png, loc1=loc1, loc2=loc2, tile_size=512)

    assert len(tiles) == 1
    assert (tiles[0].row, tiles[0].col) == (1, 1)


def test_split_into_tiles_computes_world_coords_from_pixel_offset():
    png = _make_mask_png(1024, 512, [(0, 0, 10, 10), (600, 0, 610, 10)])
    loc1 = {"x": -100, "y": 64, "z": 200}
    loc2 = {"x": 924, "y": 64, "z": 712}

    tiles = split_into_tiles(png, loc1=loc1, loc2=loc2, tile_size=512)

    by_col = {t.col: t for t in tiles}
    assert by_col[0].loc1 == {"x": -100, "y": 64, "z": 200}
    assert by_col[0].loc2 == {"x": 412, "y": 64, "z": 712}
    assert by_col[1].loc1 == {"x": 412, "y": 64, "z": 200}
    assert by_col[1].loc2 == {"x": 924, "y": 64, "z": 712}


def test_split_into_tiles_returns_empty_list_when_fully_transparent():
    png = _make_mask_png(512, 512, [])
    loc1 = {"x": 0, "y": 64, "z": 0}
    loc2 = {"x": 512, "y": 64, "z": 512}

    assert split_into_tiles(png, loc1=loc1, loc2=loc2, tile_size=512) == []


def test_split_into_tiles_rejects_size_mismatch_with_loc1_loc2():
    png = _make_mask_png(100, 100, [(0, 0, 10, 10)])
    with pytest.raises(ValueError):
        split_into_tiles(png, loc1={"x": 0, "y": 64, "z": 0}, loc2={"x": 999, "y": 64, "z": 999})


def test_split_into_tiles_rejects_non_positive_tile_size():
    png = _make_mask_png(10, 10, [(0, 0, 1, 1)])
    with pytest.raises(ValueError):
        split_into_tiles(png, loc1={"x": 0, "y": 64, "z": 0}, loc2={"x": 10, "y": 64, "z": 10}, tile_size=0)


def test_tile_filename_format():
    assert tile_filename(0, 0) == "tile_0_0.png"
    assert tile_filename(3, 12) == "tile_3_12.png"


def test_build_preview_image_downscales_and_preserves_png():
    png = _make_mask_png(4000, 2000, [(0, 0, 4000, 2000)])
    preview_bytes = build_preview_image(png, max_size=180)

    with Image.open(io.BytesIO(preview_bytes)) as preview:
        assert preview.format == "PNG"
        assert max(preview.size) <= 180
        assert preview.size[0] / preview.size[1] == pytest.approx(4000 / 2000, rel=0.05)


def test_build_preview_image_does_not_upscale_small_images():
    png = _make_mask_png(50, 40, [(0, 0, 50, 40)])
    preview_bytes = build_preview_image(png, max_size=180)

    with Image.open(io.BytesIO(preview_bytes)) as preview:
        assert preview.size == (50, 40)
