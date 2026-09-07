"""カスタムオーバーレイJSの `regions` 配列をテキストとして更新する（§6.3.4・decisions.md #31）。

別紙9章では「JSへの反映は運営が手動」としていたが、本Botでは正式承認の確定を条件に
自動反映まで行う（04-commands.md §6.3.4）。既存の `regions` 配列の書式
（image-tool-spec.md §10.2・`dynmap/web/js/custom_overlay.js`）はそのまま維持し、
1エントリ単位で追加・更新・削除する。

ネットワーク・ファイルI/Oを含まない純粋なテキスト処理（ユニットテスト対象）。
CT104への実際の読み書きは `dynmap_ssh.py` が担う。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_NAME_RE = re.compile(r'name\s*:\s*"([^"]*)"')


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


def render_entry(name: str, image_rel_path: str, loc1: dict, loc2: dict) -> str:
    """既存のエントリと同じ書式（image-tool-spec.md §10.2）で1件分のテキストを生成する。"""
    return (
        "{\n"
        f'            name: "{name}",\n'
        f"            imageUrl: '{image_rel_path}',\n"
        f"            loc1: {{ x: {loc1['x']}, y: {loc1.get('y', 64)}, z: {loc1['z']} }},\n"
        f"            loc2: {{ x: {loc2['x']}, y: {loc2.get('y', 64)}, z: {loc2['z']} }}\n"
        "        }"
    )


def upsert_region_in_js(js_text: str, *, name: str, image_rel_path: str, loc1: dict, loc2: dict) -> str:
    """`regions` 配列内の該当プレイヤーのエントリを更新（無ければ追加）する。"""
    span = _find_array_span(js_text, "regions")
    inner = js_text[span.array_start + 1 : span.array_end - 1]
    entries = _split_top_level_objects(inner)

    new_entry = render_entry(name, image_rel_path, loc1, loc2)
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


def remove_region_from_js(js_text: str, *, name: str) -> str:
    """`regions` 配列から該当プレイヤーのエントリを取り除く（存在しなければ無変更）。"""
    span = _find_array_span(js_text, "regions")
    inner = js_text[span.array_start + 1 : span.array_end - 1]
    entries = _split_top_level_objects(inner)

    rendered = [raw for raw, entry_name in entries if entry_name != name]
    new_inner = "\n        " + ",\n        ".join(rendered) + "\n    " if rendered else ""
    return js_text[: span.array_start + 1] + new_inner + js_text[span.array_end - 1 :]
