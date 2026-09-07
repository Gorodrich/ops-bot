"""個人開発領マップ処理ライブラリ（Phase 2・§6.3／別紙 image-tool-spec.md）。

既存の「個人開発領マップ自動処理ツール」（docs/appendix/indivisual_territory_map.py、
別紙要件定義書 v1.1）の座標変換（+1補正・別紙4.2章）・ファイル名解析（別紙7章）・
バリデーション（別紙6章）・クロップ仕様（別紙5.3章）はそのまま移植し、変更しない
（07-nonfunctional.md §11-9）。

本Bot組み込みにあたっての差分（04-commands.md §6.3.3）：
  * 条件⑤：特定保護区域との重複判定（ピクセル単位）
  * 条件⑥：他参加者の既存の個人開発領との重複判定（ピクセル単位・申請者自身は除外）
  * 条件⑦：ファイル名のプレイヤー名の紐づけ確認は Workers 側（account_links）で行う。
    CT はここでは「ファイル名のプレイヤー名 == 申請者本人の紐づけ済み名」の一致確認のみ行う
    （Phase 2 は単独申請のみ対応。代表者一括申請は Phase 3・§5.7.3）。
  * 条件⑧：申請範囲が旧ボーダー外にあること。別紙2章の定義上、ゾーン01〜16の16区画自体が
    「旧ボーダー外の全体マップ」であるため、ファイル名のゾーン番号が01〜16の範囲内である
    ことの確認（別紙7章の既存チェック）をもって条件⑧を満たす。旧ボーダー内はいずれの
    ゾーンにも属さないため、別途の境界データを必要としない。

既知の制約（引き継ぎ・§11-11／別紙13章）：
  * 離れたゾーンをまたぐ申請では合成キャンバスが最大20000×20000pxに達しうる。
    RGBA(4バイト/px)ではなく可能な限り単一チャンネル（"L"・1バイト/px）で保持し、
    メモリ使用量を抑える（§3.4.1のRAM制約）。最終出力（確認画像・成果物PNG）の
    生成時のみRGBA化する。連結成分ごとの分割出力への変更は将来検討（別紙13章）。
"""

from __future__ import annotations

import base64
import io
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from PIL import Image

log = logging.getLogger("opsbot_ct.image")

MAX_AREA = 250_000
ZONE_SIZE = 5000

NEW_REGION_COLOR = (255, 0, 255)   # 新規申請範囲（既存ツールと同じ配色）
OVERLAP_COLOR = (255, 0, 0)        # 重複範囲（条件⑤⑥不合格の可視化）
REMOVED_COLOR = (255, 165, 0)      # 宣言型モデルによる削除範囲の警告表示（open-items #38）

_COLS = {1: -10000, 2: -5000, 3: 0, 4: 5000}
_ROWS = {1: -10000, 2: -5000, 3: 0, 4: 5000}


def _build_zone_table() -> dict[str, tuple[int, int]]:
    zones: dict[str, tuple[int, int]] = {}
    n = 1
    for row in (1, 2, 3, 4):
        for col in (1, 2, 3, 4):
            zones[f"{n:02d}"] = (_COLS[col], _ROWS[row])
            n += 1
    return zones


ZONES = _build_zone_table()  # "01".."16" -> (zone_x_min, zone_z_min)


# ── 別紙7章：ファイル名解析 ──────────────────────────────────────────────


@dataclass
class ParsedName:
    filename: str
    zone: str
    player: str


def parse_filename(filename: str) -> tuple[str | None, ParsedName | None]:
    """成功時は (None, ParsedName)、失敗時は (理由, None) を返す。"""
    if not filename.lower().endswith(".png"):
        return ("拡張子が.pngではありません", None)
    stem = filename[:-4]
    if "_" not in stem:
        return ("ファイル名の形式が不正です（{2桁数字}_{プレイヤー名}.png ではありません）", None)
    zone_part, player_part = stem.split("_", 1)
    if not re.fullmatch(r"\d{2}", zone_part):
        return ("ゾーン番号が2桁数字ではありません", None)
    if zone_part not in ZONES:
        return (f"ゾーン番号が範囲外です（01〜16以外: {zone_part}）", None)
    if not player_part:
        return ("プレイヤー名が空です", None)
    return (None, ParsedName(filename, zone_part, player_part))


# ── 別紙6章：ファイル単位バリデーション（条件①②③） ─────────────────────


@dataclass
class FileCheckResult:
    filename: str
    ok: bool
    errors: list[str] = field(default_factory=list)
    alpha: "np.ndarray | None" = None  # uint8 (H, W)。合格時のみ


