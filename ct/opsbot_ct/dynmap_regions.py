"""カスタムオーバーレイJSの `regions` 配列をテキストとして更新する（§6.3.4・decisions.md #31・#63）。

別紙9章では「JSへの反映は運営が手動」としていたが、本Botでは正式承認の確定を条件に
自動反映まで行う（04-commands.md §6.3.4）。

decisions.md #63（Dynmapオーバーレイ軽量化）により、1エントリの画像表現を単一の
`imageUrl` からタイル配列 `tiles` へ変更した。エントリ単位のプレイヤー特定（`name`）と
チェックボックス1つに対応する仕組み（1エントリ＝1レイヤーグループ）自体は変更しない。

CT104への実際の読み書きは `dynmap_ssh.py` が担う。ネットワーク・ファイルI/Oを含まない
純粋なテキスト処理（ユニットテスト対象）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_NAME_RE = re.compile(r'name\s*:\s*"([^"]*)"')

_INDENT = "        "  # 既存ファイルのregions配列のインデント幅に合わせる


class RegionsFormatError(RuntimeError):
    pass


@dataclass
class _ArraySpan:
    array_start: int  # "[" の位置
    array_end: int  # 対応する "]" の直後の位置


def _find_array_span(js_text: str, var_name: str) -> _ArraySpan:
    """`var regions = [ ... ];` のような宣言を探し、`[`〜対応する`]`の範囲を返す。"""
    decl_re = re.compile(rf"\b{re.escape(var_name)}\s*=\s*\[")
    m = decl_re.search(js_text)
    if not m:
        raise RegionsFormatError(f"{var_name} の配列宣言が見つかりません")
    array_start = m.end() - 1  # "[" の位置

    depth = 0
    i = array_start
    while i < len(js_text):
        ch = js_text[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return _ArraySpan(array_start, i + 1)
        i += 1
    raise RegionsFormatError(f"{var_name} 配列の閉じ括弧が見つかりません（不正なJS）")


def _split_top_level_objects(array_inner: str) -> list[tuple[str, str]]:
    """配列内側のテキストから、トップレベルの `{...}` オブジェクトを (raw_text, name) で列挙する。"""
    out: list[tuple[str, str]] = []
    i = 0
    n = len(array_inner)
    while i < n:
        if array_inner[i] == "{":
            depth = 0
            start = i
            while i < n:
                if array_inner[i] == "{":
                    depth += 1
                elif array_inner[i] == "}":
                    depth -= 1
                    if depth == 0:
                        i += 1
                        break
                i += 1
            raw = array_inner[start:i]
            m = _NAME_RE.search(raw)
            name = m.group(1) if m else ""
            out.append((raw, name))
        else:
            i += 1
    return out


def _render_loc(loc: dict) -> str:
    return f"{{ x: {loc['x']}, y: {loc.get('y', 64)}, z: {loc['z']} }}"


def render_entry(
    name: str,
    *,
    loc1: dict,
    loc2: dict,
    preview_url: str,
    tiles: list[dict],
) -> str:
    """タイル形式（decisions.md #63）で1件分のテキストを生成する。

    `tiles`は [{"image_rel_path": str, "loc1": dict, "loc2": dict}, ...] の形式
    （提出順・タイル座標の昇順である必要はない。空リストは呼び出し側で弾く）。
    """
    if not tiles:
        raise RegionsFormatError("tilesは1件以上必要です（全透明の申請は承認され得ない）")

    tile_lines = [
        f"{{ imageUrl: '{t['image_rel_path']}', loc1: {_render_loc(t['loc1'])}, loc2: {_render_loc(t['loc2'])} }}"
        for t in tiles
    ]
    tiles_inner = (",\n" + _INDENT + "        ").join(tile_lines)

    return (
        "{\n"
        f'{_INDENT}    name: "{name}",\n'
        f"{_INDENT}    loc1: {_render_loc(loc1)},\n"
        f"{_INDENT}    loc2: {_render_loc(loc2)},\n"
        f"{_INDENT}    previewUrl: '{preview_url}',\n"
        f"{_INDENT}    tiles: [\n"
        f"{_INDENT}        {tiles_inner}\n"
        f"{_INDENT}    ]\n"
        f"{_INDENT}}}"
    )


def upsert_region_in_js(
    js_text: str,
    *,
    name: str,
    loc1: dict,
    loc2: dict,
    preview_url: str,
    tiles: list[dict],
    var_name: str = "regions",
) -> str:
    """`var_name` 配列内の該当エントリを更新（無ければ追加）する。

    既定は個人開発領（`regions`）だが、同一書式を使う他の配列（例：`territories`）に
    対しても呼び出し側から `var_name` を指定して流用できる。
    """
    span = _find_array_span(js_text, var_name)
    inner = js_text[span.array_start + 1 : span.array_end - 1]
    entries = _split_top_level_objects(inner)

    new_entry = render_entry(name, loc1=loc1, loc2=loc2, preview_url=preview_url, tiles=tiles)
    replaced = False
    rendered: list[str] = []
    for raw, entry_name in entries:
        if entry_name == name:
            rendered.append(new_entry)
            replaced = True
        else:
            rendered.append(raw)
    if not replaced:
        rendered.append(new_entry)

    new_inner = "\n        " + ",\n        ".join(rendered) + "\n    " if rendered else ""
    return js_text[: span.array_start + 1] + new_inner + js_text[span.array_end - 1 :]


def remove_region_from_js(js_text: str, *, name: str, var_name: str = "regions") -> str:
    """`var_name` 配列から該当エントリを取り除く（存在しなければ無変更）。
    画像ファイル自体（タイル・プレビュー）は削除しない（open-items #38と同様の方針）。
    """
    span = _find_array_span(js_text, var_name)
    inner = js_text[span.array_start + 1 : span.array_end - 1]
    entries = _split_top_level_objects(inner)

    rendered = [raw for raw, entry_name in entries if entry_name != name]
    new_inner = "\n        " + ",\n        ".join(rendered) + "\n    " if rendered else ""
    return js_text[: span.array_start + 1] + new_inner + js_text[span.array_end - 1 :]
