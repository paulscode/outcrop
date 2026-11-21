"""The service manager behind Outcrop's units: systemd on Ubuntu, Outcrop's own supervisor in the StartOS container.

Everything that starts, stops or inspects a unit, or reads its journal, goes through here, in systemd's terms: unit names
(outcrop-engine@PRESET.service, outcrop-gateway.service ...), verbs (start, stop, restart ...), properties (ActiveState,
MainPID ...) and journal lines (Unix time, message).  The backend is chosen once, from the environment:

  systemd     the default.  systemctl as this user (a polkit rule, setup/polkit/50-outcrop.rules, allows the LLM units),
              falling back to `sudo -n` where the rule is not installed; journalctl for the journal.
  supervisor  OUTCROP_PLATFORM=startos: bin/outcrop-supervisor (lib/supervisor.py), which runs the same units in the container.

Standard library only.
"""
from __future__ import annotations

import glob
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

ENGINE_GLOB = "outcrop-engine@*"
ENGINE_PREFIX = "outcrop-engine@"


def backend() -> str:
    return "supervisor" if os.environ.get("OUTCROP_PLATFORM") == "startos" else "systemd"


# ------------------------------------------------------------------------------------- the supervisor, over its socket

def _sock() -> Path:
    return Path(os.environ.get("OUTCROP_SUPERVISOR_SOCK") or Path(os.environ.get("OUTCROP_RUN") or "/run/outcrop") /
                "supervisor.sock")


def _journal_dir() -> Path:
    return Path(os.environ.get("OUTCROP_HOME") or Path.home() / ".outcrop") / "logs" / "units"


def _rpc(req: dict, timeout: float | None = 180) -> dict | None:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import supervisor
    try:
        return supervisor.rpc(_sock(), req, timeout=timeout)
    except (OSError, ValueError):
        return None


def _sup_ctl(args: tuple[str, ...], timeout: float | None) -> subprocess.CompletedProcess:
    r = _rpc({"op": "ctl", "args": [a for a in args if a != "--no-ask-password"]},
             timeout=None if timeout is None else timeout + 15)
    if r is None:
        return subprocess.CompletedProcess(["supervisor", *args], 1, "", f"the supervisor does not answer at {_sock()}")
    if "error" in r:
        return subprocess.CompletedProcess(["supervisor", *args], 1, "", r["error"])
    return subprocess.CompletedProcess(["supervisor", *args], r.get("rc", 1), r.get("stdout", ""), r.get("stderr", ""))


