"""The second review's chat fixes: settings that widen access, an answer that never stays "streaming", a Stop during the
final save, the tool time limit for a call that runs too long, and the daily database maintenance."""
import asyncio
import sqlite3
import threading
import time

from outcrop.common import db
from outcrop.console import chatdb
from outcrop.console.chatapi import widened
from outcrop.console.chatrun import DEFAULTS
import test_chat as tc
from test_chat import H, PW, _fake_stream, wait_done

stack, c = tc.stack, tc.c                        # the chat tests' fixtures


def ask(c, content, **kw):
    r = c.post("/api/chats", json={"content": content, **kw}, headers=H)
    assert r.status_code == 200, r.text
    return r.json()


def _events(c, kind):
    return [dict(r) for r in c.stack.con.execute("SELECT * FROM events WHERE kind=? ORDER BY id", (kind,))]


def test_settings_that_widen_access_need_the_password_again(c):
    st = {**DEFAULTS, "ask_before_open": True, "web_default": False, "max_tool_calls": 4, "tool_time_s": 30}
    db.set_setting(c.stack.con, "chat.settings", st, by="test")
    c.stack.con.execute("UPDATE sessions SET reauth_at=?", (time.time() - 3600,))
    for change in ({"ask_before_open": False}, {"web_default": True}, {"max_tool_calls": 5}, {"tool_time_s": 31}):
        r = c.put("/api/chat/settings", json=change, headers=H)
        assert r.status_code == 403 and r.json()["detail"]["reauth"] is True, change
    # narrowing needs nothing
    assert c.put("/api/chat/settings", json={"max_tool_calls": 3, "tool_time_s": 20}, headers=H).status_code == 200
    assert _events(c, "chat.settings")[-1]["level"] == "info"
    assert c.post("/api/auth/reauth", json={"password": PW}, headers=H).status_code == 200
    r = c.put("/api/chat/settings", json={"ask_before_open": False, "max_tool_calls": 6}, headers=H)
    assert r.status_code == 200 and r.json()["ask_before_open"] is False
    assert _events(c, "chat.settings")[-1]["level"] == "warn"


def test_widened_lists_each_wider_change():
    cur = {**DEFAULTS, "ask_before_open": True, "web_default": False, "web_allowed": False}
    assert widened(cur, dict(cur)) == []
    new = {**cur, "ask_before_open": False, "web_default": True, "web_allowed": True, "apps_any_link": True,
           "max_tool_calls": cur["max_tool_calls"] + 1, "tool_time_s": cur["tool_time_s"] + 1}
    assert sorted(widened(cur, new)) == sorted(["ask_before_open", "web_default", "web_allowed", "apps_any_link",
                                                "max_tool_calls", "tool_time_s"])


def test_an_answer_whose_last_save_fails_does_not_stay_streaming(c, monkeypatch):
    monkeypatch.setattr(c.runner, "_stream", _fake_stream([("delta", {"content": "half"})]))
    real = chatdb.save_message
    fails = {"n": 0}

    def busy(con, mid, **f):
        if f.get("status") == "error" and fails["n"] < 1:
            fails["n"] += 1
            raise sqlite3.OperationalError("database is locked")
        return real(con, mid, **f)

    monkeypatch.setattr(chatdb, "save_message", busy)
    cid = ask(c, "cut off and not saved", web=False)["chat"]["id"]
    m = wait_done(c, cid)["messages"][-1]
    assert fails["n"] == 1 and m["status"] == "error"
    monkeypatch.setattr(chatdb, "save_message", real)
    assert c.post(f"/api/chats/{cid}/turns", json={"content": "next"}, headers=H).status_code == 200


def test_a_stop_while_the_finished_answer_is_saved_keeps_it_done(c, monkeypatch):
    saving, real = threading.Event(), chatdb.index_answer

    def slow(con, mid):
        saving.set()
        time.sleep(0.5)
        return real(con, mid)

    monkeypatch.setattr(chatdb, "index_answer", slow)
    cid = ask(c, "almost done", web=False)["chat"]["id"]
    assert saving.wait(10)
    c.post(f"/api/chats/{cid}/stop", headers=H)
    m = wait_done(c, cid)["messages"][-1]
    assert m["status"] == "done" and m["content"]


def test_a_tool_call_that_runs_past_the_time_limit_is_stopped(c, monkeypatch):
    st = db.get_setting(c.stack.con, "chat.settings", {}) or {}
    db.set_setting(c.stack.con, "chat.settings", {**DEFAULTS, **st, "tool_time_s": 1}, by="test")
    real = c.runner.toolbox.run

    async def slow(name, args, ctx):
        await asyncio.sleep(30)
        return await real(name, args, ctx)

    monkeypatch.setattr(c.runner.toolbox, "run", slow)
    t0 = time.time()
    cid = ask(c, '[[call web_search {"query": "slow"}]]')["chat"]["id"]
    m = wait_done(c, cid)["messages"][-1]
    assert time.time() - t0 < 10
    assert m["tools"][0]["state"] == "error" and "time for tools ran out" in m["tools"][0]["summary"]


def test_the_daily_maintenance_runs(c, monkeypatch):
    ran = []
    monkeypatch.setattr(chatdb, "maintain", lambda con: ran.append(con))

    async def go():
        t = asyncio.ensure_future(c.runner.maintain_loop(first_s=0, every_s=0.05))
        await asyncio.sleep(0.3)
        t.cancel()

    asyncio.run(go())
    assert len(ran) >= 2


def test_an_image_by_file_id_gets_its_own_refusal():
    import pytest

    from outcrop.gateway import bodies
    for part in ({"type": "input_image", "file_id": "file-abc"},
                 {"type": "image", "source": {"type": "file", "file_id": "file_1"}}):
        with pytest.raises(bodies.Refused, match="file ID"):
            bodies.check_images({"messages": [{"role": "user", "content": [part]}]})
    with pytest.raises(bodies.Refused, match="data: URL"):
        bodies.check_images({"messages": [{"content": [{"type": "image_url", "image_url": {"url": "https://x/a.png"}}]}]})
    bodies.check_images({"messages": [{"content": [{"type": "image_url", "image_url": {"url": "data:image/x-foo;base64,AA"}}]}]})
