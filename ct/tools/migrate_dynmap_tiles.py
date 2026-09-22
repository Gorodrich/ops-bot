"""既存のDynmap個人開発領（regions配列・単一imageUrl形式）を、decisions.md #63の
タイル形式（loc1/loc2＋previewUrl＋tiles配列）へ一括変換するワンショット移行スクリプト。

対象は本番のDynmap配信ディレクトリそのもの（CT104上、またはその内容をローカルにミラーした
`dynmap/web/`配下）。旧形式の`images/indiv/<name>.png`は削除しない（open-items #38と同じ
「誤操作時に元データを残す」方針）。新たに`images/indiv/<name>/tile_<row>_<col>.png`・
`images/indiv/<name>/preview.png`を生成し、`custom_overlay.js`の該当エントリをタイル形式に
書き換える。

使い方：
    python -m opsbot_ct.tools.migrate_dynmap_tiles --web-dir path/to/dynmap/web [--tile-size 512] [--apply]

`--apply` を付けない限りファイルには一切書き込まず、変換対象の一覧と結果サマリのみを表示する
（C-4：開発者の手作業を前提とする運用にしないため、常時実行するものではなく一度限りの移行と
して明示的な`--apply`を要求する設計）。
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from opsbot_ct.dynmap_regions import upsert_region_in_js
from opsbot_ct.dynmap_tiles import (
    build_preview_image,
    split_into_tiles,
    tile_filename,
)

_LEGACY_ENTRY_RE = re.compile(
    r'\{\s*'
    r'name:\s*"(?P<name>[^"]*)",\s*'
    r"imageUrl:\s*'(?P<image_url>[^']*)',\s*"
    r"loc1:\s*\{\s*x:\s*(?P<x1>-?\d+),\s*y:\s*(?P<y1>-?\d+),\s*z:\s*(?P<z1>-?\d+)\s*\}\s*,\s*"
    r"loc2:\s*\{\s*x:\s*(?P<x2>-?\d+),\s*y:\s*(?P<y2>-?\d+),\s*z:\s*(?P<z2>-?\d+)\s*\}\s*"
    r"\}",
)


def find_legacy_regions(js_text: str, var_name: str = "regions") -> list[dict]:
    """`var <var_name> = [...]` の中から旧形式（imageUrl単体）のエントリだけを列挙する。
    既にタイル形式（tiles配列）に変換済みのエントリはimageUrlキーを持たないため対象外になる。
    `territories`配列（decisions.md #63のDynmap軽量化を個人開発領以外にも適用する用途）も
    同じ書式（name/imageUrl/loc1/loc2）のため、`var_name`を変えるだけで流用できる。
    """
    m = re.search(rf"\b{re.escape(var_name)}\s*=\s*\[", js_text)
    if not m:
        raise SystemExit(f"{var_name}配列の宣言が見つかりません")
    start = m.end() - 1
    depth = 0
    i = start
    while i < len(js_text):
        if js_text[i] == "[":
            depth += 1
        elif js_text[i] == "]":
            depth -= 1
            if depth == 0:
                break
        i += 1
    inner = js_text[start + 1 : i]

    out = []
    for em in _LEGACY_ENTRY_RE.finditer(inner):
        out.append(
            {
                "name": em.group("name"),
                "image_url": em.group("image_url"),
                "loc1": {"x": int(em.group("x1")), "y": int(em.group("y1")), "z": int(em.group("z1"))},
                "loc2": {"x": int(em.group("x2")), "y": int(em.group("y2")), "z": int(em.group("z2"))},
            }
        )
    return out


def migrate(
    *,
    web_dir: pathlib.Path,
    overlay_js_path: pathlib.Path,
    images_subdir: str,
    tile_size: int,
    apply: bool,
    var_name: str = "regions",
) -> None:
    js_text = overlay_js_path.read_text(encoding="utf-8")
    entries = find_legacy_regions(js_text, var_name)

    if not entries:
        print("旧形式（imageUrl単体）のエントリは見つかりませんでした。移行済みか、対象がありません。")
        return

    print(f"{len(entries)}件の旧形式エントリを検出しました。")

    updated_js = js_text
    for e in entries:
        name = e["name"]
        # 出力先ディレクトリ・URLは元画像ファイル名（拡張子抜き）を使う。個人開発領は
        # name（Minecraft名）と一致するため既存挙動と変わらないが、領土は`name`が
        # 日本語の国名のため、非ASCIIパスをDynmap配信URLに使わずに済むよう分離する。
        slug = pathlib.Path(e["image_url"]).stem
        src_path = web_dir / e["image_url"]
        if not src_path.exists():
            print(f"  [スキップ] {name}: 画像が見つかりません（{src_path}）")
            continue

        image_bytes = src_path.read_bytes()
        try:
            tiles = split_into_tiles(image_bytes, loc1=e["loc1"], loc2=e["loc2"], tile_size=tile_size)
        except ValueError as err:
            print(f"  [エラー] {name}: {err}")
            continue
        if not tiles:
            print(f"  [スキップ] {name}: 不透明ピクセルが1つもありません")
            continue
        preview_bytes = build_preview_image(image_bytes)

        dest_dir = web_dir / images_subdir / slug
        print(f"  {name}: {len(tiles)}タイル + プレビュー1枚 -> {dest_dir}/")

        if apply:
            dest_dir.mkdir(parents=True, exist_ok=True)
            for tile in tiles:
                (dest_dir / tile_filename(tile.row, tile.col)).write_bytes(tile.image_bytes)
            (dest_dir / "preview.png").write_bytes(preview_bytes)

        images_subdir_norm = images_subdir.strip("/")
        tile_dicts = [
            {
                "image_rel_path": f"{images_subdir_norm}/{slug}/{tile_filename(tile.row, tile.col)}",
                "loc1": tile.loc1,
                "loc2": tile.loc2,
            }
            for tile in tiles
        ]
        updated_js = upsert_region_in_js(
            updated_js,
            name=name,
            loc1=e["loc1"],
            loc2=e["loc2"],
            preview_url=f"{images_subdir_norm}/{slug}/preview.png",
            tiles=tile_dicts,
            var_name=var_name,
        )

    if apply:
        overlay_js_path.write_text(updated_js, encoding="utf-8")
        print(f"{overlay_js_path} を更新しました。")
    else:
        print("--apply を付けずに実行したため、ファイルへの書き込みは行っていません（ドライラン）。")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web-dir", type=pathlib.Path, required=True, help="Dynmap配信ディレクトリ（例: dynmap/web）")
    parser.add_argument("--overlay-js", type=pathlib.Path, default=None, help="既定: <web-dir>/js/custom_overlay.js")
    parser.add_argument("--images-subdir", default="images/indiv")
    parser.add_argument("--tile-size", type=int, default=512)
    parser.add_argument("--var-name", default="regions", help="対象のJS配列名（既定: regions。領土なら territories）")
    parser.add_argument("--apply", action="store_true", help="指定した場合のみ実際にファイルへ書き込む")
    args = parser.parse_args()

    overlay_js_path = args.overlay_js or (args.web_dir / "js" / "custom_overlay.js")
    migrate(
        web_dir=args.web_dir,
        overlay_js_path=overlay_js_path,
        images_subdir=args.images_subdir,
        tile_size=args.tile_size,
        apply=args.apply,
        var_name=args.var_name,
    )


if __name__ == "__main__":
    main()
