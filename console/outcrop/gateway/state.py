"""The gateway's runtime state: the database thread, settings, the event hub, the hold gate, limits and the request recorder."""
from __future__ import annotations

import asyncio
import collections
import json
import logging
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from ..common import db, policy, tokens

log = logging.getLogger("outcrop.gateway")


class Store:
    """All database work runs on one thread, so the event loop never waits on SQLite."""

    def __init__(self, path: Path):
        self.path = path
        self.pool = ThreadPoolExecutor(1, thread_name_prefix="outcrop-db")
        self.con: sqlite3.Connection | None = None

    async def call(self, fn, *args):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self.pool, fn, *args)

    def open(self) -> sqlite3.Connection:
        if self.con is None:
            self.con = db.connect(self.path)
        return self.con

    def data_version(self) -> int:
        return self.open().execute("PRAGMA data_version").fetchone()[0]

    def _close(self):
        if self.con is not None:
            self.con.close()
            self.con = None

    def close(self):
        """Close the connection on the database thread, after whatever it is doing (closing it from another thread while a
        query runs can crash SQLite)."""
        try:
            self.pool.submit(self._close).result(timeout=15)
        except Exception:
            pass
        self.pool.shutdown(wait=True)


@dataclass
class Settings:
    open: policy.OpenWindow | None = None
    open_raw: dict = field(default_factory=dict)
    tokenless: bool = False
    tokenless_nets: list = field(default_factory=list)
    tokenless_raw: dict = field(default_factory=dict)
    cors: list = field(default_factory=list)
    extra_hosts: list = field(default_factory=list)
    capture: dict = field(default_factory=dict)
    web_allowed: bool = True          # the console's master switch for internet access (chat and apps)
    apps_any_link: bool = False       # apps' open_page may open any public link, not only their searches' results

    @classmethod
    def from_db(cls, con: sqlite3.Connection) -> "Settings":
        s = db.all_settings(con)
        mode = s.get("auth.mode") or {}
        win = None
        if mode.get("mode") == "open" and mode.get("until"):
            lis = frozenset(mode.get("listeners") or [policy.OPENAI, policy.OLLAMA])
            win = policy.OpenWindow(float(mode["until"]), policy.parse_networks(mode.get("addresses")), lis,
                                    str(mode.get("by", "")))
        tl = s.get("ollama.tokenless") or {}
        return cls(open=win, open_raw=mode, tokenless=bool(tl.get("enabled")),
                   tokenless_nets=policy.parse_networks(tl.get("addresses")), tokenless_raw=tl,
                   cors=[str(x).rstrip("/") for x in s.get("cors.origins") or []],
                   extra_hosts=[str(x).lower() for x in s.get("hosts.extra") or []],
                   capture=s.get("capture") or {},
                   web_allowed=bool((s.get("chat.settings") or {}).get("web_allowed", True)),
                   apps_any_link=bool((s.get("chat.settings") or {}).get("apps_any_link", False)))


class Hub:
    """Fan-out of gateway events to subscribers (the console, outcrop).  A slow subscriber loses old events, never blocks."""

    def __init__(self, size: int = 2000):
        self.subs: set[asyncio.Queue] = set()
        self.size = size
        self.seq = 0
        self.recent = collections.deque(maxlen=200)

    def publish(self, etype: str, /, **data) -> None:
        self.seq += 1
        ev = {**data, "type": etype, "seq": self.seq, "at": data.get("at") or time.time()}
        self.recent.append(ev)
        for q in list(self.subs):
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(ev)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(self.size)
        self.subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subs.discard(q)


class Hold:
    """Requests that need the model wait here while a switch is in progress or Strata is not loaded."""

    def __init__(self):
        self.ready = asyncio.Event()
        self.explicit: dict[str, dict] = {}      # hold id -> {reason, until, at}
        self.strata_up = False
        self.loaded = False
        self.since = time.time()

    def active(self, now: float | None = None) -> dict | None:
        now = now or time.time()
        live = {k: v for k, v in self.explicit.items() if v["until"] > now}
        self.explicit = live
        return next(iter(live.values()), None) if live else None

    def update(self) -> bool:
        """Recompute; True when the gate changed."""
        ready = self.loaded and self.active() is None
        if ready and not self.ready.is_set():
            self.ready.set()
            self.since = time.time()
            return True
        if not ready and self.ready.is_set():
            self.ready.clear()
            self.since = time.time()
            return True
        return False

    def reason(self) -> str:
        h = self.active()
        if h:
            return h["reason"]
        if not self.strata_up:
            return "the model server is not running"
        if not self.loaded:
            return "the model is loading"
        return ""

    async def wait(self, timeout: float) -> bool:
        if self.ready.is_set():
            return True
        try:
            await asyncio.wait_for(self.ready.wait(), timeout)
            return True
        except asyncio.TimeoutError:
            return False


