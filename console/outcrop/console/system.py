"""The System page: versions, hardware, services and ports; the security posture card; metrics history."""
from __future__ import annotations

import json
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path

from ..common import config, db
from . import tls

_cache: dict = {}


def _out(cmd, timeout=5) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def _cached(key: str, ttl: float, fn):
    v = _cache.get(key)
    if v and time.time() - v[0] < ttl:
        return v[1]
    r = fn()
    _cache[key] = (time.time(), r)
    return r


def system_info(ctx, live) -> dict:
    def static():
        strata = config.OUTCROP_HOME / "src" / "Strata"
        commit = _out(["git", "-C", str(strata), "log", "-1", "--format=%h %s"])
        patches = sorted(p.name for p in (config.PROJECT / "patches").glob("*.patch"))
        engines = sorted(p.name for p in (config.OUTCROP_HOME / "bin").glob("strata*")) if (config.OUTCROP_HOME / "bin").exists() else []
        models = []
        mdir = config.OUTCROP_HOME / "models"
        if mdir.exists():
            for f in sorted(mdir.rglob("*.gguf")):
                models.append({"path": str(f.relative_to(mdir)), "gib": round(f.stat().st_size / (1 << 30), 1)})
        cuda = _out(["/usr/local/cuda-12.9/bin/nvcc", "--version"])
        m = re.search(r"release ([\d.]+)", cuda)
        return {"hostname": socket.gethostname(), "os": _out(["lsb_release", "-ds"]) or _out(["uname", "-o"]),
                "kernel": _out(["uname", "-r"]), "cpu": (live.engine.get("hardware_static") or {}).get("cpu_name"),
                "cores": (live.engine.get("hardware_static") or {}).get("cores"),
                "threads": (live.engine.get("hardware_static") or {}).get("threads"),
                "numa_nodes": len(live.numa), "gpu": live.gpu_static, "cuda": m.group(1) if m else None,
                "strata_commit": commit, "patches": patches, "engines": engines, "models": models,
                "python": _out(["python3", "--version"]), "console_version": config.VERSION}
    info = dict(_cached("static", 600, static))
    du = shutil.disk_usage(str(config.OUTCROP_HOME if config.OUTCROP_HOME.exists() else Path.home()))
    info["disk"] = {"total_gb": round(du.total / 1e9), "free_gb": round(du.free / 1e9), "used_pct": round(100 * du.used / du.total, 1)}
    info["units"] = live.units
    info["engine"] = (live.engine or {}).get("engine")
    info["ports"] = _cached("ports", 30, listening_ports)
    info["uptime_s"] = round(time.time() - _boot_time())
    return info


def _boot_time() -> float:
    try:
        return time.time() - float(Path("/proc/uptime").read_text().split()[0])
    except OSError:
        return time.time()


def listening_ports() -> list[dict]:
    out = []
    for ln in _out(["ss", "-Htln"]).splitlines():
        f = ln.split()
        if len(f) >= 4:
            addr = f[3]
            host, _, port = addr.rpartition(":")
            out.append({"address": host.strip("[]"), "port": int(port) if port.isdigit() else port,
                        "lan": host.strip("[]") in ("0.0.0.0", "*", "::") or not host.startswith(("127.", "[::1]", "::1"))})
    return sorted(out, key=lambda x: (str(x["port"]), x["address"]))


