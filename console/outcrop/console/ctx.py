"""What the console's parts share: settings, the database (one connection per thread), Strata, and the gateway's socket."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from ..common import config, db


@dataclass
class Options:
    dev: bool = False                      # plain HTTP, relaxed cookie, the Vite dev server's origin allowed
    https: bool = True
    port: int = 443
    http_port: int = 80
    host: str = "::"
    strata_url: str | None = None
    gateway_sock: Path | None = None
    db_path: Path | None = None
    web_dist: Path | None = None
    fake_units: bool = False               # development: pretend to control units (no systemd)
    extra_origins: list = field(default_factory=list)
    gateway_url: str | None = None         # the gateway's OpenAI port, for the playground and the lab
    gateway_ollama_port: int | None = None  # the gateway's Ollama port, for the lab's apitest
    log_dir: Path | None = None            # development: the dev stack's log files instead of the journal
    searx_url: str | None = None           # the chat's web search (SearXNG); default http://127.0.0.1:8888
    fetch_sock: Path | None = None         # the page fetcher's socket; default /run/outcrop-fetch/fetch.sock


class Ctx:
    def __init__(self, opts: Options):
        self.opts = opts
        self.net = config.net()
        self.strata_url = (opts.strata_url or self.net.strata_url).rstrip("/")
        self.upstream_key = config.upstream_key()
        self.gateway_sock = Path(opts.gateway_sock or config.GATEWAY_SOCK)
        self.db_path = Path(opts.db_path or config.DB_PATH)
        self.web_dist = Path(opts.web_dist or config.PROJECT / "web" / "dist")
        self._local = threading.local()
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=None), trust_env=False,
                                        limits=httpx.Limits(max_keepalive_connections=0))
        self.started_at = time.time()
        self.names = config.own_host_names(self.net.extra_hosts)
        self.dev_origins = set(opts.extra_origins) | ({"http://localhost:5173", "http://127.0.0.1:5173"} if opts.dev else set())

    # ----------------------------------------------------------------------------------------------------- database
    def con(self) -> sqlite3.Connection:
        c = getattr(self._local, "con", None)
        if c is None:
            c = db.connect(self.db_path)
            self._local.con = c
        return c

    def write_rollup(self, kind: str, ts: int, agg: dict) -> None:
        table = {"10s": "metrics_10s", "1m": "metrics_1m", "1h": "metrics_1h"}[kind]
        self.con().execute(f"INSERT OR REPLACE INTO {table}(ts, data) VALUES(?,?)", (ts, json.dumps(agg)))

    def retention(self) -> dict:
        con = self.con()
        r = db.get_setting(con, "retention")
        now = time.time()
        out = {}
        with db.tx(con):
            for table, col, days in (("requests", "started_at", r["requests_days"]),
                                     ("request_bodies", "created_at", r["bodies_days"]),
                                     ("metrics_10s", "ts", r["metrics_10s_days"]), ("metrics_1m", "ts", r["metrics_1m_days"]),
                                     ("metrics_1h", "ts", r["metrics_1h_days"]), ("events", "at", r["events_days"]),
                                     ("login_attempts", "at", 30)):
                out[table] = con.execute(f"DELETE FROM {table} WHERE {col} < ?", (now - days * 86400,)).rowcount
            cutoff = time.strftime("%Y-%m-%d", time.localtime(now - r["usage_days"] * 86400))
            out["usage_daily"] = con.execute("DELETE FROM usage_daily WHERE day < ?", (cutoff,)).rowcount
        return out

    # ------------------------------------------------------------------------------------------------------- Strata
    def strata_headers(self) -> dict:
        return {"Authorization": f"Bearer {self.upstream_key}"} if self.upstream_key else {}

    async def strata_get(self, path: str, timeout: float = 5.0):
        try:
            r = await self.client.get(self.strata_url + path, headers=self.strata_headers(), timeout=timeout)
            if r.status_code == 200:
                return r.json()
        except (httpx.HTTPError, ValueError):
            return None
        return None

    # ------------------------------------------------------------------------------------------------------ gateway
    async def gateway(self, method: str, path: str, body: dict | None = None, timeout: float = 5.0):
        if not self.gateway_sock.exists():
            return None
        try:
            tr = httpx.AsyncHTTPTransport(uds=str(self.gateway_sock))
            async with httpx.AsyncClient(transport=tr, base_url="http://gateway", timeout=timeout) as c:
                r = await c.request(method, path, json=body)
                return r.json()
        except (httpx.HTTPError, ValueError):
            return None

    def gateway_sync(self, method: str, path: str, body: dict | None = None, timeout: float = 5.0):
        if not self.gateway_sock.exists():
            return None
        try:
            tr = httpx.HTTPTransport(uds=str(self.gateway_sock))
            with httpx.Client(transport=tr, base_url="http://gateway", timeout=timeout) as c:
                return c.request(method, path, json=body).json()
        except (httpx.HTTPError, ValueError):
            return None
