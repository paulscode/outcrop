"""Preset control shared by outcrop and the console: units, the boot default, Strata and gateway access, and the switch.

Standard library only.  The units are run by systemd on Ubuntu and by Outcrop's supervisor in the StartOS container: every call
to them goes through lib/units.py, which picks the backend.

A switch is a small state machine, each step timed and recorded:
  plan (render, RAM, page cache, estimate) -> hold (the gateway queues new requests) -> drain or cancel what runs ->
  stop -> start -> phases (from the unit's journal) -> ready -> release (held requests go to the new preset)
"""
from __future__ import annotations

import http.client
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT / "lib"))
import profiles as PF  # noqa: E402
import strata_presets as SP  # noqa: E402
import units  # noqa: E402

UNIT = "outcrop-engine@{}.service"
BOOT_UNIT = "outcrop-boot.service"
GATEWAY_UNIT = "outcrop-gateway.service"
BRIDGE_UNIT = "outcrop-ollama-bridge.service"
STATE = SP.STATE
DEFAULT_FILE = STATE / "default_preset"
GATEWAY_SOCK = Path(os.environ.get("OUTCROP_RUN") or "/run/outcrop") / "gateway.sock"
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
DB_PATH = None          # the console sets its own database here; None: the default ($OUTCROP_HOME/state/outcrop.db)


# ------------------------------------------------------------------------------------------------------------- units

def _run(cmd, timeout=None):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def systemctl(*args, check: bool = True, timeout: float | None = 180) -> subprocess.CompletedProcess:
    """A verb for the service manager, in systemctl's terms (lib/units.py)."""
    return units.ctl(*args, check=check, timeout=timeout)


