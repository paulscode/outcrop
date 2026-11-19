"""Telegram commands: only the owner's chat is answered, and nothing widens access."""
import asyncio
import json
import time
import types

import httpx
import pytest

from outcrop.common import db
from outcrop.console import alerts as A
from outcrop.console import tgcommands as T


@pytest.fixture
def h(tmp_path, monkeypatch):
    con = db.connect(tmp_path / "t.db")
    monkeypatch.setattr(A, "TG_FILE", tmp_path / "telegram.json")
    A.tg_save({"token": "1:abc", "chat_id": 42, "enabled": True, "commands": True})
    started = []
    ns = types.SimpleNamespace(
        ctx=types.SimpleNamespace(con=lambda: con),
        ctl=types.SimpleNamespace(current=lambda: "quality", default=lambda: "quality",
                                  presets=lambda: {"presets": {"quality": {}, "speed": {}}}),
        live=types.SimpleNamespace(history=[{"gpu": {"util": 97, "temp": 74, "power": 183}, "engine": {"state": "idle"}}]),
        alerts=types.SimpleNamespace(host="myserver", summary=lambda: {"open": []}),
        switches=types.SimpleNamespace(start=lambda name, **kw: started.append(name)),
        poke=lambda: None)
    ns.con, ns.started = con, started
    return ns


def test_commands(h):
    c = T.Commands(h)
    assert "quality running" in c.handle("/status") and "tokens required" in c.handle("/status")
    assert "switching to speed" in c.handle("/switch speed") and h.started == ["speed"]
    assert "no preset" in c.handle("/switch turbo")
    assert "usage" in c.handle("/switch ../../x")
    assert "already closed" in c.handle("/close")
    db.set_setting(h.con, "auth.mode", {"mode": "open", "until": time.time() + 600})
    assert "closed" in c.handle("/close") and db.get_setting(h.con, "auth.mode")["mode"] == "enforced"
    assert "unknown command" in c.handle("/open 60m")                    # nothing widens access
    assert db.events(h.con, 20, kinds=["telegram.command"])


def test_only_the_owners_chat_is_answered(h, monkeypatch):
    sent = []

    def handler(request: httpx.Request):
        if request.url.path.endswith("/getUpdates"):
            return httpx.Response(200, json={"ok": True, "result": [
                {"update_id": 1, "message": {"chat": {"id": 666}, "text": "/close", "date": time.time()}},
                {"update_id": 2, "message": {"chat": {"id": 42}, "text": "/status", "date": time.time()}},
                {"update_id": 3, "message": {"chat": {"id": 42}, "text": "/switch speed",       # sent while down
                                             "date": time.time() - 3600}}]})
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"ok": True})

    real = httpx.AsyncClient
    monkeypatch.setattr(T.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler)))
    c = T.Commands(h)
    n = asyncio.run(c.poll_once(timeout=1))
    assert n == 1 and len(sent) == 1 and sent[0]["chat_id"] == 42 and "running" in sent[0]["text"]
    assert c.offset == 4 and h.started == []                             # the hour-old /switch was not run
    assert T.tg_load()["offset"] == {"bot": "1", "n": 4}                    # kept for the next start, for this bot


def test_a_new_bot_starts_from_its_own_updates(h, monkeypatch):
    """The saved position belongs to the bot it was saved for: a new bot's first messages are not skipped."""
    seen = []

    def handler(request: httpx.Request):
        if request.url.path.endswith("/getUpdates"):
            seen.append(request.url.params.get("offset"))
            return httpx.Response(200, json={"ok": True, "result": []})
        return httpx.Response(200, json={"ok": True})

    real = httpx.AsyncClient
    monkeypatch.setattr(T.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler)))
    T.tg_update(offset={"bot": "1", "n": 500})
    asyncio.run(T.Commands(h).poll_once(timeout=1))
    assert seen[-1] == "500"                                  # the same bot: carries on
    T.tg_update(token="2:xyz")                                # a new bot
    asyncio.run(T.Commands(h).poll_once(timeout=1))
    assert seen[-1] is None                                   # from its first update
