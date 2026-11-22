"""Alerts, in the console and on Telegram.

Every alert shows in the console (the bell and the Timeline); the rules you choose are also sent to Telegram by a bot you
create.  Messages are short, never contain prompts, answers, tokens or passwords, and link back to the console.  An alert is
sent once when it opens (repeats are suppressed while it stays open) and once more when it clears.  The bot only sends.

The bot token is kept in $OUTCROP_HOME/state/telegram.json (0600), not in the database, and the API never returns it.
"""
from __future__ import annotations

import asyncio
import collections
import json
import logging
import shutil
import socket
import threading
import time

import httpx

from ..common import config, db

log = logging.getLogger("outcrop.console")
TG_FILE = config.STATE / "telegram.json"

RULES = {
    "service": {"label": "A service failed or is restarting", "level": "error", "telegram": True},
    "gpu_hot": {"label": "GPU above 83 °C or throttling", "level": "warn", "telegram": True},
    "gpu_contention": {"label": "Another process is using the GPU", "level": "warn", "telegram": True},
    "disk": {"label": "Disk under 10% free", "level": "warn", "telegram": True},
    "api_open": {"label": "The API was opened or closed", "level": "info", "telegram": True},
    "auth_burst": {"label": "A burst of failed sign-ins or bad tokens", "level": "warn", "telegram": True},
    "token_expiry": {"label": "A token expires within 7 days", "level": "info", "telegram": False},
    "job_done": {"label": "A long job has finished", "level": "info", "telegram": True},
}
ICON = {"error": "✗", "warn": "⚠", "info": "ℹ", "ok": "✓"}


def tg_load() -> dict:
    try:
        return json.loads(TG_FILE.read_text())
    except (OSError, ValueError):
        return {}


def tg_save(d: dict) -> None:
    config.write_secret(TG_FILE, json.dumps(d))


TG_LOCK = threading.Lock()


def tg_update(**fields) -> dict | None:
    """Change some fields of the Telegram settings, read and written under one lock (the alert sender, the command
    poller and the settings routes all touch the file).  Nothing is written when Telegram was removed meanwhile."""
    with TG_LOCK:
        d = tg_load()
        if not d.get("token"):
            return None
        d.update(fields)
        tg_save(d)
        return d


def tg_public() -> dict:
    d = tg_load()
    t = d.get("token") or ""
    return {"configured": bool(t and d.get("chat_id")), "enabled": bool(d.get("enabled", True)),
            "bot": d.get("bot_username"), "chat_id": d.get("chat_id"), "chat_name": d.get("chat_name"),
            "token_hint": (t.split(":")[0] + ":…") if t else None, "last_ok": d.get("last_ok"), "last_error": d.get("last_error"),
            "last_error_at": d.get("last_error_at"), "commands": bool(d.get("commands"))}


def tg_send(text: str, d: dict | None = None, timeout: float = 10.0) -> tuple[bool, str]:
    d = d or tg_load()
    tok, chat = d.get("token"), d.get("chat_id")
    if not tok or not chat:
        return False, "Telegram is not set up"
    try:
        r = httpx.post(f"https://api.telegram.org/bot{tok}/sendMessage", timeout=timeout,
                       json={"chat_id": chat, "text": text, "disable_web_page_preview": True})
        j = r.json()
        if j.get("ok"):
            return True, "sent"
        return False, str(j.get("description") or r.status_code)[:200]
    except (httpx.HTTPError, ValueError) as e:
        return False, f"{type(e).__name__}: {e}"[:200]


def tg_find_chat(token: str) -> tuple[dict | None, str]:
    """The bot's name, and the private chat that last wrote to it (the owner's first message)."""
    try:
        me = httpx.get(f"https://api.telegram.org/bot{token}/getMe", timeout=10).json()
        if not me.get("ok"):
            return None, str(me.get("description") or "the token was refused")
        up = httpx.get(f"https://api.telegram.org/bot{token}/getUpdates", timeout=10).json()
    except (httpx.HTTPError, ValueError) as e:
        return None, f"{type(e).__name__}: {e}"
    chats = [u.get("message", {}).get("chat") for u in up.get("result", []) if u.get("message")]
    chats = [c for c in chats if c and c.get("type") == "private"]
    if not chats:
        return {"bot_username": me["result"].get("username")}, "send your bot any message first, then try again"
    if len({c["id"] for c in chats}) > 1:
        # someone else found the bot too: don't guess which chat is yours
        names = ", ".join(sorted({str(c.get("username") or c.get("first_name") or c["id"]) for c in chats}))
        return None, (f"more than one person has written to this bot ({names}); make a new bot with @BotFather, or "
                      f"wait a day for Telegram to drop the old messages, and write to it only from your account")
    c = chats[-1]
    return {"bot_username": me["result"].get("username"), "chat_id": c["id"],
            "chat_name": " ".join(x for x in (c.get("first_name"), c.get("last_name")) if x) or c.get("username")}, "ok"


