"""Outcrop's supervisor: what systemd does for Outcrop on Ubuntu, inside the StartOS service container (bin/outcrop-supervisor).

StartOS runs one daemon for the service, this one, and it runs Outcrop's units with the settings of systemd/*.service: the
engine (outcrop-engine@PRESET, a template), the gateway, the console, the Ollama bridge and the boot default.  It keeps
systemd's model, so the rest of Outcrop needs no second code path (lib/units.py is the only switch):

  - unit names, and the verbs start, stop, restart, try-restart, reset-failed, enable, disable;
  - ActiveState / SubState (inactive dead, active running, activating auto-restart, deactivating stop-sigterm, failed),
    ActiveEnterTimestamp, MainPID, NRestarts, Result and UnitFileState;
  - Restart= (no, on-failure, always), RestartSec=, TimeoutStopSec= (SIGTERM, then SIGKILL), StartLimitIntervalSec= and
    StartLimitBurst= (manual starts count too, as in systemd; reset-failed clears them), ConditionPathExists=!PATH;
  - a journal per unit: $OUTCROP_HOME/logs/units/<unit>.log, one "time pid message" line each, with the lifecycle lines
    systemd writes ("Stopping ...", "Main process exited, code=exited, status=1/FAILURE", "Failed with result ...") that
    lib/outcrop_control.py's switch reads.

It listens on a Unix socket ($OUTCROP_RUN/supervisor.sock, 0600, owned by the service user): one JSON request per line, one
JSON answer per line.  Run as root it starts each unit as its User=; run as anyone else (the tests), as itself.

Standard library only.
"""
from __future__ import annotations

import collections
import contextlib
import fnmatch
import json
import os
import pwd
import re
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
JOURNAL_MAX = 16 << 20          # a unit's journal file is rotated (to .1) past this size


@dataclass
class Spec:
    """A unit's settings, as in its systemd/*.service file.  argv may hold %i (a template's instance)."""
    argv: list[str]
    type: str = "simple"                      # simple | oneshot
    user: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    restart: str = "no"                       # no | on-failure | always
    restart_sec: float = 0.1
    stop_timeout: float = 90.0
    start_limit_interval: float = 10.0
    start_limit_burst: int = 5
    remain_after_exit: bool = False
    condition_not_exists: str | None = None
    enabled: bool = False                     # started when the supervisor starts
    after: list[str] = field(default_factory=list)


def fmt_time(t: float) -> str:
    """systemd's timestamp format (ActiveEnterTimestamp): Sat 2026-11-21 10:00:00 UTC."""
    return time.strftime("%a %Y-%m-%d %H:%M:%S %Z", time.localtime(t))


class Journal:
    """Append-only per-unit log files: "<unix time> <pid> <message>" lines."""

    def __init__(self, directory: Path, echo=None):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.echo = echo
        self.lock = threading.Lock()

    def path(self, unit: str) -> Path:
        return self.dir / f"{unit}.log"

    def write(self, unit: str, pid: int, msg: str) -> None:
        msg = msg.replace("\r", "").rstrip("\n")
        t = time.time()
        with self.lock:
            p = self.path(unit)
            with contextlib.suppress(OSError):
                if p.stat().st_size > JOURNAL_MAX:
                    p.replace(p.with_suffix(".log.1"))
            with open(p, "a", encoding="utf-8") as f:
                for ln in msg.split("\n") or [""]:
                    f.write(f"{t:.6f} {pid} {ln}\n")
        if self.echo:
            self.echo(f"{unit.removesuffix('.service')}[{pid}]: {msg}")