def posture(ctx, live) -> list[dict]:
    """The checks that matter here, each with a plain fix."""
    def compute():
        con = ctx.con()
        checks = []

        def add(key, ok, title, detail, fix=None, level="warn"):
            checks.append({"key": key, "ok": bool(ok), "title": title, "detail": detail, "fix": fix,
                           "level": "ok" if ok else level})

        mode = db.get_setting(con, "auth.mode")
        open_now = mode.get("mode") == "open" and float(mode.get("until") or 0) > time.time()
        add("api", not open_now, "The API requires tokens",
            "enforced" if not open_now else f"open until {time.strftime('%H:%M', time.localtime(mode['until']))}",
            "Access: close the API", level="warn")
        ports = listening_ports()
        lan18080 = any(p["port"] == 18080 and p["lan"] for p in ports)
        add("loopback", not lan18080, "Strata listens on loopback only",
            "127.0.0.1:18080" if not lan18080 else "port 18080 is open to the LAN", "presets.json server.host = 127.0.0.1",
            level="error")
        gw = (live.units or {}).get("outcrop-gateway.service") or {}
        add("gateway", gw.get("active") == "active", "The gateway is running", gw.get("active") or "unknown",
            "outcrop gateway status", level="error")
        enabled = "ENABLED=yes" in _safe_read(Path("/etc/ufw/ufw.conf"))     # world-readable; the rules are root-only
        marker = _safe_read(Path("/etc/outcrop-harden/firewall")).strip()
        add("firewall", enabled and bool(marker), "The firewall allows only the LAN",
            ("ufw on; " + marker.split(" ", 1)[1]) if enabled and marker else "ufw is on, but not with setup/harden.sh's "
            "LAN rules" if enabled else "ufw is off", "setup/harden.sh firewall")
        rdp = _out(["systemctl", "is-active", "gnome-remote-desktop.service"])
        add("rdp", rdp != "active", "Remote desktop (RDP) is off", "off" if rdp != "active" else "port 3389 is listening",
            "setup/harden.sh headless")
        sshd = _safe_read(Path("/etc/ssh/sshd_config.d/01-outcrop-keys-only.conf"))
        add("ssh", "PasswordAuthentication no" in sshd, "SSH accepts keys only",
            "password logins refused" if "PasswordAuthentication no" in sshd else "passwords are accepted",
            "setup/harden.sh ssh")
        add("https", tls.status().get("ca", False), "The console uses HTTPS", "private CA, name-constrained"
            if tls.status().get("ca") else "no certificate yet", "setup/install-console.sh")
        now = time.time()
        toks = con.execute("SELECT name, scopes, expires_at, last_used_at, created_at FROM tokens WHERE revoked_at IS NULL "
                           "AND kind='user'").fetchall()
        no_exp = [t["name"] for t in toks if not t["expires_at"]]
        stale = [t["name"] for t in toks if (t["last_used_at"] or t["created_at"]) < now - 30 * 86400]
        admins = [t["name"] for t in toks if "admin" in (t["scopes"] or "")]
        add("expiry", not no_exp, "Every token expires", f"no expiry: {', '.join(no_exp)}" if no_exp else "all expire",
            "Access: set an expiry", level="info")
        add("stale", not stale, "No unused tokens", f"unused for 30 days: {', '.join(stale)}" if stale else "all in use",
            "Access: revoke them", level="info")
        add("admin", not admins, "No admin tokens lying around", f"admin: {', '.join(admins)}" if admins else "none",
            "Access: revoke or narrow them", level="info")
        tl = db.get_setting(con, "ollama.tokenless")
        add("tokenless", not tl.get("enabled"), "The token-less Ollama option is off",
            "off" if not tl.get("enabled") else f"on for {', '.join(tl.get('addresses') or [])}", "Access: turn it off")
        expected = {22, 80, 443, 5353, ctx.net.openai_port, ctx.net.ollama_port} | ({ctx.net.https_port} if ctx.net.https_port else set())
        docker = [p for p in ports if p["lan"] and p["port"] not in expected]
        add("ports", not docker, "Nothing else listens on the LAN",
            "only the expected ports" if not docker else "also: " + ", ".join(str(p["port"]) for p in docker[:6]),
            "check `ss -tlnp`", level="info")
        return checks
    return _cached("posture", 15, compute)


def _safe_read(p: Path) -> str:
    try:
        return p.read_text()
    except OSError:
        return ""


RANGES = {"15m": (900, None), "1h": (3600, None), "6h": (6 * 3600, "metrics_10s"), "24h": (86400, "metrics_1m"),
          "7d": (7 * 86400, "metrics_1m"), "30d": (30 * 86400, "metrics_1h"), "90d": (90 * 86400, "metrics_1h")}


def metrics_series(ctx, live, range_: str) -> dict:
    span, table = RANGES.get(range_, RANGES["1h"])
    now = time.time()
    if table is None:
        rows = [r for r in live.history if r["t"] >= now - span]
        step = max(1, len(rows) // 900)
        rows = rows[::step]
        flat = []
        for r in rows:
            d = {"t": r["t"]}
            for sect in ("gpu", "host", "engine"):
                for k, v in (r.get(sect) or {}).items():
                    if isinstance(v, (int, float)) and not isinstance(v, bool):
                        d[f"{sect}.{k}"] = v
            flat.append(d)
        return {"range": range_, "step_s": step, "points": flat}
    rows = ctx.con().execute(f"SELECT ts, data FROM {table} WHERE ts >= ? ORDER BY ts", (now - span,)).fetchall()
    step = max(1, len(rows) // 900)
    pts = [{"t": r["ts"], **json.loads(r["data"])} for r in rows[::step]]
    return {"range": range_, "step_s": step * {"metrics_10s": 10, "metrics_1m": 60, "metrics_1h": 3600}[table], "points": pts}