def check_file(filename: str, raw_bytes: bytes) -> FileCheckResult:
    """条件①②③（別紙6.1章）。判定不可な項目も含め漏れなく記録する（別紙6.2章）。"""
    errors: list[str] = []
    try:
        img = Image.open(io.BytesIO(raw_bytes))
        img.load()
        fmt = img.format
        if fmt != "PNG":
            errors.append(f"条件①不合格（PNG形式として読み込めませんでした。検出形式: {fmt}）")
    except Exception as e:  # noqa: BLE001 外部入力（破損ファイル等）に起因する全例外を握りつぶす
        errors.append(f"条件①不合格（画像として読み込めません: {e}）")
        errors.append("条件②不合格（判定不可: 画像を読み込めなかったため）")
        errors.append("条件③不合格（判定不可: 画像を読み込めなかったため）")
        return FileCheckResult(filename, False, errors, None)

    w, h = img.size
    if (w, h) != (ZONE_SIZE, ZONE_SIZE):
        errors.append(f"条件②不合格（サイズが5000x5000ではありません。実際: {w}x{h}）")

    alpha = np.array(img.convert("RGBA").getchannel("A"))
    unique_vals = np.unique(alpha)
    bad_mask = (unique_vals != 0) & (unique_vals != 255)
    if bad_mask.any():
        mid_count = int(sum(int(np.count_nonzero(alpha == v)) for v in unique_vals[bad_mask]))
        errors.append(f"条件③不合格（アルファ値に中間値が{mid_count}ピクセル存在します）")

    return FileCheckResult(filename, len(errors) == 0, errors, alpha if len(errors) == 0 else None)


# ── 別紙5.2章：合成キャンバス作成（"L"チャンネルのみ・メモリ節約） ───────────


@dataclass
class WorldBBox:
    x1: int
    z1: int
    x2: int  # exclusive（+1補正後のloc2と同じ値）
    z2: int  # exclusive

    @property
    def width(self) -> int:
        return self.x2 - self.x1

    @property
    def height(self) -> int:
        return self.z2 - self.z1

    def to_dict(self) -> dict[str, int]:
        return {"x1": self.x1, "z1": self.z1, "x2": self.x2, "z2": self.z2}

    @staticmethod
    def from_dict(d: dict[str, int]) -> "WorldBBox":
        return WorldBBox(d["x1"], d["z1"], d["x2"], d["z2"])


def build_composite_alpha(zone_alphas: list[tuple[str, "np.ndarray"]]) -> tuple["np.ndarray", int, int]:
    """zone_alphas: [(zone番号, alpha配列(5000x5000))]。
    戻り値: (合成alpha配列, canvas_world_x_min, canvas_world_z_min)。
    """
    if len(zone_alphas) == 1:
        zone, alpha = zone_alphas[0]
        zx, zz = ZONES[zone]
        return alpha, zx, zz

    x_mins, z_mins, x_maxs, z_maxs = [], [], [], []
    for zone, _alpha in zone_alphas:
        zx, zz = ZONES[zone]
        x_mins.append(zx)
        z_mins.append(zz)
        x_maxs.append(zx + ZONE_SIZE)
        z_maxs.append(zz + ZONE_SIZE)

    cx_min, cz_min = min(x_mins), min(z_mins)
    cx_max, cz_max = max(x_maxs), max(z_maxs)
    canvas = np.zeros((cz_max - cz_min, cx_max - cx_min), dtype=np.uint8)
    for zone, alpha in zone_alphas:
        zx, zz = ZONES[zone]
        ox, oz = zx - cx_min, zz - cz_min
        canvas[oz : oz + ZONE_SIZE, ox : ox + ZONE_SIZE] = alpha
    return canvas, cx_min, cz_min


def crop_and_measure(canvas_alpha: "np.ndarray", canvas_x_min: int, canvas_z_min: int) -> tuple["np.ndarray | None", WorldBBox | None, int]:
    """不透明ピクセルのbboxでクロップし、面積（不透明ピクセル数）を数える。
    不透明ピクセルが1つもなければ (None, None, 0)。
    """
    rows = np.any(canvas_alpha > 0, axis=1)
    cols = np.any(canvas_alpha > 0, axis=0)
    if not rows.any():
        return None, None, 0
    py_min, py_max = int(np.argmax(rows)), int(len(rows) - 1 - np.argmax(rows[::-1]))
    px_min, px_max = int(np.argmax(cols)), int(len(cols) - 1 - np.argmax(cols[::-1]))

    cropped = canvas_alpha[py_min : py_max + 1, px_min : px_max + 1]
    area = int(np.count_nonzero(cropped))

    # 別紙4.2章：+1補正ルール（最小側は補正なし、最大側は+1）
    bbox = WorldBBox(
        x1=canvas_x_min + px_min,
        z1=canvas_z_min + py_min,
        x2=canvas_x_min + px_max + 1,
        z2=canvas_z_min + py_max + 1,
    )
    return cropped, bbox, area


