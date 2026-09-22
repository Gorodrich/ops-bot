"""Dynmap配信用マスク画像のタイル分割（decisions.md #63・Dynmapオーバーレイ軽量化）。

個人開発領のマスクPNGは、離れたゾーンをまたぐ申請ではクロップ後も数千〜1万px四方に
達しうる（image.py参照）。1枚の巨大画像をそのまま`L.imageOverlay`として配信すると、
ブラウザは表示に使う解像度に関わらず元画像を全ピクセルデコードするため、フロント側の
`custom_overlay.js`だけでは解決できない重さの原因になっていた。

本モジュールはクロップ済みマスク（image.pyの`crop_and_measure`が返す座標変換・+1補正済みの
bbox）を一切変更せず、その後段でのみ次の2種類の画像を生成する（ネットワーク・ファイルI/Oを
含まない純粋な画像処理・ユニットテスト対象）：

  * タイル：固定サイズの正方グリッドに分割した表示用フル解像度PNG。完全に透明なタイルは
    出力しない（ビューポート外・チェックボックスOFF時はフロント側が生成自体をしないため、
    そもそも配信ファイル数を減らせるだけでなく無駄な当たり判定対象も減る）。
  * プレビュー：ホバー時の「不透明部分だけに名称を表示する」当たり判定専用の縮小画像
    （`custom_overlay.js`の`ALPHA_CANVAS_MAX_SIZE`と同じ考え方をビルド時に前倒しして行う）。
    表示には使わないため、フロント側がこれ以上巨大画像をデコードする必要がなくなる。
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
from PIL import Image

# image.pyのドキュメント（合成キャンバスは最大20000x20000pxに達しうる）どおり、ここで扱う
# マスクPNGはCT側が既に生成した信頼できるファイルであり、Pillowの既定の
# 「解凍爆弾」対策（未知の外部入力を想定した上限）は本用途では過検知になるため無効化する。
Image.MAX_IMAGE_PIXELS = None

DEFAULT_TILE_SIZE = 512
DEFAULT_PREVIEW_MAX_SIZE = 180  # custom_overlay.js の ALPHA_CANVAS_MAX_SIZE と合わせる


@dataclass(frozen=True)
class Tile:
    row: int
    col: int
    image_bytes: bytes
    loc1: dict
    loc2: dict


def tile_filename(row: int, col: int) -> str:
    return f"tile_{row}_{col}.png"


def split_into_tiles(
    mask_png_bytes: bytes, *, loc1: dict, loc2: dict, tile_size: int = DEFAULT_TILE_SIZE
) -> list[Tile]:
    """マスクPNGを`tile_size`四方のグリッドに分割する。

    `loc1`/`loc2`はimage.pyの`WorldBBox`と同じ規約（loc1=最小コーナー、loc2=最大コーナー+1・
    exclusive）。画像のピクセル(0,0)がloc1、右下端がloc2に対応する前提で、各タイルの
    ワールド座標は画像内の位置から機械的に算出する（LLM不要・C-1）。

    完全に透明なタイルは戻り値に含めない。不透明ピクセルが1つもない場合は空リストを返す。
    """
    if tile_size <= 0:
        raise ValueError(f"tile_sizeは正の整数である必要があります: {tile_size}")

    with Image.open(io.BytesIO(mask_png_bytes)) as img:
        rgba = img.convert("RGBA")
        w, h = rgba.size
        alpha = np.array(rgba.getchannel("A"))

        expected_w = loc2["x"] - loc1["x"]
        expected_h = loc2["z"] - loc1["z"]
        if (w, h) != (expected_w, expected_h):
            raise ValueError(
                f"画像サイズ({w}x{h})がloc1/loc2から算出した範囲({expected_w}x{expected_h})と一致しません"
            )

        base_y = loc1.get("y", 64)
        tiles: list[Tile] = []
        for row, ty0 in enumerate(range(0, h, tile_size)):
            ty1 = min(ty0 + tile_size, h)
            for col, tx0 in enumerate(range(0, w, tile_size)):
                tx1 = min(tx0 + tile_size, w)
                if not bool(np.any(alpha[ty0:ty1, tx0:tx1] > 0)):
                    continue  # 全透明タイルは配信しない
                tile_img = rgba.crop((tx0, ty0, tx1, ty1))
                buf = io.BytesIO()
                tile_img.save(buf, format="PNG")
                tiles.append(
                    Tile(
                        row=row,
                        col=col,
                        image_bytes=buf.getvalue(),
                        loc1={"x": loc1["x"] + tx0, "y": base_y, "z": loc1["z"] + ty0},
                        loc2={"x": loc1["x"] + tx1, "y": base_y, "z": loc1["z"] + ty1},
                    )
                )
        return tiles


def build_preview_image(mask_png_bytes: bytes, *, max_size: int = DEFAULT_PREVIEW_MAX_SIZE) -> bytes:
    """ホバー当たり判定専用の縮小プレビューPNGを生成する（表示には使わない）。

    アスペクト比を保って最大辺が`max_size`になるよう縮小する。フロント側の
    `loadAlphaData`が従来クライアント側で行っていた縮小をビルド時に前倒しするだけで、
    判定ロジック自体（アルファ値配列を配列参照のみで当たり判定する方式）は変更しない。
    """
    if max_size <= 0:
        raise ValueError(f"max_sizeは正の整数である必要があります: {max_size}")

    with Image.open(io.BytesIO(mask_png_bytes)) as img:
        rgba = img.convert("RGBA")
        w, h = rgba.size
        scale = min(1.0, max_size / max(w, h))
        new_w = max(1, round(w * scale))
        new_h = max(1, round(h * scale))
        preview = rgba.resize((new_w, new_h), Image.NEAREST)
        buf = io.BytesIO()
        preview.save(buf, format="PNG")
        return buf.getvalue()