def out(cmd) -> str:
    try:
        return _run(cmd, 30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def unit_state(unit: str) -> str:
    return units.is_active(unit)


def running() -> list[tuple[str, str]]:
    """Presets whose unit is active or starting: [(name, state)]."""
    return [(u[len("outcrop-engine@"):-len(".service")], sub) for u, active, sub in units.list_engine()
            if active in ("active", "activating", "reloading")]


def current() -> str | None:
    r = running()
    return r[0][0] if r else None


def boot_unit_installed() -> bool:
    return units.boot_unit_installed()


def default_preset() -> str | None:
    """The preset started at boot: the state file read by outcrop-boot.service (or, before that is installed, the
    enabled outcrop-engine@ instance)."""
    if boot_unit_installed():
        try:
            v = DEFAULT_FILE.read_text(encoding="utf-8").strip()
            return v if v in SP.names() else None
        except OSError:
            return None
    for n in SP.names():
        if units.is_enabled(UNIT.format(n)) == "enabled":
            return n
    return None


def set_default(name: str, by: str = "cli", source: str = "") -> None:
    if name not in SP.names():
        raise ValueError(f"unknown preset {name!r}; presets: {', '.join(SP.names())}")
    if not boot_unit_installed():
        for n in SP.names():
            if n != name and units.is_enabled(UNIT.format(n)) == "enabled":
                systemctl("disable", "-q", UNIT.format(n))
        systemctl("enable", "-q", UNIT.format(name))
    else:
        STATE.mkdir(parents=True, exist_ok=True)
        tmp = DEFAULT_FILE.with_suffix(".tmp")
        tmp.write_text(name + "\n", encoding="utf-8")
        tmp.replace(DEFAULT_FILE)
    audit("preset.default", f"boot default set to {name}", actor=by, source=source, details={"preset": name})


# ------------------------------------------------------------------------------------------------------ the database

def _db():
    sys.path.insert(0, str(PROJECT / "console"))
    from outcrop.common import db  # noqa: E402
    return db


def audit(kind: str, summary: str, *, actor: str = "cli", source: str = "", level: str = "info",
          details: dict | None = None) -> None:
    """Add to the audit log, if the console's database exists (best effort: never stops a command)."""
    try:
        db = _db()
        con = db.connect(DB_PATH)
        try:
            db.add_event(con, kind, summary, actor=actor, source=source or _ssh_source(), level=level, details=details)
        finally:
            con.close()
    except Exception:
        pass


def _ssh_source() -> str:
    c = os.environ.get("SSH_CLIENT", "").split()
    return f"ssh {c[0]}" if c else ("ssh" if os.environ.get("SSH_TTY") else "local")


# ----------------------------------------------------------------------------------------------------------- Strata

def strata_addr() -> tuple[str, int]:
    host, port = SP.bind(SP.load())
    return ("127.0.0.1" if host in ("0.0.0.0", "::", "") else host), port


def strata_key() -> str | None:
    k = SP.api_key(SP.load())
    if isinstance(k, list):
        return k[0] if k else None
    return None if k in (None, "", "none") else k


def strata(path: str, timeout: float = 3.0, method: str = "GET", body: dict | None = None):
    """GET (or POST) Strata directly on its own port with the internal key; None if it does not answer."""
    host, port = strata_addr()
    try:
        c = http.client.HTTPConnection(host, port, timeout=timeout)
        h = {"Content-Type": "application/json"}
        k = strata_key()
        if k:
            h["Authorization"] = f"Bearer {k}"
        c.request(method, path, body=json.dumps(body).encode() if body is not None else None, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        if r.status != 200:
            return None
        return json.loads(data or b"null")
    except (OSError, ValueError, http.client.HTTPException):
        return None


def health():
    return strata("/health")


# ---------------------------------------------------------------------------------------------------------- gateway

class _UnixConn(http.client.HTTPConnection):
    def __init__(self, path, timeout=5.0):
        super().__init__("gateway", timeout=timeout)
        self._path = str(path)

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._path)
        self.sock = s


def gateway(method: str, path: str, body: dict | None = None, timeout: float = 5.0):
    """Call the gateway's control socket; None when the gateway is not running."""
    if not GATEWAY_SOCK.exists():
        return None
    try:
        c = _UnixConn(GATEWAY_SOCK, timeout)
        c.request(method, path, body=json.dumps(body).encode() if body is not None else None,
                  headers={"Content-Type": "application/json"})
        r = c.getresponse()
        data = r.read()
        c.close()
        return json.loads(data or b"null")
    except (OSError, ValueError, http.client.HTTPException):
        return None


def gateway_events(timeout: float | None = None):
    """Yield the gateway's events (dicts) from its control socket."""
    c = _UnixConn(GATEWAY_SOCK, timeout or 3600)
    c.request("GET", "/events")
    r = c.getresponse()
    buf = b""
    while True:
        chunk = r.read1(65536) if hasattr(r, "read1") else r.read(1)
        if not chunk:
            return
        buf += chunk
        while b"\n\n" in buf:
            block, buf = buf.split(b"\n\n", 1)
            for ln in block.split(b"\n"):
                if ln.startswith(b"data: "):
                    try:
                        yield json.loads(ln[6:])
                    except ValueError:
                        pass


# -------------------------------------------------------------------------------------------------- start phases

# The lines a start writes to the unit's journal, in order: (pattern, phase, label)
PHASES = [
    (re.compile(r"Stopping outcrop-engine@"), "stop", "Stop the running preset"),
    (re.compile(r"Starting outcrop-engine@"), "start", "Start the unit"),
    (re.compile(r"loading the vision encoder"), "vision", "Picture encoder"),
    (re.compile(r"reading the model's weights|loading the model"), "weights", "Model weights"),
    (re.compile(r"loading the experts into RAM(?: \(about (?P<gb>[\d.]+) GB\))?"), "experts", "Experts into RAM"),
    (re.compile(r"filling the GPU's expert cache \((?P<slots>\d+) experts, (?P<vram>[\d.]+) GiB"), "gpu_cache",
     "GPU expert cache"),
    (re.compile(r"almost ready"), "final", "Final checks"),
    (re.compile(r"^ready: |\] ready\b|^\s*ready: http"), "ready", "Ready"),
]
LOADED_RE = re.compile(r"experts loaded: (?P<gib>[\d.]+) GiB at (?P<rate>[\d.]+) GiB/s")
STOPPED_RE = re.compile(r"\[strata\] stopped|Deactivated successfully|Stopped outcrop-engine@")
FAILED_RE = re.compile(r"Failed with result|Main process exited, code=exited, status=[1-9]|Traceback|Error:", re.I)


def parse_phase(line: str) -> tuple[str, dict] | None:
    for rx, phase, _ in PHASES:
        m = rx.search(line)
        if m:
            return phase, {k: v for k, v in m.groupdict().items() if v is not None}
    m = LOADED_RE.search(line)
    if m:
        return "experts_loaded", m.groupdict()
    if STOPPED_RE.search(line):
        return "stopped", {}
    return None


def journal_since(unit: str, since: float) -> list[tuple[float, str]]:
    """The unit's journal lines since a Unix time: [(time, message)]."""
    return units.journal(unit, since=since)


def engine_pid(unit: str) -> int | None:
    """The engine process under the unit (the largest descendant of its main process)."""
    main = units.show([unit], ["MainPID"]).get(unit, {}).get("MainPID", "")
    try:
        root = int(main)
    except ValueError:
        return None
    if root <= 0:
        return None
    kids: dict[int, list[int]] = {}
    for d in Path("/proc").iterdir():
        if not d.name.isdigit():
            continue
        try:
            stat = (d / "stat").read_text()
            ppid = int(stat.rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            continue
        kids.setdefault(ppid, []).append(int(d.name))
    best, best_rss = root, -1.0
    stack = [root]
    while stack:
        p = stack.pop()
        rss = rss_anon_gib(p)
        if rss is not None and rss > best_rss:
            best, best_rss = p, rss
        stack.extend(kids.get(p, []))
    return best


def rss_anon_gib(pid: int) -> float | None:
    try:
        for ln in Path(f"/proc/{pid}/status").read_text().splitlines():
            if ln.startswith("RssAnon:"):
                return int(ln.split()[1]) / (1 << 20)
    except (OSError, ValueError):
        return None
    return None


def pack_files(name: str) -> list[Path]:
    p = SP.load()["presets"][name]
    q = p["pack"].upper()
    mdir = SP.OUTCROP_HOME / "models" / (f"{q}-q8dense" if p.get("q8_dense", True) else q)
    files = [mdir / SP.SHARD.format(Q=q, n=1)]
    pack_dir = SP.OUTCROP_HOME / "data" / "packs" / p["pack"]
    if pack_dir.is_dir():
        files += [f for f in pack_dir.rglob("*") if f.is_file() and f.stat().st_size > (64 << 20)]
    return [f for f in files if f.exists()]


def _resident(path: Path) -> tuple[int, int]:
    """(bytes in the page cache, size) of one file, by mmap + mincore(2): reads nothing from the disk."""
    import ctypes
    import ctypes.util
    import mmap
    size = path.stat().st_size
    if size == 0:
        return 0, 0
    libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)
    libc.mmap.restype = ctypes.c_void_p
    libc.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_long]
    libc.mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
    libc.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
    fd = os.open(path, os.O_RDONLY)
    try:
        addr = libc.mmap(None, size, mmap.PROT_READ, mmap.MAP_SHARED, fd, 0)
    finally:
        os.close(fd)
    if addr in (None, ctypes.c_void_p(-1).value):
        return 0, size
    try:
        page = mmap.PAGESIZE
        n = (size + page - 1) // page
        vec = (ctypes.c_ubyte * n)()
        if libc.mincore(ctypes.c_void_p(addr), size, vec) != 0:
            return 0, size
        res = (n - bytes(vec).count(0)) * page       # a non-zero byte: the page is resident (counted in C)
        return min(res, size), size
    finally:
        libc.munmap(ctypes.c_void_p(addr), size)