# ── ピクセル単位の重複判定（条件⑤⑥・§6.3.1決定#5：bbox交差では判定しない） ──


def bbox_intersection(a: WorldBBox, b: WorldBBox) -> WorldBBox | None:
    x1, z1 = max(a.x1, b.x1), max(a.z1, b.z1)
    x2, z2 = min(a.x2, b.x2), min(a.z2, b.z2)
    if x1 >= x2 or z1 >= z2:
        return None
    return WorldBBox(x1, z1, x2, z2)


def pixel_overlap_count(mask_a: "np.ndarray", bbox_a: WorldBBox, mask_b: "np.ndarray", bbox_b: WorldBBox) -> int:
    """2つのマスク（各々 bbox 原点基準のalpha配列）のピクセル単位重複数。
    bbox交差を先に見るのは「重複しうるかの必要条件での足切り」であり、bbox交差自体を
    重複判定の代用にはしていない（実際のピクセルANDで最終判定する・§6.3.1）。
    """
    inter = bbox_intersection(bbox_a, bbox_b)
    if inter is None:
        return 0
    a_slice = mask_a[
        inter.z1 - bbox_a.z1 : inter.z2 - bbox_a.z1,
        inter.x1 - bbox_a.x1 : inter.x2 - bbox_a.x1,
    ] > 0
    b_slice = mask_b[
        inter.z1 - bbox_b.z1 : inter.z2 - bbox_b.z1,
        inter.x1 - bbox_b.x1 : inter.x2 - bbox_b.x1,
    ] > 0
    return int(np.count_nonzero(a_slice & b_slice))


def load_mask_alpha(path: str) -> "np.ndarray | None":
    """既存の個人開発領・保護区域のマスク画像（RGBA PNG）からalpha配列を読み込む。
    ファイルが存在しない・破損している場合は None を返し、呼び出し側で警告してスキップする
    （1件のマスク破損でジョブ全体を失敗させない）。
    """
    try:
        with Image.open(path) as img:
            return np.array(img.convert("RGBA").getchannel("A"))
    except OSError as e:
        log.warning("マスク読み込み失敗（スキップ）: path=%s error=%s", path, e)
        return None


# ── 出力：recolor・確認画像生成 ──────────────────────────────────────────


def recolor(alpha: "np.ndarray", color: tuple[int, int, int]) -> Image.Image:
    """alpha>0のピクセルを指定色、alpha自体は変更しない（既存ツールと同じ配色規約）。"""
    h, w = alpha.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    opaque = alpha > 0
    rgba[opaque, 0], rgba[opaque, 1], rgba[opaque, 2] = color
    rgba[:, :, 3] = alpha
    return Image.fromarray(rgba, "RGBA")


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@dataclass
class OverlayLayer:
    alpha: "np.ndarray"
    bbox: WorldBBox
    color: tuple[int, int, int]


def render_confirmation_image(layers: list[OverlayLayer]) -> bytes:
    """複数レイヤー（新規申請範囲・重複範囲・削除範囲）を、それらを包含する最小の
    キャンバス上に重ね合わせて1枚のPNGにする（§6.3.4：確認画像）。後段のレイヤーが
    前段を上書きする（重複・削除の強調表示を最後に描くこと）。
    """
    if not layers:
        raise ValueError("layers は1件以上必要です")
    x1 = min(l.bbox.x1 for l in layers)
    z1 = min(l.bbox.z1 for l in layers)
    x2 = max(l.bbox.x2 for l in layers)
    z2 = max(l.bbox.z2 for l in layers)
    canvas = np.zeros((z2 - z1, x2 - x1, 4), dtype=np.uint8)
    for layer in layers:
        ox, oz = layer.bbox.x1 - x1, layer.bbox.z1 - z1
        h, w = layer.alpha.shape
        opaque = layer.alpha > 0
        region = canvas[oz : oz + h, ox : ox + w]
        region[opaque, 0], region[opaque, 1], region[opaque, 2] = layer.color
        region[opaque, 3] = 255
    return png_bytes(Image.fromarray(canvas, "RGBA"))


