"""Test harness: the fake Strata, the real Ollama bridge and the gateway, on free loopback ports, with a fresh database."""
from __future__ import annotations

import asyncio
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_TMP = tempfile.mkdtemp(prefix="outcrop-test-")
os.environ.setdefault("OUTCROP_STATE", str(Path(_TMP) / "state"))
os.environ.setdefault("OUTCROP_RUN", str(Path(_TMP) / "run"))
# never the real ~/.outcrop: the engine library and the command keep state under OUTCROP_HOME too
os.environ.setdefault("OUTCROP_HOME", str(Path(_TMP) / "home"))
# three measured runs from the reference server, for the Lab's import and the presets' measured speeds
# presets.json as ./setup.sh makes it on the reference system: from the m6000-256g profile
sys.path.insert(0, str(ROOT / "lib"))
os.environ.setdefault("OUTCROP_PRESETS", str(Path(_TMP) / "presets.json"))
import json as _json  # noqa: E402
import profiles as _profiles  # noqa: E402
Path(os.environ["OUTCROP_PRESETS"]).write_text(_json.dumps(_profiles.render("m6000-256g"), indent=2) + "\n")
os.environ.setdefault("OUTCROP_BENCH_RESULTS", str(Path(__file__).resolve().parent / "fixtures" / "bench-results"))
sys.path.insert(0, str(ROOT / "console"))

import httpx  # noqa: E402
import uvicorn  # noqa: E402

from fakestrata.server import FakeStrata  # noqa: E402
from outcrop.common import config, db, tokens  # noqa: E402
from outcrop.gateway.__main__ import Server, unix_socket  # noqa: E402
from outcrop.gateway.app import Control, Gateway  # noqa: E402

UPSTREAM_KEY = "strata-internal-test-key-0123456789"


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def bound(port: int = 0) -> socket.socket:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", port))
    s.listen(256)
    s.setblocking(False)
    return s


class Stack:
    def __init__(self, tmp: Path, hold_max_s: float = 3.0):
        self.tmp = tmp
        self.fake = FakeStrata(api_key=UPSTREAM_KEY).start()
        self.bridge_port = free_port()
        self.bridge = subprocess.Popen(
            [sys.executable, str(ROOT / "bin" / "outcrop-ollama-bridge"), "--listen", "127.0.0.1", "--port",
             str(self.bridge_port), "--upstream", self.fake.url],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.db_path = tmp / "outcrop.db"
        self.pepper = b"p" * 32
        self.con = db.connect(self.db_path)
        self.s_openai, self.s_ollama = bound(), bound()
        self.openai_port = self.s_openai.getsockname()[1]
        self.ollama_port = self.s_ollama.getsockname()[1]
        net = config.Net(strata_port=self.fake.port, openai_port=self.openai_port, ollama_port=self.ollama_port,
                         bridge_port=self.bridge_port, hold_max_s=hold_max_s, body_max_mib=1)
        self.gw = Gateway(net, db_path=self.db_path, pepper=self.pepper, upstream_key=UPSTREAM_KEY,
                          strata_url=self.fake.url, bridge_url=f"http://127.0.0.1:{self.bridge_port}",
                          ports={self.openai_port: "openai", self.ollama_port: "ollama"})
        self.sock_path = tmp / "gateway.sock"
        self.ready = threading.Event()
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        if not self.ready.wait(15):
            raise RuntimeError("the gateway did not start")
        self._wait_bridge()

    def _run(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self._main())

    async def _main(self):
        await self.gw.start()
        common = dict(ws="none", lifespan="off", proxy_headers=False, server_header=False, access_log=False,
                      log_level="warning", interface="asgi3")
        self.api = Server(uvicorn.Config(self.gw, http="httptools", timeout_keep_alive=5, **common))
        self.ctl = Server(uvicorn.Config(Control(self.gw), http="h11", **common))
        usock = unix_socket(self.sock_path)
        t = asyncio.gather(self.api.serve(sockets=[self.s_openai, self.s_ollama]), self.ctl.serve(sockets=[usock]))
        await asyncio.sleep(0.2)
        self.ready.set()
        await t
        await self.gw.stop()

    def _wait_bridge(self):
        for _ in range(100):
            try:
                httpx.get(f"http://127.0.0.1:{self.bridge_port}/api/version", timeout=1)
                return
            except httpx.HTTPError:
                time.sleep(0.05)

    # ----------------------------------------------------------------------------------------------------- helpers
    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.openai_port}"

    @property
    def ollama_url(self) -> str:
        return f"http://127.0.0.1:{self.ollama_port}"

    def token(self, name="t", **kw) -> str:
        _, plain = tokens.create(self.con, self.pepper, name, **kw)
        self.reload()
        return plain

    def reload(self):
        asyncio.run_coroutine_threadsafe(self.gw.reload(), self.loop).result(5)

    def set(self, key, value):
        db.set_setting(self.con, key, value, by="test")
        self.reload()

    def control(self, method, path, json=None):
        tr = httpx.HTTPTransport(uds=str(self.sock_path))
        with httpx.Client(transport=tr, base_url="http://gateway", timeout=10) as c:
            r = c.request(method, path, json=json)
            return r.json()

    def flush(self):
        asyncio.run_coroutine_threadsafe(self.gw.recorder.flush(), self.loop).result(5)

    def stop(self):
        self.api.should_exit = True
        self.ctl.should_exit = True
        self.thread.join(10)
        self.bridge.terminate()
        self.bridge.wait(5)
        self.fake.stop()
        self.con.close()


@pytest.fixture
def stack(tmp_path):
    s = Stack(tmp_path)
    try:
        yield s
    finally:
        s.stop()


def chat(stream=False, **kw):
    body = {"model": "qwen3.8-flash-next", "messages": [{"role": "user", "content": "hi"}], "stream": stream}
    body.update(kw)
    return body
