"""解凍爆弾（巨大な寸法を宣言した小さなPNG）の回帰テスト（監査指摘・2026-10-07）。

/kaihatsu set の添付画像は外部入力のため、寸法検査の前に全画素を展開してはならない。
また、CT自身のマスク用に上限を引き上げる処理が、プロセス全体の上限を無効化してはならない。
"""

from __future__ import annotations

import io
import struct
import zlib

import pytest
from PIL import Image, ImageFile

import opsbot_ct.dynmap_sync  # noqa: F401  poller と同じ import 連鎖（dynmap_tiles を含む）を再現する
import opsbot_ct.poller  # noqa: F401
from opsbot_ct.image import ZONE_SIZE, check_file, trusted_mask_pixel_limit


def _bomb_png(width: int, height: int) -> bytes:
    """全画素0の1bitグレースケールPNGを手組みする（20000x20000でも数十KB）。"""

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 1, 0, 0, 0, 0)
    row = b"\x00" + b"\x00" * ((width + 7) // 8)
    comp = zlib.compressobj(9)
    idat = b"".join(comp.compress(row) for _ in range(height)) + comp.flush()
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def test_process_wide_pixel_limit_is_not_disabled():
    assert Image.MAX_IMAGE_PIXELS is not None
    assert Image.MAX_IMAGE_PIXELS <= ZONE_SIZE * ZONE_SIZE


def test_check_file_rejects_oversized_png_without_decoding(monkeypatch):
    raw = _bomb_png(20000, 20000)
    assert len(raw) < 100_000

    def fail_load(self):  # noqa: ANN001
        raise AssertionError("寸法超過の画像のピクセルを展開してはならない")

    monkeypatch.setattr(ImageFile.ImageFile, "load", fail_load)
    result = check_file("01_Alice.png", raw)

    assert result.ok is False
    assert result.alpha is None
    assert any("条件②不合格" in e and "20000x20000" in e for e in result.errors)
    assert any("条件③不合格（判定不可" in e for e in result.errors)
    assert not any(e.startswith("条件①不合格") for e in result.errors)


def test_check_file_still_decodes_small_wrong_size_png():
    """1ゾーン以下の画素数なら従来どおり展開して条件③まで判定する。"""
    img = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    result = check_file("01_Alice.png", buf.getvalue())
    assert result.ok is False
    assert any("条件②不合格" in e for e in result.errors)
    assert not any("条件③" in e for e in result.errors)


def test_trusted_mask_limit_is_scoped():
    raw = _bomb_png(8000, 8000)  # 既定上限（5000x5000）の2倍超：既定では開けない
    with pytest.raises(Image.DecompressionBombError):
        Image.open(io.BytesIO(raw))
    with trusted_mask_pixel_limit():
        with Image.open(io.BytesIO(raw)) as img:
            assert img.size == (8000, 8000)
    assert Image.MAX_IMAGE_PIXELS == ZONE_SIZE * ZONE_SIZE