# ── ジョブ本体：/kaihatsu set の形式審査（§5.7.2・単独申請のみ／Phase 2） ────


@dataclass
class ExistingClaim:
    claim_id: int
    owner_uuid: str
    owner_name: str
    mask_ref: str
    bbox: WorldBBox
    # Phase 3（§5.7.5・§5.7.4最終段落）：確定済み(confirmed)との重複は却下だが、
    # 仮承認中(provisional)・グループ予約中(reserved)との重複は却下ではなく「保留」とする。
    # ref_type/ref_idはWorkers側が持つ保留先の参照（application_id または group_key）を
    # そのまま素通しする（CTはD1を直接見ないため、Workers側から渡されたIDをそのまま返す）。
    kind: str = "confirmed"  # confirmed|provisional|reserved
    ref_type: str | None = None  # "application"|"group"（kind!=confirmedの場合のみ使う）
    ref_id: "int | str | None" = None
    # 代表者一括申請（§5.7.1後段）：同一バッチ内で先に承認された参加者のマスクは、
    # まだディスク保存前でもインメモリのまま後続参加者の「既存の個人開発領」として扱える
    # ようにする（設定時はmask_refより優先して使う）。
    alpha: "np.ndarray | None" = None


@dataclass
class ProtectedArea:
    area_id: int
    name: str
    mask_ref: str
    bbox: WorldBBox


def evaluate_kaihatsu_set(
    *,
    requester_mc_name: str,
    attachments: list[tuple[str, bytes]],
    existing_claims: list[ExistingClaim],
    protected_areas: list[ProtectedArea],
    previous_own_claim: ExistingClaim | None,
) -> dict[str, Any]:
    """ネットワークI/Oを含まない純粋な評価本体（ユニットテスト対象）。
    attachments はすでにダウンロード済みの (filename, raw_bytes) のリスト。
    """
    reasons: list[str] = []

    parsed: list[ParsedName] = []
    for filename, _raw in attachments:
        reason, result = parse_filename(filename)
        if reason is not None:
            reasons.append(f"{filename}: {reason}")
        else:
            assert result is not None
            parsed.append(result)

    # Phase 2 制約：代表者による一括申請は未対応（§5.7.3はPhase 3）。
    # 自分以外のプレイヤー名を検出した場合は全体を却下する。
    others = sorted({p.player for p in parsed if p.player.lower() != requester_mc_name.lower()})
    if others:
        reasons.append(
            f"このコマンドはご自身（{requester_mc_name}）の申請のみ受け付けます"
            f"（ファイル名から別プレイヤーの申請を検出: {', '.join(others)}）。"
            "代表者による一括申請はPhase 3以降で対応予定です。"
        )

    own_parsed = [p for p in parsed if p.player.lower() == requester_mc_name.lower()]
    if not own_parsed and not reasons:
        reasons.append("有効な申請画像がありません。")

    file_by_name = dict(attachments)
    checked: list[tuple[ParsedName, FileCheckResult]] = []
    for p in own_parsed:
        fr = check_file(p.filename, file_by_name[p.filename])
        for err in fr.errors:
            reasons.append(f"{p.filename}: {err}")
        checked.append((p, fr))

    if reasons:
        return {"outcome": "rejected", "reasons": reasons}

    return _evaluate_core(
        checked=checked,
        existing_claims=existing_claims,
        protected_areas=protected_areas,
        previous_own_claim=previous_own_claim,
    )