class Limits:
    """Per-token requests per minute (sliding window) and concurrency, and per-address requests a minute for requests
    without a token (open mode, the token-less option).

    check() reserves the concurrency slot when it allows a request, so two requests that arrive together cannot both
    pass while their bodies are still being read; the caller gives it back with end() whatever happens next."""

    def __init__(self):
        self.hits: dict[str, collections.deque] = {}
        self.active: collections.Counter = collections.Counter()
        self.anon: dict[str, collections.deque] = {}

    def check(self, tok: tokens.Token, now: float) -> tuple[str, float] | None:
        if tok.concurrency and self.active[tok.id] >= tok.concurrency:
            return f"token {tok.name!r} already has {self.active[tok.id]} requests running (its limit)", 1.0
        if tok.rpm:
            dq = self.hits.setdefault(tok.id, collections.deque())
            while dq and dq[0] <= now - 60:
                dq.popleft()
            if len(dq) >= tok.rpm:
                return f"token {tok.name!r} is limited to {tok.rpm} requests a minute", max(1.0, 60 - (now - dq[0]))
            dq.append(now)
        self.active[tok.id] += 1
        return None

    def check_anon(self, ip: str, now: float, rpm: int) -> tuple[str, float] | None:
        if not rpm or rpm <= 0:
            return None
        dqs = []
        for key, mult in policy.addr_keys(ip):
            dq = self.anon.setdefault(key, collections.deque())
            while dq and dq[0] <= now - 60:
                dq.popleft()
            if len(dq) >= rpm * mult:
                return f"requests without an API key are limited to {rpm} a minute from one address", \
                    max(1.0, 60 - (now - dq[0]))
            dqs.append(dq)
        for dq in dqs:
            dq.append(now)
        if len(self.anon) > 10000:
            self.anon = {k: v for k, v in self.anon.items() if v and v[-1] > now - 60}
        return None

    def end(self, tok_id: str | None):
        if tok_id:
            self.active[tok_id] -= 1
            if self.active[tok_id] <= 0:
                del self.active[tok_id]


class DenyLog:
    """Refused requests are recorded, but at most `per_min` per address a minute (an IPv6 /64: four times that) and `global_per_min` in
    all, so a flood cannot fill the database.  Past the global limit they are counted, and summary() gives one row a
    minute for them."""

    def __init__(self, per_min: int = 30, global_per_min: int = 300):
        self.per_min = per_min
        self.global_per_min = global_per_min
        self.win: dict[str, list] = {}
        self.g_start = 0.0
        self.g_count = 0
        self.suppressed = 0
        self.supp_addrs: set[str] = set()
        self.supp_since: float | None = None
        self.last_summary = 0.0

    def allow(self, ip: str, now: float) -> bool:
        over = False
        for key, mult in policy.addr_keys(ip):
            w = self.win.get(key)
            if w is None or now - w[0] >= 60:
                self.win[key] = [now, 1]
                if len(self.win) > 10000:
                    self.win = {k: v for k, v in self.win.items() if now - v[0] < 60}
            else:
                w[1] += 1
                over = over or w[1] > self.per_min * mult
        if over:
            return False
        if now - self.g_start >= 60:
            self.g_start, self.g_count = now, 0
        self.g_count += 1
        if self.g_count > self.global_per_min:
            self.suppressed += 1
            if self.supp_since is None:
                self.supp_since = now
            if len(self.supp_addrs) < 10000:
                self.supp_addrs.add(key)
            return False
        return True

    def summary(self, now: float) -> dict | None:
        """At most once a minute: the refusals past the global limit since the last summary, as a request-log row."""
        if not self.suppressed or now - self.last_summary < 60:
            return None
        n, addrs, since = self.suppressed, len(self.supp_addrs), self.supp_since or now
        self.suppressed, self.supp_addrs, self.supp_since, self.last_summary = 0, set(), None, now
        return {"rid": f"deny_{int(now)}", "started_at": since, "ended_at": now, "listener": "", "client_ip": "",
                "user_agent": "", "app": "", "auth": "denied", "method": "", "path": "", "route_class": "",
                "outcome": "denied", "auth_reason": f"{n} more refused requests from {addrs} addresses (or IPv6 /64s), "
                                                    f"not recorded one by one (over {self.global_per_min} a minute)"}