def _run(cmd, timeout=None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _out(cmd) -> str:
    try:
        return _run(cmd, 30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


# ------------------------------------------------------------------------------------------------------------ control

def ctl(*args: str, check: bool = True, timeout: float | None = 180) -> subprocess.CompletedProcess:
    """A systemctl verb and its arguments, e.g. ctl("restart", "outcrop-gateway.service") or ctl("start", "--no-block", u).
    check: raise RuntimeError when it fails."""
    if backend() == "supervisor":
        r = _sup_ctl(args, timeout)
        if check and r.returncode != 0:
            raise RuntimeError(f"{' '.join(args)} failed: {(r.stderr or r.stdout).strip()}")
        return r
    cmd = ["systemctl", "--no-ask-password", *args]
    r = _run(cmd, timeout)
    if r.returncode != 0 and os.geteuid() != 0 and re.search(r"Access denied|authentication required|Permission denied|"
                                                            r"Interactive authentication", r.stderr or "", re.I):
        r = _run(["sudo", "-n", *cmd], timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"systemctl {' '.join(args)} failed: {(r.stderr or r.stdout).strip()}")
    return r


def is_active(unit: str) -> str:
    """active, activating, inactive, failed ... ("unknown" when the manager does not answer)."""
    if backend() == "supervisor":
        return _sup_ctl(("is-active", unit), 30).stdout.strip() or "unknown"
    return _out(["systemctl", "is-active", unit]) or "unknown"


def is_enabled(unit: str) -> str:
    if backend() == "supervisor":
        return _sup_ctl(("is-enabled", unit), 30).stdout.strip()
    return _out(["systemctl", "is-enabled", unit])


def list_engine() -> list[tuple[str, str, str]]:
    """Every outcrop-engine@ unit the manager knows: [(unit, active state, sub state)]."""
    if backend() == "supervisor":
        r = _rpc({"op": "list", "pattern": ENGINE_GLOB}, timeout=30) or {}
        return [tuple(u) for u in r.get("units", [])]
    res = []
    for ln in _out(["systemctl", "list-units", ENGINE_GLOB, "--all", "--no-legend", "--plain"]).splitlines():
        f = ln.split()
        if len(f) >= 4 and f[0].startswith(ENGINE_PREFIX):
            res.append((f[0], f[2], f[3]))
    return res


def show(units: list[str], props: list[str]) -> dict[str, dict[str, str]]:
    """Properties of units: {unit: {property: value}} (missing units are left out)."""
    if not units:
        return {}
    if backend() == "supervisor":
        r = _rpc({"op": "show", "units": units}, timeout=30) or {}
        return {u: {k: v for k, v in p.items() if k == "Id" or k in props} for u, p in r.get("units", {}).items()}
    try:
        r = _run(["systemctl", "show", *units, "-p", ",".join(["Id", *props])], 10)
    except (OSError, subprocess.SubprocessError):
        return {}
    out, cur = {}, {}
    for ln in r.stdout.splitlines() + [""]:
        if not ln.strip():
            if cur.get("Id"):
                out[cur["Id"]] = cur
            cur = {}
            continue
        k, _, v = ln.partition("=")
        cur[k] = v
    return out


def boot_unit_installed() -> bool:
    """Whether the boot default is kept in a state file read by outcrop-boot (always so under the supervisor)."""
    if backend() == "supervisor":
        return True
    return Path("/etc/systemd/system", "outcrop-boot.service").exists()


# ------------------------------------------------------------------------------------------------------------ journal

def _parse_short_unix(txt: str) -> list[tuple[float, str]]:
    """journalctl -o short-unix lines ("1732222222.123456 host unit[pid]: message") as [(time, message)]."""
    res = []
    for ln in txt.splitlines():
        parts = ln.split(" ", 2)
        if len(parts) < 3:
            continue
        try:
            t = float(parts[0])
        except ValueError:
            continue
        msg = parts[2].split(": ", 1)[1] if ": " in parts[2] else parts[2]
        res.append((t, msg))
    return res


def journal(unit: str, since: float | None = None, lines: int | None = None) -> list[tuple[float, str]]:
    """A unit's journal: the lines since a Unix time, or the last `lines` lines.  [(time, message)]"""
    if backend() == "supervisor":
        rows = [(t, msg) for t, _pid, msg in _read_journal(unit) if since is None or t >= since]
        return rows[-lines:] if lines is not None else rows
    cmd = ["journalctl", "-u", unit]
    if since is not None:
        cmd += ["--since", f"@{since:.3f}"]
    if lines is not None:
        cmd += ["-n", str(lines)]
    cmd += ["-o", "short-unix", "--no-pager", "-q"]
    if since is not None:
        return _parse_short_unix(_out(cmd))
    try:
        return _parse_short_unix(_run(cmd, 15).stdout)
    except (OSError, subprocess.SubprocessError):
        return []


def follow_cmd(units: list[str], lines: int = 0, message_only: bool = False, human: bool = False) -> list[str]:
    """The command that follows units' journals, printing short-unix lines ("time host unit[pid]: message") as they come
    (human: journalctl's usual dates, for a terminal)."""
    if backend() == "supervisor":
        return [sys.executable, str(Path(__file__).resolve()), "follow", "-n", str(lines),
                *(["--human"] if human else []), *units]
    cmd = ["journalctl", "-f", "-n", str(lines)] + ([] if human else ["-o", "short-unix"]) + ["-q"]
    for u in units:
        cmd += ["-u", u]
    if message_only:
        cmd += ["--output-fields=MESSAGE"]
    return cmd


def journal_cmd(unit: str, lines: int) -> list[str]:
    """The command that prints a unit's last lines for a person (outcrop logs)."""
    if backend() == "supervisor":
        return [sys.executable, str(Path(__file__).resolve()), "journal", "-n", str(lines), unit]
    return ["journalctl", "-u", unit, "-n", str(lines), "--no-pager", "-q"]


# ------------------------------------------------------------------------------- the supervisor's journal files

def _journal_files(pattern: str) -> list[Path]:
    """The journal files of the units a name or a glob names (outcrop-engine@*), rotated ones first."""
    if not pattern.endswith(".service") and not pattern.endswith("*"):
        pattern += ".service"
    d = _journal_dir()
    names = sorted({Path(p).name.removesuffix(".1").removesuffix(".log")
                    for p in glob.glob(str(d / f"{glob.escape(pattern) if '*' not in pattern else pattern}.log*"))})
    out = []
    for n in names:
        out += [p for p in (d / f"{n}.log.1", d / f"{n}.log") if p.exists()]
    return out


def _parse_line(ln: str) -> tuple[float, int, str] | None:
    parts = ln.rstrip("\n").split(" ", 2)
    if len(parts) < 2:
        return None
    try:
        return float(parts[0]), int(parts[1]), parts[2] if len(parts) > 2 else ""
    except ValueError:
        return None


def _read_journal(unit: str) -> list[tuple[float, int, str]]:
    rows = []
    for p in _journal_files(unit):
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                rows += [r for r in map(_parse_line, f) if r]
        except OSError:
            pass
    return rows


def _line(unit: str, t: float, pid: int, msg: str, human: bool) -> str:
    when = time.strftime("%b %d %H:%M:%S", time.localtime(t)) if human else f"{t:.6f}"
    return f"{when} {socket.gethostname()} {unit.removesuffix('.service')}[{pid}]: {msg}"


def _cli(argv: list[str]) -> int:
    """python3 lib/units.py follow [-n N] [--human] UNIT... | journal -n N UNIT: journalctl's output, from the files."""
    if not argv or argv[0] not in ("follow", "journal"):
        print(_cli.__doc__, file=sys.stderr)
        return 2
    cmd, args = argv[0], argv[1:]
    n, human, pats = 0, cmd == "journal", []
    while args:
        a = args.pop(0)
        if a == "-n":
            n = int(args.pop(0))
        elif a == "--human":
            human = True
        else:
            pats.append(a)
    files = {f.name.removesuffix(".1").removesuffix(".log") for pat in pats for f in _journal_files(pat)}
    rows = sorted((t, pid, u, msg) for u in files for t, pid, msg in _read_journal(u))
    for t, pid, u, msg in rows[-n:] if n else []:
        print(_line(u, t, pid, msg, human), flush=True)
    if cmd == "journal":
        return 0
    # follow: from the current end of each file; a unit that appears later (another preset) from its beginning
    pos = {f: f.stat().st_size for pat in pats for f in _journal_files(pat) if f.suffix == ".log"}
    while True:
        for f in {f for pat in pats for f in _journal_files(pat) if f.suffix == ".log"}:
            try:
                size = f.stat().st_size
            except OSError:
                continue
            at = pos.get(f, 0)
            if size < at:                                   # rotated: the new file from its beginning
                at = 0
            if size > at:
                with open(f, "rb") as fh:
                    fh.seek(at)
                    data = fh.read(size - at)
                end = data.rfind(b"\n") + 1                # only whole lines; a line being written waits
                pos[f] = at + end
                for ln in data[:end].decode("utf-8", "replace").splitlines():
                    r = _parse_line(ln)
                    if r:
                        print(_line(f.name.removesuffix(".log"), r[0], r[1], r[2], human), flush=True)
            else:
                pos[f] = size
        time.sleep(0.3)


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