def _evaluate_core(
    *,
    checked: list[tuple[ParsedName, FileCheckResult]],
    existing_claims: list[ExistingClaim],
    protected_areas: list[ProtectedArea],
    previous_own_claim: ExistingClaim | None,
) -> dict[str, Any]:
    """条件①②③・ファイル名解析を通過した1人分の提出について、条件④⑤⑥の判定から
    承認・却下・保留までを行う共通本体（単独申請・代表者一括申請の両方から呼ばれる）。
    """
    reasons: list[str] = []
    zone_alphas = [(p.zone, fr.alpha) for p, fr in checked]
    canvas, cx_min, cz_min = build_composite_alpha(zone_alphas)
    cropped_alpha, bbox, area = crop_and_measure(canvas, cx_min, cz_min)

    if cropped_alpha is None or bbox is None:
        return {"outcome": "rejected", "reasons": ["不透明ピクセルが1つも存在しません。"]}

    if area > MAX_AREA:
        reasons.append(f"条件④不合格（申請面積が{area:,}ブロックで、上限{MAX_AREA:,}ブロックを超えています）")

    # 条件⑤：特定保護区域との重複（ピクセル単位）。現状は登録0件のため実質常に通過する
    # （open-items #6：データ投入まで「登録0件」として暫定運用・decisions.md #50）。
    overlap_protected: list[dict[str, Any]] = []
    protected_overlap_layers: list[OverlayLayer] = []
    for area_def in protected_areas:
        mask = load_mask_alpha(area_def.mask_ref)
        if mask is None:
            continue
        count = pixel_overlap_count(cropped_alpha, bbox, mask, area_def.bbox)
        if count > 0:
            overlap_protected.append({"name": area_def.name, "pixels": count})
            protected_overlap_layers.append(OverlayLayer(mask, area_def.bbox, OVERLAP_COLOR))
    for o in overlap_protected:
        reasons.append(f"条件⑤不合格（特定保護区域「{o['name']}」と{o['pixels']:,}ピクセル重複しています）")

    # 条件⑥：他参加者の既存の個人開発領との重複（申請者自身は呼び出し側（Workers）で除外済み）。
    # 重複相手の名前を提示する（open-items #36・decisions.md #52）。
    # confirmed（確定済み）との重複は却下、provisional/reserved（仮承認中・グループ予約中）との
    # 重複は却下ではなく「保留」とする（§5.7.5・§5.7.4最終段落）。
    overlap_confirmed: list[dict[str, Any]] = []
    overlap_pending: list[dict[str, Any]] = []
    claim_overlap_layers: list[OverlayLayer] = []
    for claim in existing_claims:
        mask = claim.alpha if claim.alpha is not None else load_mask_alpha(claim.mask_ref)
        if mask is None:
            continue
        count = pixel_overlap_count(cropped_alpha, bbox, mask, claim.bbox)
        if count == 0:
            continue
        claim_overlap_layers.append(OverlayLayer(mask, claim.bbox, OVERLAP_COLOR))
        if claim.kind == "confirmed":
            overlap_confirmed.append({"owner_name": claim.owner_name, "pixels": count})
        else:
            overlap_pending.append(
                {
                    "owner_name": claim.owner_name,
                    "pixels": count,
                    "ref_type": claim.ref_type,
                    "ref_id": claim.ref_id,
                }
            )
    for o in overlap_confirmed:
        reasons.append(f"条件⑥不合格（{o['owner_name']}さんの既存の個人開発領と{o['pixels']:,}ピクセル重複しています）")

    if reasons:
        # 却下時も確認画像を添付する（申請範囲と重複箇所を重ねて可視化・§6.3.4）。
        layers = [OverlayLayer(cropped_alpha, bbox, NEW_REGION_COLOR), *claim_overlap_layers, *protected_overlap_layers]
        confirmation_image = render_confirmation_image(layers)
        return {
            "outcome": "rejected",
            "reasons": reasons,
            "area_blocks": area,
            "overlap_with": overlap_confirmed,
            "overlap_protected": overlap_protected,
            "confirmation_image_base64": base64.b64encode(confirmation_image).decode("ascii"),
        }

    if overlap_pending:
        # confirmedとの重複はないが、仮承認中／グループ予約中の範囲とのみ重複する場合は
        # 却下せず保留とする（§5.7.5）。先頭（Workers側が届出時刻の古い順に並べて渡す）を
        # 保留先として採用する（複数該当時のタイブレークはWorkers側の並び順に委ねる設計）。
        layers = [OverlayLayer(cropped_alpha, bbox, NEW_REGION_COLOR), *claim_overlap_layers, *protected_overlap_layers]
        confirmation_image = render_confirmation_image(layers)
        blocker = overlap_pending[0]
        return {
            "outcome": "held",
            "reasons": [f"{blocker['owner_name']}さんの仮承認中の範囲と{blocker['pixels']:,}ピクセル重複しているため保留します。"],
            "area_blocks": area,
            "held_blocking_ref_type": blocker["ref_type"],
            "held_blocking_ref_id": blocker["ref_id"],
            "overlap_pending": overlap_pending,
            "confirmation_image_base64": base64.b64encode(confirmation_image).decode("ascii"),
        }

    # ── 承認 ──────────────────────────────────────────────────────────
    removed_pixels, added_pixels = _diff_against_previous(cropped_alpha, bbox, previous_own_claim)

    layers = [OverlayLayer(cropped_alpha, bbox, NEW_REGION_COLOR)]
    if previous_own_claim is not None and removed_pixels > 0:
        prev_mask = load_mask_alpha(previous_own_claim.mask_ref)
        if prev_mask is not None:
            removed_mask = _removed_pixel_mask(prev_mask, previous_own_claim.bbox, cropped_alpha, bbox)
            if removed_mask is not None:
                layers.append(OverlayLayer(removed_mask, previous_own_claim.bbox, REMOVED_COLOR))

    confirmation_image = render_confirmation_image(layers)
    output_image = recolor(cropped_alpha, NEW_REGION_COLOR)

    return {
        "outcome": "approved",
        "reasons": [],
        "area_blocks": area,
        "bbox": bbox.to_dict(),
        "loc1": {"x": bbox.x1, "y": 64, "z": bbox.z1},
        "loc2": {"x": bbox.x2, "y": 64, "z": bbox.z2},
        "removed_pixels": removed_pixels,
        "added_pixels": added_pixels,
        "had_previous_claim": previous_own_claim is not None,
        "confirmation_image_base64": base64.b64encode(confirmation_image).decode("ascii"),
        "output_image_bytes": png_bytes(output_image),  # 呼び出し側でmasks_dirへ保存する
    }


