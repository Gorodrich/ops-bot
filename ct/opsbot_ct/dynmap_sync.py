"""Dynmap配信ディレクトリへの自動反映ジョブ本体（job_queue kind="dynmap_sync"・§6.3.4）。

正式承認の確定時（§5.7.2の24時間撤回猶予経過後、または§5.7.3/§5.7.4の本人確認完了時）に
Workers側がこのジョブを積む。CT102はCT104への制限付きSSH経由（dynmap_ssh.py）で
Dynmap配信ディレクトリへ画像配置・regions配列更新を行う（open-items #41の決定・
decisions.md #53・phase-3-checklist.md C-5：Crafty File Manager API経由は非公開エンドポイント
依存とTLS検証無効化の問題があったためSSH方式に切り替え済み）。

反映失敗時は例外を送出せず (False, message) を返し、呼び出し側（poller.py）が
job_queue の失敗として扱う。再試行上限超過時の運営へのタスク起票はWorkers側
（jobs/completion.ts）が既存の再試行上限ロジックと同様に行う。
"""

from __future__ import annotations

import logging
import os

from .config import Config
from .dynmap_regions import remove_region_from_js, upsert_region_in_js
from .dynmap_ssh import DynmapSSHClient, DynmapSSHError

log = logging.getLogger("opsbot_ct.dynmap_sync")


def sync_upsert(cfg: Config, client: DynmapSSHClient, *, mc_name: str, mask_local_path: str, loc1: dict, loc2: dict) -> None:
    with open(mask_local_path, "rb") as f:
        image_bytes = f.read()
    client.write_image(mc_name, image_bytes)

    current = client.read_regions_js()
    if current is None:
        raise DynmapSSHError("regionsファイルがCT104側に存在しません（配置スクリプトの初期セットアップを確認）")
    updated = upsert_region_in_js(
        current,
        name=mc_name,
        image_rel_path=f"{cfg.dynmap_images_subdir.strip('/')}/{mc_name}.png",
        loc1=loc1,
        loc2=loc2,
    )
    client.write_regions_js(updated)


def sync_remove(cfg: Config, client: DynmapSSHClient, *, mc_name: str) -> None:
    """regions配列からエントリを取り除く。画像ファイル自体の削除は行わない
    （誤削除時に確認画像が失われないための設計判断・open-items #38）。
    """
    current = client.read_regions_js()
    if current is None:
        raise DynmapSSHError("regionsファイルがCT104側に存在しません（配置スクリプトの初期セットアップを確認）")
    updated = remove_region_from_js(current, name=mc_name)
    client.write_regions_js(updated)


def process_dynmap_sync_job(payload: dict, *, cfg: Config) -> dict:
    if not cfg.dynmap_sync_enabled:
        return {"skipped": True, "reason": "dynmap_sync_enabled=false（CT104側SSHセットアップ確認待ち）"}

    client = DynmapSSHClient(cfg)
    op = payload.get("op")
    mc_name = payload["mc_name"]
    if op == "upsert":
        mask_local_path = payload["mask_local_path"]
        if not os.path.exists(mask_local_path):
            raise DynmapSSHError(f"マスク画像がCT102ローカルに存在しません: {mask_local_path}")
        sync_upsert(cfg, client, mc_name=mc_name, mask_local_path=mask_local_path, loc1=payload["loc1"], loc2=payload["loc2"])
        return {"op": "upsert", "mc_name": mc_name}
    if op == "remove":
        sync_remove(cfg, client, mc_name=mc_name)
        return {"op": "remove", "mc_name": mc_name}
    raise DynmapSSHError(f"未知のop: {op}")
