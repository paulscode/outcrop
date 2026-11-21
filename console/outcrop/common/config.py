"""Paths and network settings shared by the gateway, the console and the CLI.  Standard library only.

Everything secret lives in the state directory ($OUTCROP_HOME/state, 0700), never in the repo:

  outcrop.db     SQLite: tokens (as HMACs), settings, request log, audit log, ...
  pepper         the HMAC key for API tokens (0600)
  upstream_key   the internal key Strata and the Ollama bridge require; only the gateway and the console send it (0600)
  local_token    the `local-tools` API token used by outcrop and bench/ on this machine (0600)
  tls/           the private CA and the console's certificate (0600 keys)
"""
from __future__ import annotations

import json
import os
import secrets
import socket
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

PROJECT = Path(os.environ.get("OUTCROP_PROJECT") or Path(__file__).resolve().parents[3])
OUTCROP_HOME = Path(os.environ.get("OUTCROP_HOME") or Path.home() / ".outcrop")
STATE = Path(os.environ.get("OUTCROP_STATE") or OUTCROP_HOME / "state")
RUN_DIR = Path(os.environ.get("OUTCROP_RUN") or "/run/outcrop")
PRESETS_FILE = Path(os.environ.get("OUTCROP_PRESETS") or OUTCROP_HOME / "presets.json")
# benchmark output (bench/*.py), imported by the Lab and read for measured speeds
BENCH_RESULTS = Path(os.environ.get("OUTCROP_BENCH_RESULTS") or PROJECT / "bench" / "results")

DB_PATH = STATE / "outcrop.db"
PEPPER_FILE = STATE / "pepper"
UPSTREAM_KEY_FILE = STATE / "upstream_key"
LOCAL_TOKEN_FILE = STATE / "local_token"
BYPASS_FILE = STATE / "bypass.json"
TLS_DIR = STATE / "tls"
GATEWAY_SOCK = RUN_DIR / "gateway.sock"

VERSION = "0.1.0"


def ensure_state_dir() -> Path:
    STATE.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(STATE, 0o700)
    except OSError:
        pass
    return STATE


def write_secret(path: Path, data: bytes | str) -> None:
    """Write a file only its owner can read, atomically."""
    ensure_state_dir()
    if isinstance(data, str):
        data = data.encode()
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def read_secret(path: Path) -> str | None:
    try:
        v = path.read_text(encoding="utf-8").strip()
        return v or None
    except OSError:
        return None


def upstream_key(create: bool = False) -> str | None:
    """The internal key Strata requires.  Created on first use when `create`."""
    k = read_secret(UPSTREAM_KEY_FILE)
    if k is None and create:
        k = "strata-internal-" + secrets.token_urlsafe(32)
        write_secret(UPSTREAM_KEY_FILE, k + "\n")
    return k


def load_presets() -> dict:
    with open(PRESETS_FILE, encoding="utf-8") as f:
        return json.load(f)


@dataclass
class Net:
    """Where everything listens.  From presets.json's `server` (Strata itself) and `gateway` sections."""
    strata_host: str = "127.0.0.1"
    strata_port: int = 18080
    gateway_enabled: bool = True
    listen: str = "0.0.0.0"
    openai_port: int = 8080
    ollama_port: int = 11434
    bridge_port: int = 11435
    hold_max_s: float = 120.0
    body_max_mib: int = 64
    body_budget_mib: int = 512             # all request bodies in the gateway's memory at once; beyond it: 503
    open_rpm: int = 120                    # requests a minute per address without a token (open mode, token-less)
    max_held: int = 256                    # requests waiting at once during a switch; beyond it: 503
    extra_hosts: list[str] = field(default_factory=list)
    model_id: str = "qwen3.8-flash-next"
    console_port: int = 443
    console_http_port: int = 80
    https_port: int = 0                    # the OpenAI/Anthropic API on HTTPS too (the console's certificate); 0: off
    # The OpenAI/Anthropic API on plain HTTP behind a reverse proxy that terminates TLS (StartOS's); 0: off.  Only on this
    # port, and only from these exact addresses, is X-Forwarded-For believed (gateway/app.py client_ip).
    proxied_port: int = 0
    trusted_proxies: list[str] = field(default_factory=list)
    # The console on plain HTTP behind that same proxy (presets.json console.proxied_port): no certificate of its own and
    # no port 80; 0: off (HTTPS on console_port with the private CA, as on Ubuntu).
    console_proxied_port: int = 0

    @property
    def strata_url(self) -> str:
        return f"http://{self.strata_host}:{self.strata_port}"

    @property
    def bridge_url(self) -> str:
        return f"http://127.0.0.1:{self.bridge_port}"


