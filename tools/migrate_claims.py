"""既存の個人開発領データ（カスタムオーバーレイJSの `regions` 配列＋ `images/indiv/*.png`）から、
OpsBotの `claims` テーブルへ移行するための一回限りのツール（decisions.md #34・#51／open-items #34）。

C-4（開発者の手作業を要する運用は設計しない）は「日次の確認・手動投入」等の恒常的な運用を
禁じる趣旨であり、稼働開始前の一回限りのデータ移行はこれに当たらない。

前提・制約：
  * 実データ（既存の regions 配列本体・open-items #18-a）は本ツール作成時点で未提供のため、
    本ツールは image-tool-spec.md §10.2 に文書化された既知のスニペット書式を入力として
    受け付ける形で実装している。実データが提供された時点でそのまま実行できる。
  * Mojang APIへの問い合わせはこのスクリプト自身のプロセスから行う（Cloudflare Workersの
    データセンターIPは403で拒否されるため・§3.4.5）。開発者の手元またはCT102など、
    通常のインターネット経路から実行すること。
  * 生成した mask 画像は `--masks-dir`（既定 ./migrated_masks、ローカルの一時保存先）に保存する。
    その後、この中身をCT102の `OPSBOT_MASKS_DIR` 配下（例: /var/lib/opsbot/masks）へ配置すること。
  * `claims.mask_ref` は、通常の `/kaihatsu set` 承認フロー（ct/opsbot_ct/image.py の
    process_kaihatsu_set_job → workers/src/jobs/completion.ts の maskRef）と同様、
    CT102上での**フルパス**（`OPSBOT_MASKS_DIR` と結合済み）をそのまま保存する。
    CT102側の `load_mask_alpha()` は mask_ref を相対パス解決せず直接 open() するため、
    ファイル名のみを保存すると承認済みclaimの重複判定（条件⑥）が壊れる。
    このフルパスは `--ct-masks-dir`（既定 /var/lib/opsbot/masks。CT102とローカルの
    `OPSBOT_MASKS_DIR` 設定が異なる場合は明示的に指定すること）で決定する。
  * 出力する `claims-seed.sql` は settings-seed.sql / staff-seed.sql と同じ運用：
    `wrangler d1 execute opsbot --remote --file=claims-seed.sql` で投入する。

使い方：
  python tools/migrate_claims.py --regions-js path/to/regions.js --images-dir path/to/images/indiv \
      --masks-dir ./migrated_masks --out claims-seed.sql

regions.js の書式（1エントリの例）：
  {
      name: "Test_Player1",
      imageUrl: 'images/indiv/Test_Player1.png',
      loc1: { x: -1700, y: 64, z: -5200 },
      loc2: { x: -400, y: 64, z: -4200 }
  },
"""

from __future__ import annotations

import argparse
import logging
import os
import posixpath
import re
import sys
import time
from dataclasses import dataclass

import numpy as np
from PIL import Image

log = logging.getLogger("migrate_claims")

_ENTRY_RE = re.compile(
    r"name:\s*['\"](?P<name>[^'\"]+)['\"]"
    r".*?imageUrl:\s*['\"](?P<image_url>[^'\"]+)['\"]"
    r".*?loc1:\s*\{\s*x:\s*(?P<x1>-?\d+)\s*,\s*y:\s*-?\d+\s*,\s*z:\s*(?P<z1>-?\d+)\s*\}"
    r".*?loc2:\s*\{\s*x:\s*(?P<x2>-?\d+)\s*,\s*y:\s*-?\d+\s*,\s*z:\s*(?P<z2>-?\d+)\s*\}",
    re.DOTALL,
)

MOJANG_UUID_API = "https://api.mojang.com/users/profiles/minecraft/{name}"


@dataclass
class RegionEntry:
    name: str
    image_url: str
    x1: int
    z1: int
    x2: int
    z2: int


def parse_regions_js(text: str) -> list[RegionEntry]:
    entries = []
    for m in _ENTRY_RE.finditer(text):
        entries.append(
            RegionEntry(
                name=m.group("name"),
                image_url=m.group("image_url"),
                x1=int(m.group("x1")),
                z1=int(m.group("z1")),
                x2=int(m.group("x2")),
                z2=int(m.group("z2")),
            )
        )
    return entries


def resolve_uuid(name: str) -> str | None:
    import httpx

    try:
        res = httpx.get(MOJANG_UUID_API.format(name=name), timeout=10.0)
    except httpx.HTTPError as e:
        log.warning("Mojang API 呼び出し失敗（%s）: %s", name, e)
        return None
    if res.status_code == 404:
        return None
    if res.status_code != 200:
        log.warning("Mojang API 異常応答（%s）: status=%s", name, res.status_code)
        return None
    data = res.json()
    raw = data.get("id")
    if not raw or len(raw) != 32:
        return None
    return f"{raw[0:8]}-{raw[8:12]}-{raw[12:16]}-{raw[16:20]}-{raw[20:32]}"