def page_cache_share(files: list[Path]) -> float | None:
    """The share of these files in the page cache (0..1), or None."""
    res = size = 0
    for f in files:
        try:
            r, sz = _resident(f)
        except OSError:
            continue
        res += r
        size += sz
    return round(res / size, 3) if size else None


# ----------------------------------------------------------------------------------------------------------- switch

class SwitchError(RuntimeError):
    pass


GENERATING = ("chat", "messages", "responses", "ollama-chat", "ollama-generate")


def estimate_s(name: str, warm: float | None) -> float | None:
    """From past switches to this preset (the median of the last five with a similar page-cache state)."""
    try:
        db = _db()
        con = db.connect(DB_PATH)
        rows = con.execute("SELECT started_at, ended_at, warm FROM switches WHERE to_preset=? AND ok=1 "
                           "ORDER BY started_at DESC LIMIT 20", (name,)).fetchall()
        con.close()
    except Exception:
        return None
    vals = [r["ended_at"] - r["started_at"] for r in rows
            if r["ended_at"] and (warm is None or r["warm"] is None or abs((r["warm"] or 0) - warm) < 0.3)][:5]
    if not vals:
        return None
    vals.sort()
    return round(vals[len(vals) // 2], 1)


SWITCH_LOCK = STATE / "switch.lock"


def switch_running() -> bool:
    """True while some process (the console, outcrop, a schedule) is switching presets."""
    import fcntl
    try:
        fd = os.open(SWITCH_LOCK, os.O_RDONLY)              # read-only: works where state/ is not writable
    except FileNotFoundError:
        return False                                       # never switched since install
    except OSError:
        return True                                        # can't tell: assume one runs (callers wait)
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)     # shared: a probe never blocks a switch from starting
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    except BlockingIOError:
        return True
    finally:
        os.close(fd)


def switch(name: str, *, cancel_inflight: bool = False, by: str = "cli", source: str = "", on=None,
           timeout: float = 1500, restart: bool = False, should_cancel=None) -> dict:
    """Run preset `name` now (or restart it).  `on(event: dict)` is told about each step.  Returns the switch record.

    One switch at a time across processes: the console, outcrop and the schedules take a lock on state/switch.lock
    (an flock: the kernel lets go when a process dies, so a crashed switch never blocks the next)."""
    import fcntl
    STATE.mkdir(parents=True, exist_ok=True)
    with open(SWITCH_LOCK, "a+") as lock:
        for _ in range(20):                                # a probe may hold it for a moment
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(0.05)
        else:
            raise SwitchError("another preset switch is running; wait for it to finish")
        return _switch(name, cancel_inflight=cancel_inflight, by=by, source=source, on=on, timeout=timeout,
                       restart=restart, should_cancel=should_cancel)


DRAIN_MAX_S = 600          # how long a switch lets running answers finish before it cancels them


def _switch(name: str, *, cancel_inflight: bool = False, by: str = "cli", source: str = "", on=None,
            timeout: float = 1500, restart: bool = False, should_cancel=None) -> dict:
    on = on or (lambda ev: None)
    should_cancel = should_cancel or (lambda: False)
    cfg = SP.load()
    if name not in cfg["presets"]:
        raise SwitchError(f"unknown preset {name!r}; presets: {', '.join(cfg['presets'])}")
    missing = PF.not_downloaded(cfg, name)
    if missing:
        raise SwitchError(missing)
    t0 = time.time()
    rec = {"started_at": t0, "from": current(), "to": name, "by": by, "phases": [], "ok": False, "error": None}
    phases = rec["phases"]

    def phase(key, label, **kw):
        now = time.time()
        if phases and phases[-1].get("end") is None:
            phases[-1]["end"] = now
        phases.append({"key": key, "label": label, "start": now, "end": None, **kw})
        on({"type": "phase", "phase": key, "label": label, "at": now, **kw})

    # 1. plan
    phase("plan", "Plan")
    try:
        # a bad preset fails here, with a clear message; not strict about the RAM, which the running engine still holds
        # (the engine's start renders again, strictly)
        SP.render(name, cfg, strict=False)
    except (KeyError, ValueError) as e:
        raise SwitchError(str(e.args[0] if e.args else e)) from None
    pack = cfg["presets"][name]["pack"]
    need = SP.FULL_ARENA_GIB.get(pack, 60)
    freed = 0.0
    for n, _ in running():
        pid = engine_pid(UNIT.format(n))
        freed += rss_anon_gib(pid) or 0.0 if pid else 0.0
    avail = SP.mem_available_gib() + freed
    warm = page_cache_share(pack_files(name))
    est = estimate_s(name, warm)
    rec.update(warm=warm, estimate_s=est, ram_need_gib=need, ram_avail_gib=round(avail, 1))
    on({"type": "plan", "preset": name, "from": rec["from"], "warm": warm, "estimate_s": est, "ram_need_gib": need,
        "ram_avail_gib": round(avail, 1), "low_ram": avail < need})

    # 2. hold new requests at the gateway, 3. drain or cancel what runs
    _HOLD["id"] = None
    last_renew = time.time()

    def renew():
        """Keep the hold alive through a long answer or a long start (it lapses after 600 s otherwise)."""
        nonlocal last_renew
        if _HOLD["id"] and time.time() - last_renew > 60:
            h2 = gateway("POST", "/hold", {"reason": f"switching to {name}", "max_s": 600})
            if h2:
                gateway("POST", "/release", {"hold_id": _HOLD["id"]})
                _HOLD["id"] = h2.get("hold_id")
            last_renew = time.time()

    gw = gateway("GET", "/state")
    try:
        if gw is not None:
            _hold_and_drain(name, gw, restart, cancel_inflight, phase, on, should_cancel, renew)
    except BaseException as e:
        # cancelled, interrupted or failed while draining: the hold must not outlive the switch
        if _HOLD["id"]:
            gateway("POST", "/release", {"hold_id": _HOLD["id"]})
        _HOLD["id"] = None
        rec["error"] = (str(e) if isinstance(e, SwitchCancelled) else
                        "interrupted while running requests finished" if isinstance(e, KeyboardInterrupt) else
                        f"failed while running requests finished: {e}")
        rec["ended_at"] = time.time()
        _record_switch(rec, source)
        raise
    if should_cancel():                                    # cancelled during the plan or the hold: nothing stopped yet
        if _HOLD["id"]:
            gateway("POST", "/release", {"hold_id": _HOLD["id"]})
        _HOLD["id"] = None
        rec["error"] = "cancelled before the running preset was stopped"
        rec["ended_at"] = time.time()
        _record_switch(rec, source)
        raise SwitchCancelled(rec["error"])
    try:
        # 4. stop
        others = [n for n, _ in running() if n != name or restart]
        if others:
            phase("stop", "Stop " + ", ".join(others), preset=others[0])
            for n in others:
                systemctl("stop", UNIT.format(n), timeout=300)
        # 5. start, 6. phases, 7. ready
        unit = UNIT.format(name)
        t_start = time.time()
        phase("start", f"Start {name}")
        systemctl("reset-failed", unit, check=False)        # manual starts count toward StartLimitBurst too
        systemctl("start", "--no-block", unit)
        seen = set()
        arena_target = None
        while True:
            if time.time() - t_start > timeout:
                raise SwitchError(f"{name} was not ready after {timeout:.0f} s (outcrop logs)")
            h = health()
            if h and h.get("loaded"):
                break
            st = unit_state(unit)
            if st in ("failed", "inactive") and time.time() - t_start > 3:
                tail = "\n".join(m for _, m in journal_since(unit, t_start)[-15:])
                raise SwitchError(f"{name} stopped while starting ({st}). Last lines:\n{tail}")
            for _t, msg in journal_since(unit, t_start - 0.5):
                p = parse_phase(msg)
                if not p:
                    continue
                key, info = p
                if key in seen or key in ("stop", "stopped", "start"):
                    continue
                seen.add(key)
                if key == "experts_loaded":
                    if phases:
                        phases[-1].update(info)
                    on({"type": "experts_loaded", **info})
                    continue
                if key == "experts" and info.get("gb"):
                    arena_target = float(info["gb"]) * 1e9 / (1 << 30) * 0.88
                label = next(lb for _, k, lb in PHASES if k == key)
                phase(key, label, **info)
            if "experts" in seen and "gpu_cache" not in seen:
                pid = engine_pid(unit)
                rss = rss_anon_gib(pid) if pid else None
                if rss is not None:
                    on({"type": "progress", "phase": "experts", "rss_gib": round(rss, 2),
                        "target_gib": round(arena_target, 1) if arena_target else None})
            on({"type": "tick", "elapsed_s": round(time.time() - t0, 1)})
            renew()
            time.sleep(1.0)
        if not phases or phases[-1]["key"] != "ready":
            phase("ready", "Ready")
        phases[-1]["end"] = time.time()
        rec["ok"] = True
        return rec
    except Exception as e:
        rec["error"] = str(e)
        raise
    finally:
        if _HOLD["id"]:
            gateway("POST", "/release", {"hold_id": _HOLD["id"]})
        _HOLD["id"] = None
        rec["ended_at"] = time.time()
        if phases and phases[-1].get("end") is None:
            phases[-1]["end"] = rec["ended_at"]
        _record_switch(rec, source)
        on({"type": "done", "ok": rec["ok"], "error": rec["error"], "total_s": round(rec["ended_at"] - t0, 1)})

_HOLD = {"id": None}         # the hold this process's switch has (for the release after an interrupted drain)


class SwitchCancelled(SwitchError):
    pass


def _hold_and_drain(name, gw, restart, cancel_inflight, phase, on, should_cancel, renew) -> None:
    """Hold new requests at the gateway, then let running answers finish (or cancel them).  Running answers get
    DRAIN_MAX_S; then they are cancelled, so a stuck generation can't hold every client forever.  `should_cancel()`
    true: give up the switch (the hold is released by the caller)."""
    phase("hold", "Hold new requests")
    h = gateway("POST", "/hold", {"reason": f"switching to {name}" if not restart else f"restarting {name}", "max_s": 600})
    _HOLD["id"] = (h or {}).get("hold_id")
    busy = [f for f in (gw.get("inflight") or []) if f.get("kind") in GENERATING and f.get("phase") != "held"]
    if not busy:
        return
    phase("drain", "Cancel running requests" if cancel_inflight else "Let running requests finish", count=len(busy))
    if cancel_inflight:
        for f in busy:
            gateway("POST", "/cancel", {"request_id": f["rid"], "reason": f"switching to {name}"})
    t_drain = time.time()
    while True:
        if should_cancel():
            raise SwitchCancelled("the switch was cancelled while running requests finished")
        st = gateway("GET", "/state") or {}
        # only requests already at Strata; held ones wait for this switch (counting them would deadlock)
        left = [f for f in st.get("inflight") or [] if f.get("kind") in GENERATING and f.get("phase") != "held"]
        if not left:
            return
        if time.time() - t_drain > DRAIN_MAX_S:
            on({"type": "drain", "left": len(left), "cancelling": True})
            for f in left:
                gateway("POST", "/cancel", {"request_id": f["rid"],
                                            "reason": f"switching to {name}: waited {DRAIN_MAX_S // 60} minutes"})
            t_drain = time.time() + 30 - DRAIN_MAX_S              # give the cancels 30 s, then look again
        on({"type": "drain", "left": len(left)})
        renew()
        time.sleep(1)


def _record_switch(rec: dict, source: str) -> None:
    try:
        db = _db()
        con = db.connect(DB_PATH)
        try:
            con.execute("INSERT INTO switches(started_at, ended_at, from_preset, to_preset, by, phases, ok, error, warm) "
                        "VALUES(?,?,?,?,?,?,?,?,?)", (rec["started_at"], rec["ended_at"], rec["from"], rec["to"],
                                                      rec["by"], json.dumps(rec["phases"]), int(rec["ok"]),
                                                      rec["error"], rec.get("warm")))
            took = rec["ended_at"] - rec["started_at"]
            what = (f"restarted {rec['to']}" if rec["from"] == rec["to"] else
                    f"switched from {rec['from']} to {rec['to']}" if rec["from"] else f"started {rec['to']}")
            db.add_event(con, "preset.switch", f"{what} in {took:.0f} s" if rec["ok"] else f"{what}: failed",
                         actor=rec["by"], source=source or _ssh_source(), level="info" if rec["ok"] else "error",
                         details={"from": rec["from"], "to": rec["to"], "ok": rec["ok"], "error": rec["error"],
                                  "seconds": round(took, 1)})
        finally:
            con.close()
    except Exception:
        pass


def stop_all(by: str = "cli") -> list[str]:
    names = [n for n, _ in running()]
    for n in names:
        systemctl("stop", UNIT.format(n), timeout=300)
    if names:
        audit("preset.stop", f"stopped {', '.join(names)}", actor=by)
    return names
