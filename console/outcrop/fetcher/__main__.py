"""python -m outcrop.fetcher --socket /run/outcrop-fetch/fetch.sock  - the page fetcher service (see fetch.py).

GET /health -> {ok, isolated, checked, own}.  POST /fetch {"url"} -> what fetch.fetch returns.  At start it checks that it
is isolated from your network: connections to this server (127.0.0.1:22, 127.0.0.1:443, [::1]:443) and to the LAN's
gateway must be dropped by the kernel.  While one gets through, every fetch is refused (unless --allow-unisolated, for
development only), and the check runs again at most once a minute, on the next fetch.

The home's public IPv4 is looked up once at start and every 6 hours, best effort, through an "IP echo" service
(OUTCROP_FETCH_WAN_ECHO, default https://api.ipify.org; empty turns it off).  That service sees the home's IP, as every page
opened does.  The fetcher then refuses that address too: a router often answers its admin page there, and port forwards
hairpin back to this server.  Only the host of each link opened is logged, not the link.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import errno
import ipaddress
import socket
import stat
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

import anyio
import uvicorn

from . import fetch as F
from .fetch import fetch

log = logging.getLogger("outcrop.fetcher")
STATE = {"isolated": None, "checked": [], "allow_unisolated": False, "checked_at": 0.0}
RECHECK_S = 60.0
WAN_EVERY_S = 6 * 3600
DEFAULT_ECHO = "https://api.ipify.org"


def default_gateway() -> str | None:
    """The LAN's gateway: from OUTCROP_FETCH_PROBE (the installer sets it, since the sandbox hides /proc/net), else the
    routing table."""
    probe = os.environ.get("OUTCROP_FETCH_PROBE", "").strip()
    if probe:
        return probe
    try:
        for line in Path("/proc/net/route").read_text().splitlines()[1:]:
            f = line.split()
            if f[1] == "00000000" and f[2] != "00000000":
                g = int(f[2], 16)
                return socket.inet_ntoa(g.to_bytes(4, "little"))
    except OSError:
        pass
    return None


def isolation_check() -> dict:
    """True when the kernel stops connections to this server and to the LAN, so a bug here cannot reach them.

    systemd's IPAddressDeny drops the packets: a connection to a port that is listening (sshd on 22, the console on
    443) then times out instead of connecting at once, and one to the LAN gets no answer at all.  A connection that
    is made, or refused (a reset came back), means the rule is missing."""
    targets = [("127.0.0.1", 22), ("127.0.0.1", 443), ("::1", 443)]
    gw = default_gateway()
    if gw:
        targets.append((gw, 80))
    res = []
    for host, port in targets:
        v6 = ":" in host
        name = f"[{host}]:{port}" if v6 else f"{host}:{port}"
        try:
            s = socket.socket(socket.AF_INET6 if v6 else socket.AF_INET, socket.SOCK_STREAM)
        except OSError:                                      # no IPv6 on this machine: nothing to reach there
            res.append({"target": name, "blocked": True, "why": "no IPv6"})
            continue
        s.settimeout(1.5)
        try:
            s.connect((host, port))
            res.append({"target": name, "blocked": False, "why": "connected"})
        except PermissionError:
            res.append({"target": name, "blocked": True, "why": "refused by the kernel"})
        except TimeoutError:
            res.append({"target": name, "blocked": True, "why": "dropped (no answer)"})
        except OSError as e:
            if v6 and e.errno in (errno.EADDRNOTAVAIL, errno.EAFNOSUPPORT, errno.ENETUNREACH):
                res.append({"target": name, "blocked": True, "why": "no IPv6"})
            else:                                            # a reset (rule missing), or no route yet: not proven
                res.append({"target": name, "blocked": False, "why": type(e).__name__})
        finally:
            s.close()
    return {"isolated": all(r["blocked"] for r in res), "checked": res, "checked_at": time.time()}


async def ensure_isolated() -> bool:
    """While not isolated, check again (at most once a minute): a network that was not up at boot, a rule added later."""
    if not STATE["isolated"] and time.time() - STATE["checked_at"] >= RECHECK_S:
        STATE["checked_at"] = time.time()
        STATE.update(await anyio.to_thread.run_sync(isolation_check))
        if STATE["isolated"]:
            log.info("isolated from the network now: %s", ", ".join(r["target"] for r in STATE["checked"]))
    return bool(STATE["isolated"])


def wan_lookup(echo: str) -> str | None:
    """The home's public IPv4, through an IP echo service (best effort)."""
    try:
        got = anyio.run(_wan, echo)
    except Exception:                                        # noqa: BLE001
        return None
    return got


