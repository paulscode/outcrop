#!/usr/bin/env python3
"""health.py console|models|engine|web  - (StartOS) one health check's answer, as JSON: {"result": ..., "message": ...}.

result is StartOS's: success, loading (starting, downloading), failure.  Run by startos/main.ts in the service's container,
as root: it reads the supervisor (lib/units.py), the console's port and Strata's /health.  Standard library only.
"""
from __future__ import annotations

import http.client
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import outcrop_control as LC  # noqa: E402
import units  # noqa: E402

MODELS = "outcrop-models.service"
STEP = re.compile(r"^== (fetching|checking) (\S+)|^(PREP_DONE|PREP_FAILED|FAILED|SHA MISMATCH|NOT DONE)(.*)|^== (preparing.*)")


def answer(result: str, message: str) -> dict:
    return {"result": result, "message": message}


def console() -> dict:
    try:
        c = http.client.HTTPConnection("127.0.0.1", 8800, timeout=3)
        c.request("GET", "/api/auth/session")
        status = c.getresponse().status
        c.close()
    except OSError:
        status = 0
    if status in (200, 401):
        return answer("success", "The console is up")
    st = units.is_active("outcrop-console.service")
    return answer("loading" if st in ("activating", "active") else "failure", f"The console is not answering ({st})")


class _UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float = 5.0):
        super().__init__("fetch", timeout=timeout)
        self._path = path

    def connect(self):
        import socket
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._path)
        self.sock = s


def _get(conn: http.client.HTTPConnection, path: str) -> tuple[int, bytes]:
    try:
        conn.request("GET", path)
        r = conn.getresponse()
        return r.status, r.read()
    except OSError:
        return 0, b""
    finally:
        conn.close()


def web() -> dict:
    """The chat's web access: the page fetcher (and its own check that it cannot reach this server or the LAN) and
    SearXNG, both in the outcrop-web network namespace."""
    st, body = _get(_UnixHTTP("/run/outcrop-fetch/fetch.sock"), "/health")
    try:
        f = json.loads(body) if st == 200 else {}
    except ValueError:
        f = {}
    sx, _ = _get(http.client.HTTPConnection("10.255.53.2", 8080, timeout=5), "/healthz")
    if not f:
        return answer("loading", "Web access is starting (the page fetcher does not answer yet)")
    if not f.get("isolated"):
        open_ = ", ".join(c["target"] for c in f.get("checked", []) if not c.get("blocked")) or "unknown"
        return answer("failure", f"The page fetcher is NOT isolated from your network ({open_}): it refuses every page")
    if sx != 200:
        return answer("loading", "Pages can be opened; web search (SearXNG) is not answering yet")
    return answer("success", "Web search and page reading work, isolated from your network")


def models_step() -> str:
    """What the models unit is doing now, from its journal: the file being fetched or checked, or the preparation."""
    for _, msg in reversed(units.journal(MODELS, lines=200)):
        m = STEP.search(msg)
        if not m:
            continue
        if m.group(1):
            return f"{m.group(1)} {m.group(2)}"
        if m.group(5):
            return m.group(5)
        return (m.group(3) + m.group(4)).strip()
    return "starting"


def models() -> dict:
    p = units.show([MODELS], ["ActiveState", "SubState"]).get(MODELS, {})
    st, sub = p.get("ActiveState", "unknown"), p.get("SubState", "")
    if st == "active" and sub == "exited":
        return answer("success", "The models are downloaded and prepared")
    if st == "failed":
        last = [m for _, m in units.journal(MODELS, lines=30) if m.strip()][-3:]
        return answer("failure", "Downloading or preparing the models stopped: " + " / ".join(last) +
                      " (restart the service to resume: finished files are kept)")
    if st == "activating":
        return answer("loading", "Downloading and preparing the models (hours the first time): " + models_step())
    return answer("loading", "Waiting to download the models")


def engine() -> dict:
    running = LC.running()
    if not running:
        m = units.show([MODELS], ["ActiveState"]).get(MODELS, {}).get("ActiveState")
        if m in ("activating", "inactive", "unknown", None):
            return answer("loading", "Waiting for the models")
        failed = [u for u, active, _ in units.list_engine() if active == "failed"]
        if failed:
            return answer("failure", f"{failed[0].removeprefix('outcrop-engine@').removesuffix('.service')} failed to start "
                          "(the console's Logs page says why)")
        return answer("failure", "No preset is running (choose one in the console)")
    name, _ = running[0]
    h = LC.health()
    if h and h.get("loaded"):
        return answer("success", f"Answering: preset {name}")
    seen = [p for p in (LC.parse_phase(m) for _, m in units.journal(LC.UNIT.format(name), lines=200)) if p]
    label = next((lb for _, k, lb in LC.PHASES if seen and k == seen[-1][0]), "starting")
    return answer("loading", f"Loading preset {name}: {label}")


def main(argv: list[str]) -> int:
    checks = {"console": console, "models": models, "engine": engine, "web": web}
    if len(argv) != 1 or argv[0] not in checks:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        print(json.dumps(checks[argv[0]]()))
    except Exception as e:                       # a health check must answer, not crash
        print(json.dumps(answer("failure", f"the check itself failed: {type(e).__name__}: {e}")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
