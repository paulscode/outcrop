"""The chat API (the contract: docs/CHAT-API.md): chats, spaces, turns, the answer stream, search,
settings and export.  Registered by app.create_app()."""
from __future__ import annotations

import asyncio
import contextlib
import json
import re
import time

from fastapi import Body, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from ..common import db
from . import chatdb
from .chatrun import DEFAULTS, SETTINGS_KEY, ChatError, Runner, settings

IMAGE_MAX = 8 << 20                         # bytes of one picture (decoded)
IMAGES_MAX = 8                              # pictures in one question
MAX_TURN_BYTES = 32 << 20                   # the whole JSON body: the console's limit for /api/chats (app.py BodyLimit)
TOO_LARGE = "too large: at most 32 MB in all (up to 8 pictures, each up to 8 MB)"
IMAGE_RE = re.compile(r"data:image/(png|jpeg|gif|webp);base64,")


def widened(cur: dict, new: dict) -> list[str]:
    """The settings changes that let answers (or apps) reach more of the internet, or with less asking: each needs the
    password again and is logged as a warning."""
    out = [k for k in ("web_allowed", "apps_any_link", "web_default") if new[k] and not cur[k]]
    if cur["ask_before_open"] and not new["ask_before_open"]:
        out.append("ask_before_open")
    out += [k for k in ("max_tool_calls", "tool_time_s") if new[k] > cur[k]]
    return out