def sql_escape(s: str) -> str:
    return s.replace("'", "''")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--regions-js", required=True, help="既存のカスタムオーバーレイJS（regions配列を含むファイル）")
    parser.add_argument("--images-dir", required=True, help="images/indiv/ の実体があるローカルディレクトリ")
    parser.add_argument("--masks-dir", default="./migrated_masks", help="mask画像のローカル一時保存先（後でCT102へコピーする）")
    parser.add_argument(
        "--ct-masks-dir",
        default="/var/lib/opsbot/masks",
        help="CT102上でのmasks_dir（OPSBOT_MASKS_DIR）。claims.mask_refに書き込むフルパスの生成に使う",
    )
    parser.add_argument("--out", default="claims-seed.sql", help="出力するSQLファイル")
    parser.add_argument("--skip-mojang", action="store_true", help="Mojang解決をスキップしuuid列にプレイヤー名をそのまま入れる（開発・検証用）")
    args = parser.parse_args()

    with open(args.regions_js, encoding="utf-8") as f:
        text = f.read()
    entries = parse_regions_js(text)
    if not entries:
        log.error("regions配列のエントリを1件も検出できませんでした。書式を確認してください。")
        sys.exit(1)
    log.info("%d 件のエントリを検出しました。", len(entries))

    os.makedirs(args.masks_dir, exist_ok=True)
    sql_lines = [
        "-- tools/migrate_claims.py により生成（既存 regions 配列からの移行・decisions.md #51）",
        "-- 適用: wrangler d1 execute opsbot --remote --file=claims-seed.sql",
    ]
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    ok_count = 0
    skip_count = 0
    for entry in entries:
        image_path = os.path.join(args.images_dir, os.path.basename(entry.image_url))
        if not os.path.isfile(image_path):
            log.warning("[スキップ] %s: 画像ファイルが見つかりません（%s）", entry.name, image_path)
            skip_count += 1
            continue

        try:
            with Image.open(image_path) as img:
                alpha = np.array(img.convert("RGBA").getchannel("A"))
        except OSError as e:
            log.warning("[スキップ] %s: 画像を読み込めません（%s）", entry.name, e)
            skip_count += 1
            continue
        area = int(np.count_nonzero(alpha))

        if args.skip_mojang:
            uuid = f"unresolved-{entry.name}"
        else:
            uuid = resolve_uuid(entry.name)
            time.sleep(0.2)  # Mojang APIのレート制限に配慮
        if not uuid:
            log.warning("[スキップ] %s: MojangのUUID解決に失敗しました（プレイヤー名の変更・存在しないアカウント等）。"
                        " 手動で確認のうえ、必要であれば --skip-mojang で再実行してください。", entry.name)
            skip_count += 1
            continue

        mask_filename = f"migrated_{entry.name}.png"
        mask_dest = os.path.join(args.masks_dir, mask_filename)
        with Image.open(image_path) as img:
            img.convert("RGBA").save(mask_dest)

        # claims.mask_ref はCT102側でload_mask_alpha()がそのままopen()するフルパス
        # （通常の承認フローのmask_saved_pathと同じ扱い）。masks_dirとの結合はここで行う。
        mask_ref = posixpath.join(args.ct_masks_dir, mask_filename)

        loc1 = f'{{"x":{entry.x1},"y":64,"z":{entry.z1}}}'
        loc2 = f'{{"x":{entry.x2},"y":64,"z":{entry.z2}}}'
        sql_lines.append(
            "INSERT INTO claims (owner_uuid, owner_mc_name, status, mask_ref, area_blocks, bbox_loc1, bbox_loc2, application_id, created_at, updated_at) "
            f"VALUES ('{sql_escape(uuid)}', '{sql_escape(entry.name)}', 'active', '{sql_escape(mask_ref)}', {area}, "
            f"'{sql_escape(loc1)}', '{sql_escape(loc2)}', NULL, '{now}', '{now}');"
        )
        ok_count += 1

    with open(args.out, "w", encoding="utf-8") as f:
        f.write("\n".join(sql_lines) + "\n")

    log.info("完了: 成功 %d 件 / スキップ %d 件。出力: %s", ok_count, skip_count, args.out)
    log.info(
        "次の手順: 1) %s の中身をCT102の %s へコピー 2) %s をD1へ投入",
        args.masks_dir, args.ct_masks_dir, args.out,
    )


if __name__ == "__main__":
    main()
