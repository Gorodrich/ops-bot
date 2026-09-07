"""Mojang API 連携（ユーザー名の実在確認・UUID解決・§3.4.5）。

経緯：Cloudflare Workers（データセンター系IP）からの直接呼び出しは
api.mojang.com に 403 で拒否されることが実地確認で判明したため、
CT102からのアウトバウンド呼び出しに変更した（Workers→CT102はジョブキュー経由のプル方式）。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

log = logging.getLogger("opsbot_ct.mojang")

_LOOKUP_URL = "https://api.mojang.com/users/profiles/minecraft/"


class MojangError(RuntimeError):
    pass


@dataclass
class MojangProfile:
    uuid: str  # ハイフン無し32桁
    name: str


def resolve_profile(username: str, *, client: httpx.Client | None = None) -> MojangProfile | None:
    """Minecraftユーザー名からUUIDを解決する。実在しない場合は None を返す。"""
    owns_client = client is None
    c = client or httpx.Client(timeout=30.0)
    try:
        res = c.get(_LOOKUP_URL + username, headers={"accept": "application/json"})
        if res.status_code in (204, 404):
            return None
        if res.status_code >= 400:
            raise MojangError(f"Mojang API エラー: status={res.status_code} body={res.text[:300]}")
        body = res.json()
        uuid, name = body.get("id"), body.get("name")
        if not uuid or not name:
            return None
        return MojangProfile(uuid=uuid, name=name)
    finally:
        if owns_client:
            c.close()