def register(app, h, toolbox=None) -> Runner:
    ctx = h.ctx
    runner = Runner(h, toolbox)
    h.chats = runner
    app.state.chats = runner
    if toolbox is not None:
        h.start_tasks.append(toolbox.health_loop)
    h.start_tasks.append(runner.maintain_loop)

    def con():
        return runner.con()

    def bad(e: Exception, code: int = 400):
        raise HTTPException(code, str(e)) from None

    def with_running(c: dict | None) -> dict | None:
        if c is not None:
            c["running"] = c["id"] in runner.runs
        return c

    def context_of(cid: str, convo: list[dict]) -> dict:
        used = 0
        for m in reversed(convo):
            st = m.get("stats") or {}
            if m["role"] == "assistant" and st.get("context_tokens") is not None:
                used = int(st["context_tokens"])
                break
        cur = h.ctl.current()
        try:
            mx = ((h.ctl.presets().get("presets") or {}).get(cur) or {}).get("context") if cur else None
        except Exception:                                      # noqa: BLE001 - presets.json being edited
            mx = None
        return {"used": used, "max": mx}

    # ---------------------------------------------------------------------------------------------- settings
    @app.get("/api/chat/settings")
    def get_settings(s=Depends(h.session_dep)):
        return settings(ctx.con()) | {"web_ready": bool(toolbox and toolbox.available()),
                                      "web_status": toolbox.status() if toolbox else {"ready": False, "why": "not set up"}}

    @app.put("/api/chat/settings")
    def put_settings(request: Request, body: dict = Body(...), s=Depends(h.session_dep)):
        cur = settings(ctx.con())
        new = dict(cur)
        for k, v in body.items():
            if k not in DEFAULTS:
                continue
            if k in ("max_tool_calls", "tool_time_s"):
                if isinstance(v, bool) or not isinstance(v, int | float) or v != int(v):
                    raise HTTPException(400, f"{k} is a whole number")
                v = int(v)
                lo, hi = (1, 20) if k == "max_tool_calls" else (10, 300)
                if not lo <= v <= hi:
                    raise HTTPException(400, f"{k} is between {lo} and {hi}")
            elif not isinstance(v, bool):
                raise HTTPException(400, f"{k} is true or false")
            new[k] = v
        wider = widened(cur, new)
        if wider:
            h.need_reauth(s)                                   # widening access: the password again after 10 minutes
        with db.tx(ctx.con()):
            db.set_setting(ctx.con(), SETTINGS_KEY, {k: new[k] for k in DEFAULTS}, by=s.username)
            changed = {k: new[k] for k in DEFAULTS if new[k] != cur[k]}
            if changed:
                db.add_event(ctx.con(), "chat.settings", "chat settings: " + ", ".join(f"{k} {v}" for k, v in changed.items()),
                             actor=s.username, source=h.ip_of(request), level="warn" if wider else "info")
        if toolbox is not None and "web_allowed" in changed:
            toolbox.set_allowed(new["web_allowed"])
        if "web_allowed" in changed or "apps_any_link" in changed:
            try:
                h.poke()                                       # the gateway's web tools for apps follow these too
            except Exception:                                  # noqa: BLE001 - the gateway reloads on its own anyway
                pass
        return get_settings(s)

    # ------------------------------------------------------------------------------------------------- spaces
    @app.get("/api/spaces")
    def list_spaces(s=Depends(h.session_dep)):
        return chatdb.spaces(con())

    @app.post("/api/spaces")
    def create_space(body: dict = Body(...), s=Depends(h.session_dep)):
        try:
            sp = chatdb.create_space(con(), body)
        except ValueError as e:
            bad(e)
        runner.publish("space", space=sp)
        return sp

    @app.patch("/api/spaces/{sid}")
    def patch_space(sid: str, body: dict = Body(...), s=Depends(h.session_dep)):
        try:
            sp = chatdb.update_space(con(), sid, body)
        except KeyError:
            bad("no such space", 404)
        except ValueError as e:
            bad(e)
        runner.publish("space", space=sp)
        return sp

    @app.put("/api/spaces/order")
    def order_spaces(body: dict = Body(...), s=Depends(h.session_dep)):
        ids = [str(i) for i in body.get("ids") or []]
        out = chatdb.order_spaces(con(), ids)
        runner.publish("spaces", spaces=out)
        return out

    @app.delete("/api/spaces/{sid}")
    async def delete_space(sid: str, request: Request, chats: str = "keep", stop: int = 0, s=Depends(h.session_dep)):
        """`chats=delete` deletes its chats too; `stop=1` first stops answers being written in them (else 409)."""
        if chats not in ("keep", "delete"):
            bad("chats is keep or delete")
        running = await asyncio.to_thread(
            lambda: [cid for cid in runner.running() if (chatdb.chat(con(), cid) or {}).get("space_id") == sid])
        if chats == "delete" and running:
            if not stop:
                bad("an answer is being written in this space: stop it first", 409)
            for cid in running:
                await stop_and_wait(cid)
        out = await asyncio.to_thread(_delete_space, sid, chats, request, s)
        runner.after_delete()
        return out

    def _delete_space(sid: str, chats: str, request: Request, s):
        try:
            out = chatdb.delete_space(con(), sid, chats == "delete")
        except KeyError:
            bad("no such space", 404)
        db.add_event(ctx.con(), "chat.space.delete", f"space deleted ({out['chats']} chats "
                     + ("deleted too)" if chats == "delete" else "kept)"), actor=s.username, source=h.ip_of(request))
        for cid in out["ids"]:                                 # each deleted chat leaves every open console
            runner.publish("chat.deleted", id=cid)
        runner.publish("space.deleted", id=sid, chats=chats)
        return out

    # -------------------------------------------------------------------------------------------------- chats
    @app.get("/api/chats")
    def list_chats(space: str | None = None, limit: int = 500, before: float | None = None, s=Depends(h.session_dep)):
        return {"chats": [with_running(c) for c in chatdb.list_chats(con(), space, limit, before)],
                "running": runner.running()}

    @app.post("/api/chats")
    async def create_chat(request: Request, s=Depends(h.session_dep)):
        """A new chat; with `content` (or `images`) its first question goes at once."""
        body = await _json(request)
        st = settings(ctx.con())
        sid = body.get("space_id") or None
        sp = chatdb.space(con(), str(sid)) if sid else None
        if sid and sp is None:
            bad("no such space")
        try:
            web = chatdb.as_bool(body, "web", nullable=True)
            thinking = chatdb.as_bool(body, "thinking", nullable=True)
            content, images = _content(body), _images(body)
        except ValueError as e:
            bad(e)
        web = (sp["web"] if sp and sp["web"] is not None else st["web_default"]) if web is None else web
        thinking = (sp["thinking"] if sp and sp["thinking"] is not None else True) if thinking is None else thinking
        c = chatdb.create_chat(con(), sid, web=web, thinking=thinking)
        out = {"chat": c}
        if content or images:
            try:
                out |= runner.start(c["id"], content=content, images=images, by=s.username)
            except (ValueError, RuntimeError) as e:
                bad(e)
        else:
            runner.publish("chat", chat=c)
        out["chat"] = with_running(chatdb.chat(con(), c["id"]))
        return out

    @app.get("/api/chats/search")
    def search(q: str = "", space: str | None = None, limit: int = 30, s=Depends(h.session_dep)):
        return {"q": q, "results": chatdb.search(con(), q[:200], space, min(max(limit, 1), 100))}

    @app.get("/api/chats/stats")
    def chat_stats(s=Depends(h.session_dep)):
        """Today's counts (since local midnight), for Overview: answers, searches, pages read, links refused."""
        t = time.localtime()
        midnight = time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1))
        return chatdb.stats(con(), midnight)

    @app.get("/api/chats/export")
    def export_all(s=Depends(h.session_dep)):
        data = json.dumps(chatdb.export_all(con()), indent=1)
        name = f"chats-{time.strftime('%Y%m%d-%H%M')}.json"
        return Response(data, media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})

    @app.post("/api/chats/delete")
    async def delete_many(request: Request, body: dict = Body(...), s=Depends(h.session_dep)):
        """{ids, stop?}: several; `stop: true` stops answers being written first (else 409)."""
        ids = [str(i) for i in body.get("ids") or []][:500]
        busy = [i for i in ids if i in runner.runs]
        if busy and not body.get("stop"):
            bad("an answer is being written in one of these chats: stop it first", 409)
        for cid in busy:
            await stop_and_wait(cid)
        out = await asyncio.to_thread(_delete_many, ids, request, s)
        runner.after_delete()
        return out

    def _delete_many(ids: list[str], request: Request, s):
        out = chatdb.delete_chats(con(), ids)
        if out["chats"]:
            db.add_event(ctx.con(), "chat.delete", f"{out['chats']} chat(s) deleted ({out['messages']} messages)",
                         actor=s.username, source=h.ip_of(request))
        for cid in out["ids"]:
            runner.publish("chat.deleted", id=cid)
        return out

    @app.post("/api/chats/move")
    def move_many(body: dict = Body(...), s=Depends(h.session_dep)):
        ids = [str(i) for i in body.get("ids") or []][:500]
        try:
            n = chatdb.move_chats(con(), ids, body.get("space_id") or None)
        except ValueError as e:
            bad(e)
        for cid in ids:
            c = chatdb.chat(con(), cid)
            if c:
                runner.publish("chat", chat=with_running(c))
        return {"moved": n}

    @app.get("/api/chats/{cid}")
    def get_chat(cid: str, s=Depends(h.session_dep)):
        c = chatdb.chat(con(), cid)
        if c is None:
            bad("no such chat", 404)
        convo = chatdb.path(con(), cid)
        return {"chat": with_running(c), "messages": convo, "context": context_of(cid, convo),
                "space": chatdb.space(con(), c["space_id"]) if c["space_id"] else None,
                "suggested_space": chatdb.space(con(), c["suggested_space"]) if c["suggested_space"] else None}

    @app.patch("/api/chats/{cid}")
    def patch_chat(cid: str, body: dict = Body(...), s=Depends(h.session_dep)):
        try:
            c = chatdb.update_chat(con(), cid, body)
        except KeyError:
            bad("no such chat", 404)
        except ValueError as e:
            bad(e)
        runner.publish("chat", chat=with_running(c))
        return with_running(c)

    async def stop_and_wait(cid: str) -> None:
        r = runner.runs.get(cid)
        if r is not None and r.task is not None:
            r.task.cancel()
            with contextlib.suppress(asyncio.CancelledError, asyncio.TimeoutError, Exception):
                await asyncio.wait_for(asyncio.shield(r.task), 10)

    @app.delete("/api/chats/{cid}")
    async def delete_chat(cid: str, request: Request, stop: int = 0, s=Depends(h.session_dep)):
        """Delete for good.  ?stop=1 stops an answer being written first (else 409)."""
        if cid in runner.runs:
            if not stop:
                bad("an answer is being written in this chat: stop it first", 409)
            await stop_and_wait(cid)
        out = await asyncio.to_thread(_delete_one, cid, request, s)
        runner.after_delete()
        return out

    def _delete_one(cid: str, request: Request, s):
        out = chatdb.delete_chats(con(), [cid])
        if not out["chats"]:
            bad("no such chat", 404)
        db.add_event(ctx.con(), "chat.delete", f"a chat deleted ({out['messages']} messages)", actor=s.username,
                     source=h.ip_of(request))
        runner.publish("chat.deleted", id=cid)
        return out

    @app.post("/api/chats/{cid}/turns")
    async def turn(cid: str, request: Request, s=Depends(h.session_dep)):
        """Ask: {content, images?, parent_id?} (parent_id: edit an earlier question, as a new version), or
        {regenerate: ANSWER_ID} for another answer.  Then watch GET /api/chats/{id}/stream."""
        body = await _json(request)
        if chatdb.chat(con(), cid) is None:
            bad("no such chat", 404)
        try:
            flags = {k: chatdb.as_bool(body, k) for k in ("web", "thinking") if k in body}
            content, images = _content(body), _images(body)
            for k in ("parent_id", "regenerate"):
                if body.get(k) is not None and not isinstance(body[k], str):
                    raise ValueError(f"{k} is a message id")
        except ValueError as e:
            bad(e)
        try:                                                   # the switches change only if the turn starts
            out = runner.start(cid, content=content, images=images, parent_id=body.get("parent_id"),
                               regenerate=body.get("regenerate") or None, by=s.username, flags=flags)
        except RuntimeError as e:
            bad(e, 409)
        except (ValueError, KeyError) as e:
            bad(e)
        return out | {"chat": with_running(chatdb.chat(con(), cid))}

    @app.post("/api/chats/{cid}/stop")
    async def stop(cid: str, s=Depends(h.session_dep)):              # async: Task.cancel only from the loop
        return {"stopped": runner.stop(cid)}

    @app.get("/api/chats/{cid}/stream")
    async def stream(cid: str, s=Depends(h.session_dep)):
        run, q = runner.subscribe(cid)
        snap = run.snapshot() if run else None              # taken with the subscription: no event is missed or doubled

        async def gen():
            if run is None:
                yield _sse({"type": "idle"})
                return
            try:
                yield _sse(snap)
                while True:
                    try:
                        ev = await asyncio.wait_for(q.get(), 15)
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
                        continue
                    if ev is None:
                        break
                    yield _sse(ev)
            finally:
                run.subs.discard(q)

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    @app.post("/api/chats/{cid}/tools/{call_id:path}")
    async def answer_tool(cid: str, call_id: str, body: dict = Body(...), s=Depends(h.session_dep)):
        """"Ask before opening pages": {allow: true|false} for the page the answer is waiting on.  async: the waiting
        future is resolved on the event loop (a future is not thread-safe)."""
        allow = body.get("allow")
        if not isinstance(allow, bool):
            bad("allow is true or false")
        if not runner.answer(cid, call_id, allow):
            bad("nothing is waiting for that", 404)
        return {"ok": True}

    @app.post("/api/chats/{cid}/head")
    def set_head(cid: str, body: dict = Body(...), s=Depends(h.session_dep)):
        """Show another version: the message given and the newest branch under it."""
        if cid in runner.runs:
            bad("an answer is being written in this chat", 409)
        try:
            chatdb.set_head(con(), cid, str(body.get("message_id") or ""))
        except KeyError:
            bad("no such message in this chat", 404)
        return get_chat(cid, s)

    @app.post("/api/chats/{cid}/title")
    async def suggest_title(cid: str, s=Depends(h.session_dep)):
        """Ask the model for a title again (also for one you wrote, when you ask)."""
        if chatdb.chat(con(), cid) is None:
            bad("no such chat", 404)
        await runner.maybe_title(cid, force=True)
        return with_running(chatdb.chat(con(), cid))

    @app.post("/api/chats/{cid}/summarize")
    async def summarize(cid: str, s=Depends(h.session_dep)):
        try:
            return {"chat": await runner.summarize(cid, s.username)}
        except KeyError:
            bad("no such chat", 404)
        except ChatError as e:
            bad(e, 502 if e.status >= 500 else e.status)

    @app.get("/api/chats/{cid}/export")
    def export_one(cid: str, s=Depends(h.session_dep)):
        try:
            md = chatdb.export_markdown(con(), cid)
        except KeyError:
            bad("no such chat", 404)
        c = chatdb.chat(con(), cid)
        slug = "".join(ch if ch.isalnum() else "-" for ch in (c["title"] or "chat").lower()).strip("-")[:50] or "chat"
        return Response(md, media_type="text/markdown; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{slug}.md"', "Cache-Control": "no-store"})

    return runner


async def _json(request: Request) -> dict:
    """The body, read only up to MAX_TURN_BYTES (a bigger one is refused while it arrives, not after)."""
    try:
        if int(request.headers.get("content-length") or 0) > MAX_TURN_BYTES:
            raise HTTPException(413, TOO_LARGE)
    except ValueError:
        raise HTTPException(400, "a bad Content-Length") from None
    buf = bytearray()
    async for chunk in request.stream():
        buf += chunk
        if len(buf) > MAX_TURN_BYTES:
            raise HTTPException(413, TOO_LARGE)
    raw = bytes(buf)
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        raise HTTPException(400, "send JSON") from None
    if not isinstance(body, dict):
        raise HTTPException(400, "send a JSON object")
    return body


def _content(body: dict) -> str:
    c = body.get("content")
    if c is None:
        return ""
    if not isinstance(c, str):
        raise ValueError("content is text")
    if len(c.encode("utf-8", "replace")) > chatdb.CONTENT_MAX:
        raise ValueError(f"a message is at most {chatdb.CONTENT_MAX // 1000} KB of text")
    return c


def _images(body: dict) -> list[str]:
    """Pictures as data: URLs (PNG, JPEG, GIF, WebP), at most IMAGES_MAX of IMAGE_MAX bytes each; anything else is a 400."""
    imgs = body.get("images")
    if imgs is None:
        return []
    if not isinstance(imgs, list):
        raise ValueError("images is a list of data: URLs")
    if len(imgs) > IMAGES_MAX:
        raise ValueError(f"at most {IMAGES_MAX} pictures in one message")
    for u in imgs:
        m = IMAGE_RE.match(u) if isinstance(u, str) else None
        if not m:
            raise ValueError("a picture must be PNG, JPEG, GIF or WebP, as a data: URL in base64 (convert HEIC, AVIF or "
                             "BMP pictures first)")
        if (len(u) - m.end()) * 3 // 4 > IMAGE_MAX:
            raise ValueError(f"a picture is at most {IMAGE_MAX >> 20} MB")
    return list(imgs)


def _sse(ev: dict) -> str:
    return "data: " + json.dumps(ev) + "\n\n"
