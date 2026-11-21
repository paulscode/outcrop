"""outcrop-gateway: checks an API token on every request to ports 8080 and 11434, then passes it to Strata (or to the Ollama bridge)
on loopback with the internal key, streams the answer back, and records what happened.

Raw ASGI (served by uvicorn), so streaming, disconnects and timeouts are under direct control:
  - a client that hangs up closes the upstream connection at once, so Strata cancels the work;
  - nothing times out while Strata reads a long prompt (a 1M-token prompt sends nothing for two hours when not streamed);
  - writing to a client that stopped reading gives up after 60 s.
"""
from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import json
import logging
import secrets
import socket
import time
from dataclasses import dataclass, field
from datetime import datetime

import httpx

from ..common import apps, config, db, policy, tokens
from ..common.policy import INFERENCE, OLLAMA, OPENAI, PUBLIC, TELEMETRY
from . import bodies, streams
from .state import DenyLog, Hold, Hub, Limits, Recorder, Settings, Store, json_dumps

log = logging.getLogger("outcrop.gateway")

HOP = {b"connection", b"keep-alive", b"proxy-connection", b"te", b"trailer", b"transfer-encoding", b"upgrade"}
DROP_REQ = HOP | {b"host", b"authorization", b"x-api-key", b"cookie", b"proxy-authorization", b"content-length", b"expect",
                  b"x-forwarded-for", b"x-forwarded-proto", b"x-forwarded-host", b"forwarded", b"x-real-ip", b"origin"}
DROP_RESP = HOP | {b"server", b"date", b"set-cookie"}
MAX_HEADER_BYTES = 64 << 10
WRITE_TIMEOUT = 60.0
BODY_IDLE_S = 30.0          # the longest wait for the next piece of a request body
BODY_TOTAL_S = 300.0        # the longest a whole request body may take to arrive
SMALL_BODY = 1 << 20        # the body limit for routes that do not take a conversation (admin, Ollama's /api/show, MCP)
INLINE_PARSE = 1 << 20      # bodies up to this size are read on the event loop; larger ones on a thread, one at a time
BIG_BODY_KINDS = policy.GENERATING | {"count", "images"}


class ClientGone(Exception):
    pass


@dataclass
class Flight:
    """One request in progress."""
    rid: str
    listener: str
    method: str
    path: str
    route: policy.Route
    client_ip: str
    user_agent: str
    app: str
    decision: policy.Decision
    started_at: float
    token_id: str | None = None
    token_name: str | None = None
    model: str | None = None
    stream: bool | None = None
    held_ms: float = 0.0
    forwarded_at: float | None = None
    first_byte_at: float | None = None
    status: int | None = None
    bytes_in: int = 0
    bytes_out: int = 0
    parser: streams.Parser | None = None
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    cancel_reason: str = ""
    response_started: bool = False
    outcome: str | None = None
    error: str | None = None
    phase: str = "waiting"
    last_progress: float = 0.0
    capture_req: bytes | None = None
    capture_resp: bytearray | None = None
    retry_ok: bool = False      # a refused connection to Strata may wait in the hold and try once more
    body: bytes | None = None   # the request body, until Strata (or the bridge) has it
    budget: int = 0             # its bytes in the gateway's body budget, given back with the body

    def public(self) -> dict:
        s = self.parser.stats if self.parser else None
        return {"rid": self.rid, "listener": self.listener, "method": self.method, "path": self.path[:300],
                "client_ip": self.client_ip, "app": self.app, "token_id": self.token_id, "token": self.token_name,
                "auth": self.decision.mode, "model": self.model, "stream": self.stream, "started_at": self.started_at,
                "first_token_at": s.first_token_at if s else None, "answer_at": s.answer_at if s else None,
                "tokens": s.tokens_so_far if s else 0, "phase": self.phase, "held_ms": self.held_ms,
                "kind": self.route.kind}


def norm_ip(ip: str | None) -> str:
    if not ip:
        return ""
    try:
        a = ipaddress.ip_address(ip.split("%", 1)[0])
    except ValueError:
        return ip
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped:
        return str(a.ipv4_mapped)
    return str(a)


def client_ip(peer: str | None, headers: dict[str, str], proxied: bool, trusted: frozenset[str]) -> str:
    """The client's address: the TCP peer, except on the port behind a reverse proxy (gateway.proxied_port) when the peer is
    one of the trusted proxies.  Then it is the last X-Forwarded-For entry, the one that proxy wrote (StartOS's replaces
    whatever the client sent).  Forwarded and X-Real-IP are never read: StartOS passes a client's Forwarded through."""
    ip = norm_ip(peer)
    if not proxied or ip not in trusted:
        return ip
    last = (headers.get("x-forwarded-for") or "").split(",")[-1].strip()
    try:
        ipaddress.ip_address(last.split("%", 1)[0])
    except ValueError:
        return ip                    # nothing usable: the proxy itself
    return norm_ip(last)


def error_body(dialect: str, status: int, message: str, code: str | None = None) -> bytes:
    if dialect == policy.D_ANTHROPIC:
        t = {400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error",
             405: "invalid_request_error", 413: "request_too_large", 429: "rate_limit_error"}.get(status, "api_error")
        return json_dumps({"type": "error", "error": {"type": t, "message": message}})
    if dialect == policy.D_OLLAMA:
        return json_dumps({"error": message})
    t = {401: "authentication_error", 403: "permission_error", 404: "not_found_error", 429: "rate_limit_error",
         413: "invalid_request_error", 400: "invalid_request_error", 405: "invalid_request_error"}.get(status, "server_error")
    c = code or {401: "invalid_api_key", 403: "forbidden", 404: "not_found", 429: "rate_limit_exceeded",
                 503: "unavailable"}.get(status)
    return json_dumps({"error": {"message": message, "type": t, "code": c}})