def net(cfg: dict | None = None) -> Net:
    cfg = cfg if cfg is not None else load_presets()
    s = cfg.get("server", {})
    g = cfg.get("gateway", {})
    c = cfg.get("console", {})
    return Net(
        strata_host=str(s.get("host", "127.0.0.1")),
        strata_port=int(s.get("port", 18080)),
        gateway_enabled=bool(g.get("enabled", False)),
        listen=str(g.get("listen", "0.0.0.0")),
        openai_port=int(g.get("port", 8080)),
        ollama_port=int(g.get("ollama_port", 11434)),
        bridge_port=int(g.get("bridge_port", 11435)),
        hold_max_s=float(g.get("hold_max_s", 120)),
        body_max_mib=int(g.get("body_max_mib", 64)),
        body_budget_mib=int(g.get("body_budget_mib", 512)),
        open_rpm=int(g.get("open_rpm", 120)),
        max_held=int(g.get("max_held", 256)),
        extra_hosts=list(g.get("hosts", [])),
        model_id=str(s.get("model_id", "qwen3.8-flash-next")),
        https_port=int(g.get("https_port", 0) or 0),
        proxied_port=int(g.get("proxied_port", 0) or 0),
        trusted_proxies=[str(x) for x in g.get("trusted_proxies", [])],
        console_port=int(c.get("port", 443)),
        console_http_port=int(c.get("http_port", 80)),
        console_proxied_port=int(c.get("proxied_port", 0) or 0),
    )


VIRTUAL_IF = ("docker", "br-", "veth", "virbr", "lxc", "cni", "flannel", "tailscale", "zt", "wg")


def lan_addresses() -> list[str]:
    """This machine's LAN addresses: no loopback, link-local, or container and VPN interfaces (Docker's bridges, the
    SearXNG network ...).  From `ip`, by interface name; `hostname -I` (no names) only when that fails."""
    out: list[str] = []
    try:
        r = subprocess.run(["ip", "-o", "addr", "show", "scope", "global"], capture_output=True, text=True, timeout=3)
        if r.returncode == 0 and r.stdout.strip():
            for line in r.stdout.splitlines():
                f = line.split()
                if len(f) >= 4 and f[2] in ("inet", "inet6") and not f[1].startswith(VIRTUAL_IF):
                    out.append(f[3].split("/")[0])
            return out
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        r = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=3)
        for a in r.stdout.split():
            if a.startswith(("127.", "172.17.", "172.18.", "172.30.53.", "fe80")) or a == "::1":
                continue
            out.append(a)
    except (OSError, subprocess.SubprocessError):
        pass
    return out


def own_host_names(extra: list[str] | None = None, lan: list[str] | None = None) -> set[str]:
    """The names a browser may use for this server: what the gateway accepts in `Host` while the API is open.  `lan`:
    the LAN addresses when the caller already has them (lan_addresses() runs a program)."""
    h = socket.gethostname().lower()
    names = {"localhost", "127.0.0.1", "::1", h, f"{h}.local"}
    names.update(a.lower() for a in (lan_addresses() if lan is None else lan))
    names.update(x.lower() for x in (extra or []))
    return names