async def _wan(echo: str) -> str | None:
    with anyio.fail_after(10):
        r = await F.download(echo, max_bytes=200)
    if not r.get("ok"):
        return None
    try:
        return str(ipaddress.IPv4Address(r["data"].decode("ascii", "replace").strip()))
    except ValueError:
        return None


def wan_loop(echo: str) -> None:
    while True:
        if STATE["isolated"]:
            ip = wan_lookup(echo)
            if ip:
                F.set_wan([ip])
                log.info("this home's public address is refused too (looked up through %s)", urlsplit(echo).hostname)
            else:
                log.warning("could not look up this home's public address through %s", urlsplit(echo).hostname)
            time.sleep(WAN_EVERY_S if ip else 600)
        else:
            time.sleep(60)


def host_of(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "?")[:100]
    except ValueError:
        return "?"


async def app(scope, receive, send):
    if scope["type"] != "http":
        return
    path, method = scope["path"], scope["method"]

    async def reply(code: int, obj: dict):
        b = json.dumps(obj).encode()
        await send({"type": "http.response.start", "status": code,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(b)).encode())]})
        await send({"type": "http.response.body", "body": b})

    if path == "/health" and method == "GET":
        await ensure_isolated()
        return await reply(200, {"ok": True, "isolated": STATE["isolated"], "checked": STATE["checked"],
                                 "own": {"addresses": len(F.own_addresses()), "how": F.OWN["how"],
                                         "wan_known": bool(F.OWN["wan"])}})
    if path == "/fetch" and method == "POST":
        body = b""
        while True:
            m = await receive()
            body += m.get("body", b"")
            if len(body) > 16384:
                return await reply(413, {"ok": False, "error": "too large"})
            if not m.get("more_body"):
                break
        try:
            url = str(json.loads(body or b"{}").get("url") or "")
        except (ValueError, AttributeError):
            return await reply(400, {"ok": False, "error": "send {\"url\": ...}"})
        if not await ensure_isolated() and not STATE["allow_unisolated"]:
            return await reply(200, {"ok": False, "error": "the page fetcher is not isolated from your network, so it "
                                                           "opens nothing (see outcrop-fetch.service)"})
        try:
            out = await fetch(url)
        except Exception as e:                               # noqa: BLE001 - an answer, never a 500
            log.exception("fetch")
            out = {"ok": False, "error": f"the page could not be opened ({type(e).__name__})"}
        log.info("fetch %s -> %s", host_of(url), "ok" if out.get("ok") else out.get("error"))
        return await reply(200, out)
    return await reply(404, {"ok": False, "error": "not found"})


def unix_socket(path: Path) -> socket.socket:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and stat.S_ISSOCK(path.stat().st_mode):
        path.unlink()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(str(path))
    os.chmod(path, 0o660)
    s.listen(64)
    return s


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--socket", default="/run/outcrop-fetch/fetch.sock")
    ap.add_argument("--allow-unisolated", action="store_true", help="development: fetch even without the kernel's rule")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    STATE["allow_unisolated"] = a.allow_unisolated
    STATE.update(isolation_check())
    if STATE["isolated"]:
        log.info("isolated from the network: %s", ", ".join(r["target"] for r in STATE["checked"]))
    else:
        log.warning("NOT isolated from the network (%s): %s", "; ".join(f"{r['target']} {r['why']}" for r in STATE["checked"]),
                    "fetching anyway (development)" if a.allow_unisolated else "every fetch will be refused")
    echo = os.environ.get("OUTCROP_FETCH_WAN_ECHO", DEFAULT_ECHO).strip()
    if echo:
        threading.Thread(target=wan_loop, args=(echo,), daemon=True, name="wan").start()
    sock = unix_socket(Path(a.socket))
    cfg = uvicorn.Config(app, http="h11", lifespan="off", log_level="warning", access_log=False, server_header=False)
    asyncio.run(uvicorn.Server(cfg).serve(sockets=[sock]))


if __name__ == "__main__":
    main()
