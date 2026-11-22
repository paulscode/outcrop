"""The console's web app: the admin API under /api, the live WebSocket, and the UI (web/dist)."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import threading
import time
import types
from pathlib import Path
from typing import Any

from fastapi import Body, Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field

from ..common import config, db, tokens
from ..common.tokens import TokenError
from . import auth, passwords, tls
from .alerts import RULES, Alerts, tg_find_chat, tg_public, tg_save, tg_send, tg_update
from .control import Controller, FakeController, SP, preset_cards
from .ctx import Ctx, Options
from .live import Client, Live
from ..gateway.app import norm_ip

log = logging.getLogger("outcrop.console")

CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; "
       "font-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; "
       "base-uri 'none'; form-action 'self'; object-src 'none'")
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}


class SwitchRunner:
    """One switch at a time, run in a thread; its events go to the `switch` topic and stay readable for late browsers."""

    def __init__(self, ctx: Ctx, live: Live, ctl: Controller, alerts: Alerts):
        self.ctx, self.live, self.ctl, self.alerts = ctx, live, ctl, alerts
        self.cur: dict | None = None
        self.lock = threading.Lock()
        self.loop: asyncio.AbstractEventLoop | None = None

    def state(self) -> dict | None:
        return self.cur

    def start(self, name: str, *, when: str, cancel_inflight: bool, by: str, source: str, restart: bool = False) -> dict:
        with self.lock:
            if self.cur and self.cur["status"] in ("waiting", "running"):
                raise HTTPException(409, f"a switch to {self.cur['to']} is already in progress")
            sid = f"sw_{int(time.time() * 1000)}"
            self.cur = {"id": sid, "to": name, "from": self.ctl.current(), "status": "waiting" if when == "idle" else "running",
                        "when": when, "events": [], "started_at": time.time(), "by": by, "restart": restart,
                        "cancel": threading.Event()}
        threading.Thread(target=self._run, args=(name, when, cancel_inflight, by, source, restart), daemon=True).start()
        return self.public()

    def public(self) -> dict | None:
        if not self.cur:
            return None
        return {k: v for k, v in self.cur.items() if k != "cancel"}

    def _emit(self, ev: dict, cur: dict | None = None) -> None:
        cur = cur or self.cur
        if ev.get("type") != "tick":
            cur["events"].append(ev)
        if ev.get("type") == "phase":
            cur["phase"] = ev.get("phase")
        cur["last"] = ev
        self._push()

    def _push(self) -> None:
        if self.loop and not self.loop.is_closed():
            with contextlib.suppress(RuntimeError):
                self.loop.call_soon_threadsafe(self.live.publish, "switch", self.public())

    def cancellable(self) -> bool:
        """Before it starts, or while it holds new requests and lets running ones finish: nothing stopped yet."""
        cur = self.cur
        return bool(cur) and (cur["status"] == "waiting"
                              or (cur["status"] == "running" and cur.get("phase") in (None, "plan", "hold", "drain")))

    def _run(self, name, when, cancel_inflight, by, source, restart):
        cur = self.cur                       # this switch's record, even if another starts the moment it ends
        emit = lambda ev: self._emit(ev, cur)  # noqa: E731
        try:
            if when == "idle":
                emit({"type": "waiting", "reason": "waiting until no request is running"})
                while not cur["cancel"].is_set():
                    st = self.ctx.gateway_sync("GET", "/state") or {}
                    busy = [f for f in st.get("inflight") or [] if f.get("kind") in ("chat", "messages", "responses",
                                                                                     "ollama-chat", "ollama-generate")
                            and f.get("phase") != "held"]
                    if not busy:
                        break
                    time.sleep(1.0)
                if cur["cancel"].is_set():
                    cur["status"] = "cancelled"
                    emit({"type": "done", "ok": False, "error": "cancelled before it started"})
                    return
                cur["status"] = "running"
            self.ctl.switch(name, cancel_inflight=cancel_inflight, by=by, source=source, on=emit, restart=restart,
                            should_cancel=cur["cancel"].is_set)
            cur["status"] = "done"
            with contextlib.suppress(Exception):
                self.alerts.close(f"switch:{name}", f"switched to {name}")
        except Exception as e:
            cancelled = cur["cancel"].is_set() and isinstance(e, getattr(LC_mod(), "SwitchCancelled", ()))
            cur["status"] = "cancelled" if cancelled else "failed"
            cur["error"] = str(e)
            emit({"type": "done", "ok": False, "error": str(e)})
            if not cancelled:
                with contextlib.suppress(Exception):
                    self.alerts.open("service", f"switch:{name}", f"switching to {name} failed: {str(e)[:120]}")
        finally:
            cur["ended_at"] = time.time()
            self._push()


def LC_mod():
    import outcrop_control
    return outcrop_control


# --------------------------------------------------------------------------------------------------------- models

class LoginIn(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=1024)
    remember: bool = False


class PasswordIn(BaseModel):
    password: str = Field(max_length=1024)


class ChangePasswordIn(BaseModel):
    current: str = Field(max_length=1024)
    new: str = Field(max_length=1024)


class TokenIn(BaseModel):
    name: str = Field(max_length=64)
    scopes: list[str] = ["inference"]
    listeners: list[str] = ["openai", "ollama"]
    cidrs: list[str] = []
    expires: str | None = None
    rpm: int | None = None
    concurrency: int | None = None
    notes: str = Field("", max_length=500)
    value: str | None = Field(None, max_length=512)


class TokenPatch(BaseModel):
    name: str | None = None
    scopes: list[str] | None = None
    listeners: list[str] | None = None
    cidrs: list[str] | None = None
    expires: str | None = None
    rpm: int | None = None
    concurrency: int | None = None
    notes: str | None = None


class ModeIn(BaseModel):
    mode: str
    minutes: float | None = None
    addresses: list[str] = []
    listeners: list[str] = []


class TokenlessIn(BaseModel):
    enabled: bool
    addresses: list[str] = []


class SwitchIn(BaseModel):
    when: str = "now"
    cancel_inflight: bool = False


# ------------------------------------------------------------------------------------------------------------ app

def create_app(opts: Options) -> FastAPI:
    ctx = Ctx(opts)
    live = Live(ctx)
    ctl = FakeController(ctx.strata_url, gateway=ctx.gateway_sync) if opts.fake_units else Controller()
    alerts = Alerts(ctx, live)
    live.alerts = alerts
    switches = SwitchRunner(ctx, live, ctl, alerts)
    live.ctl = ctl
    import outcrop_control
    outcrop_control.DB_PATH = ctx.db_path

    h = types.SimpleNamespace(ctx=ctx, live=live, ctl=ctl, alerts=alerts, loop=None, start_tasks=[],
                              gateway_url=(opts.gateway_url or f"http://127.0.0.1:{ctx.net.openai_port}").rstrip("/"),
                              gateway_ollama_port=opts.gateway_ollama_port or ctx.net.ollama_port)

    @contextlib.asynccontextmanager
    async def lifespan(app):
        switches.loop = asyncio.get_running_loop()
        h.loop = switches.loop
        await live.start()
        bg = [asyncio.create_task(alerts.run())] + [asyncio.create_task(fn()) for fn in h.start_tasks]
        if opts.fake_units:
            live._units_override = lambda: fake_units(ctl)
        yield
        for t in bg:
            t.cancel()
        await live.stop()
        await ctx.client.aclose()

    app = FastAPI(title="Outcrop", docs_url=None, redoc_url=None, openapi_url="/api/openapi.json" if opts.dev else None,
                  lifespan=lifespan)
    app.state.ctx, app.state.live, app.state.ctl, app.state.alerts, app.state.switches = ctx, live, ctl, alerts, switches
    app.add_middleware(BodyLimit)

    # ------------------------------------------------------------------------------------------------ middleware
    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        bearer_only = (request.headers.get("authorization", "").lower().startswith("bearer ")
                       and not request.cookies.get(auth.COOKIE_SECURE) and not request.cookies.get(auth.COOKIE_PLAIN))
        if path.startswith("/api/") and request.method in UNSAFE and not bearer_only:
            bad = csrf_problem(request, ctx)
            if bad:
                return JSONResponse({"error": bad}, status_code=403, headers=security_headers(request, ctx, api=True))
        try:
            resp = await call_next(request)
        except Exception:
            log.exception("request failed: %s %s", request.method, path)
            resp = JSONResponse({"error": "internal error"}, status_code=500)
        # setdefault, never overwrite: a route that sets its own (the sandboxed Strata view's CSP, X-Frame-Options and
        # CORP) keeps them
        for k, v in security_headers(request, ctx, api=path.startswith("/api/")).items():
            resp.headers.setdefault(k, v)
        return resp

    def ip_of(request: Request) -> str:
        """The client's address, IPv4 as such (the dual-stack socket reports ::ffff:192.168.1.50)."""
        return norm_ip(request.client.host if request.client else "")

    def cookie_name(request: Request) -> str:
        return auth.COOKIE_SECURE if request.url.scheme == "https" else auth.COOKIE_PLAIN

    def token_session(request: Request) -> auth.Session | None:
        """Automation: an `admin` API token as `Authorization: Bearer`, over HTTPS.  It never counts as the
        password entered again, so nothing that widens access can be done with it."""
        hdr = request.headers.get("authorization", "")
        if not hdr.lower().startswith("bearer ") or request.cookies.get(cookie_name(request)):
            return None
        con = ctx.con()
        cache = tokens.TokenCache(tokens.load_pepper(create=False))
        cache.load(con)
        lk = cache.lookup(hdr[7:].strip())
        if lk.status != "ok" or "admin" not in lk.token.scopes or not lk.token.allows_ip(ip_of(request)):
            return None
        user = auth.get_user(con)
        if user is None:
            return None
        con.execute("UPDATE tokens SET last_used_at=?, last_ip=?, last_app=? WHERE id=?",
                    (time.time(), ip_of(request), "console API", lk.token.id))
        now = time.time()
        return auth.Session(f"token:{lk.token.id}", user["id"], f"token:{lk.token.name}", now, now, now + 60, False,
                            ip_of(request), request.headers.get("user-agent"), None)

    def session_dep(request: Request) -> auth.Session:
        sid = request.cookies.get(cookie_name(request))
        s = auth.session(ctx.con(), sid, touch=True, ip=ip_of(request)) if sid else None
        if s is None:
            s = token_session(request)
        if s is None:
            raise HTTPException(401, "sign in first")
        request.state.session = s
        return s

    def need_reauth(s: auth.Session) -> None:
        if not s.reauth_ok:
            raise HTTPException(403, detail={"reauth": True, "message": "enter your password again to do this"})

    def poke():
        ctx.gateway_sync("POST", "/reload")

    def actor(s: auth.Session) -> str:
        return s.username

    # ------------------------------------------------------------------------------------------------------ auth
    @app.post("/api/auth/login")
    def login(body: LoginIn, request: Request):
        con = ctx.con()
        slow = auth.global_slowdown(con)
        if slow:
            time.sleep(slow)
        try:
            sid, s = auth.login(con, body.username, body.password, ip=ip_of(request),
                                user_agent=request.headers.get("user-agent", ""), remember=body.remember)
        except auth.AuthError as e:
            if e.status == 401:
                alerts.observe_signin_fail(ip_of(request))
            h = {"Retry-After": str(e.extra["retry_after"])} if "retry_after" in e.extra else None
            return JSONResponse({"error": e.message}, status_code=e.status, headers=h)
        resp = JSONResponse({"user": s.username, "expires_at": s.expires_at})
        resp.set_cookie(cookie_name(request), sid, max_age=auth.REMEMBER_S if body.remember else None, path="/",
                        secure=request.url.scheme == "https", httponly=True, samesite="strict")
        return resp

    @app.post("/api/auth/logout")
    def logout(request: Request, s: auth.Session = Depends(session_dep)):
        auth.logout(ctx.con(), s, ip_of(request))
        live_close_session(s.id_hash)
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(cookie_name(request), path="/", secure=request.url.scheme == "https", httponly=True,
                           samesite="strict")
        return resp

    def live_close_session(h: str):
        for c in list(live.clients):
            if c.session_hash == h:
                c.put({"t": "signout", "d": {}, "at": time.time()})

    @app.get("/api/auth/session")
    def get_session(s: auth.Session = Depends(session_dep)):
        return {"user": s.username, "created_at": s.created_at, "expires_at": s.expires_at, "remember": s.remember,
                "reauth_ok": s.reauth_ok, "reauth_until": (s.reauth_at or 0) + auth.REAUTH_S}

    @app.post("/api/auth/reauth")
    def reauth(body: PasswordIn, request: Request, s: auth.Session = Depends(session_dep)):
        try:
            auth.reauth(ctx.con(), s, body.password, ip_of(request))
        except auth.AuthError as e:
            # 403, not 401: the session is still good (a 401 means "signed out" to clients); the attempt still counts
            return JSONResponse({"error": e.message, "code": "wrong_password"}, status_code=403 if e.status == 401 else e.status)
        return {"ok": True, "reauth_until": time.time() + auth.REAUTH_S}

    @app.get("/api/auth/sessions")
    def sessions(s: auth.Session = Depends(session_dep)):
        rows = auth.sessions_of(ctx.con(), s.user_id)
        for r in rows:
            r["current"] = r["id_hash"] == s.id_hash
            r["id"] = r.pop("id_hash")[:16]
        return rows

    @app.delete("/api/auth/sessions/{sid}")
    def end_session(sid: str, request: Request, s: auth.Session = Depends(session_dep)):
        con = ctx.con()
        rows = [r for r in auth.sessions_of(con, s.user_id) if r["id_hash"].startswith(sid) and len(sid) >= 8]
        if not rows:
            raise HTTPException(404, "no such session")
        with db.tx(con):
            con.execute("DELETE FROM sessions WHERE id_hash=?", (rows[0]["id_hash"],))
            db.add_event(con, "signin.out", "ended a session", actor=s.username, source=ip_of(request))
        live_close_session(rows[0]["id_hash"])
        return {"ok": True}

    @app.post("/api/auth/sessions/end-others")
    def end_others(request: Request, s: auth.Session = Depends(session_dep)):
        con = ctx.con()
        others = [r["id_hash"] for r in auth.sessions_of(con, s.user_id) if r["id_hash"] != s.id_hash]
        n = auth.end_sessions(con, s.user_id, s.id_hash, s.username, ip_of(request))
        for h in others:
            live_close_session(h)
        return {"ended": n}

    @app.post("/api/auth/password")
    def change_password(body: ChangePasswordIn, request: Request, s: auth.Session = Depends(session_dep)):
        con = ctx.con()
        try:
            auth.reauth(con, s, body.current, ip_of(request))
        except auth.AuthError as e:
            return JSONResponse({"error": "the current password is wrong" if e.status == 401 else e.message,
                                 "code": "wrong_password"}, status_code=403 if e.status == 401 else e.status)
        try:
            auth.set_password(con, s.username, body.new, actor=s.username, source=ip_of(request), keep_session=s.id_hash)
        except auth.AuthError as e:
            return JSONResponse({"error": e.message, **e.extra}, status_code=e.status)
        return {"ok": True}

    @app.post("/api/auth/password/check")
    def check_password(body: PasswordIn, s: auth.Session = Depends(session_dep)):
        return passwords.check(body.password, s.username).public()

    @app.get("/api/auth/generate")
    def generate(s: auth.Session = Depends(session_dep)):
        return {"passphrase": passwords.generate(username=s.username)}

    # ----------------------------------------------------------------------------------------------------- state
    @app.get("/api/state")
    def state(request: Request, s: auth.Session = Depends(session_dep)):
        con = ctx.con()
        cfg = SP.load()
        mode = db.get_setting(con, "auth.mode")
        open_now = mode.get("mode") == "open" and float(mode.get("until") or 0) > time.time()
        local, hosts = config.server_names(ctx.net)
        host = request.url.hostname or local
        return {
            "host": local.removesuffix(".local") or __import__("socket").gethostname(), "version": config.VERSION,
            "user": s.username,
            "dev": opts.dev, "fake": opts.fake_units, "started_at": ctx.started_at,
            "console": {"https": request.url.scheme == "https", "hsts": bool(db.get_setting(con, "console.hsts", False)),
                        "tls": tls.status() if request.url.scheme == "https" else None},
            "server": {"preset": ctl.current(), "default": ctl.default(), "presets": list(cfg["presets"]),
                       "model_id": ctx.net.model_id},
            "auth": {"mode": "open" if open_now else "enforced", "until": mode.get("until") if open_now else None,
                     "addresses": mode.get("addresses") or [], "listeners": mode.get("listeners") or []},
            "tokenless": db.get_setting(con, "ollama.tokenless"),
            "gateway": live.gateway or {},
            "switch": switches.public(),
            "alerts": {"open": len(alerts.summary()["open"])},
            "urls": {"openai": f"http://{hosts[0] if hosts else host}:{ctx.net.openai_port}/v1",
                     "anthropic": f"http://{hosts[0] if hosts else host}:{ctx.net.openai_port}",
                     "ollama": f"http://{hosts[0] if hosts else host}:{ctx.net.ollama_port}",
                     "hostname": local, "addresses": hosts,
                     "openai_port": ctx.net.openai_port, "ollama_port": ctx.net.ollama_port},
        }

    # ---------------------------------------------------------------------------------------------------- tokens
    def token_public(t: dict, usage: dict | None = None) -> dict:
        now = time.time()
        status = ("revoked" if t["revoked_at"] else "expired" if t["expires_at"] and t["expires_at"] <= now else "active")
        out = {k: t[k] for k in ("id", "name", "notes", "kind", "scopes", "listeners", "cidrs", "expires_at", "rpm",
                                 "concurrency", "imported", "hint", "created_at", "created_by", "rotated_at", "revoked_at",
                                 "revoked_by", "revoke_reason", "last_used_at", "last_ip", "last_app")}
        out["status"] = status
        if usage is not None:
            out["usage"] = usage
        return out

    def usage_by_token(con, days: int = 30) -> dict:
        since = time.strftime("%Y-%m-%d", time.localtime(time.time() - days * 86400))
        out: dict[str, dict] = {}
        for r in con.execute("SELECT day, token_id, requests, prompt_tokens, output_tokens, errors FROM usage_daily "
                             "WHERE day >= ? ORDER BY day", (since,)):
            u = out.setdefault(r["token_id"], {"days": {}, "requests": 0, "prompt_tokens": 0, "output_tokens": 0,
                                                "errors": 0})
            u["days"][r["day"]] = r["requests"]
            for k in ("requests", "prompt_tokens", "output_tokens", "errors"):
                u[k] += r[k]
        return out

    @app.get("/api/tokens")
    def list_tokens(s: auth.Session = Depends(session_dep)):
        con = ctx.con()
        use = usage_by_token(con)
        return [token_public(t, use.get(t["id"])) for t in tokens.list_tokens(con)]

    WIDE = {"admin", "web"}               # scopes that need the password again (admin: everything; web: the internet)

    def _create(body: TokenIn, request: Request, s: auth.Session, value: str | None):
        if WIDE & set(body.scopes or []):
            need_reauth(s)
        con = ctx.con()
        try:
            exp = tokens.parse_expiry(body.expires or "never")
            tok, plain = tokens.create(con, tokens.load_pepper(), body.name, scopes=body.scopes, listeners=body.listeners,
                                       cidrs=body.cidrs, expires_at=exp, rpm=body.rpm or None,
                                       concurrency=body.concurrency or None, notes=body.notes, by=actor(s),
                                       source=ip_of(request), value=value)
        except TokenError as e:
            raise HTTPException(400, str(e)) from None
        poke()
        return {"token": token_public(tok), "plaintext": None if value else plain}

    @app.post("/api/tokens")
    def create_token(body: TokenIn, request: Request, s: auth.Session = Depends(session_dep)):
        return _create(body, request, s, None)

    @app.post("/api/tokens/import")
    def import_token(body: TokenIn, request: Request, s: auth.Session = Depends(session_dep)):
        if not body.value:
            raise HTTPException(400, "send the token's value")
        return _create(body, request, s, body.value)

    @app.get("/api/tokens/{tid}")
    def get_token(tid: str, s: auth.Session = Depends(session_dep)):
        con = ctx.con()
        t = tokens.get(con, tid)
        if t is None:
            raise HTTPException(404, "no such token")
        recent = [dict(r) for r in con.execute(
            "SELECT rid, started_at, client_ip, app, path, status, outcome, prompt_tokens, output_tokens, ttft_ms, "
            "decode_tok_s FROM requests WHERE token_id=? ORDER BY started_at DESC LIMIT 25", (tid,))]
        apps_ = [dict(r) for r in con.execute(
            "SELECT app, client_ip, count(*) n, max(started_at) last FROM requests WHERE token_id=? AND started_at > ? "
            "GROUP BY app, client_ip ORDER BY last DESC LIMIT 10", (tid, time.time() - 30 * 86400))]
        return {**token_public(t, usage_by_token(con).get(tid)), "recent": recent, "seen": apps_}

    @app.patch("/api/tokens/{tid}")
    def patch_token(tid: str, body: TokenPatch, request: Request, s: auth.Session = Depends(session_dep)):
        cur = tokens.get(ctx.con(), tid)
        if cur is None:
            raise HTTPException(404, "no such token")
        # the password again to give a wide scope, or to change anything about a token that has one (its networks,
        # listeners, expiry or limits would widen what it can do)
        if (body.scopes and WIDE & (set(body.scopes) - set(cur["scopes"]))) or WIDE & set(cur["scopes"]):
            need_reauth(s)
        fields: dict[str, Any] = {k: v for k, v in body.model_dump(exclude_unset=True).items() if k != "expires"}
        if "expires" in body.model_fields_set:
            fields["expires_at"] = tokens.parse_expiry(body.expires or "never")
        try:
            t = tokens.update(ctx.con(), tid, by=actor(s), source=ip_of(request), **fields)
        except TokenError as e:
            raise HTTPException(400, str(e)) from None
        poke()
        return token_public(t)

    @app.post("/api/tokens/{tid}/rotate")
    def rotate_token(tid: str, request: Request, body: dict = Body(default={}), s: auth.Session = Depends(session_dep)):
        cur = tokens.get(ctx.con(), tid)
        if cur is None:
            raise HTTPException(404, "no such token")
        if WIDE & set(cur["scopes"]):
            need_reauth(s)                     # rotating hands out a new secret: for an admin or web token, the password
        try:
            t, plain = tokens.rotate(ctx.con(), tokens.load_pepper(), tid, tokens.parse_grace(body.get("grace")),
                                     by=actor(s), source=ip_of(request))
        except TokenError as e:
            raise HTTPException(400, str(e)) from None
        poke()
        return {"token": token_public(t), "plaintext": plain}

    @app.post("/api/tokens/{tid}/revoke")
    def revoke_token(tid: str, request: Request, body: dict = Body(default={}), s: auth.Session = Depends(session_dep)):
        try:
            t = tokens.revoke(ctx.con(), tid, by=actor(s), source=ip_of(request), reason=str(body.get("reason") or ""))
        except TokenError as e:
            raise HTTPException(400, str(e)) from None
        poke()
        n = 0
        if body.get("disconnect"):
            n = (ctx.gateway_sync("POST", "/cancel", {"token_id": t["id"], "reason": "the token was revoked"}) or {}).get(
                "cancelled", 0)
        return {"token": token_public(t), "cancelled": n}

    # ---------------------------------------------------------------------------------------------------- access
    @app.get("/api/access")
    def access(s: auth.Session = Depends(session_dep)):
        con = ctx.con()
        mode = db.get_setting(con, "auth.mode")
        open_now = mode.get("mode") == "open" and float(mode.get("until") or 0) > time.time()
        anon = [dict(r) for r in con.execute(
            "SELECT client_ip, app, count(*) n, sum(auth='denied') denied, max(started_at) last, "
            "max(auth_reason) reason FROM requests WHERE auth IN ('open','denied','tokenless') AND route_class != 'public' "
            "AND started_at > ? GROUP BY client_ip, app ORDER BY last DESC LIMIT 50", (time.time() - 7 * 86400,))]
        return {"mode": {**mode, "mode": "open" if open_now else "enforced"}, "tokenless": db.get_setting(con, "ollama.tokenless"),
                "cors": db.get_setting(con, "cors.origins"), "hosts": db.get_setting(con, "hosts.extra"),
                "anonymous": anon, "max_open_minutes": 1440}

    @app.put("/api/access/mode")
    def set_mode(body: ModeIn, request: Request, s: auth.Session = Depends(session_dep)):
        con = ctx.con()
        if body.mode == "enforced":
            with db.tx(con):
                was = db.get_setting(con, "auth.mode")
                db.set_setting(con, "auth.mode", {"mode": "enforced"}, by=s.username)
                if was.get("mode") == "open":
                    db.add_event(con, "auth.close", "API closed: tokens are required again", actor=s.username,
                                 source=ip_of(request))
            poke()
            return {"mode": "enforced"}
        if body.mode != "open":
            raise HTTPException(400, "mode is enforced or open")
        minutes = float(body.minutes or 15)
        if minutes <= 0 or minutes > 1440:
            raise HTTPException(400, "the API opens for 1 minute to 24 hours")
        if minutes > 60:
            need_reauth(s)
        try:
            addrs = tokens.norm_cidrs(body.addresses)
            lis = tokens.norm_listeners(body.listeners or None)
        except TokenError as e:
            raise HTTPException(400, str(e)) from None
        until = time.time() + minutes * 60
        with db.tx(con):
            db.set_setting(con, "auth.mode", {"mode": "open", "until": until, "addresses": addrs, "listeners": lis,
                                              "by": s.username, "at": time.time()}, by=s.username)
            db.add_event(con, "auth.open", f"API opened for {tokens._fmt_dur(minutes * 60)}"
                         + (f" for {', '.join(addrs)}" if addrs else " for the whole LAN")
                         + ("" if set(lis) == {"openai", "ollama"} else f" on {','.join(lis)} only"),
                         actor=s.username, source=ip_of(request), level="warn",
                         details={"until": until, "addresses": addrs, "listeners": lis})
        poke()
        return {"mode": "open", "until": until, "addresses": addrs, "listeners": lis}

    @app.put("/api/access/ollama-tokenless")
    def set_tokenless(body: TokenlessIn, request: Request, s: auth.Session = Depends(session_dep)):
        if body.enabled:
            need_reauth(s)
            if not body.addresses:
                raise HTTPException(400, "name the app's address")
        try:
            addrs = tokens.norm_cidrs(body.addresses)
        except TokenError as e:
            raise HTTPException(400, str(e)) from None
        con = ctx.con()
        with db.tx(con):
            db.set_setting(con, "ollama.tokenless", {"enabled": body.enabled, "addresses": addrs}, by=s.username)
            db.add_event(con, "auth.tokenless", f"token-less Ollama option turned {'on' if body.enabled else 'off'}"
                         + (f" for {', '.join(addrs)}" if body.enabled else ""), actor=s.username, source=ip_of(request),
                         level="warn" if body.enabled else "info", details={"enabled": body.enabled, "addresses": addrs})
        poke()
        return {"enabled": body.enabled, "addresses": addrs}

    @app.put("/api/access/cors")
    def set_cors(request: Request, body: dict = Body(...), s: auth.Session = Depends(session_dep)):
        need_reauth(s)
        origins = [str(o).strip().rstrip("/") for o in body.get("origins") or [] if str(o).strip()]
        for o in origins:
            if o != "*" and not o.startswith(("http://", "https://")):
                raise HTTPException(400, f"{o!r} is not an origin like https://app.example")
        con = ctx.con()
        with db.tx(con):
            db.set_setting(con, "cors.origins", origins, by=s.username)
            db.add_event(con, "auth.cors", f"CORS origins: {', '.join(origins) or 'none'}", actor=s.username,
                         source=ip_of(request), level="warn" if origins else "info")
        poke()
        return {"origins": origins}

    # --------------------------------------------------------------------------------------------------- presets
    @app.get("/api/presets")
    def presets(s: auth.Session = Depends(session_dep)):
        return {"presets": preset_cards(ctl, ctx.con()), "current": ctl.current(), "default": ctl.default(),
                "switch": switches.public()}

    @app.post("/api/presets/{name}/switch")
    def switch(name: str, body: SwitchIn, request: Request, s: auth.Session = Depends(session_dep)):
        if name not in SP.names():
            raise HTTPException(404, f"no preset {name!r}")
        if body.when not in ("now", "idle"):
            raise HTTPException(400, "when is now or idle")
        restart = name == ctl.current()
        return switches.start(name, when=body.when, cancel_inflight=body.cancel_inflight, by=s.username,
                              source=ip_of(request), restart=restart)

    @app.post("/api/switches/current/cancel")
    def cancel_switch(s: auth.Session = Depends(session_dep)):
        cur = switches.cur
        if not switches.cancellable():
            raise HTTPException(409, "no switch can be cancelled now (once the old preset is stopping, it goes on)")
        cur["cancel"].set()
        return {"ok": True}

    @app.get("/api/switches/current")
    def current_switch(s: auth.Session = Depends(session_dep)):
        return switches.public()

    @app.get("/api/switches")
    def switch_history(limit: int = 30, s: auth.Session = Depends(session_dep)):
        rows = ctx.con().execute("SELECT * FROM switches ORDER BY started_at DESC LIMIT ?", (min(limit, 200),)).fetchall()
        return [dict(r) | {"phases": json.loads(r["phases"] or "[]")} for r in rows]

    @app.put("/api/presets/default")
    def set_default(request: Request, body: dict = Body(...), s: auth.Session = Depends(session_dep)):
        name = str(body.get("name") or "")
        try:
            ctl.set_default(name, by=s.username, source=ip_of(request))
        except (ValueError, RuntimeError) as e:
            raise HTTPException(400, str(e)) from None
        return {"default": ctl.default()}

    # -------------------------------------------------------------------------------------------------- requests
    @app.get("/api/requests")
    def requests_(limit: int = 100, before: float | None = None, token: str | None = None,
                  app_: str | None = Query(None, alias="app"),
                  ip: str | None = None, status: str | None = None, q: str | None = None, path: str | None = None,
                  s: auth.Session = Depends(session_dep)):
        where, args = ["1=1"], []
        if before:
            where.append("started_at < ?"); args.append(before)
        if token:
            where.append("token_id = ?"); args.append(token)
        if app_:
            where.append("app = ?"); args.append(app_)
        if ip:
            where.append("client_ip = ?"); args.append(ip)
        if path:
            where.append("path = ?"); args.append(path)
        if status == "ok":
            where.append("status < 400 AND outcome = 'ok'")
        elif status == "error":
            where.append("(status >= 400 OR outcome != 'ok')")
        elif status == "denied":
            where.append("auth = 'denied'")
        if q:
            where.append("(path LIKE ? OR app LIKE ? OR client_ip LIKE ? OR rid LIKE ? OR model LIKE ?)")
            args += [f"%{q}%"] * 5
        rows = ctx.con().execute(f"SELECT r.*, t.name AS token_name FROM requests r LEFT JOIN tokens t ON t.id = r.token_id "
                                 f"WHERE {' AND '.join(where)} ORDER BY started_at DESC LIMIT ?",
                                 (*args, min(limit, 500))).fetchall()
        return [dict(r) for r in rows]

    @app.get("/api/requests/{rid}")
    def request_detail(rid: str, s: auth.Session = Depends(session_dep)):
        con = ctx.con()
        r = con.execute("SELECT r.*, t.name AS token_name FROM requests r LEFT JOIN tokens t ON t.id = r.token_id "
                        "WHERE rid=?", (rid,)).fetchone()
        if r is None:
            live_r = live.inflight.get(rid) or next((x for x in live.recent_requests if x.get("rid") == rid), None)
            if live_r is None:
                raise HTTPException(404, "no such request")
            return {"live": True, **live_r}
        out = dict(r)
        b = con.execute("SELECT request, response FROM request_bodies WHERE request_rid=?", (rid,)).fetchone()
        if b is not None:
            import zstandard
            d = zstandard.ZstdDecompressor()
            out["captured"] = {"request": d.decompress(b["request"]).decode("utf-8", "replace") if b["request"] else None,
                               "response": d.decompress(b["response"]).decode("utf-8", "replace") if b["response"] else None}
        return out

    @app.post("/api/requests/{rid}/cancel")
    def cancel_request(rid: str, s: auth.Session = Depends(session_dep)):
        r = ctx.gateway_sync("POST", "/cancel", {"request_id": rid, "reason": f"cancelled by {s.username}"})
        if r is None:
            raise HTTPException(503, "the gateway is not answering")
        return r

    @app.get("/api/requests-summary")
    def requests_summary(hours: float = 24, s: auth.Session = Depends(session_dep)):
        con = ctx.con()
        since = time.time() - hours * 3600
        tot = con.execute("SELECT count(*) n, sum(prompt_tokens) p, sum(output_tokens) o, sum(status >= 400) err, "
                          "sum(auth='denied') denied, avg(ttft_ms) ttft, avg(decode_tok_s) dec, avg(hit_rate) hit "
                          "FROM requests WHERE started_at > ? AND route_class='inference'", (since,)).fetchone()
        by_app = [dict(r) for r in con.execute("SELECT app, count(*) n, sum(output_tokens) o FROM requests WHERE started_at > ? "
                                               "AND route_class='inference' AND auth != 'denied' GROUP BY app ORDER BY n DESC "
                                               "LIMIT 10", (since,))]
        return {**dict(tot), "by_app": by_app, "hours": hours}

    # ---------------------------------------------------------------------------------------------------- events
    @app.get("/api/events")
    def events(limit: int = 100, before: float | None = None, kind: str | None = None,
               s: auth.Session = Depends(session_dep)):
        return db.events(ctx.con(), min(limit, 500), kinds=[k for k in (kind or "").split(",") if k] or None, before=before)

    # ---------------------------------------------------------------------------------------------------- alerts
    @app.get("/api/alerts")
    def get_alerts(s: auth.Session = Depends(session_dep)):
        return {**alerts.summary(), "rules": alerts.rules()}

    @app.post("/api/alerts/ack")
    def ack_alerts(body: dict = Body(default={}), s: auth.Session = Depends(session_dep)):
        con = ctx.con()
        ids = body.get("ids")
        if ids:
            con.executemany("UPDATE alerts SET acked_at=? WHERE id=?", [(time.time(), int(i)) for i in ids])
        else:
            con.execute("UPDATE alerts SET acked_at=? WHERE acked_at IS NULL", (time.time(),))
        alerts._publish()
        return {"ok": True}

    @app.put("/api/alerts/rules")
    def set_rules(request: Request, body: dict = Body(...), s: auth.Session = Depends(session_dep)):
        cur = db.get_setting(ctx.con(), "alerts.rules", {}) or {}
        for k, v in body.items():
            if k in RULES and isinstance(v, dict):
                cur[k] = {**(cur.get(k) or {}), **{kk: bool(vv) for kk, vv in v.items() if kk in ("enabled", "telegram")}}
        db.set_setting(ctx.con(), "alerts.rules", cur, by=s.username)
        return alerts.rules()

    @app.put("/api/alerts/telegram")
    def set_telegram(request: Request, body: dict = Body(...), s: auth.Session = Depends(session_dep)):
        need_reauth(s)
        token = str(body.get("token") or "").strip()
        if not token or ":" not in token or len(token) > 100:
            raise HTTPException(400, "paste the bot token @BotFather gave you (it looks like 123456:ABC-...)")
        info, msg = tg_find_chat(token)
        if info is None or not info.get("chat_id"):
            raise HTTPException(400, msg)
        d = {"token": token, "enabled": True, **info}
        ok, why = tg_send(f"✓ {alerts.host}: Telegram alerts are set up. You will get a message here when something "
                          f"needs you.\n{alerts.console_url()}", d)
        if not ok:
            raise HTTPException(400, f"the test message failed: {why}")
        tg_save({**d, "last_ok": time.time()})
        con = ctx.con()
        db.add_event(con, "alerts.telegram", f"Telegram alerts set up (bot @{info.get('bot_username')})", actor=s.username,
                     source=ip_of(request))
        return tg_public()

    @app.delete("/api/alerts/telegram")
    def del_telegram(request: Request, s: auth.Session = Depends(session_dep)):
        with contextlib.suppress(FileNotFoundError):
            (config.STATE / "telegram.json").unlink()
        db.add_event(ctx.con(), "alerts.telegram", "Telegram alerts removed", actor=s.username, source=ip_of(request))
        return tg_public()

    @app.post("/api/alerts/test")
    def test_alert(s: auth.Session = Depends(session_dep)):
        ok, why = tg_send(f"ℹ {alerts.host}: a test message from the console.\n{alerts.console_url()}")
        if ok:
            tg_update(last_ok=time.time())
        else:
            tg_update(last_error=why, last_error_at=time.time())
        return {"ok": ok, "message": why, "telegram": tg_public()}

    # ---------------------------------------------------------------------------------------------------- system
    @app.get("/api/system")
    def system(s: auth.Session = Depends(session_dep)):
        from .system import posture, system_info
        return {"info": system_info(ctx, live), "posture": posture(ctx, live)}

    @app.get("/api/metrics")
    def metrics(range_: str = Query("1h", alias="range"), s: auth.Session = Depends(session_dep)):
        from .system import metrics_series
        return metrics_series(ctx, live, range_)

    @app.get("/api/tls")
    def tls_status(s: auth.Session = Depends(session_dep)):
        return tls.status()

    @app.put("/api/settings/hsts")
    def set_hsts(request: Request, body: dict = Body(...), s: auth.Session = Depends(session_dep)):
        on = bool(body.get("enabled"))
        db.set_setting(ctx.con(), "console.hsts", on, by=s.username)
        db.add_event(ctx.con(), "console.hsts", f"HSTS turned {'on' if on else 'off'}", actor=s.username,
                     source=ip_of(request))
        return {"hsts": on}

    # --------------------------------------------------------------------------------------------- live socket
    @app.websocket("/api/live")
    async def live_ws(ws: WebSocket):
        host = ws.headers.get("host")
        if not auth.own_origin_ok(ws.headers.get("origin"), host, ctx.names, ctx.dev_origins):
            await ws.close(code=4403)
            return
        name = auth.COOKIE_SECURE if ws.url.scheme == "wss" else auth.COOKIE_PLAIN
        sid = ws.cookies.get(name)
        sess = await asyncio.to_thread(lambda: auth.session(ctx.con(), sid))
        if sess is None:
            await ws.close(code=4401)
            return
        await ws.accept()
        c = Client(sess.id_hash)
        live.clients.add(c)
        checked = time.time()

        async def reader():
            while True:
                msg = await ws.receive_json()
                if not isinstance(msg, dict):
                    continue
                if msg.get("op") == "sub":
                    live.subscribe(c, msg.get("topics") or [])
                elif msg.get("op") == "unsub":
                    c.topics -= set(msg.get("topics") or [])
                elif msg.get("op") == "ping":
                    c.put({"t": "pong", "d": {}, "at": time.time()})

        rt = asyncio.create_task(reader())
        try:
            while not rt.done():
                try:
                    msg = await asyncio.wait_for(c.q.get(), 15.0)
                except asyncio.TimeoutError:
                    msg = {"t": "hb", "d": {}, "at": time.time()}
                if msg.get("t") == "signout":
                    await ws.send_json(msg)
                    break
                await ws.send_json(msg)
                if time.time() - checked > 300:            # the session is checked again every 5 minutes
                    checked = time.time()
                    ok = await asyncio.to_thread(lambda: auth.session(ctx.con(), sid))
                    if ok is None:
                        await ws.send_json({"t": "signout", "d": {}, "at": time.time()})
                        break
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            rt.cancel()
            live.clients.discard(c)
            with contextlib.suppress(Exception):
                await ws.close()

    # ------------------------------------------------------------------------------------- part 2 (extras.py)
    def console_token() -> str:
        """The token the playground's requests go through the gateway with (kind "console", loopback only)."""
        f = config.STATE / "console_token"
        plain = config.read_secret(f)
        con = ctx.con()
        pepper = tokens.load_pepper()
        if plain:
            look = tokens.TokenCache(pepper)
            look.load(con)
            if look.lookup(plain).status == "ok":
                return plain
        for r in con.execute("SELECT id FROM tokens WHERE kind='console' AND revoked_at IS NULL").fetchall():
            tokens.revoke(con, r["id"], by="console", reason="replaced")
        _, plain = tokens.create(con, pepper, "console-playground", scopes=["inference"], cidrs=["127.0.0.0/8", "::1/128"],
                                 notes="the console's playground", by="console", kind="console")
        config.write_secret(f, plain + "\n")
        poke()
        return plain

    h.session_dep, h.need_reauth, h.ip_of, h.poke, h.console_token = session_dep, need_reauth, ip_of, poke, console_token
    h.switches = switches
    from . import extras, schedules, tgcommands
    extras.register(app, h)
    from . import chatapi, webtools
    chatapi.register(app, h, toolbox=webtools.Toolbox.from_env(ctx))
    h.start_tasks.append(tgcommands.Commands(h).run)
    h.start_tasks.append(schedules.Scheduler(h).run)

    @app.get("/api/schedules")
    def get_schedules(s: auth.Session = Depends(session_dep)):
        return {"schedules": schedules.load(ctx.con()), "days": schedules.DAYS}

    @app.put("/api/schedules")
    def put_schedules(request: Request, body: dict = Body(...), s: auth.Session = Depends(session_dep)):
        try:
            items = [schedules.normalize(i, SP.names()) for i in body.get("schedules") or []]
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        if len(items) > 20:
            raise HTTPException(400, "at most 20 schedules")
        return {"schedules": schedules.save(ctx.con(), items, s.username, ip_of(request)), "days": schedules.DAYS}

    @app.put("/api/alerts/commands")
    def set_commands(request: Request, body: dict = Body(...), s: auth.Session = Depends(session_dep)):
        on = bool(body.get("enabled"))
        if on:
            need_reauth(s)
        try:
            tgcommands.set_enabled(on)
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        db.add_event(ctx.con(), "alerts.commands", f"Telegram commands turned {'on' if on else 'off'}", actor=s.username,
                     source=ip_of(request), level="warn" if on else "info")
        return tg_public()

    # ------------------------------------------------------------------------------------------------ CA, the UI
    @app.get("/dl/outcrop-web-mcp")
    def dl_web_mcp():
        """The stdio bridge to the web tools for apps (bin/outcrop-web-mcp): no secret in it, so no sign-in needed."""
        f = config.PROJECT / "bin" / "outcrop-web-mcp"
        if not f.is_file():
            raise HTTPException(404, "not found")
        return Response(f.read_bytes(), media_type="text/x-python; charset=utf-8",
                        headers={"Content-Disposition": 'attachment; filename="outcrop-web-mcp"', "Cache-Control": "no-cache"})

    @app.get("/ca.crt")
    def ca_crt():
        pem = tls.ca_pem()
        if pem is None:
            raise HTTPException(404, "no CA yet")
        return Response(pem, media_type="application/x-x509-ca-cert",
                        headers={"Content-Disposition": f'attachment; filename="{__import__("socket").gethostname()}-ca.crt"'})

    @app.get("/{path:path}")
    def ui(path: str, request: Request):
        if path.startswith("api/"):
            raise HTTPException(404, "not found")
        dist = ctx.web_dist
        f = (dist / path).resolve()
        if path and f.is_file() and dist.resolve() in f.parents:
            immutable = path.startswith("assets/")
            return FileResponse(f, headers={"Cache-Control": "public, max-age=31536000, immutable" if immutable
                                            else "no-cache"})
        idx = dist / "index.html"
        if idx.exists():
            return FileResponse(idx, headers={"Cache-Control": "no-cache"})
        return PlainTextResponse("The console's UI is not built yet: setup/build-ui.sh", status_code=503)

    return app