class Unit:
    def __init__(self, name: str, spec: Spec, instance: str | None, sup: Supervisor):
        self.name, self.spec, self.instance, self.sup = name, spec, instance, sup
        self.active, self.sub, self.result = "inactive", "dead", "success"
        self.proc: subprocess.Popen | None = None
        self.since = ""
        self.nrestarts = 0
        self.starts: collections.deque[float] = collections.deque()
        self.stopping = False
        self.timer: threading.Timer | None = None
        self.done = threading.Event()          # set when a run ends (stop and oneshot starts wait on it)
        self.done.set()

    def log(self, msg: str, pid: int | None = None) -> None:
        self.sup.journal.write(self.name, self.proc.pid if pid is None and self.proc else (pid or 0), msg)

    def props(self) -> dict[str, str]:
        enabled = self.sup.is_enabled(self.name)
        return {"Id": self.name, "ActiveState": self.active, "SubState": self.sub, "ActiveEnterTimestamp": self.since,
                "MainPID": str(self.proc.pid if self.proc and self.proc.poll() is None else 0),
                "NRestarts": str(self.nrestarts), "Result": self.result, "UnitFileState": enabled}


class Supervisor:
    def __init__(self, specs: dict[str, Spec], journal_dir: Path, *, state_file: Path | None = None, echo=None):
        self.specs = specs
        self.journal = Journal(journal_dir, echo=echo)
        self.state_file = state_file
        self.units: dict[str, Unit] = {}
        self.lock = threading.RLock()
        self.shutting_down = False
        self._enabled = self._load_enabled()

    # -------------------------------------------------------------------------------------------- names and state
    def resolve(self, name: str) -> Unit:
        """The unit for a name (templates: outcrop-engine@speed.service).  KeyError: no such unit."""
        if not name.endswith(".service"):
            name += ".service"
        with self.lock:
            if name in self.units:
                return self.units[name]
            base, inst = name, None
            if "@" in name:
                prefix, rest = name.split("@", 1)
                inst = rest.removesuffix(".service")
                base = f"{prefix}@.service"
                if not NAME_RE.fullmatch(inst):
                    raise KeyError(f"Invalid unit name {name!r}")
            spec = self.specs.get(base)
            if spec is None:
                raise KeyError(f"Unit {name} not found.")
            u = self.units[name] = Unit(name, spec, inst, self)
            return u

    def _load_enabled(self) -> dict[str, bool]:
        if self.state_file:
            with contextlib.suppress(OSError, ValueError):
                return {k: bool(v) for k, v in json.loads(self.state_file.read_text()).get("enabled", {}).items()}
        return {}

    def _save_enabled(self) -> None:
        if self.state_file:
            tmp = self.state_file.with_suffix(".tmp")
            tmp.write_text(json.dumps({"enabled": self._enabled}, indent=1))
            tmp.replace(self.state_file)

    def is_enabled(self, name: str) -> str:
        try:
            u = self.resolve(name)
        except KeyError:
            return ""
        if name in self._enabled:
            return "enabled" if self._enabled[name] else "disabled"
        return "enabled" if u.spec.enabled and u.instance is None else "disabled"

    # ---------------------------------------------------------------------------------------------------- running
    def _argv(self, u: Unit) -> list[str]:
        return [a.replace("%i", u.instance or "") for a in u.spec.argv]

    def _preexec(self, user: str | None):
        if user is None or os.geteuid() != 0:
            return None
        pw = pwd.getpwnam(user)

        def drop():
            os.setgroups([])
            os.setgid(pw.pw_gid)
            os.setuid(pw.pw_uid)
        return drop

    def start(self, name: str, block: bool = True, manual: bool = True) -> str | None:
        """Start a unit; an error message, or None."""
        u = self.resolve(name)
        with self.lock:
            if u.timer:
                u.timer.cancel()
                u.timer = None
            if u.proc and u.proc.poll() is None:
                return None                                   # already running
            if u.active == "active" and u.spec.type == "oneshot" and u.spec.remain_after_exit:
                return None
            cond = u.spec.condition_not_exists
            if cond and Path(cond).exists():
                u.log(f"{u.name} was skipped because of an unmet condition check (ConditionPathExists=!{cond}).", 0)
                return None
            now = time.time()
            while u.starts and now - u.starts[0] > u.spec.start_limit_interval:
                u.starts.popleft()
            if len(u.starts) >= u.spec.start_limit_burst:
                u.active, u.sub, u.result = "failed", "failed", "start-limit-hit"
                u.log(f"{u.name}: Start request repeated too quickly.", 0)
                u.log(f"{u.name}: Failed with result 'start-limit-hit'.", 0)
                return f"Job for {u.name} failed: start request repeated too quickly. (systemctl reset-failed {u.name})"
            u.starts.append(now)
            env = {**os.environ, **u.spec.env}
            try:
                u.proc = subprocess.Popen(self._argv(u), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                          stderr=subprocess.STDOUT, env=env, start_new_session=True,
                                          preexec_fn=self._preexec(u.spec.user))
            except OSError as e:
                u.active, u.sub, u.result = "failed", "failed", "resources"
                u.log(f"{u.name}: Failed to start: {e}", 0)
                return f"Job for {u.name} failed: {e}"
            u.stopping = False
            u.done.clear()
            u.result = "success"
            if u.spec.type == "oneshot":
                u.active, u.sub = "activating", "start"
            else:
                u.active, u.sub = "active", "running"
                u.since = fmt_time(now)
            u.log(f"Started {u.name}.")
            threading.Thread(target=self._watch, args=(u, u.proc), daemon=True, name=f"watch-{u.name}").start()
        if u.spec.type == "oneshot" and block:
            u.done.wait()
            if u.active == "failed":
                return f"Job for {u.name} failed."
        return None

    def _watch(self, u: Unit, proc: subprocess.Popen) -> None:
        assert proc.stdout is not None
        for raw in iter(proc.stdout.readline, b""):
            self.journal.write(u.name, proc.pid, raw.decode("utf-8", "replace"))
        rc = proc.wait()
        with self.lock:
            if u.proc is not proc:
                return
            if rc < 0:
                how = f"code=killed, status={-rc}/{signal.Signals(-rc).name.removeprefix('SIG')}"
            else:
                how = f"code=exited, status={rc}/{'SUCCESS' if rc == 0 else 'FAILURE'}"
            u.log(f"Main process exited, {how}", proc.pid)
            clean = rc == 0 or (u.stopping and rc in (-signal.SIGTERM, 143))
            if u.stopping:
                u.active, u.sub, u.result = "inactive", "dead", "success"
                u.log(f"Stopped {u.name}.", proc.pid)
            elif u.spec.type == "oneshot":
                if clean:
                    u.active, u.sub = ("active", "exited") if u.spec.remain_after_exit else ("inactive", "dead")
                    u.since = fmt_time(time.time())
                    u.log(f"Finished {u.name}.", proc.pid)
                else:
                    u.active, u.sub, u.result = "failed", "failed", "exit-code"
                    u.log(f"{u.name}: Failed with result 'exit-code'.", proc.pid)
            else:
                again = u.spec.restart == "always" or (u.spec.restart == "on-failure" and not clean)
                if not clean:
                    u.result = "signal" if rc < 0 else "exit-code"
                    u.log(f"{u.name}: Failed with result '{u.result}'.", proc.pid)
                if again and not self.shutting_down:
                    u.active, u.sub = "activating", "auto-restart"
                    u.timer = threading.Timer(u.spec.restart_sec, self._auto_restart, args=(u,))
                    u.timer.daemon = True
                    u.timer.start()
                elif clean:
                    u.active, u.sub = "inactive", "dead"
                else:
                    u.active, u.sub = "failed", "failed"
            u.done.set()

    def _auto_restart(self, u: Unit) -> None:
        with self.lock:
            if u.active != "activating" or u.sub != "auto-restart":
                return
            u.timer = None
            u.nrestarts += 1
            u.log(f"{u.name}: Scheduled restart job, restart counter is at {u.nrestarts}.", 0)
        self.start(u.name, manual=False)

    def stop(self, name: str, timeout: float | None = None) -> str | None:
        u = self.resolve(name)
        with self.lock:
            if u.timer:
                u.timer.cancel()
                u.timer = None
            proc = u.proc
            if not proc or proc.poll() is not None:
                if u.active in ("activating", "active"):
                    u.active, u.sub = "inactive", "dead"
                return None
            u.stopping = True
            u.active, u.sub = "deactivating", "stop-sigterm"
            u.log(f"Stopping {u.name}...", proc.pid)
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGTERM)
        limit = u.spec.stop_timeout if timeout is None else min(timeout, u.spec.stop_timeout)
        if not u.done.wait(limit):
            u.log(f"{u.name}: State 'stop-sigterm' timed out. Killing.", proc.pid)
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
            u.done.wait(10)
        return None

    def reset_failed(self, name: str) -> None:
        u = self.resolve(name)
        with self.lock:
            u.starts.clear()
            if u.active == "failed":
                u.active, u.sub, u.result = "inactive", "dead", "success"

    # ----------------------------------------------------------------------------------------------- systemctl verbs
    def ctl(self, args: list[str]) -> dict:
        """systemctl's command line (without "systemctl"): {"rc", "stdout", "stderr"}."""
        opts = [a for a in args if a.startswith("-")]
        rest = [a for a in args if not a.startswith("-")]
        if not rest:
            return {"rc": 1, "stdout": "", "stderr": "no verb"}
        verb, names = rest[0], rest[1:]
        block = "--no-block" not in opts
        errs = []
        try:
            for n in names:
                if verb == "start":
                    e = self.start(n, block=block)
                elif verb == "stop":
                    e = self.stop(n)
                elif verb in ("restart", "try-restart", "reload-or-restart"):
                    u = self.resolve(n)
                    if verb == "try-restart" and u.active not in ("active", "activating"):
                        continue
                    self.stop(n)
                    e = self.start(n, block=block)
                elif verb == "reset-failed":
                    e = self.reset_failed(n)
                elif verb in ("enable", "disable"):
                    self.resolve(n)
                    self._enabled[n if n.endswith(".service") else n + ".service"] = verb == "enable"
                    self._save_enabled()
                    e = None
                    if verb == "enable" and "--now" in opts:
                        e = self.start(n, block=block)
                    elif verb == "disable" and "--now" in opts:
                        e = self.stop(n)
                elif verb == "is-active":
                    u = self.resolve(n)
                    return {"rc": 0 if u.active == "active" else 3, "stdout": u.active + "\n", "stderr": ""}
                elif verb == "is-enabled":
                    s = self.is_enabled(n)
                    return {"rc": 0 if s == "enabled" else 1, "stdout": s + "\n", "stderr": ""}
                else:
                    return {"rc": 1, "stdout": "", "stderr": f"Unknown command verb '{verb}'."}
                if e:
                    errs.append(e)
        except KeyError as e:
            return {"rc": 5, "stdout": "", "stderr": f"{e.args[0]}"}
        return {"rc": 1 if errs else 0, "stdout": "", "stderr": "\n".join(errs)}

    def show(self, names: list[str]) -> dict[str, dict[str, str]]:
        out = {}
        for n in names:
            with contextlib.suppress(KeyError):
                u = self.resolve(n)
                out[u.name] = u.props()
        return out

    def list_units(self, pattern: str) -> list[tuple[str, str, str]]:
        with self.lock:
            return [(n, u.active, u.sub) for n, u in sorted(self.units.items()) if fnmatch.fnmatch(n, pattern)]

    def boot(self) -> None:
        """Start the enabled units, each after the ones it names in after."""
        todo = [n for n, s in self.specs.items() if "@" not in n and self.is_enabled(n) == "enabled"]
        started: set[str] = set()
        while todo:
            ready = [n for n in todo if all(a in started or a not in todo for a in self.specs[n].after)] or todo[:1]
            for n in ready:
                e = self.start(n, block=self.specs[n].type == "oneshot")
                if e:
                    self.journal.write(n, 0, e)
                started.add(n)
                todo.remove(n)

    def shutdown(self) -> None:
        """Stop everything: the engines first (they take longest), then the rest, as systemd does at power-off."""
        self.shutting_down = True
        with self.lock:
            names = list(self.units)
        engines = [n for n in names if "@" in n]
        threads = [threading.Thread(target=self.stop, args=(n,)) for n in engines]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        for n in reversed([n for n in names if "@" not in n]):
            self.stop(n)

    # ------------------------------------------------------------------------------------------------------ socket
    def handle(self, req: dict) -> dict:
        op = req.get("op")
        if op == "ctl":
            return self.ctl([str(a) for a in req.get("args", [])])
        if op == "show":
            return {"units": self.show([str(n) for n in req.get("units", [])])}
        if op == "list":
            return {"units": self.list_units(str(req.get("pattern", "*")))}
        if op == "ping":
            return {"ok": True, "pid": os.getpid()}
        return {"error": f"unknown op {op!r}"}

    def serve(self, path: Path, owner: str | None = None) -> socketserver.BaseServer:
        sup = self
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(FileNotFoundError):
            path.unlink()

        class H(socketserver.StreamRequestHandler):
            def handle(self):
                for line in self.rfile:
                    try:
                        ans = sup.handle(json.loads(line))
                    except Exception as e:                      # one bad request must not end the supervisor
                        ans = {"error": f"{type(e).__name__}: {e}"}
                    self.wfile.write(json.dumps(ans).encode() + b"\n")
                    self.wfile.flush()

        class S(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True

        old = os.umask(0o177)
        try:
            srv = S(str(path), H)
        finally:
            os.umask(old)
        if owner and os.geteuid() == 0:
            pw = pwd.getpwnam(owner)
            os.chown(path, pw.pw_uid, pw.pw_gid)
            os.chown(path.parent, pw.pw_uid, pw.pw_gid)
        threading.Thread(target=srv.serve_forever, daemon=True, name="supervisor-socket").start()
        return srv


def rpc(path: Path, req: dict, timeout: float | None = 180) -> dict:
    """One request to a supervisor's socket."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        s.connect(str(path))
        s.sendall(json.dumps(req).encode() + b"\n")
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
    return json.loads(buf or b"{}")


# -------------------------------------------------------------------------------------------- Outcrop's own units

def outcrop_units(project: Path, home: Path, user: str = "outcrop") -> dict[str, Spec]:
    """Outcrop's units in the StartOS container, with the settings of their systemd/*.service files."""
    b = project / "bin"
    env = {"OUTCROP_HOME": str(home), "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    return {
        "outcrop-engine@.service": Spec([str(b / "outcrop-serve"), "%i"], user=user, env=env, restart="on-failure",
                                        restart_sec=20, stop_timeout=120, start_limit_interval=600, start_limit_burst=5),
        "outcrop-gateway.service": Spec([str(b / "outcrop-gateway")], user=user, env=env, restart="always", restart_sec=2,
                                        stop_timeout=30, condition_not_exists=str(home / "state" / "bypass.json"),
                                        enabled=True),
        "outcrop-console.service": Spec([str(b / "outcrop-console")], user=user, env=env, restart="always", restart_sec=3,
                                        stop_timeout=20, enabled=True, after=["outcrop-gateway.service"]),
        "outcrop-ollama-bridge.service": Spec([str(b / "outcrop-ollama-bridge"), "--auto"], user=user, env=env,
                                              restart="always", restart_sec=5, enabled=True),
        "outcrop-boot.service": Spec([sys.executable, str(b / "outcrop"), "boot-start"], type="oneshot", user=user, env=env,
                                     remain_after_exit=True, enabled=True,
                                     after=["outcrop-gateway.service", "outcrop-ollama-bridge.service"]),
    }


def main(argv: list[str] | None = None) -> int:
    project = Path(__file__).resolve().parent.parent
    home = Path(os.environ.get("OUTCROP_HOME") or Path.home() / ".outcrop")
    run = Path(os.environ.get("OUTCROP_RUN") or "/run/outcrop")
    user = os.environ.get("OUTCROP_USER", "outcrop")
    (home / "state").mkdir(parents=True, exist_ok=True)
    sup = Supervisor(outcrop_units(project, home, user), home / "logs" / "units",
                     state_file=home / "state" / "supervisor.json", echo=lambda s: print(s, flush=True))
    if os.geteuid() == 0:
        pw = pwd.getpwnam(user)
        for d in (home / "logs", home / "logs" / "units"):
            os.chown(d, pw.pw_uid, pw.pw_gid)
    srv = sup.serve(run / "supervisor.sock", owner=user)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    print(f"outcrop-supervisor: listening on {run / 'supervisor.sock'}", flush=True)
    sup.boot()
    stop.wait()
    print("outcrop-supervisor: stopping every unit", flush=True)
    sup.shutdown()
    srv.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