REQ_COLS = ("rid", "started_at", "first_byte_at", "ended_at", "listener", "client_ip", "user_agent", "app", "token_id", "auth",
            "auth_reason", "method", "path", "route_class", "model", "stream", "status", "outcome", "held_ms", "bytes_in",
            "bytes_out", "prompt_tokens", "output_tokens", "reused_tokens", "ttft_ms", "think_ms", "prefill_tok_s",
            "decode_tok_s", "hit_rate", "pcie_share", "drafts_offered", "drafts_accepted", "finish", "preset", "strata_id",
            "error")


class Recorder:
    """Finished requests wait up to `match_s` for Strata's own record of them (from /metrics), then go to SQLite in one
    transaction a second, with the daily usage and each token's last use."""

    def __init__(self, store: Store, fetch_metrics, hub: Hub, match_s: float = 8.0):
        self.store = store
        self.fetch_metrics = fetch_metrics      # async () -> dict | None
        self.hub = hub
        self.match_s = match_s
        self.pending: list[dict] = []           # waiting for a match
        self.ready: list[dict] = []
        self.last_used: dict[str, tuple] = {}   # token id -> (at, ip, app)
        self.claimed: collections.deque = collections.deque(maxlen=500)
        self.claimed_set: set = set()
        self.wake = asyncio.Event()
        self.bodies: list[tuple] = []

    MAX_BACKLOG = 50_000                    # rows kept for a retry while the database cannot be written

    def add(self, rec: dict, want_match: bool) -> None:
        if rec.get("token_id") and rec.get("auth") != "denied":     # a refused attempt is not a use
            self.last_used[rec["token_id"]] = (rec["ended_at"] or rec["started_at"], rec.get("client_ip"), rec.get("app"))
        if want_match:
            rec["_deadline"] = time.time() + self.match_s
            self.pending.append(rec)
            self.wake.set()
        else:
            self.ready.append(rec)

    def add_body(self, rid: str, at: float, req: bytes | None, resp: bytes | None) -> None:
        self.bodies.append((rid, at, req, resp))

    async def match_loop(self):
        while True:
            await self.wake.wait()
            self.wake.clear()
            await asyncio.sleep(0.3)
            while self.pending:
                try:
                    m = await self.fetch_metrics()
                    recs = m.get("requests") if isinstance(m, dict) else None
                    if isinstance(recs, list):
                        self._match([x for x in recs if isinstance(x, dict)])
                except Exception:
                    log.exception("matching requests with Strata's records failed; they are written without")
                now = time.time()
                keep = []
                for r in self.pending:
                    if r.get("_matched") or r["_deadline"] <= now:
                        r.pop("_deadline", None)
                        r.pop("_matched", None)
                        self.ready.append(r)
                    else:
                        keep.append(r)
                self.pending = keep
                if self.pending:
                    await asyncio.sleep(0.7)

    def _match(self, records: list[dict]) -> None:
        free = []
        for x in records:
            try:
                if isinstance(x.get("id"), (str, int)) and x["id"] not in self.claimed_set and x.get("time"):
                    float(x["time"])
                    free.append(x)
            except (TypeError, ValueError):
                continue
        for r in sorted(self.pending, key=lambda r: r["started_at"]):
            if r.get("_matched"):
                continue
            t0 = r.get("_forwarded_at") or r["started_at"]
            t1 = (r.get("ended_at") or time.time()) + 0.5
            cands = [x for x in free if t0 - 2.0 <= float(x["time"]) <= t1]
            if r.get("output_tokens") is not None:
                exact = [x for x in cands if x.get("output_tokens") == r["output_tokens"]]
                cands = exact or cands
            if not cands:
                continue
            best = min(cands, key=lambda x: abs(float(x["time"]) - t0))
            free.remove(best)
            self.claimed.append(best["id"])
            self.claimed_set = set(self.claimed)
            r["strata_id"] = best["id"]
            for k_src, k_dst in (("hit_rate", "hit_rate"), ("pcie_share", "pcie_share"), ("decode_tok_s", "decode_tok_s"),
                                 ("drafts_offered", "drafts_offered"), ("drafts_accepted", "drafts_accepted")):
                if best.get(k_src) is not None:
                    r[k_dst] = best[k_src]
            if best.get("reused") is not None:
                r["reused_tokens"] = best["reused"]
            if r.get("prompt_tokens") is None and best.get("prompt_tokens") is not None:
                r["prompt_tokens"] = best["prompt_tokens"]
            if r.get("output_tokens") is None and best.get("output_tokens") is not None:
                r["output_tokens"] = best["output_tokens"]
            pm = best.get("prompt_ms")
            read = (best.get("prompt_read") if best.get("prompt_read") is not None
                    else (best.get("prompt_tokens") or 0) - (best.get("reused") or 0))
            if pm and read and pm > 0:
                r["prefill_tok_s"] = round(read / (pm / 1000.0), 1)
            r["_matched"] = True
            self.hub.publish("request.stats", rid=r["rid"], **{k: r.get(k) for k in (
                "hit_rate", "pcie_share", "decode_tok_s", "prefill_tok_s", "drafts_offered", "drafts_accepted",
                "reused_tokens", "prompt_tokens", "output_tokens", "strata_id")})

    async def flush_loop(self):
        while True:
            await asyncio.sleep(1.0)
            try:
                await self.flush()
            except Exception:
                log.exception("writing the request log failed")

    async def flush(self) -> None:
        if not (self.ready or self.last_used or self.bodies):
            return
        rows, self.ready = self.ready, []
        used, self.last_used = self.last_used, {}
        bodies, self.bodies = self.bodies, []
        try:
            await self.store.call(self._write, rows, used, bodies)
        except BaseException:
            # kept for the next try (the transaction was rolled back), within limits: newest rows win
            self.ready = (rows + self.ready)[-self.MAX_BACKLOG:]
            for tid, v in used.items():
                if tid not in self.last_used or self.last_used[tid][0] < v[0]:
                    self.last_used[tid] = v
            self.bodies = (bodies + self.bodies)[-100:]
            raise

    def _write(self, rows: list[dict], used: dict, bodies: list) -> None:
        con = self.store.open()
        with db.tx(con):
            if rows:
                con.executemany(f"INSERT INTO requests({', '.join(REQ_COLS)}) VALUES({', '.join('?' for _ in REQ_COLS)})",
                                [tuple(r.get(c) for c in REQ_COLS) for r in rows])
                daily: dict = {}
                for r in rows:
                    if r.get("route_class") != "inference" or r.get("auth") == "denied":
                        continue
                    day = datetime.fromtimestamp(r["started_at"]).strftime("%Y-%m-%d")
                    k = (day, r.get("token_id") or "")
                    d = daily.setdefault(k, [0, 0, 0, 0])
                    d[0] += 1
                    d[1] += int(r.get("prompt_tokens") or 0)
                    d[2] += int(r.get("output_tokens") or 0)
                    d[3] += 1 if (r.get("status") or 0) >= 400 or r.get("outcome") not in ("ok", None) else 0
                con.executemany("INSERT INTO usage_daily(day, token_id, requests, prompt_tokens, output_tokens, errors) "
                                "VALUES(?,?,?,?,?,?) ON CONFLICT(day, token_id) DO UPDATE SET "
                                "requests=requests+excluded.requests, prompt_tokens=prompt_tokens+excluded.prompt_tokens, "
                                "output_tokens=output_tokens+excluded.output_tokens, errors=errors+excluded.errors",
                                [(k[0], k[1], *v) for k, v in daily.items()])
            for tid, (at, ip, app) in used.items():
                con.execute("UPDATE tokens SET last_used_at=?, last_ip=?, last_app=? WHERE id=? AND "
                            "(last_used_at IS NULL OR last_used_at < ?)", (at, ip, app, tid, at))
            for rid, at, req, resp in bodies:
                con.execute("INSERT OR REPLACE INTO request_bodies(request_rid, created_at, request, response) "
                            "VALUES(?,?,?,?)", (rid, at, req, resp))


def json_dumps(obj) -> bytes:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode()