def _diff_against_previous(
    new_alpha: "np.ndarray", new_bbox: WorldBBox, previous: ExistingClaim | None
) -> tuple[int, int]:
    """宣言型モデル（§5.7.1）：従前の範囲のうち今回含まれない部分＝削除、新規に含まれる部分＝追加。
    削除は「復元不可」（open-items #38・decisions.md #52）のため、確定前の可視化に用いる。
    """
    if previous is None:
        return 0, int(np.count_nonzero(new_alpha))

    prev_mask = load_mask_alpha(previous.mask_ref)
    if prev_mask is None:
        # 旧マスクが読めない場合は安全側（差分不明として全域を「追加」扱い、削除0）に倒す。
        return 0, int(np.count_nonzero(new_alpha))

    union = _union_bbox(previous.bbox, new_bbox)
    prev_grid = np.zeros((union.height, union.width), dtype=bool)
    new_grid = np.zeros((union.height, union.width), dtype=bool)
    po_x, po_z = previous.bbox.x1 - union.x1, previous.bbox.z1 - union.z1
    prev_grid[po_z : po_z + previous.bbox.height, po_x : po_x + previous.bbox.width] = prev_mask > 0
    no_x, no_z = new_bbox.x1 - union.x1, new_bbox.z1 - union.z1
    new_grid[no_z : no_z + new_bbox.height, no_x : no_x + new_bbox.width] = new_alpha > 0

    removed = int(np.count_nonzero(prev_grid & ~new_grid))
    added = int(np.count_nonzero(new_grid & ~prev_grid))
    return removed, added


def _removed_pixel_mask(
    prev_mask: "np.ndarray", prev_bbox: WorldBBox, new_alpha: "np.ndarray", new_bbox: WorldBBox
) -> "np.ndarray | None":
    """削除される範囲（旧bbox原点基準のalpha配列）。確認画像の警告表示用（open-items #38）。"""
    union = _union_bbox(prev_bbox, new_bbox)
    prev_grid = np.zeros((union.height, union.width), dtype=bool)
    new_grid = np.zeros((union.height, union.width), dtype=bool)
    po_x, po_z = prev_bbox.x1 - union.x1, prev_bbox.z1 - union.z1
    prev_grid[po_z : po_z + prev_bbox.height, po_x : po_x + prev_bbox.width] = prev_mask > 0
    no_x, no_z = new_bbox.x1 - union.x1, new_bbox.z1 - union.z1
    new_grid[no_z : no_z + new_bbox.height, no_x : no_x + new_bbox.width] = new_alpha > 0
    removed = prev_grid & ~new_grid
    if not removed.any():
        return None
    # previous.bbox 原点基準に戻す
    po_x, po_z = prev_bbox.x1 - union.x1, prev_bbox.z1 - union.z1
    return (removed[po_z : po_z + prev_bbox.height, po_x : po_x + prev_bbox.width]).astype(np.uint8) * 255


def _union_bbox(a: WorldBBox, b: WorldBBox) -> WorldBBox:
    return WorldBBox(min(a.x1, b.x1), min(a.z1, b.z1), max(a.x2, b.x2), max(a.z2, b.z2))


# ── 代表者による一括申請（§5.7.3・複数参加者・Phase 3） ──────────────────


