"""DynmapSSHClientの単体テスト（open-items #41・decisions.md #53のSSH切り替え）。

subprocess.runをモンキーパッチし、実際のsshは呼ばない。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from opsbot_ct.config import Config
from opsbot_ct.dynmap_ssh import DynmapSSHClient, DynmapSSHError

CFG = Config(
    workers_base_url="https://example.workers.dev",
    ct_shared_secret="secret",
    dynmap_ssh_host="192.168.100.3",
    dynmap_ssh_user="opsbot-dynmap",
    dynmap_ssh_identity_file="/etc/opsbot/dynmap_ssh_id_ed25519",
    dynmap_ssh_known_hosts_file="/etc/opsbot/dynmap_known_hosts",
)


def _fake_run(returncode: int, stdout: bytes = b"", stderr: bytes = b""):
    def run(cmd, input=None, capture_output=None, timeout=None, check=None):
        run.last_cmd = cmd
        run.last_input = input
        return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)

    return run


def test_read_regions_js_returns_content(monkeypatch):
    fake = _fake_run(0, stdout=b"var regions = [];")
    monkeypatch.setattr("opsbot_ct.dynmap_ssh.subprocess.run", fake)

    client = DynmapSSHClient(CFG)
    assert client.read_regions_js() == "var regions = [];"
    assert fake.last_cmd[-1] == "read-regions"


def test_read_regions_js_returns_none_when_missing(monkeypatch):
    fake = _fake_run(3, stderr=b"not found")
    monkeypatch.setattr("opsbot_ct.dynmap_ssh.subprocess.run", fake)

    client = DynmapSSHClient(CFG)
    assert client.read_regions_js() is None


def test_read_regions_js_raises_on_other_failure(monkeypatch):
    fake = _fake_run(1, stderr=b"boom")
    monkeypatch.setattr("opsbot_ct.dynmap_ssh.subprocess.run", fake)

    client = DynmapSSHClient(CFG)
    with pytest.raises(DynmapSSHError):
        client.read_regions_js()


def test_write_tile_sends_bytes_on_stdin_with_validated_name_and_coords(monkeypatch):
    fake = _fake_run(0)
    monkeypatch.setattr("opsbot_ct.dynmap_ssh.subprocess.run", fake)

    client = DynmapSSHClient(CFG)
    client.write_tile("Alice_1", 2, 3, b"\x89PNG...")
    assert fake.last_cmd[-1] == "write-tile Alice_1 2 3"
    assert fake.last_input == b"\x89PNG..."


def test_write_tile_rejects_unsafe_name(monkeypatch):
    fake = _fake_run(0)
    monkeypatch.setattr("opsbot_ct.dynmap_ssh.subprocess.run", fake)

    client = DynmapSSHClient(CFG)
    with pytest.raises(DynmapSSHError):
        client.write_tile("../../etc/passwd", 0, 0, b"x")
    assert not hasattr(fake, "last_cmd")


def test_write_tile_rejects_negative_coords(monkeypatch):
    fake = _fake_run(0)
    monkeypatch.setattr("opsbot_ct.dynmap_ssh.subprocess.run", fake)

    client = DynmapSSHClient(CFG)
    with pytest.raises(DynmapSSHError):
        client.write_tile("Alice_1", -1, 0, b"x")
    assert not hasattr(fake, "last_cmd")


def test_write_preview_sends_bytes_on_stdin_with_validated_name(monkeypatch):
    fake = _fake_run(0)
    monkeypatch.setattr("opsbot_ct.dynmap_ssh.subprocess.run", fake)

    client = DynmapSSHClient(CFG)
    client.write_preview("Alice_1", b"\x89PNG...")
    assert fake.last_cmd[-1] == "write-preview Alice_1"
    assert fake.last_input == b"\x89PNG..."


def test_write_preview_rejects_unsafe_name(monkeypatch):
    fake = _fake_run(0)
    monkeypatch.setattr("opsbot_ct.dynmap_ssh.subprocess.run", fake)

    client = DynmapSSHClient(CFG)
    with pytest.raises(DynmapSSHError):
        client.write_preview("../../etc/passwd", b"x")
    assert not hasattr(fake, "last_cmd")


def test_write_regions_js_sends_utf8_bytes(monkeypatch):
    fake = _fake_run(0)
    monkeypatch.setattr("opsbot_ct.dynmap_ssh.subprocess.run", fake)

    client = DynmapSSHClient(CFG)
    client.write_regions_js("var regions = [];")
    assert fake.last_cmd[-1] == "write-regions"
    assert fake.last_input == b"var regions = [];"