class Gateway:
    def __init__(self, net: config.Net, *, db_path=None, pepper: bytes | None = None, upstream_key: str | None = None,
                 strata_url: str | None = None, bridge_url: str | None = None, ports: dict | None = None,
                 searx_url: str | None = None, fetch_sock=None):
        self.net = net
        self.store = Store(db_path or config.DB_PATH)
        self.pepper = pepper if pepper is not None else tokens.load_pepper()
        self.upstream_key = upstream_key if upstream_key is not None else config.upstream_key(create=True)
        self.strata_url = (strata_url or net.strata_url).rstrip("/")
        self.bridge_url = (bridge_url or net.bridge_url).rstrip("/")
        self.upstream_host = self.strata_url.split("://", 1)[-1].encode()
        # local port -> listener
        self.ports = ports or {net.openai_port: OPENAI, net.ollama_port: OLLAMA,
                               **({net.https_port: OPENAI} if net.https_port else {}),
                               **({net.proxied_port: OPENAI} if net.proxied_port else {})}
        self.proxied_ports = frozenset({net.proxied_port} - {0})
        self.trusted_proxies = frozenset(norm_ip(x) for x in net.trusted_proxies)
        self.tokens = tokens.TokenCache(self.pepper)
        self.settings = Settings()
        self.names: set[str] = set()
        self.hub = Hub()
        self.hold = Hold()
        self.limits = Limits()
        self.denylog = DenyLog()
        self.inflight: dict[str, Flight] = {}
        self.held = 0
        self.started_at = time.time()
        self.health: dict = {}
        self.preset: str | None = None
        self.counts = {"requests": 0, "denied": 0, "errors": 0}
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=None, write=60.0, pool=10.0),
            limits=httpx.Limits(max_connections=512, max_keepalive_connections=0),
            trust_env=False, follow_redirects=False)
        self.recorder = Recorder(self.store, self._fetch_metrics, self.hub)
        from .webmcp import WebMCP
        self.webmcp = WebMCP(searx_url, fetch_sock, store=self.store)
        self.tasks: list[asyncio.Task] = []
        self.db_ok = True
        self._dv = None
        self.capture_count = 0
        self.body_inflight = 0                      # bytes of request bodies held in memory now
        self._parse_lock = asyncio.Semaphore(1)     # large bodies are parsed one at a time (memory)
        self._lan: list[str] | None = None          # this machine's LAN addresses, read once at start
        self._probe_fails = 0

    # ---------------------------------------------------------------------------------------------------------- startup
    async def start(self) -> None:
        await self.store.call(self.store.open)
        self._lan = await asyncio.to_thread(config.lan_addresses)
        self._dv = await self.store.call(self.store.data_version)
        await self.reload()
        await self._probe()
        for name, fn in (("poll_db", self._poll_db), ("probe", self._probe_loop), ("flush", self.recorder.flush_loop),
                         ("match", self.recorder.match_loop), ("tick", self._tick)):
            self.tasks.append(asyncio.create_task(self._supervise(name, fn), name=f"gateway-{name}"))
        log.info("gateway ready: %d tokens, auth %s, upstream %s, bridge %s", len(self.tokens.by_id),
                 "open" if self.settings.open else "enforced", self.strata_url, self.bridge_url)

    async def _supervise(self, name: str, fn) -> None:
        """A background loop that fails is logged and started again, never lost without a word."""
        while True:
            try:
                await fn()
                return
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("the gateway's %s loop failed; starting it again", name)
                await asyncio.sleep(1.0)

    async def stop(self) -> None:
        for t in self.tasks:
            t.cancel()
        with contextlib.suppress(Exception):
            await self.recorder.flush()
            # whatever still waits for a match goes in as it is
            self.recorder.ready += self.recorder.pending
            self.recorder.pending = []
            await self.recorder.flush()
        await self.client.aclose()
        self.store.close()

    async def reload(self) -> bool:
        def load():
            con = self.store.open()
            cache = tokens.TokenCache(self.pepper)
            cache.load(con)
            st = Settings.from_db(con)
            cap = 0
            c = st.capture
            if c.get("enabled") and c.get("started_at"):
                cap = con.execute("SELECT count(*) FROM request_bodies WHERE created_at >= ?",
                                  (c["started_at"],)).fetchone()[0]
            return cache, st, cap
        try:
            cache, st, cap = await self.store.call(load)
        except Exception:
            self.db_ok = False
            log.exception("reading tokens and settings failed; serving from memory")
            self.hub.publish("db.error")
            return False
        self.db_ok = True
        was_open = self.settings.open
        self.tokens, self.settings, self.capture_count = cache, st, cap
        self.webmcp.configure(st.web_allowed, st.apps_any_link)
        self.names = config.own_host_names(self.net.extra_hosts + st.extra_hosts, lan=self._lan)
        if bool(was_open) != bool(st.open):
            self.hub.publish("auth.mode", mode="open" if st.open else "enforced", until=st.open.until if st.open else None)
        return True

    async def _poll_db(self) -> None:
        """Another process (the console, outcrop) changed tokens or settings: SQLite's data_version moves."""
        while True:
            await asyncio.sleep(1.0)
            await self._poll_once()

    async def _poll_once(self) -> None:
        try:
            dv = await self.store.call(self.store.data_version)
        except Exception:
            if self.db_ok:
                log.exception("the database cannot be read; serving from memory")
                self.hub.publish("db.error")
            self.db_ok = False
            return
        # the version is recorded only once the reload worked, so a failed reload is tried again next second
        if dv != self._dv and await self.reload():
            self._dv = dv

    async def _tick(self) -> None:
        """Once a second: close an open window that has run out (it is also checked on every request), end old holds."""
        while True:
            await asyncio.sleep(1.0)
            now = time.time()
            w = self.settings.open
            if w is not None and now >= w.until:
                self.settings.open = None
                self.hub.publish("auth.mode", mode="enforced", until=None, reason="expired")
                try:
                    await self.store.call(self._close_window, w.until)
                except Exception:
                    log.exception("recording the end of the open window failed")
            if self.hold.explicit and self.hold.update():
                self._publish_hold()
            row = self.denylog.summary(now)
            if row:
                self.recorder.add(row, want_match=False)

    def _close_window(self, until: float) -> None:
        con = self.store.open()
        with db.tx(con):
            cur = db.get_setting(con, "auth.mode")
            if cur.get("mode") == "open" and float(cur.get("until") or 0) <= time.time():
                opened = cur.get("at")
                db.set_setting(con, "auth.mode", {"mode": "enforced"}, by="expiry")
                mins = f" (it was open {(until - opened) / 60:.0f} min)" if opened else ""
                db.add_event(con, "auth.close", "the API closed by itself: tokens are required again" + mins,
                             actor="gateway", details={"reason": "expired", "until": until})
        # _dv is left alone: this connection's own commit does not move data_version, and recording the current value
        # here would swallow another process's change (a revocation) made since the last poll

    async def _probe_loop(self) -> None:
        while True:
            await asyncio.sleep(1.0)
            await self._probe()

    async def _probe(self) -> None:
        up, loaded, h, answered = False, False, {}, False
        try:
            r = await self.client.get(self.strata_url + "/health", timeout=2.0)
            if r.status_code == 200:
                h = r.json()
                if isinstance(h, dict):
                    up, loaded, answered = True, bool(h.get("loaded")), True
                else:
                    h = {}
        except Exception:
            pass
        if answered:
            self._probe_fails = 0
        else:
            self._probe_fails += 1
            if self._probe_fails < 2 and self.hold.strata_up:
                return              # one slow or failed probe (Strata busy) does not close the gate: the next decides
        changed = (up, loaded) != (self.hold.strata_up, self.hold.loaded)
        self.hold.strata_up, self.hold.loaded = up, loaded
        if h:
            self.health = h
        if changed:
            if loaded:
                await self._learn_preset()
            self.hub.publish("strata", up=up, loaded=loaded, preset=self.preset)
        if self.hold.update():
            self._publish_hold()

    async def _learn_preset(self) -> None:
        try:
            r = await self.client.get(self.strata_url + "/v1/models", headers=self._up_auth(), timeout=5.0)
            for m in r.json().get("data", []):
                if ":" in m.get("id", "") and m.get("alias_of"):
                    self.preset = m["id"].split(":", 1)[1]
                    return
        except Exception:
            pass

    def _publish_hold(self) -> None:
        self.hub.publish("hold" if not self.hold.ready.is_set() else "release", reason=self.hold.reason(),
                         waiting=self.held)

    def _up_auth(self) -> dict:
        return {"Authorization": f"Bearer {self.upstream_key}"} if self.upstream_key else {}

    async def _fetch_metrics(self) -> dict | None:
        try:
            r = await self.client.get(self.strata_url + "/metrics", headers=self._up_auth(), timeout=5.0)
            if r.status_code == 200:
                return r.json()
        except Exception:
            return None
        return None

    # ---------------------------------------------------------------------------------------------------------- policy
    def decide(self, listener: str, route: policy.Route, ip: str, method: str, raw_headers, h: dict,
               now: float, local_ip: str = "") -> policy.Decision:
        if route.cls == PUBLIC:
            return policy.Decision(True, "public", reason="public")
        try:
            presented_all = policy.credentials(raw_headers)
        except policy.BadCredential as e:
            return policy.Decision(False, "denied", 401, str(e), "bad credential")
        fail: tuple | None = None
        for cand in presented_all:
            lk = self.tokens.lookup(cand, now)
            t = lk.token
            this: tuple | None
            if lk.status == "ok":
                if listener not in t.listeners:
                    port = self.net.ollama_port if listener == OLLAMA else self.net.openai_port
                    this = (403, f"token {t.name!r} is not allowed on port {port}", "listener", t)
                elif not t.allows_ip(ip):
                    this = (403, f"token {t.name!r} is not allowed from {ip}", "network", t)
                elif not t.allows_scope(route.cls):
                    this = (403, f"token {t.name!r} does not have the {route.cls} scope", "scope", t)
                else:
                    lim = self.limits.check(t, now)         # reserves a concurrency slot: handle() gives it back
                    if lim:
                        return policy.Decision(False, "denied", 429, lim[0], "limit", t, lim[1])
                    return policy.Decision(True, "token", reason="token", token=t)
            elif lk.status == "unknown":
                this = (401, "unknown API key", f"unknown key {policy.unknown_hint(cand)}", None)
            elif lk.status == "revoked":
                this = (401, "this API key was revoked", "revoked", t)
            elif lk.status == "expired":
                this = (401, "this API key has expired", "expired", t)
            else:
                this = (401, "this API key was replaced by a new one (rotated)", "rotated", t)
            # keep the most telling refusal: a known token's reason over "unknown"
            if fail is None or (fail[3] is None and this[3] is not None):
                fail = this
        # no usable token: open mode, or the token-less Ollama option
        w = self.settings.open
        if route.cls in (INFERENCE, TELEMETRY) and w is not None and w.covers(listener, ip, now):
            bad = self._browser_check(method, h, local_ip) or self._anon_limit(ip, now)
            if bad:
                return bad
            why = "open" + (f"; {fail[2]}" if fail else "")
            return policy.Decision(True, "open", reason=why)
        if (route.cls == INFERENCE and listener == OLLAMA and self.settings.tokenless
                and policy.ip_in(ip, self.settings.tokenless_nets)):
            bad = self._browser_check(method, h, local_ip) or self._anon_limit(ip, now)
            if bad:
                return bad
            return policy.Decision(True, "tokenless", reason=f"token-less Ollama option for {ip}")
        if fail:
            d = policy.Decision(False, "denied", fail[0], fail[1], fail[2])
            d.token = fail[3]
            return d
        return policy.Decision(False, "denied", 401, "an API key is required: send it as Authorization: Bearer <token>",
                               "missing")

    def _anon_limit(self, ip: str, now: float) -> policy.Decision | None:
        lim = self.limits.check_anon(ip, now, self.net.open_rpm)
        if lim:
            return policy.Decision(False, "denied", 429, lim[0], "limit", None, lim[1])
        return None

    def _own_ports(self) -> frozenset:
        """The ports a page of this server's own can come from: the gateway's and the console's HTTPS."""
        n = self.net
        return frozenset(p for p in (n.openai_port, n.ollama_port, n.https_port, n.console_port, *self.ports) if p)

    def _browser_check(self, method: str, h: dict, local_ip: str = "") -> policy.Decision | None:
        """While a request needs no token, the browser protections Strata drops with a key are ours to keep.  The address
        the connection arrived on is one of this server's own, so it is always an acceptable Host."""
        names = self.names | {local_ip} if local_ip else self.names
        if not policy.host_allowed(h.get("host"), names):
            return policy.Decision(False, "denied", 403, "this server does not answer to that host name "
                                   "(add it to the gateway's hosts if it is yours)", "host")
        if method not in ("GET", "HEAD") and not policy.origin_allowed(h.get("origin"), h.get("host"), names,
                                                                        self.settings.cors, self._own_ports()):
            return policy.Decision(False, "denied", 403, "requests from other web sites are refused "
                                   "(list the site's origin for CORS if it should be allowed)", "origin")
        if h.get("sec-fetch-site") == "cross-site" and method not in ("GET", "HEAD") and h.get("origin") is None:
            return policy.Decision(False, "denied", 403, "requests from other web sites are refused", "origin")
        return None

    # ------------------------------------------------------------------------------------------------------------ ASGI
    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            return await self._lifespan(receive, send)
        if scope["type"] != "http":
            return
        server = scope.get("server") or ("", 0)
        listener = self.ports.get(server[1] if server else 0, OPENAI)
        try:
            await self.handle(listener, scope, receive, send)
        except ClientGone:
            pass

    async def _lifespan(self, receive, send):
        while True:
            m = await receive()
            if m["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            elif m["type"] == "lifespan.shutdown":
                await send({"type": "lifespan.shutdown.complete"})
                return

    async def handle(self, listener: str, scope, receive, send):
        now = time.time()
        method = scope["method"].upper()
        raw = scope.get("raw_path")
        raw_path = raw.decode("latin-1") if raw else scope["path"]
        qs = scope.get("query_string") or b""
        raw_headers = scope.get("headers") or []
        h: dict[str, str] = {}
        size = 0
        for k, v in raw_headers:
            size += len(k) + len(v)
            h[k.decode("latin-1").lower()] = v.decode("latin-1")
        client = scope.get("client")
        server = scope.get("server")
        ip = client_ip(client[0] if client else "", h, bool(server and server[1] in self.proxied_ports), self.trusted_proxies)
        rid = "req_" + secrets.token_hex(6)
        if size > MAX_HEADER_BYTES:
            return await self._plain(send, 431, b'{"error":{"message":"request headers too large"}}', rid)
        route = policy.classify(listener, method, raw_path)
        if route is None:
            status = 405 if policy.known_path(listener, raw_path) else 404
            dialect = policy.D_OLLAMA if listener == OLLAMA and raw_path.startswith("/api/") else policy.D_OPENAI
            msg = "method not allowed" if status == 405 else "not found"
            return await self._error(send, dialect, status, msg, rid, h)
        if route.kind == "preflight":
            return await self._preflight(send, h, rid)
        ua = h.get("user-agent", "")
        app = apps.recognize(ua, h)
        local_ip = norm_ip(server[0]) if server and server[0] else ""
        decision = self.decide(listener, route, ip, method, raw_headers, h, now, local_ip)
        if not decision.allowed:
            self.counts["denied"] += 1
            tok = decision.token
            self.hub.publish("auth.fail", rid=rid, ip=ip, app=app, path=raw_path.split("?")[0], listener=listener,
                             status=decision.status, reason=decision.reason, token=getattr(tok, "name", None))
            if self.denylog.allow(ip, now):
                self.recorder.add({"rid": rid, "started_at": now, "ended_at": now, "listener": listener, "client_ip": ip,
                                   "user_agent": ua[:300], "app": app, "token_id": getattr(tok, "id", None),
                                   "auth": "denied", "auth_reason": decision.reason, "method": method,
                                   "path": raw_path.split("?")[0][:300], "route_class": route.cls,
                                   "status": decision.status, "outcome": "denied"}, want_match=False)
            extra = []
            if decision.status == 401:
                extra.append((b"www-authenticate", b'Bearer realm="outcrop"'))
            if decision.retry_after:
                extra.append((b"retry-after", str(int(decision.retry_after + 0.999)).encode()))
            return await self._error(send, route.dialect, decision.status, decision.message, rid, h, extra)
        reserved = decision.token.id if decision.mode == "token" and decision.token is not None else None
        held_bytes = 0
        try:
            if route.kind == "health":
                return await self._health(send, listener, ip, rid, h)
            if route.kind == "home":
                return await self._home(send, h, local_ip, rid)

            # the body: read whole (the gateway needs `stream` and `model`), within the limit, the memory budget and
            # the time limits (a client that sends a body slowly or never cannot hold the connection for ever)
            limit = self.net.body_max_mib << 20
            if route.kind not in BIG_BODY_KINDS:
                limit = min(limit, SMALL_BODY)
            budget = self.net.body_budget_mib << 20
            too_big = f"the request body is over {max(1, limit >> 20)} MiB"
            busy = "the server holds too many large request bodies right now; try again shortly"
            cl = h.get("content-length")
            if cl is not None:
                try:
                    n = int(cl)
                except ValueError:
                    return await self._error(send, route.dialect, 400, "invalid Content-Length", rid, h)
                if n > limit:
                    return await self._error(send, route.dialect, 413, too_big, rid, h)
                if n > 0:
                    if self.body_inflight + n > budget:
                        return await self._error(send, route.dialect, 503, busy, rid, h, [(b"retry-after", b"5")])
                    self.body_inflight += n
                    held_bytes = n
            chunks, total = [], 0
            deadline = time.monotonic() + BODY_TOTAL_S
            while True:
                left = deadline - time.monotonic()
                try:
                    if left <= 0:
                        raise asyncio.TimeoutError
                    m = await asyncio.wait_for(receive(), min(BODY_IDLE_S, left))
                except asyncio.TimeoutError:
                    return await self._error(send, route.dialect, 408, "the request body did not arrive in time",
                                             rid, h, [(b"connection", b"close")])
                if m["type"] == "http.disconnect":
                    return
                b = m.get("body", b"")
                total += len(b)
                if total > limit:
                    return await self._error(send, route.dialect, 413, too_big, rid, h, [(b"connection", b"close")])
                if total > held_bytes:
                    if self.body_inflight + (total - held_bytes) > budget:
                        return await self._error(send, route.dialect, 503, busy, rid, h,
                                                 [(b"retry-after", b"5"), (b"connection", b"close")])
                    self.body_inflight += total - held_bytes
                    held_bytes = total
                chunks.append(b)
                if not m.get("more_body"):
                    break
            body = b"".join(chunks)
            del chunks

            tok = decision.token
            f = Flight(rid=rid, listener=listener, method=method, path=raw_path.split("?")[0], route=route,
                       client_ip=ip, user_agent=ua[:300], app=app, decision=decision, started_at=now,
                       token_id=getattr(tok, "id", None), token_name=getattr(tok, "name", None), bytes_in=len(body))
            f.budget, held_bytes = held_bytes, 0       # from here the budget goes with the body (_drop_body)
            self.inflight[f.rid] = f
            self.counts["requests"] += 1
            try:
                if method == "POST" and route.kind != "mcp" and body:
                    try:
                        seen = await self._inspect(body, route)
                    except bodies.Refused as e:
                        f.outcome, f.status, f.error = "refused", e.status, str(e)[:300]
                        return await self._error(send, route.dialect, e.status, str(e), rid, h)
                    if seen.removed_mcp:
                        log.info("removed strata_mcp from a request by %s", getattr(tok, "name", None) or ip)
                    body = seen.body
                    f.bytes_in = len(body)
                    f.model, f.stream = seen.model, seen.stream
                    del seen
                if self._capturing(f):
                    f.capture_req = body[:4 << 20]
                    f.capture_resp = bytearray()
                f.body = body
                del body
                self.hub.publish("request.start", **f.public())
                await self._serve(f, scope, receive, send, h, qs)
            finally:
                self._drop_body(f)
                self.inflight.pop(f.rid, None)
                self._finish(f)
        finally:
            self.body_inflight -= held_bytes
            if reserved:
                self.limits.end(reserved)

    def _drop_body(self, f: Flight) -> None:
        """The body has been passed on (or the request ended): give its bytes back to the budget and let it go."""
        if f.budget:
            self.body_inflight -= f.budget
            f.budget = 0
        f.body = None

    async def _body_stream(self, f: Flight):
        body = f.body
        yield body
        del body
        self._drop_body(f)                          # written whole to Strata (or the bridge)

    async def _inspect(self, body: bytes, route: policy.Route) -> bodies.Seen:
        """bodies.inspect: on the event loop for a small body, else on a thread, one large body at a time."""
        ollama = route.dialect == policy.D_OLLAMA
        gen = ollama and route.kind in ("ollama-chat", "ollama-generate")
        if len(body) <= INLINE_PARSE:
            return bodies.inspect(body, ollama, gen)
        async with self._parse_lock:
            return await asyncio.to_thread(bodies.inspect, body, ollama, gen)

    def _capturing(self, f: Flight) -> bool:
        c = self.settings.capture
        if not c.get("enabled") or f.route.kind not in policy.GENERATING:
            return False
        if c.get("until") and time.time() >= float(c["until"]):
            return False
        if c.get("token_id") and c["token_id"] != f.token_id:
            return False
        tok = f.decision.token
        if getattr(tok, "kind", None) == "console" and c.get("token_id") != f.token_id:
            return False            # the console's own chat and playground: only when capture names that token
        if c.get("max_requests") and self.capture_count >= int(c["max_requests"]):
            return False
        self.capture_count += 1
        return True

    async def _serve(self, f: Flight, scope, receive, send, h: dict, qs: bytes):
        if f.route.kind == "mcp":
            return await self._mcp(f, receive, send, h, f.body or b"")
        retried = False
        while True:
            # wait while a switch or a start is in progress
            if f.route.hold and not self.hold.ready.is_set():
                if not await self._hold_wait(f, receive, send, h):
                    return
            upstream = (self.bridge_url if f.route.target == policy.T_BRIDGE else self.strata_url) + f.path
            if qs:
                upstream += "?" + qs.decode("latin-1")
            fwd = [(k, v) for k, v in scope.get("headers") or [] if k.lower() not in DROP_REQ]
            fwd.append((b"host", self.upstream_host if f.route.target == policy.T_STRATA else
                        self.bridge_url.split("://", 1)[-1].encode()))
            if self.upstream_key:
                fwd.append((b"authorization", f"Bearer {self.upstream_key}".encode()))
            fwd.append((b"x-forwarded-for", f.client_ip.encode()))
            fwd.append((b"x-forwarded-proto", b"https" if scope.get("scheme") == "https" else b"http"))
            fwd.append((b"x-request-id", f.rid.encode()))
            origin = h.get("origin")
            if origin:
                # Strata's own page (same origin as this gateway) stays "own" behind the proxy: Strata compares Origin
                # with Host
                same = h.get("host") and origin.rstrip("/").split("://", 1)[-1].lower() == h["host"].lower()
                fwd.append((b"origin", (f"http://{self.upstream_host.decode()}" if same else origin).encode()))
            # Strata refused the connection (it stopped or restarts between two probes): the request waits in the hold
            # like one that arrived a moment later, and is tried once more
            f.retry_ok = not retried and f.route.hold and f.route.target == policy.T_STRATA
            await self._forward(f, upstream, fwd, receive, send, h)
            if f.outcome != "retry":
                return
            retried = True
            f.outcome = f.status = f.error = None
            self._strata_down()

    def _strata_down(self) -> None:
        """A connection to Strata was refused: close the gate now rather than at the next probes."""
        self.hold.strata_up = self.hold.loaded = False
        self._probe_fails = max(self._probe_fails, 2)
        if self.hold.update():
            self._publish_hold()

    def _cancel_msg(self, f: Flight) -> str:
        return f"cancelled by the server's administrator{': ' + f.cancel_reason if f.cancel_reason else ''}"

    async def _hold_wait(self, f: Flight, receive, send, h: dict) -> bool:
        """Wait for the gate.  True: go on; False: the request was answered (or its client left)."""
        if self.held >= self.net.max_held:
            f.outcome, f.status = "held_full", 503
            msg = f"the model is not available right now ({self.hold.reason()}) and too many requests wait already"
            await self._error(send, f.route.dialect, 503, msg, f.rid, h, [(b"retry-after", b"10")])
            return False
        f.phase = "held"
        self.held += 1
        self.hub.publish("request.held", rid=f.rid, reason=self.hold.reason())
        t0 = time.time()
        gone = asyncio.create_task(self._wait_disconnect(receive))
        ok = asyncio.create_task(self.hold.wait(self.net.hold_max_s))
        cancel = asyncio.create_task(f.cancel.wait())
        try:
            done, _ = await asyncio.wait({gone, ok, cancel}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            self.held -= 1
            for t in (gone, ok, cancel):
                if not t.done():
                    t.cancel()
        f.held_ms = round(f.held_ms + (time.time() - t0) * 1000, 1)
        if gone in done:
            f.outcome = "client_gone"
            return False
        if cancel in done:
            f.outcome, f.status = "cancelled", 503
            with contextlib.suppress(Exception):
                await self._error(send, f.route.dialect, 503, self._cancel_msg(f), f.rid, h)
            return False
        if not ok.result():
            if self.hold.active() is not None or not self.hold.strata_up:
                f.outcome = "held_timeout"
                f.status = 503
                msg = f"the model is not available right now ({self.hold.reason()}); try again shortly"
                await self._error(send, f.route.dialect, 503, msg, f.rid, h, [(b"retry-after", b"10")])
                return False
            # Strata answers but says it is not loaded: let it decide (it may load on use)
        f.phase = "waiting"
        return True

    async def _forward(self, f: Flight, upstream: str, fwd, receive, send, h: dict):
        proxy = asyncio.create_task(self._proxy(f, upstream, fwd, send, h))
        gone = asyncio.create_task(self._wait_disconnect(receive))
        cancel = asyncio.create_task(f.cancel.wait())
        try:
            done, _ = await asyncio.wait({proxy, gone, cancel}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in (gone, cancel):
                if not t.done():
                    t.cancel()
        if proxy in done:
            exc = proxy.exception()
            if isinstance(exc, ClientGone):
                f.outcome = "client_gone"
            elif exc is not None:
                log.error("passing on %s %s failed", f.method, f.path, exc_info=exc)
                f.outcome, f.error = "error", f"{type(exc).__name__}: {exc}"[:300]
                if not f.response_started:
                    f.status = 502
                    with contextlib.suppress(Exception):
                        await self._error(send, f.route.dialect, 502, "the gateway could not pass this request on",
                                          f.rid, h)
            return
        # the client hung up, or the request was cancelled: close the upstream connection now, so Strata stops
        proxy.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await proxy
        if cancel in done and gone not in done:
            f.outcome = "cancelled"
            msg = self._cancel_msg(f)
            with contextlib.suppress(Exception):
                if not f.response_started:
                    f.status = 503
                    await self._error(send, f.route.dialect, 503, msg, f.rid, h)
                else:
                    tail = self._error_tail(f, msg)
                    if tail:
                        await self._send(send, {"type": "http.response.body", "body": tail, "more_body": True})
                    await self._send(send, {"type": "http.response.body", "body": b"", "more_body": False})
        else:
            f.outcome = "client_gone"

    async def _wait_disconnect(self, receive) -> None:
        while True:
            m = await receive()
            if m["type"] == "http.disconnect":
                return

    async def _proxy(self, f: Flight, url: str, headers, send, h: dict):
        if f.body:
            # sent as a stream with its length, so the moment it has all been written is known: the body leaves the
            # budget then, not at the end of a generation that can last hours (Strata answers only after the prompt)
            headers = [*headers, (b"content-length", str(len(f.body)).encode())]
            content = self._body_stream(f)
        else:
            content = None
        req = self.client.build_request(f.method, url, headers=headers, content=content)
        f.forwarded_at = time.time()
        f.phase = "waiting"
        try:
            resp = await self.client.send(req, stream=True)
            self._drop_body(f)                      # an answer has started (a refused connection keeps it for a retry)
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            if f.retry_ok:
                f.outcome = "retry"            # _serve waits in the hold and tries once more
                return
            f.outcome, f.status, f.error = "upstream_down", 503, type(e).__name__
            msg = "the model server is not running (starting, switching or stopped); try again shortly"
            await self._error(send, f.route.dialect, 503, msg, f.rid, h, [(b"retry-after", b"10")])
            return
        except httpx.HTTPError as e:
            f.outcome, f.status, f.error = "error", 502, f"{type(e).__name__}: {e}"[:300]
            await self._error(send, f.route.dialect, 502, "the model server did not answer properly", f.rid, h)
            return
        try:
            f.status = resp.status_code
            ct = resp.headers.get("content-type", "")
            if f.route.kind in policy.GENERATING:
                f.parser = streams.Parser(f.route.dialect, f.route.kind, ct)
            out = [(k, v) for k, v in resp.headers.raw if k.lower() not in DROP_RESP]
            out.append((b"x-request-id", f.rid.encode()))
            out += self._cors_headers(h)
            await self._send(send, {"type": "http.response.start", "status": resp.status_code, "headers": out})
            f.response_started = True
            async for chunk in resp.aiter_raw():
                if not chunk:
                    continue
                if f.first_byte_at is None:
                    f.first_byte_at = time.time()
                    self.hub.publish("request.first_byte", rid=f.rid, at=f.first_byte_at)
                f.bytes_out += len(chunk)
                if f.parser:
                    f.parser.feed(chunk)            # never raises: a parser problem stops parsing, not the answer
                    self._progress(f)
                if f.capture_resp is not None and len(f.capture_resp) < (4 << 20):
                    f.capture_resp += chunk[: (4 << 20) - len(f.capture_resp)]
                await self._send(send, {"type": "http.response.body", "body": chunk, "more_body": True})
            await self._send(send, {"type": "http.response.body", "body": b"", "more_body": False})
            f.outcome = f.outcome or ("ok" if resp.status_code < 400 else "error")
        except httpx.HTTPError as e:
            # Strata closed the connection mid-answer (a crash or a restart)
            f.outcome, f.error = "error", f"upstream: {type(e).__name__}"
            with contextlib.suppress(Exception):
                tail = self._error_tail(f, "the model server stopped while answering")
                if tail:
                    await self._send(send, {"type": "http.response.body", "body": tail, "more_body": True})
                await self._send(send, {"type": "http.response.body", "body": b"", "more_body": False})
        finally:
            await resp.aclose()

    def _progress(self, f: Flight) -> None:
        s = f.parser.stats
        ph = s.phase
        now = time.time()
        if ph != f.phase or now - f.last_progress >= 1.0:
            f.phase = ph
            f.last_progress = now
            self.hub.publish("request.progress", rid=f.rid, phase=ph, tokens=s.tokens_so_far,
                             think_tokens=s.think_tokens, answer_tokens=s.answer_tokens,
                             first_token_at=s.first_token_at, answer_at=s.answer_at)

    def _error_tail(self, f: Flight, msg: str) -> bytes | None:
        """An error event in the stream's own format, for a stream cut short."""
        ct = f.parser.mode if f.parser else None
        if ct == "sse":
            if f.route.dialect == policy.D_ANTHROPIC:
                return b"event: error\ndata: " + json_dumps({"type": "error", "error": {"type": "api_error",
                                                                                        "message": msg}}) + b"\n\n"
            return b"data: " + json_dumps({"error": {"message": msg, "type": "server_error"}}) + b"\n\n"
        if ct == "ndjson":
            return json_dumps({"error": msg}) + b"\n"
        return None

    async def _send(self, send, msg) -> None:
        try:
            await asyncio.wait_for(send(msg), WRITE_TIMEOUT)
        except (asyncio.TimeoutError, OSError, RuntimeError) as e:
            raise ClientGone() from e

    def _finish(self, f: Flight) -> None:
        end = time.time()
        s = f.parser.close() if f.parser else None
        if f.outcome is None:
            f.outcome = "error" if (f.status or 500) >= 400 else "ok"
        if f.outcome not in ("ok",):
            self.counts["errors"] += 1
        rec = {"rid": f.rid, "started_at": f.started_at, "first_byte_at": f.first_byte_at, "ended_at": end,
               "listener": f.listener, "client_ip": f.client_ip, "user_agent": f.user_agent, "app": f.app,
               "token_id": f.token_id, "auth": f.decision.mode, "auth_reason": f.decision.reason, "method": f.method,
               "path": f.path[:300], "route_class": f.route.cls, "model": f.model, "stream": None if f.stream is None
               else int(f.stream), "status": f.status, "outcome": f.outcome, "held_ms": f.held_ms or None,
               "bytes_in": f.bytes_in, "bytes_out": f.bytes_out, "preset": self.preset, "error": f.error,
               "_forwarded_at": f.forwarded_at}
        if s is not None:
            base = f.forwarded_at or f.started_at
            ttft = (s.first_token_at - base) * 1000 if s.first_token_at else None
            rec.update(prompt_tokens=s.prompt_tokens, output_tokens=s.output_tokens, reused_tokens=s.reused_tokens,
                       ttft_ms=round(ttft, 1) if ttft is not None else None,
                       think_ms=round((s.answer_at - s.first_token_at) * 1000, 1)
                       if s.answer_at and s.first_token_at and s.think_tokens else None,
                       prefill_tok_s=s.prefill_tok_s, decode_tok_s=s.decode_tok_s, drafts_offered=s.drafts_offered,
                       drafts_accepted=s.drafts_accepted, finish=s.finish)
            if s.error and not f.error:
                rec["error"] = s.error[:300]
        want = (f.route.kind in policy.GENERATING and f.forwarded_at is not None and (f.status or 0) < 400
                and f.route.target in (policy.T_STRATA, policy.T_BRIDGE))
        pub = {k: v for k, v in rec.items() if not k.startswith("_")}
        self.hub.publish("request.end", **pub, token=f.token_name, phase="done")
        self.recorder.add(rec, want_match=want)
        if f.capture_req is not None:
            try:
                import zstandard
                z = zstandard.ZstdCompressor(level=6)
                self.recorder.add_body(f.rid, end, z.compress(f.capture_req), z.compress(bytes(f.capture_resp or b"")))
            except Exception:
                log.exception("capturing a request failed")

    # ---------------------------------------------------------------------------------------------------- local answers
    async def _mcp(self, f: Flight, receive, send, h: dict, body: bytes):
        """The web tools for apps: one JSON-RPC message in, its answer out (gateway/webmcp.py).  A call stops when its
        client hangs up or the token's requests are cancelled (revoke --disconnect)."""
        if f.method != "POST":
            f.status = 405
            return await self._error(send, policy.D_OPENAI, 405, "the MCP endpoint takes POST (Streamable HTTP, no "
                                     "server stream)", f.rid, h, [(b"allow", b"POST")])
        work = asyncio.create_task(self.webmcp.handle(body, f.decision.token, f))
        gone = asyncio.create_task(self._wait_disconnect(receive))
        cancel = asyncio.create_task(f.cancel.wait())
        try:
            done, _ = await asyncio.wait({work, gone, cancel}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in (gone, cancel):
                if not t.done():
                    t.cancel()
        if work not in done:
            work.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await work
            if cancel in done and gone not in done:
                f.outcome, f.status = "cancelled", 503
                await self._error(send, policy.D_OPENAI, 503, self._cancel_msg(f), f.rid, h)
            else:
                f.outcome = "client_gone"
            return
        exc = work.exception()
        if exc is not None:
            log.error("a web tool call failed", exc_info=exc)
            f.status, f.error = 500, f"{type(exc).__name__}: {exc}"[:300]
            out = {"jsonrpc": "2.0", "id": None, "error": {"code": -32603, "message": "internal error"}}
            return await self._plain(send, 500, json.dumps(out).encode(), f.rid, self._cors_headers(h))
        status, out = work.result()
        f.status = status
        if out is None:
            await send({"type": "http.response.start", "status": 202,
                        "headers": [(b"content-length", b"0"), (b"x-request-id", f.rid.encode())]})
            await send({"type": "http.response.body", "body": b""})
            return
        data = json.dumps(out).encode()
        f.bytes_out = len(data)
        await self._plain(send, status, data, f.rid, self._cors_headers(h))

    async def _plain(self, send, status: int, body: bytes, rid: str, headers=None):
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
                                (b"x-request-id", rid.encode()), *(headers or [])]})
        await send({"type": "http.response.body", "body": body})

    async def _error(self, send, dialect, status, message, rid, h, extra=None):
        body = error_body(dialect, status, message)
        await self._plain(send, status, body, rid, (extra or []) + self._cors_headers(h))

    def _cors_headers(self, h: dict) -> list:
        o = h.get("origin")
        if o and (o.rstrip("/") in self.settings.cors or "*" in self.settings.cors):
            return [(b"access-control-allow-origin", o.encode()), (b"vary", b"Origin"),
                    (b"access-control-expose-headers", b"x-request-id")]
        return []

    async def _preflight(self, send, h: dict, rid: str):
        o = h.get("origin")
        if o and (o.rstrip("/") in self.settings.cors or "*" in self.settings.cors):
            hdrs = [(b"access-control-allow-origin", o.encode()), (b"vary", b"Origin"),
                    (b"access-control-allow-methods", b"GET, POST, OPTIONS"),
                    (b"access-control-allow-headers", (h.get("access-control-request-headers") or
                                                       "authorization, content-type, x-api-key").encode()[:1000]),
                    (b"access-control-max-age", b"600"), (b"content-length", b"0"), (b"x-request-id", rid.encode())]
            await send({"type": "http.response.start", "status": 204, "headers": hdrs})
            await send({"type": "http.response.body", "body": b""})
            return
        await self._plain(send, 403, json_dumps({"error": {"message": "this origin is not allowed (CORS)"}}), rid)

    async def _home(self, send, h: dict, local_ip: str, rid: str):
        """GET / on the API ports: to the console's view of Strata's page (HTTPS, a sandboxed origin)."""
        host = policy.host_of(h.get("host")) or local_ip
        if not host or (host not in self.names and host != local_ip):
            host = f"{socket.gethostname().lower()}.local"     # never a redirect to a name this server does not answer to
        if ":" in host:
            host = f"[{host}]"
        port = self.net.console_port
        url = f"https://{host}{'' if port in (443, 0) else f':{port}'}/strata"
        body = (f"Strata's chat page is in the console: {url}\n").encode()
        await send({"type": "http.response.start", "status": 302,
                    "headers": [(b"location", url.encode()), (b"content-type", b"text/plain; charset=utf-8"),
                                (b"content-length", str(len(body)).encode()), (b"x-request-id", rid.encode()),
                                (b"cache-control", b"no-store")]})
        await send({"type": "http.response.body", "body": body})

    def open_for(self, listener: str, ip: str) -> bool:
        w = self.settings.open
        return w is not None and w.covers(listener, ip, time.time())

    async def _health(self, send, listener: str, ip: str, rid: str, h: dict):
        hl = self.health or {}
        w = self.settings.open
        is_open = self.open_for(listener, ip)
        body = {"status": "ok" if self.hold.strata_up else "unavailable", "service": "strata",
                "model": hl.get("model", self.net.model_id), "max_context": hl.get("max_context"),
                "images": hl.get("images", False), "image_generation": hl.get("image_generation", False),
                "loaded": bool(self.hold.loaded and self.hold.ready.is_set()), "api_key": not is_open,
                "auth": "open" if w is not None and time.time() < w.until else "enforced",
                "open_until": datetime.fromtimestamp(w.until).astimezone().isoformat(timespec="seconds")
                if w is not None and time.time() < w.until else None,
                "gateway": config.VERSION}
        if not self.hold.ready.is_set() and self.hold.strata_up:
            body["status"] = "switching" if self.hold.active() else "loading"
        await self._plain(send, 200, json_dumps(body), rid, self._cors_headers(h))

    # ------------------------------------------------------------------------------------------------------- control
    def state(self) -> dict:
        w = self.settings.open
        now = time.time()
        return {
            "version": config.VERSION, "started_at": self.started_at, "db_ok": self.db_ok,
            "auth": {"mode": "open" if w is not None and now < w.until else "enforced",
                     "until": w.until if w else None, "addresses": [str(n) for n in w.addresses] if w else [],
                     "listeners": sorted(w.listeners) if w else [], "by": w.by if w else None},
            "tokenless": {"enabled": self.settings.tokenless,
                          "addresses": [str(n) for n in self.settings.tokenless_nets]},
            "strata": {"up": self.hold.strata_up, "loaded": self.hold.loaded, "preset": self.preset,
                       "model": (self.health or {}).get("model")},
            "hold": {"ready": self.hold.ready.is_set(), "reason": self.hold.reason(), "explicit": self.hold.active(),
                     "since": self.hold.since, "waiting": self.held},
            "inflight": [fl.public() for fl in self.inflight.values()],
            "counts": dict(self.counts), "tokens": len([t for t in self.tokens.by_id.values() if not t.revoked_at]),
            "capture": self.settings.capture, "listen": {"openai": self.net.openai_port, "ollama": self.net.ollama_port,
                                                         "https": self.net.https_port or None},
        }

    def cancel(self, request_id: str | None = None, token_id: str | None = None, reason: str = "") -> int:
        n = 0
        for f in list(self.inflight.values()):
            if (request_id and f.rid == request_id) or (token_id and f.token_id == token_id):
                f.cancel_reason = reason
                f.cancel.set()
                n += 1
        return n

    def set_hold(self, reason: str, max_s: float) -> str:
        hid = "hold_" + secrets.token_hex(4)
        self.hold.explicit[hid] = {"id": hid, "reason": reason or "maintenance", "until": time.time() + max(1.0, max_s),
                                   "at": time.time()}
        if self.hold.update():
            self._publish_hold()
        return hid

    def release(self, hold_id: str | None) -> int:
        if hold_id:
            n = 1 if self.hold.explicit.pop(hold_id, None) else 0
        else:
            n = len(self.hold.explicit)
            self.hold.explicit.clear()
        if self.hold.update():
            self._publish_hold()
        return n


class Control:
    """The control API on the unix socket /run/outcrop/gateway.sock (0660): state, events, reload, hold, release, cancel."""

    def __init__(self, gw: Gateway):
        self.gw = gw

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return
        method, path = scope["method"], scope["path"].rstrip("/") or "/"
        body = b""
        while True:
            m = await receive()
            if m["type"] == "http.disconnect":
                return
            body += m.get("body", b"")
            if not m.get("more_body"):
                break
        try:
            req = json.loads(body) if body else {}
        except ValueError:
            return await self._json(send, 400, {"error": "send JSON"})
        if not isinstance(req, dict):
            return await self._json(send, 400, {"error": "send a JSON object"})
        gw = self.gw
        if method == "GET" and path == "/state":
            return await self._json(send, 200, gw.state())
        if method == "GET" and path == "/events":
            return await self._events(receive, send)
        if method == "POST" and path == "/reload":
            await gw.reload()
            return await self._json(send, 200, {"ok": True, "tokens": len(gw.tokens.by_id)})
        if method == "POST" and path == "/hold":
            try:
                max_s = float(req.get("max_s") or 300)
            except (TypeError, ValueError):
                return await self._json(send, 400, {"error": "max_s must be a number of seconds"})
            if not 0 < max_s <= 86400:
                return await self._json(send, 400, {"error": "max_s must be between 0 and 86400 seconds"})
            hid = gw.set_hold(str(req.get("reason") or "maintenance"), max_s)
            return await self._json(send, 200, {"hold_id": hid, "inflight": len(gw.inflight)})
        if method == "POST" and path == "/release":
            hid = req.get("hold_id")
            if not isinstance(hid, (str, type(None))):
                return await self._json(send, 400, {"error": "hold_id is a string"})
            return await self._json(send, 200, {"released": gw.release(hid)})
        if method == "POST" and path == "/cancel":
            rid, tid = req.get("request_id"), req.get("token_id")
            if not isinstance(rid, (str, type(None))) or not isinstance(tid, (str, type(None))):
                return await self._json(send, 400, {"error": "request_id and token_id are strings"})
            n = gw.cancel(rid, tid, str(req.get("reason") or ""))
            return await self._json(send, 200, {"cancelled": n})
        return await self._json(send, 404, {"error": "not found"})

    async def _json(self, send, status, obj):
        b = json_dumps(obj)
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(b)).encode())]})
        await send({"type": "http.response.body", "body": b})

    async def _events(self, receive, send):
        q = self.gw.hub.subscribe()
        await send({"type": "http.response.start", "status": 200,
                    "headers": [(b"content-type", b"text/event-stream"), (b"cache-control", b"no-cache")]})
        gone = asyncio.create_task(self._gone(receive))
        try:
            await send({"type": "http.response.body", "body": b"data: " + json_dumps({"type": "hello",
                                                                                     **self.gw.state()}) + b"\n\n",
                        "more_body": True})
            while not gone.done():
                try:
                    ev = await asyncio.wait_for(q.get(), 15.0)
                    chunk = b"data: " + json_dumps(ev) + b"\n\n"
                except asyncio.TimeoutError:
                    chunk = b": keep-alive\n\n"
                await asyncio.wait_for(send({"type": "http.response.body", "body": chunk, "more_body": True}), 30)
        except Exception:
            pass
        finally:
            self.gw.hub.unsubscribe(q)
            gone.cancel()

    async def _gone(self, receive):
        while True:
            m = await receive()
            if m["type"] == "http.disconnect":
                return