@dataclass
class BatchPlayerInput:
    player_name: str
    files: list[tuple[str, bytes]]  # (filename, raw_bytes)（提出順を保持）
    previous_own_claim: ExistingClaim | None


def evaluate_kaihatsu_set_batch(
    *,
    attachments: list[tuple[str, bytes]],
    resolved_owners: dict[str, ExistingClaim | None],
    existing_claims: list[ExistingClaim],
    protected_areas: list[ProtectedArea],
) -> dict[str, Any]:
    """代表者による一括申請（§5.7.3）・同時処理グループ内のset（§5.7.4）の評価本体。

    attachments は1回の `/kaihatsu set` に含まれる全参加者分のファイル（提出順）。
    resolved_owners は「小文字化したプレイヤー名」→「そのプレイヤーの従前claim（無ければNone）」の
    辞書で、Workers側が事前に account_links と照合済みのプレイヤーのみを含む（条件⑦）。
    ここに存在しないプレイヤー名のファイルは `unresolved_players` として返し、CT側では処理しない。

    §5.7.1後段：同一バッチ内で先に評価され要件を満たした申請は、後続の評価では
    「既存の個人開発領」と同様に扱う（自己重複除外の対象にはしない＝pool_by_name経由でのみ追加）。
    """
    skipped_files: list[str] = []
    parsed: list[ParsedName] = []
    for filename, _raw in attachments:
        reason, result = parse_filename(filename)
        if reason is not None:
            skipped_files.append(f"{filename}: {reason}")
        else:
            assert result is not None
            parsed.append(result)

    # プレイヤーごとにグルーピングしつつ、初出順を提出順とする（§5.7.1：添付オプション順）。
    order: list[str] = []
    files_by_player: dict[str, list[ParsedName]] = {}
    for p in parsed:
        key = p.player.lower()
        if key not in files_by_player:
            files_by_player[key] = []
            order.append(key)
        files_by_player[key].append(p)

    file_by_name = dict(attachments)
    unresolved_players = sorted({k for k in order if k not in resolved_owners})

    players_result: dict[str, Any] = {}
    running_pool = list(existing_claims)  # このバッチ内で承認済みの参加者を随時追加していく（confirmed扱い）

    for key in order:
        if key not in resolved_owners:
            continue  # unresolved_players 側に既に記録済み
        player_files = files_by_player[key]
        display_name = player_files[0].player  # ファイル名の表記をそのまま使う

        checked: list[tuple[ParsedName, FileCheckResult]] = []
        reasons: list[str] = []
        for p in player_files:
            fr = check_file(p.filename, file_by_name[p.filename])
            for err in fr.errors:
                reasons.append(f"{p.filename}: {err}")
            checked.append((p, fr))

        if reasons:
            players_result[display_name] = {"outcome": "rejected", "reasons": reasons}
            continue

        result = _evaluate_core(
            checked=checked,
            existing_claims=running_pool,
            protected_areas=protected_areas,
            previous_own_claim=resolved_owners[key],
        )
        players_result[display_name] = result

        if result["outcome"] == "approved":
            # 後続参加者から見て「既存の個人開発領」として扱う（§5.7.1後段）。
            zone_alphas = [(p.zone, fr.alpha) for p, fr in checked]
            canvas, cx_min, cz_min = build_composite_alpha(zone_alphas)
            cropped_alpha, bbox, _area = crop_and_measure(canvas, cx_min, cz_min)
            if cropped_alpha is not None and bbox is not None:
                running_pool = [
                    *running_pool,
                    ExistingClaim(
                        claim_id=-1,
                        owner_uuid="",
                        owner_name=display_name,
                        mask_ref="",
                        bbox=bbox,
                        kind="confirmed",
                        alpha=cropped_alpha,
                    ),
                ]

    return {
        "players": players_result,
        "unresolved_players": unresolved_players,
        "skipped_files": skipped_files,
    }


# ── ジョブディスパッチ用エントリポイント（ネットワークI/O込み） ────────────


def download_attachments(urls: list[tuple[str, str]], *, timeout: float = 60.0) -> list[tuple[str, bytes]]:
    """[(filename, url), ...] をDiscord CDNから直接取得する（§3.3：Workers経由の転送はしない）。"""
    import httpx

    out: list[tuple[str, bytes]] = []
    with httpx.Client(timeout=timeout) as client:
        for filename, url in urls:
            res = client.get(url)
            res.raise_for_status()
            out.append((filename, res.content))
    return out