class BodyLimit:
    """Refuse a request body over its route's limit before anything reads it (FastAPI parses a JSON body before the
    session is checked, so without this anyone on the LAN could make the console hold gigabytes).  1 MB in general;
    32 MB where pictures go (the chat, the playground, Strata's own page)."""
    BIG = ("/api/chats", "/api/playground/", "/strata/")

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        limit = (32 << 20) if scope["path"].startswith(self.BIG) else (1 << 20)
        cl = dict(scope.get("headers") or []).get(b"content-length")
        if cl is not None and (not cl.isdigit() or int(cl) > limit):
            return await self._too_large(send, limit)
        if scope.get("method") in ("GET", "HEAD", "OPTIONS"):
            return await self.app(scope, receive, send)
        # read the body here, up to the limit, then hand it on: whatever middleware or route comes next, nothing
        # beyond the limit is ever held
        chunks, seen = [], 0
        while True:
            m = await receive()
            if m["type"] == "http.disconnect":
                return
            seen += len(m.get("body", b""))
            if seen > limit:
                return await self._too_large(send, limit)
            chunks.append(m.get("body", b""))
            if not m.get("more_body"):
                break
        body, sent = b"".join(chunks), False

        async def replay():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)

    @staticmethod
    async def _too_large(send, limit):
        body = json.dumps({"error": f"too large: at most {limit >> 20} MB"}).encode()
        try:
            await send({"type": "http.response.start", "status": 413,
                        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
        except Exception:                                      # noqa: BLE001 - a response had started: nothing to add
            pass


def csrf_problem(request: Request, ctx: Ctx) -> str | None:
    """Every change must come from the console's own page: JSON (when there is a body), our header, our origin."""
    h = request.headers
    if h.get("x-outcrop") != "1":
        return "missing the X-Outcrop header"
    origin = h.get("origin")
    if origin is None and h.get("sec-fetch-site") == "same-origin":
        origin = f"{request.url.scheme}://{h.get('host')}"
    if not auth.own_origin_ok(origin, h.get("host"), ctx.names, ctx.dev_origins):
        return "this request did not come from the console's own page"
    cl = h.get("content-length")
    if (cl and cl != "0") or h.get("transfer-encoding"):
        if not (h.get("content-type") or "").startswith("application/json"):
            return "send JSON"
    return None


def security_headers(request: Request, ctx: Ctx, api: bool) -> dict:
    h = {"Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
         "X-Frame-Options": "DENY", "Cross-Origin-Opener-Policy": "same-origin",
         "Cross-Origin-Resource-Policy": "same-origin",
         "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"}
    if api:
        h["Cache-Control"] = "no-store"
    if request.url.scheme == "https" and _hsts(ctx):
        h["Strict-Transport-Security"] = "max-age=31536000"
    return h


_HSTS = {"at": 0.0, "on": False}


def _hsts(ctx: Ctx) -> bool:
    """The HSTS setting, read at most every 10 s (this runs on the event loop for every response)."""
    if time.time() - _HSTS["at"] > 10:
        try:
            _HSTS["on"] = bool(db.get_setting(ctx.con(), "console.hsts", False))
        except Exception:
            pass
        _HSTS["at"] = time.time()
    return _HSTS["on"]


def fake_units(ctl) -> dict:
    cur = ctl.current()
    out = {u: {"active": "active", "sub": "running", "since": None, "pid": 1, "restarts": 0, "result": "success",
               "enabled": "enabled"} for u in ("outcrop-gateway.service", "outcrop-console.service", "outcrop-ollama-bridge.service")}
    if cur:
        out[f"outcrop-engine@{cur}.service"] = {"active": "active", "sub": "running", "since": None, "pid": 2, "restarts": 0,
                                            "result": "success", "enabled": "disabled"}
    return out


Path  # noqa: B018
