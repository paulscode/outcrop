"""Telegram commands: /status, /switch PRESET, /close, /help from your own chat only.

Off unless turned on (`outcrop alerts commands on`, or Settings).  The console asks Telegram for new messages (long polling;
no port is opened to the internet), answers only the chat that alerts go to, and ignores everyone else.  Nothing that widens
access can be done from Telegram: no opening the API, no tokens.  Every command goes in the audit log.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time

import httpx

from ..common import db
from .alerts import tg_load, tg_update

log = logging.getLogger("outcrop.console")
HELP = ("Commands:\n/status  what runs, access, GPU\n/switch PRESET  run another preset\n/close  require tokens again "
        "(if the API is open)\n/help  this list")


class Commands:
    def __init__(self, h):
        self.h = h
        self.offset = None
        self.bot = None

    def enabled(self) -> bool:
        d = tg_load()
        return bool(d.get("token") and d.get("chat_id") and d.get("commands"))

    async def run(self) -> None:
        backoff = 15
        while True:
            if not self.enabled():
                await asyncio.sleep(10)
                continue
            try:
                await self.poll_once()
                backoff = 15
            except Exception as e:                                  # noqa: BLE001
                # a refused token, a second poller (409), no network: say it once in a while, wait longer each time
                log.warning("Telegram commands: %s (next try in %d s)", str(e)[:200], backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 900)

    async def poll_once(self, timeout: int = 50) -> int:
        d = tg_load()
        tok, chat = d["token"], int(d["chat_id"])
        params = {"timeout": timeout, "allowed_updates": '["message"]'}
        bot = str(tok).split(":", 1)[0]
        if bot != self.bot:                                    # a new bot: its updates have their own numbers
            self.bot, self.offset = bot, None
        saved = d.get("offset")
        if self.offset is None and isinstance(saved, dict) and saved.get("bot") == bot:
            self.offset = int(saved["n"])                      # kept across restarts: no command runs twice
        elif self.offset is None and isinstance(saved, int):
            self.offset = saved                                # saved by an older version, for the bot of the time
        if self.offset is not None:
            params["offset"] = self.offset
        async with httpx.AsyncClient(timeout=timeout + 15) as c:
            r = await c.get(f"https://api.telegram.org/bot{tok}/getUpdates", params=params)
            j = r.json()
            if not j.get("ok"):
                raise RuntimeError(str(j.get("description")))
            n = 0
            results = j.get("result", [])
            for u in results:
                self.offset = u["update_id"] + 1
                m = u.get("message") or {}
                if (m.get("chat") or {}).get("id") != chat or not m.get("text"):
                    continue                                    # not the owner's chat: ignored
                if time.time() - float(m.get("date") or 0) > 600:
                    continue                                    # sent while the console was down: too old to act on
                reply = await asyncio.to_thread(self.handle, m["text"].strip())
                await c.post(f"https://api.telegram.org/bot{tok}/sendMessage",
                             json={"chat_id": chat, "text": reply, "disable_web_page_preview": True})
                n += 1
            if results:
                tg_update(offset={"bot": bot, "n": self.offset})
            return n

    def handle(self, text: str) -> str:
        h = self.h
        con = h.ctx.con()
        cmd, _, arg = text.partition(" ")
        cmd = cmd.split("@", 1)[0].lower()
        host = h.alerts.host
        db.add_event(con, "telegram.command", f"Telegram: {text[:60]}", actor="telegram", source="telegram")
        if cmd in ("/start", "/help"):
            return HELP
        if cmd == "/status":
            cur, dflt = h.ctl.current(), h.ctl.default()
            mode = db.get_setting(con, "auth.mode")
            open_now = mode.get("mode") == "open" and float(mode.get("until") or 0) > time.time()
            s = h.live.history[-1] if h.live.history else {}
            g, e = s.get("gpu") or {}, s.get("engine") or {}
            lines = [f"{host}: {cur or 'nothing'} running" + (f" (boot default {dflt})" if dflt != cur else ""),
                     f"engine: {e.get('state') or '?'}" + (f", {e.get('tok_s')} tok/s" if e.get("tok_s") else ""),
                     f"GPU: {g.get('util', '?')}%, {g.get('temp', '?')} °C, {g.get('power', '?')} W",
                     "API: OPEN until " + time.strftime("%H:%M", time.localtime(mode["until"])) if open_now
                     else "API: tokens required",
                     f"alerts open: {len(h.alerts.summary()['open'])}"]
            return "\n".join(lines)
        if cmd == "/switch":
            name = arg.strip().lower()
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,40}", name or ""):
                return "usage: /switch PRESET (" + ", ".join(h.ctl.presets()["presets"]) + ")"
            if name not in h.ctl.presets()["presets"]:
                return f"no preset {name!r}: " + ", ".join(h.ctl.presets()["presets"])
            try:
                h.switches.start(name, when="now", cancel_inflight=False, by="telegram", source="telegram",
                                 restart=name == h.ctl.current())
            except Exception as ex:
                return f"cannot switch: {getattr(ex, 'detail', ex)}"
            return f"switching to {name}; running requests finish first, new ones wait. About a minute."
        if cmd == "/close":
            mode = db.get_setting(con, "auth.mode")
            if mode.get("mode") != "open":
                return "the API is already closed: tokens are required"
            with db.tx(con):
                db.set_setting(con, "auth.mode", {"mode": "enforced"}, by="telegram")
                db.add_event(con, "auth.close", "API closed from Telegram", actor="telegram", source="telegram")
            h.poke()
            return "closed: tokens are required again"
        return "unknown command. " + HELP


def set_enabled(on: bool) -> dict:
    d = tg_update(commands=bool(on))
    if d is None:
        raise ValueError("set up Telegram first (outcrop alerts telegram)")
    return d