def _existing_claim_from_dict(c: dict[str, Any]) -> ExistingClaim:
    return ExistingClaim(
        claim_id=c["claim_id"],
        owner_uuid=c["owner_uuid"],
        owner_name=c["owner_name"],
        mask_ref=c["mask_ref"],
        bbox=WorldBBox.from_dict(c["bbox"]),
        kind=c.get("kind", "confirmed"),
        ref_type=c.get("ref_type"),
        ref_id=c.get("ref_id"),
    )


def process_kaihatsu_set_job(payload: dict[str, Any], *, masks_dir: str) -> dict[str, Any]:
    """job_queue の kind="image_process", subkind="kaihatsu_set" ジョブ本体。
    戻り値は Workers へそのまま /ct/jobs/complete の result として返す。
    """
    requester_mc_name = payload["requester_mc_name"]
    attachments = download_attachments([(a["filename"], a["url"]) for a in payload["attachments"]])
    existing_claims = [_existing_claim_from_dict(c) for c in payload.get("existing_claims", [])]
    protected_areas = [
        ProtectedArea(
            area_id=a["id"],
            name=a["name"],
            mask_ref=a["mask_ref"],
            bbox=WorldBBox.from_dict(a["bbox"]),
        )
        for a in payload.get("protected_areas", [])
    ]
    prev_raw = payload.get("previous_own_claim")
    previous_own_claim = _existing_claim_from_dict(prev_raw) if prev_raw else None

    result = evaluate_kaihatsu_set(
        requester_mc_name=requester_mc_name,
        attachments=attachments,
        existing_claims=existing_claims,
        protected_areas=protected_areas,
        previous_own_claim=previous_own_claim,
    )

    if result["outcome"] == "approved":
        os.makedirs(masks_dir, exist_ok=True)
        application_id = payload["application_id"]
        mask_path = os.path.join(masks_dir, f"application_{application_id}.png")
        with open(mask_path, "wb") as f:
            f.write(result.pop("output_image_bytes"))
        result["mask_saved_path"] = mask_path

    return result


def process_kaihatsu_set_batch_job(payload: dict[str, Any], *, masks_dir: str) -> dict[str, Any]:
    """job_queue の kind="image_process", subkind="kaihatsu_set_batch"／"kaihatsu_group" ジョブ本体
    （代表者による一括申請・§5.7.3、同時処理グループのset側・§5.7.4）。

    payload["players"] は Workers 側が account_links 照合済みの参加者一覧：
      [{"player_name":..., "application_id":..., "attachments":[{filename,url}],
        "previous_own_claim": ExistingClaim辞書 | null}, ...]
    削除専用メンバー（グループのdelete）はここでは扱わない（Workers側で即時に領域を確定するのみで
    画像評価は不要なため。§5.7.4の評価順序＝delete→setはWorkers側がジョブ投入順で担保する）。
    """
    all_attachments: list[tuple[str, bytes]] = []
    resolved_owners: dict[str, ExistingClaim | None] = {}
    application_id_by_name: dict[str, int] = {}

    for player in payload["players"]:
        name = player["player_name"]
        application_id_by_name[name.lower()] = player["application_id"]
        prev_raw = player.get("previous_own_claim")
        resolved_owners[name.lower()] = _existing_claim_from_dict(prev_raw) if prev_raw else None
        urls = [(a["filename"], a["url"]) for a in player["attachments"]]
        all_attachments.extend(download_attachments(urls))

    existing_claims = [_existing_claim_from_dict(c) for c in payload.get("existing_claims", [])]
    protected_areas = [
        ProtectedArea(area_id=a["id"], name=a["name"], mask_ref=a["mask_ref"], bbox=WorldBBox.from_dict(a["bbox"]))
        for a in payload.get("protected_areas", [])
    ]

    batch_result = evaluate_kaihatsu_set_batch(
        attachments=all_attachments,
        resolved_owners=resolved_owners,
        existing_claims=existing_claims,
        protected_areas=protected_areas,
    )

    os.makedirs(masks_dir, exist_ok=True)
    players_out: dict[str, Any] = {}
    for display_name, result in batch_result["players"].items():
        application_id = application_id_by_name.get(display_name.lower())
        if result["outcome"] == "approved":
            mask_path = os.path.join(masks_dir, f"application_{application_id}.png")
            with open(mask_path, "wb") as f:
                f.write(result.pop("output_image_bytes"))
            result["mask_saved_path"] = mask_path
        result["application_id"] = application_id
        players_out[display_name] = result

    return {
        "players": players_out,
        "unresolved_players": batch_result["unresolved_players"],
        "skipped_files": batch_result["skipped_files"],
    }
