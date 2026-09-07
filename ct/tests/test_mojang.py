"""mojang.py の単体テスト（httpx.MockTransport でネットワークI/Oをスタブ）。"""

from __future__ import annotations

import httpx
import pytest

from opsbot_ct.mojang import MojangError, resolve_profile


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_resolve_profile_found():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/TestPlayer01")
        return httpx.Response(200, json={"id": "0123456789abcdef0123456789abcdef", "name": "TestPlayer01"})

    with _client(handler) as client:
        profile = resolve_profile("TestPlayer01", client=client)
    assert profile is not None
    assert profile.uuid == "0123456789abcdef0123456789abcdef"
    assert profile.name == "TestPlayer01"


def test_resolve_profile_not_found_204():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(204)

    with _client(handler) as client:
        assert resolve_profile("nobody", client=client) is None


def test_resolve_profile_not_found_404():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"path": "/users/profiles/minecraft/nobody", "errorMessage": "Not Found"})

    with _client(handler) as client:
        assert resolve_profile("nobody", client=client) is None


def test_resolve_profile_error_status_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, text="Forbidden")

    with _client(handler) as client:
        with pytest.raises(MojangError):
            resolve_profile("TestPlayer01", client=client)