class Alerts:
    def __init__(self, ctx, live):
        self.ctx = ctx
        self.live = live
        self.host = socket.gethostname()
        self.hot_since = None
        self.contention_since = None
        self.signin_fails = collections.deque(maxlen=200)
        self.auth_fails = collections.deque(maxlen=2000)
        self.last_burst: dict[str, float] = {}
        self.gw_down_since: float | None = None
        self.loop = None
        self._open: set | None = None           # keys of open alerts (from the database: survives a restart)
        self.stable_since: dict[str, float] = {}  # unit -> when it was last seen running with no new restart
        self.missing: dict[str, int] = {}         # unit with an open alert -> polls in a row it was not listed

    # ------------------------------------------------------------------------------------------------ settings
    def rules(self) -> dict:
        s = db.get_setting(self.ctx.con(), "alerts.rules", {}) or {}
        return {k: {**{"enabled": True, "telegram": v["telegram"]}, **(s.get(k) or {}), "label": v["label"],
                    "level": v["level"]} for k, v in RULES.items()}

    def console_url(self) -> str:
        return f"https://{self.host}.local"

    # ------------------------------------------------------------------------------------------------- lifecycle
    def open(self, rule: str, key: str, summary: str, details: dict | None = None, level: str | None = None,
             notify_only: bool = False) -> None:
        """Open an alert (once while it stays open); `notify_only`: a one-off notice that closes at once."""
        con = self.ctx.con()
        now = time.time()
        level = level or RULES[rule]["level"]
        row = con.execute("SELECT id FROM alerts WHERE key=? AND closed_at IS NULL", (key,)).fetchone()
        if row is not None and not notify_only:
            con.execute("UPDATE alerts SET last_seen=? WHERE id=?", (now, row["id"]))
            return
        if not notify_only:
            self.is_open(key)
            self._open.add(key)
        with db.tx(con):
            cur = con.execute("INSERT INTO alerts(rule, key, level, opened_at, closed_at, last_seen, summary, details) "
                              "VALUES(?,?,?,?,?,?,?,?)", (rule, key, level, now, now if notify_only else None, now, summary,
                                                          json.dumps(details or {})))
            aid = cur.lastrowid
            db.add_event(con, f"alert.{rule}", summary, actor="console", level=level, details={"alert_id": aid, **(details or {})})
        self._publish()
        self._notify(aid, rule, f"{ICON.get(level, '•')} {self.host}: {summary}")

    def is_open(self, key: str) -> bool:
        if self._open is None:
            self._open = {r["key"] for r in self.ctx.con().execute("SELECT key FROM alerts WHERE closed_at IS NULL")}
        return key in self._open

    def close(self, key: str, summary: str | None = None) -> None:
        self.is_open(key)
        self._open.discard(key)
        self.missing.pop(key.split(":", 1)[-1], None)            # a later alert for that unit starts counting afresh
        con = self.ctx.con()
        rows = con.execute("SELECT id, rule, summary FROM alerts WHERE key=? AND closed_at IS NULL", (key,)).fetchall()
        if not rows:
            return
        now = time.time()
        with db.tx(con):
            for r in rows:
                con.execute("UPDATE alerts SET closed_at=? WHERE id=?", (now, r["id"]))
                db.add_event(con, f"alert.{r['rule']}.clear", summary or f"cleared: {r['summary']}", actor="console")
        self._publish()
        r = rows[0]
        self._notify(r["id"], r["rule"], f"{ICON['ok']} {self.host}: {summary or 'cleared: ' + r['summary']}")

    def _notify(self, aid: int, rule: str, text: str) -> None:
        rr = self.rules().get(rule, {})
        if not rr.get("enabled", True) or not rr.get("telegram"):
            return
        d = tg_load()
        if not d.get("token") or not d.get("chat_id") or not d.get("enabled", True):
            return
        text = f"{text}\n{self.console_url()}"

        def work():
            ok, msg = tg_send(text, d)
            con = self.ctx.con()
            con.execute("UPDATE alerts SET sent=? WHERE id=?", (json.dumps({"telegram": "ok" if ok else msg}), aid))
            if ok:
                tg_update(last_ok=time.time())
            else:
                tg_update(last_error=msg, last_error_at=time.time())
            if not ok:
                log.warning("Telegram: %s", msg)
            self._publish()

        if self.loop is not None:
            self.loop.run_in_executor(None, work)
        else:
            work()

    def _publish(self) -> None:
        try:
            self.live.publish("alerts", self.summary())
        except Exception:
            pass

    def summary(self) -> dict:
        con = self.ctx.con()
        open_ = [dict(r) for r in con.execute("SELECT * FROM alerts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 50")]
        recent = [dict(r) for r in con.execute("SELECT * FROM alerts ORDER BY opened_at DESC LIMIT 30")]
        for r in open_ + recent:
            r["details"] = json.loads(r.get("details") or "{}")
            r["sent"] = json.loads(r.get("sent") or "{}")
        return {"open": open_, "recent": recent, "telegram": tg_public(),
                "unacked": sum(1 for r in recent if not r.get("acked_at"))}

    # ------------------------------------------------------------------------------------------------ observers
    def _open_keys(self, prefix: str) -> set:
        return {r["key"] for r in self.ctx.con().execute("SELECT key FROM alerts WHERE closed_at IS NULL AND key LIKE ?",
                                                         (prefix + "%",))}

    def observe_units(self, prev: dict, cur: dict) -> None:
        """Called on every poll (every 2 s): a unit that failed or crash-restarted opens an alert; once it is active again
        with no new restart, the alert clears."""
        if not self.rules()["service"]["enabled"]:
            return
        if not cur:
            return                      # an empty poll (systemctl did not answer): it says nothing about the units
        open_keys = self._open_keys("service:")
        for unit, st in cur.items():
            if unit == "outcrop-boot.service":
                continue
            p = prev.get(unit) or {}
            key = f"service:{unit}"
            name = unit.replace(".service", "")
            if st.get("active") == "failed":
                self.open("service", key, f"{name} failed"
                          + (f" ({st.get('result')})" if st.get("result") not in (None, "success") else ""), {"unit": unit})
            elif p and st.get("restarts", 0) > p.get("restarts", 0):
                self.open("service", key, f"{name} crashed and is restarting (restart {st.get('restarts')})", {"unit": unit})
            elif st.get("active") == "active" and st.get("restarts", 0) == p.get("restarts", 0):
                # cleared once it has run for 3 minutes without a restart: a unit crashing every 30 s is one alert,
                # not an open and a clear each time
                since = self.stable_since.setdefault(unit, time.time())
                if key in open_keys and time.time() - since >= 180:
                    self.close(key, f"{name} is running again")
                continue
            self.stable_since.pop(unit, None)
        for key in open_keys:                                   # a unit that is gone (a preset switched away from)
            unit = key.split(":", 1)[1]
            if unit.endswith(".service") and unit not in cur:
                self.missing[unit] = self.missing.get(unit, 0) + 1
                if self.missing[unit] >= 3:                       # three polls in a row, not one hiccup
                    self.missing.pop(unit, None)
                    self.close(key, f"{unit.replace('.service', '')} is no longer running")
            else:
                self.missing.pop(unit, None)
        gw = cur.get("outcrop-gateway.service")
        down = bool(gw and gw.get("enabled") == "enabled" and gw.get("active") in ("inactive", "failed")
                    and not config.BYPASS_FILE.exists())
        if down:
            self.gw_down_since = self.gw_down_since or time.time()
            if time.time() - self.gw_down_since >= 10:           # not for a restart that takes a moment
                self.open("service", "service:gateway-down", "the API gateway is not running: the API is down",
                          {"unit": "outcrop-gateway.service"})
        else:
            self.gw_down_since = None
            if gw and gw.get("active") == "active" and "service:gateway-down" in open_keys:
                self.close("service:gateway-down", "the API gateway is running again")

    def observe_sample(self, s: dict) -> None:
        g = s.get("gpu") or {}
        now = s.get("t") or time.time()
        temp = g.get("temp") or 0
        thr = [x for x in (g.get("throttle") or []) if x in ("thermal", "thermal (software)", "hardware slowdown",
                                                             "power brake")]
        if temp > 83 or thr:
            self.hot_since = self.hot_since or now
            if now - self.hot_since >= 60:
                why = f"GPU at {temp} °C" + (f" (throttling: {', '.join(thr)})" if thr else "") + " for over a minute"
                self.open("gpu_hot", "gpu_hot", why, {"temp": temp, "throttle": thr})
        else:
            if temp < 78:
                if self.is_open("gpu_hot"):
                    self.close("gpu_hot", f"GPU back to {temp} °C")
                self.hot_since = None
        others = [p for p in g.get("procs") or [] if "strata" not in (p.get("name") or "") and (p.get("mem") or 0) > 0]
        if others:
            self.contention_since = self.contention_since or now
            if now - self.contention_since >= 30:
                names = ", ".join(sorted({p["name"] for p in others}))
                self.open("gpu_contention", "gpu_contention", f"another process is using the GPU ({names}); sharing "
                          f"it with a remote desktop cost 7 to 15% of decode speed", {"procs": others})
        else:
            if self.is_open("gpu_contention"):
                self.close("gpu_contention", "the GPU is Strata's alone again")
            self.contention_since = None

    def _burst(self, key: str, summary: str, details: dict | None = None) -> None:
        """A burst is a one-off notice (nothing to clear), at most once per 10 minutes per kind."""
        now = time.time()
        if now - self.last_burst.get(key, 0) < 600:
            return
        self.last_burst[key] = now
        self.open("auth_burst", f"{key}:{now:.0f}", summary, details, notify_only=True)

    def observe_auth_fail(self, ev: dict) -> None:
        now = time.time()
        self.auth_fails.append((now, ev.get("ip")))
        recent = [x for x in self.auth_fails if now - x[0] < 300]
        if len(recent) >= 20:
            ips = collections.Counter(ip for _, ip in recent).most_common(3)
            self._burst("auth_burst:tokens", f"{len(recent)} requests with no valid token in 5 minutes, mostly from "
                        f"{', '.join(f'{ip} ({n})' for ip, n in ips)}", {"ips": ips})

    def observe_signin_fail(self, ip: str) -> None:
        now = time.time()
        self.signin_fails.append((now, ip))
        recent = [x for x in self.signin_fails if now - x[0] < 600]
        if len(recent) >= 5:
            self._burst("auth_burst:signin", f"{len(recent)} failed console sign-ins in 10 minutes "
                        f"(from {', '.join(sorted({i for _, i in recent}))})")

    def observe_mode(self, ev: dict) -> None:
        if ev.get("mode") == "open":
            until = ev.get("until")
            when = time.strftime("%H:%M", time.localtime(until)) if until else "?"
            self.open("api_open", f"api_open:{until}", f"the API is open without tokens until {when}", notify_only=True,
                      level="warn")
        else:
            why = " by itself" if ev.get("reason") == "expired" else ""
            self.open("api_open", f"api_closed:{time.time():.0f}", f"the API closed{why}: tokens are required again",
                      notify_only=True, level="info")

    def observe_request(self, r: dict) -> None:
        pass

    def job_done(self, summary: str, details: dict | None = None) -> None:
        self.open("job_done", f"job:{time.time():.0f}", summary, details, notify_only=True)

    # ---------------------------------------------------------------------------------------------- periodic
    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        # bursts are one-off notices; close any left open by an older version
        await asyncio.to_thread(lambda: self.ctx.con().execute(
            "UPDATE alerts SET closed_at=? WHERE closed_at IS NULL AND rule='auth_burst'", (time.time(),)))
        n = 0
        while True:
            try:
                if n % 300 == 0:
                    await asyncio.to_thread(self._disk)
                if n % 3600 == 30 or n == 5:
                    await asyncio.to_thread(self._expiring)
            except Exception:
                log.exception("alert check failed")
            n += 1
            await asyncio.sleep(1.0)

    def _disk(self) -> None:
        u = shutil.disk_usage(str(config.OUTCROP_HOME if config.OUTCROP_HOME.exists() else config.STATE.parent))
        free = u.free / u.total
        if free < 0.10:
            self.open("disk", "disk", f"the disk is {100 - free * 100:.0f}% full ({u.free / 1e9:.0f} GB free)")
        elif free > 0.12:
            self.close("disk", f"the disk has {free * 100:.0f}% free again")

    def _expiring(self) -> None:
        con = self.ctx.con()
        now = time.time()
        for t in con.execute("SELECT id, name, expires_at FROM tokens WHERE revoked_at IS NULL AND expires_at IS NOT NULL "
                             "AND expires_at > ? AND expires_at < ?", (now, now + 7 * 86400)).fetchall():
            days = (t["expires_at"] - now) / 86400
            self.open("token_expiry", f"token_expiry:{t['id']}", f"token {t['name']!r} expires in {days:.0f} days",
                      {"token_id": t["id"]})
        soon = {f"token_expiry:{t['id']}" for t in con.execute(
            "SELECT id FROM tokens WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at > ? "
            "AND expires_at < ?", (now, now + 7 * 86400))}
        for key in self._open_keys("token_expiry:") - soon:     # renewed, revoked or expired since
            t = con.execute("SELECT name, revoked_at, expires_at FROM tokens WHERE id=?", (key.split(":", 1)[1],)).fetchone()
            why = ("is gone" if t is None else "was revoked" if t["revoked_at"] else
                   "has expired" if t["expires_at"] and t["expires_at"] <= now else "no longer expires soon")
            self.close(key, f"token {t['name'] if t else '?'!r} {why}")
