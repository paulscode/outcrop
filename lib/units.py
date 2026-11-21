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

import os
import re
import subprocess
from pathlib import Path

ENGINE_GLOB = "outcrop-engine@*"
ENGINE_PREFIX = "outcrop-engine@"


def backend() -> str:
    return "supervisor" if os.environ.get("OUTCROP_PLATFORM") == "startos" else "systemd"


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
    return _out(["systemctl", "is-active", unit]) or "unknown"


def is_enabled(unit: str) -> str:
    return _out(["systemctl", "is-enabled", unit])


def list_engine() -> list[tuple[str, str, str]]:
    """Every outcrop-engine@ unit the manager knows: [(unit, active state, sub state)]."""
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
    cmd = ["journalctl", "-f", "-n", str(lines)] + ([] if human else ["-o", "short-unix"]) + ["-q"]
    for u in units:
        cmd += ["-u", u]
    if message_only:
        cmd += ["--output-fields=MESSAGE"]
    return cmd


def journal_cmd(unit: str, lines: int) -> list[str]:
    """The command that prints a unit's last lines for a person (outcrop logs)."""
    return ["journalctl", "-u", unit, "-n", str(lines), "--no-pager", "-q"]
