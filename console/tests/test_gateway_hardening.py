"""The gateway's defences found in the review of 2026-11-07: body memory, strata_mcp in any encoding, image sources, slow
clients, limits that cannot be raced, cancellation (Ollama port, MCP, held requests), revocation at the window's close,
persistence of the web tools' limits, origins, dot segments, background loops, the recorder, the parser, retries."""
import asyncio
import json
import socket
import threading
import time
import types

import httpx
import pytest
import uvicorn

from conftest import chat
from outcrop.common import config, db, policy, tokens
from outcrop.gateway import app as gwapp
from outcrop.gateway import bodies, conn, state, streams, webmcp


def auth(t):
    return {"Authorization": f"Bearer {t}"}


def run(stack, coro, timeout=10):
    return asyncio.run_coroutine_threadsafe(coro, stack.loop).result(timeout)


def seen_keys(stack, prefix="/v1/chat/completions"):
    return [x for x in stack.fake.state.seen if x["path"].startswith(prefix)][-1].get("body_keys")


def raw_post(port, path, body: bytes, headers: dict) -> socket.socket:
    s = socket.create_connection(("127.0.0.1", port))
    head = f"POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {len(body)}\r\n"
    head += "".join(f"{k}: {v}\r\n" for k, v in headers.items())
    s.sendall(head.encode() + b"\r\n" + body)
    return s


# ------------------------------------------------------------------------------------------------ #1 body memory

def test_parse_caps_refuse_bodies_that_would_explode():
    with pytest.raises(bodies.Refused) as e:
        bodies.inspect(b"[" + b"{}," * (bodies.MAX_CONTAINERS + 1) + b"{}]", False, False)
    assert e.value.status == 413
    with pytest.raises(bodies.Refused):
        bodies.inspect(b"[" + b"0," * (bodies.MAX_COMMAS + 1) + b"0]", False, False)
    with pytest.raises(bodies.Refused) as e:
        bodies.inspect(b"[" * 100000 + b"]" * 100000, False, False)
    assert e.value.status == 400
    s = bodies.inspect(b"not json", False, False)                   # Strata refuses it the same way
    assert s.body == b"not json" and not s.parsed


def test_body_budget_and_small_limits(stack, monkeypatch):
    t = stack.token()
    adm = stack.token("adm", scopes=["admin", "inference"])
    # a body larger than the routes that take no conversation accept
    monkeypatch.setattr(gwapp, "SMALL_BODY", 2000)
    big = json.dumps(chat(pad="x" * 5000)).encode()
    assert httpx.post(stack.url + "/v1/chat/completions", content=big, headers=auth(t)).status_code == 200
    assert httpx.post(stack.url + "/settings", content=big, headers=auth(adm)).status_code == 413
    r = httpx.post(stack.ollama_url + "/api/show", content=big, headers=auth(t))
    assert r.status_code == 413 and isinstance(r.json()["error"], str)
    # the memory budget: a second large body waits for none, it is refused while the first is held
    stack.gw.net.body_budget_mib = 1
    first = json.dumps(chat(pad="x" * 700_000)).encode()
    s = socket.create_connection(("127.0.0.1", stack.openai_port))
    s.sendall(b"POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + t.encode() +
              b"\r\nContent-Length: " + str(len(first)).encode() + b"\r\n\r\n" + first[:100])
    time.sleep(0.3)
    assert stack.gw.body_inflight == len(first)
    r = httpx.post(stack.url + "/v1/chat/completions", content=json.dumps(chat(pad="y" * 500_000)), headers=auth(t))
    assert r.status_code == 503 and r.headers["retry-after"]
    s.sendall(first[100:])
    s.settimeout(10)
    assert s.recv(100).startswith(b"HTTP/1.1 200")
    s.close()
    time.sleep(0.2)
    assert stack.gw.body_inflight == 0
    assert httpx.post(stack.url + "/v1/chat/completions", content=json.dumps(chat(pad="y" * 500_000)),
                      headers=auth(t)).status_code == 200


def test_large_bodies_are_read_off_the_loop(stack, monkeypatch):
    monkeypatch.setattr(gwapp, "INLINE_PARSE", 10)
    t = stack.token()
    r = httpx.post(stack.url + "/v1/chat/completions", json={**chat(), "strata_mcp": True}, headers=auth(t))
    assert r.status_code == 200 and "strata_mcp" not in seen_keys(stack)


# --------------------------------------------------------------------------------------------- #2 any encoding

def test_strata_mcp_removed_in_any_encoding(stack):
    t = stack.token()
    body = json.dumps({**chat(), "strata_mcp": True})
    for raw in (b"\xef\xbb\xbf" + body.encode(), body.encode("utf-16-be"), body.encode("utf-16-le"),
                body.encode("utf-32"), body.encode()):
        r = httpx.post(stack.url + "/v1/chat/completions", content=raw,
                       headers={**auth(t), "Content-Type": "application/json"})
        assert r.status_code == 200, r.text
        keys = seen_keys(stack)
        assert "strata_mcp" not in keys and "messages" in keys, raw[:4]


# ---------------------------------------------------------------------------------------------- #3 image sources

PNG = "data:image/png;base64,iVBORw0KGgo="


@pytest.mark.parametrize("path,body,ok", [
    ("/v1/chat/completions", {"messages": [{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": PNG}}]}]}, True),
    ("/v1/chat/completions", {"messages": [{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": "/home/dev/Pictures/x.png"}}]}]}, False),
    ("/v1/chat/completions", {"messages": [{"role": "user", "content": [
        {"type": "image_url", "image_url": "http://192.168.1.1/x.png"}]}]}, False),
    ("/v1/chat/completions", {"messages": [{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": "file:///etc/x.png"}}]}]}, False),
    ("/v1/chat/completions", {"messages": [{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": "DATA:/etc/x.png"}}]}]}, False),
    ("/v1/chat/completions", {"messages": [{"role": "tool", "tool_call_id": "a", "content": [
        {"type": "image_url", "image_url": {"url": "https://example.com/x.png"}}]}]}, False),
    ("/v1/messages", {"max_tokens": 5, "messages": [{"role": "user", "content": [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}}]}]}, True),
    ("/v1/messages", {"max_tokens": 5, "messages": [{"role": "user", "content": [
        {"type": "image", "source": {"type": "url", "url": "http://127.0.0.1:8888/"}}]}]}, False),
    ("/v1/messages", {"max_tokens": 5, "messages": [{"role": "user", "content": [
        {"type": "image", "image_url": PNG, "source": {"type": "url", "url": "/etc/x"}}]}]}, False),
    ("/v1/messages", {"max_tokens": 5, "messages": [{"role": "user", "content": [{"type": "tool_result",
        "tool_use_id": "t", "content": [{"type": "image", "source": {"type": "path", "path": "/x.png"}}]}]}]}, False),
    ("/v1/responses", {"input": [{"role": "user", "content": [{"type": "input_image", "image_url": PNG}]}]}, True),
    ("/v1/responses", {"input": [{"role": "user", "content": [
        {"type": "input_image", "image_url": "https://example.com/a.png"}]}]}, False),
    ("/v1/responses", {"input": [{"role": "user", "content": [{"type": "input_image", "file_id": "f1"}]}]}, False),
])
def test_images_must_be_data_urls(stack, path, body, ok):
    t = stack.token()
    r = httpx.post(stack.url + path, json={"model": "m", **body}, headers=auth(t))
    if ok:
        assert r.status_code != 400 or "image" not in r.text, r.text
    else:
        assert r.status_code == 400 and "data: URL" in r.text, r.text


def test_tool_schemas_are_not_mistaken_for_images():
    tools = [{"type": "function", "function": {"name": "f", "parameters": {"type": "object", "properties": {
        "pic": {"type": "image", "image_url": "x"}}}}}]
    bodies.check_images({"messages": [], "tools": tools})


def test_ollama_images_are_base64(stack):
    t = stack.token()
    ok = {"model": "m", "stream": False, "messages": [{"role": "user", "content": "x", "images": ["iVBORw0KGgo="]}]}
    assert httpx.post(stack.ollama_url + "/api/chat", json=ok, headers=auth(t), timeout=20).status_code == 200
    for bad in ({"model": "m", "messages": [{"role": "user", "content": "x", "images": ["/home/dev/x.png"]}]},
                {"model": "m", "prompt": "x", "images": ["http://192.168.1.1/x.png"]},
                {"model": "m", "messages": [{"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": "/x.png"}}]}]}):
        route = "/api/generate" if "prompt" in bad else "/api/chat"
        r = httpx.post(stack.ollama_url + route, json=bad, headers=auth(t))
        assert r.status_code == 400 and isinstance(r.json()["error"], str), r.text


# ----------------------------------------------------------------------------------------------- #4 slow clients

def test_slow_body_gets_408(stack, monkeypatch):
    monkeypatch.setattr(gwapp, "BODY_IDLE_S", 0.5)
    t = stack.token()
    s = socket.create_connection(("127.0.0.1", stack.openai_port))
    s.sendall(b"POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + t.encode() +
              b"\r\nContent-Length: 100\r\n\r\n{")
    s.settimeout(5)
    got = b""
    while True:                                                     # the head and the body may come in separate reads
        chunk = s.recv(4096)
        if not chunk:
            break                                                   # closed by the gateway
        got += chunk
    assert got.startswith(b"HTTP/1.1 408") and b"connection: close" in got.lower()
    s.close()


@pytest.fixture
def plain_server(monkeypatch):
    """A uvicorn server with the gateway's connection protocol and a trivial app."""
    monkeypatch.setattr(conn, "HEADER_TIMEOUT_S", 0.5)
    monkeypatch.setattr(conn, "MAX_PER_IP", 3)

    async def app(scope, receive, send):
        if scope["type"] != "http":
            return
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-length", b"2")]})
        await send({"type": "http.response.body", "body": b"ok"})

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(64)
    port = sock.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(app, http=conn.GatewayProtocol, lifespan="off", log_level="warning",
                                        timeout_keep_alive=30))
    th = threading.Thread(target=lambda: asyncio.run(srv.serve(sockets=[sock])), daemon=True)
    th.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    yield port
    srv.should_exit = True
    th.join(5)


def _closed(s: socket.socket, wait: float) -> bool:
    s.settimeout(wait)
    try:
        return s.recv(10) == b""
    except socket.timeout:
        return False
    except OSError:
        return True


def test_headers_must_arrive_in_time(plain_server):
    s = socket.create_connection(("127.0.0.1", plain_server))
    s.sendall(b"GET / HTTP/1.1\r\nHost: x\r\n")
    assert _closed(s, 3)
    # a complete request is answered, and a kept-alive connection that starts another one slowly is closed too
    s = socket.create_connection(("127.0.0.1", plain_server))
    s.sendall(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
    s.settimeout(3)
    got = b""
    while not got.endswith(b"ok"):
        got += s.recv(100)
    assert got.startswith(b"HTTP/1.1 200")
    s.sendall(b"GET / HT")
    assert _closed(s, 3)
    assert conn.GatewayProtocol.per_ip.get("127.0.0.1", 0) == 0


def test_connections_per_address_are_capped(plain_server):
    socks = [socket.create_connection(("127.0.0.1", plain_server)) for _ in range(3)]
    extra = socket.create_connection(("127.0.0.1", plain_server))
    assert _closed(extra, 0.3)                                       # closed at once, not after the header timeout
    for s in socks:
        s.close()


# --------------------------------------------------------------------------------------------- #5 concurrency race

def test_concurrency_limit_counts_requests_still_sending(stack):
    t = stack.token("c", concurrency=1)
    out = []

    def gen():
        b = json.dumps(chat()).encode()
        yield b[:5]
        time.sleep(1.0)
        yield b[5:]

    def go():
        out.append(httpx.post(stack.url + "/v1/chat/completions", content=gen(), headers=auth(t), timeout=30).status_code)

    ths = [threading.Thread(target=go) for _ in range(4)]
    for th in ths:
        th.start()
    for th in ths:
        th.join()
    assert sorted(out) == [200, 429, 429, 429]
    _no_slots(stack)                                                # every slot given back
    assert httpx.post(stack.url + "/v1/chat/completions", json=chat(), headers=auth(t)).status_code == 200
    _no_slots(stack)


def _no_slots(stack):
    t0 = time.time()
    while stack.gw.limits.active:                   # the answer reaches the client a moment before the request ends
        assert time.time() - t0 < 2, stack.gw.limits.active
        time.sleep(0.02)


# ------------------------------------------------------------------------------------- #6 Ollama port hang-ups

@pytest.mark.parametrize("stream", [True, False])
def test_ollama_hangup_cancels_upstream(stack, stream):
    t = stack.token()
    httpx.post(stack.fake.url + "/_fake/config", json={"first_delay_s": 10})
    before = stack.fake.state.cancels
    body = json.dumps({"model": "m", "stream": stream, "messages": [{"role": "user", "content": "hi"}]}).encode()
    s = raw_post(stack.ollama_port, "/api/chat", body, {"Authorization": f"Bearer {t}"})
    time.sleep(0.6)
    s.close()
    t0 = time.time()
    while stack.fake.state.cancels == before:
        assert time.time() - t0 < 1.5, f"Strata not cancelled within 1.5 s (stream={stream})"
        time.sleep(0.02)
    httpx.post(stack.fake.url + "/_fake/config", json={"first_delay_s": 0})


# ------------------------------------------------------------------------------- #7 revocation at window close

def test_revocation_is_not_swallowed_when_the_window_closes(stack):
    tok = stack.token("rev")
    stack.loop.call_soon_threadsafe(stack.gw.tasks[0].cancel)        # the poll loop: run by hand below
    time.sleep(0.1)
    other = db.connect(stack.db_path)
    db.set_setting(other, "auth.mode", {"mode": "open", "until": time.time() - 1, "at": time.time() - 60})
    run(stack, stack.gw._poll_once())
    tokens.revoke(other, "rev", by="test")                          # between two polls...
    run(stack, stack.gw.store.call(stack.gw._close_window, time.time() - 1))       # ...the window closes
    run(stack, stack.gw._poll_once())
    assert httpx.get(stack.url + "/v1/models", headers=auth(tok)).status_code == 401
    # a reload that fails is tried again at the next poll
    tok2 = stack.token("rev2")
    tokens.revoke(other, "rev2", by="test")
    real = stack.gw.reload

    async def failing():
        return False

    stack.gw.reload = failing
    run(stack, stack.gw._poll_once())
    stack.gw.reload = real
    assert httpx.get(stack.url + "/v1/models", headers=auth(tok2)).status_code == 200
    run(stack, stack.gw._poll_once())
    assert httpx.get(stack.url + "/v1/models", headers=auth(tok2)).status_code == 401
    other.close()


# ------------------------------------------------------------------------------------------ #8 no program per reload

def test_reload_does_not_run_a_program(stack, monkeypatch):
    calls = []
    monkeypatch.setattr(config, "lan_addresses", lambda: calls.append(1) or [])
    for _ in range(3):
        stack.reload()
    assert calls == [] and stack.gw._lan is not None


# --------------------------------------------------------------------------------------- #9 malformed messages

def test_mcp_params_must_be_an_object(stack):
    w = stack.token("w", scopes=["web"])
    for params in ([1], "x", 5):
        r = httpx.post(stack.url + "/tools/mcp", headers=auth(w),
                       json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": params})
        assert r.status_code == 200 and r.json()["error"]["code"] == -32602


def test_control_socket_refuses_bad_bodies(stack):
    tr = httpx.HTTPTransport(uds=str(stack.sock_path))
    with httpx.Client(transport=tr, base_url="http://gateway", timeout=10) as c:
        assert c.post("/hold", json=[1]).status_code == 400
        assert c.post("/hold", json={"max_s": "soon"}).status_code == 400
        assert c.post("/hold", json={"max_s": -5}).status_code == 400
        assert c.post("/cancel", json={"token_id": ["x"]}).status_code == 400
        assert c.post("/release", json={"hold_id": 3}).status_code == 400
        assert c.get("/state").status_code == 200


# ----------------------------------------------------------------------------------------- #10 cancellation

def test_mcp_call_is_cancelled_with_its_token(stack):
    w = stack.token("w", scopes=["web"])
    tid = stack.gw.tokens.lookup(w).token.id
    started = threading.Event()

    async def slow(body, token, f):
        started.set()
        await asyncio.sleep(30)

    stack.gw.webmcp.handle = slow
    out = {}
    th = threading.Thread(target=lambda: out.update(r=httpx.post(
        stack.url + "/tools/mcp", headers=auth(w), json={"jsonrpc": "2.0", "id": 1, "method": "ping"}, timeout=30)))
    th.start()
    assert started.wait(5)
    t0 = time.time()
    assert stack.control("POST", "/cancel", {"token_id": tid, "reason": "revoked"})["cancelled"] == 1
    th.join(5)
    assert out["r"].status_code == 503 and time.time() - t0 < 2
    assert not stack.gw.inflight


def test_held_request_is_cancelled_at_once(stack):
    t = stack.token("h")
    tid = stack.gw.tokens.lookup(t).token.id
    stack.control("POST", "/hold", {"reason": "switch", "max_s": 30})
    out = {}
    th = threading.Thread(target=lambda: out.update(r=httpx.post(stack.url + "/v1/chat/completions", json=chat(),
                                                                 headers=auth(t), timeout=30)))
    th.start()
    time.sleep(0.5)
    t0 = time.time()
    assert stack.control("POST", "/cancel", {"token_id": tid})["cancelled"] == 1
    th.join(5)
    assert out["r"].status_code == 503 and "cancelled" in out["r"].text and time.time() - t0 < 2
    stack.control("POST", "/release", {})


# ------------------------------------------------------------------------------- #11 web limits survive restarts

def test_web_limits_and_links_survive_a_restart(stack):
    class Tools:
        async def run(self, name, args, ctx):
            if name == "web_search":
                ctx.allow(["https://Example.com/a/", "https://example.org/b"])
                return types.SimpleNamespace(ok=True, state=None, text="results", sources=[])
            ok = ctx.may_open(args["url"])
            return types.SimpleNamespace(ok=ok, state=None if ok else "refused", text="page" if ok else "refused",
                                         sources=[])

        def set_allowed(self, on):
            pass

    def fresh():
        wm = webmcp.WebMCP(store=stack.gw.store)
        wm.tools = Tools()
        return wm

    tok = types.SimpleNamespace(id="tokA")

    def call(wm, name, **args):
        f = types.SimpleNamespace(model=None)
        msg = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}
        return run(stack, wm.handle(json.dumps(msg).encode(), tok, f))[1]["result"]

    wm = fresh()
    assert call(wm, "web_search", query="q")["isError"] is False
    wm2 = fresh()                                                   # the gateway restarted
    assert call(wm2, "open_page", url="https://example.com/a")["isError"] is False
    assert call(wm2, "open_page", url="https://evil.example/")["isError"] is True
    assert len(wm2.calls["tokA"]) == 3
    # the day's limit counts the calls from before the restart
    con = db.connect(stack.db_path)
    now = time.time()
    con.executemany("INSERT INTO web_calls(token_id, at) VALUES(?,?)", [("tokB", now - 100 - i) for i in range(600)])
    con.close()
    wm3 = fresh()
    tokb = types.SimpleNamespace(id="tokB")
    f = types.SimpleNamespace(model=None)
    msg = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "web_search", "arguments": {"query": "q"}}}
    res = run(stack, wm3.handle(json.dumps(msg).encode(), tokb, f))[1]["result"]
    assert res["isError"] and "for the day" in res["content"][0]["text"]


# ------------------------------------------------------------------------------------------------- #13 origins

def test_origin_ports_and_loopback():
    names = {"myserver.local", "myserver", "192.168.1.20", "localhost", "127.0.0.1", "::1"}
    ports = frozenset({8080, 11434, 8443, 443})
    ok = policy.origin_allowed
    assert ok("https://myserver.local", "192.168.1.20:8080", names, [], ports)          # the console
    assert ok("http://myserver.local:8080", "192.168.1.20:8080", names, [], ports)
    assert not ok("https://myserver:9999", "myserver.local:8080", names, [], ports)
    assert not ok("http://localhost:3000", "myserver.local:8080", names, [], ports)
    assert not ok("http://localhost:8080", "myserver.local:8080", names, [], ports)
    assert ok("http://localhost:8080", "localhost:8080", names, [], ports)               # an SSH tunnel: same origin
    assert ok("http://localhost:3000", "myserver.local:8080", names, ["http://localhost:3000"], ports)


def test_open_mode_refuses_other_ports_and_localhost_pages(stack):
    stack.set("auth.mode", {"mode": "open", "until": time.time() + 60, "at": time.time()})
    for o in ("http://localhost:3000", "https://myserver:9999"):
        assert httpx.post(stack.url + "/v1/chat/completions", json=chat(), headers={"Origin": o}).status_code == 403
    assert httpx.post(stack.url + "/v1/chat/completions", json=chat(),
                      headers={"Origin": f"http://127.0.0.1:{stack.openai_port}"}).status_code == 200


# ------------------------------------------------------------------------------------- #14 #20 route tables

def test_dot_segments_and_v1_v1_aliases(stack):
    for p in ("/v1/responses/.", "/v1/responses/x/./y", "/web/./app.css", "/v1/images/files/."):
        assert policy.classify("openai", "POST" if "responses" in p else "GET", p) is None, p
    assert policy.classify("openai", "POST", "/v1/v1/messages").kind == "messages"
    assert policy.classify("openai", "POST", "/v1/v1/messages/count_tokens").kind == "count"
    t = stack.token()
    s = raw_post(stack.openai_port, "/v1/responses/.", b'{"model": "m", "input": "hi"}',
                 {"Authorization": f"Bearer {t}"})                  # raw: httpx itself would remove the "."
    s.settimeout(5)
    assert s.recv(100).startswith(b"HTTP/1.1 404")
    s.close()


# --------------------------------------------------------------------------------- #15 #16 recorder and loops

def test_a_failing_loop_is_restarted(stack):
    n = []

    async def flaky():
        n.append(1)
        if len(n) < 2:
            raise RuntimeError("boom")

    run(stack, stack.gw._supervise("test", flaky), timeout=5)
    assert len(n) == 2


def test_requests_are_written_when_matching_fails(stack):
    rec = stack.gw.recorder
    rec.match_s = 0.5

    def broken(records):
        raise TypeError("a new /metrics format")

    rec._match = broken
    t = stack.token()
    r = httpx.post(stack.url + "/v1/chat/completions", json=chat(), headers=auth(t))
    rid = r.headers["x-request-id"]
    t0 = time.time()
    while not stack.con.execute("SELECT 1 FROM requests WHERE rid=?", (rid,)).fetchone():
        assert time.time() - t0 < 6, "the request was never written"
        time.sleep(0.2)


def test_recorder_keeps_rows_when_the_database_fails():
    class Store:
        fail = True

        async def call(self, fn, *args):
            if self.fail:
                raise RuntimeError("database is locked")
            self.wrote = args

    st = Store()
    rec = state.Recorder(st, None, state.Hub())
    rec.add({"rid": "r1", "started_at": 1.0, "ended_at": 2.0, "token_id": "t1", "auth": "token"}, want_match=False)
    with pytest.raises(RuntimeError):
        asyncio.run(rec.flush())
    assert [r["rid"] for r in rec.ready] == ["r1"] and "t1" in rec.last_used
    st.fail = False
    asyncio.run(rec.flush())
    assert [r["rid"] for r in st.wrote[0]] == ["r1"] and not rec.ready


# ---------------------------------------------------------------------------------------------- #17 parser

def test_the_parser_never_raises():
    p = streams.Parser("openai", "chat", "text/event-stream")
    p.feed(b'data: {"choices": ["x"]}\n\n')
    p.feed(b'data: {"choices": [{"delta": {"content": "hi"}}]}\n\n')    # parsing stopped; nothing raised
    p.close()
    q = streams.Parser("ollama", "ollama-chat", "application/x-ndjson")
    q.feed(b'{"done": true, "prompt_eval_count": "many", "prompt_eval_duration": "x"}\n')
    q.close()


# ---------------------------------------------------------------------------------- #18 #19 probes and retries

def test_a_refused_connection_waits_in_the_hold_and_is_retried(stack):
    t = stack.token()
    client = stack.gw.client
    real = client.send
    n = []

    async def once(req, **kw):
        if not n and req.url.path == "/v1/chat/completions":
            n.append(1)
            raise httpx.ConnectError("refused")
        return await real(req, **kw)

    client.send = once
    try:
        r = httpx.post(stack.url + "/v1/chat/completions", json=chat(), headers=auth(t), timeout=30)
    finally:
        client.send = real
    assert r.status_code == 200 and n == [1]


def test_one_failed_probe_does_not_close_the_gate(stack):
    gw = stack.gw
    stack.loop.call_soon_threadsafe(gw.tasks[1].cancel)              # the probe loop: run by hand below
    time.sleep(0.1)
    real = gw.client.get

    async def fail(*a, **kw):
        raise httpx.ReadTimeout("slow")

    gw.client.get = fail
    try:
        run(stack, gw._probe())
        assert gw.hold.strata_up and gw.hold.ready.is_set()
        run(stack, gw._probe())
        assert not gw.hold.strata_up and not gw.hold.ready.is_set()
    finally:
        gw.client.get = real
    run(stack, gw._probe())
    assert gw.hold.strata_up and gw.hold.ready.is_set()


# ------------------------------------------------------------------------------------ #21 #22 use and limits

def test_refused_attempts_are_not_a_use(stack):
    far = stack.token("far", cidrs=["10.0.0.0/8"])
    assert httpx.get(stack.url + "/v1/models", headers=auth(far)).status_code == 403
    stack.flush()
    row = stack.con.execute("SELECT last_used_at FROM tokens WHERE name='far'").fetchone()
    assert row["last_used_at"] is None


def test_held_requests_are_capped(stack):
    t = stack.token()
    stack.gw.net.max_held = 0
    stack.control("POST", "/hold", {"reason": "switch", "max_s": 30})
    t0 = time.time()
    r = httpx.post(stack.url + "/v1/chat/completions", json=chat(), headers=auth(t), timeout=30)
    assert r.status_code == 503 and time.time() - t0 < 1.5
    stack.control("POST", "/release", {})


def test_requests_without_a_token_are_rate_limited(stack):
    stack.gw.net.open_rpm = 2
    stack.set("auth.mode", {"mode": "open", "until": time.time() + 60, "at": time.time()})
    got = [httpx.get(stack.url + "/v1/models").status_code for _ in range(3)]
    assert got == [200, 200, 429]
    t = stack.token()
    assert httpx.get(stack.url + "/v1/models", headers=auth(t)).status_code == 200      # tokens are not counted


# =============================================================================== the second review (2026-11-07)

# ------------------------------------------------------------------------------------- R2 #1 IPv6 and floods

def test_addresses_are_limited_one_by_one_and_per_ipv6_64():
    """Per address (the devices of one home LAN share a /64 and must not share a limit), and per /64 at four times the
    limit (one device rotating through its /64's addresses is still stopped)."""
    assert policy.addr_keys("192.168.1.30") == [("192.168.1.30", 1)]
    assert policy.addr_keys("::ffff:192.168.1.30") == [("192.168.1.30", 1)]
    assert policy.addr_keys("2001:db8:1:2:aaaa::1") == [("2001:db8:1:2:aaaa::1", 1), ("net 2001:db8:1:2::/64", 4)]
    lim = state.Limits()
    now = time.time()
    assert lim.check_anon("2001:db8:1:2::1", now, 2) is None
    assert lim.check_anon("2001:db8:1:2::1", now, 2) is None
    assert lim.check_anon("2001:db8:1:2::1", now, 2) is not None        # this address: its own limit
    assert lim.check_anon("2001:db8:1:2::2", now, 2) is None             # another device on the LAN: not affected
    for i in range(3, 20):                                                # rotating through the /64
        lim.check_anon(f"2001:db8:1:2::{i}", now, 2)
    assert lim.check_anon("2001:db8:1:2::99", now, 2) is not None        # the /64 at 4x the limit
    assert lim.check_anon("2001:db8:1:9::1", now, 2) is None             # another /64
    d = state.DenyLog(per_min=2, global_per_min=1000)
    assert [d.allow("2001:db8:1:2::1", now) for _ in range(3)] == [True, True, False]
    assert d.allow("2001:db8:1:2::2", now) is True
    assert sum(d.allow(f"2001:db8:1:2::{i}", now) for i in range(10, 30)) < 10    # capped per /64 too
    assert conn.addr_keys is policy.addr_keys                        # the connection cap uses the same keys


def test_refused_requests_are_logged_within_a_global_cap():
    d = state.DenyLog(per_min=1000, global_per_min=5)
    now = time.time()
    got = [d.allow(f"192.168.1.{i}", now) for i in range(12)]
    assert got == [True] * 5 + [False] * 7
    row = d.summary(now + 1)
    assert row["auth"] == "denied" and "7 more refused requests from 7 addresses" in row["auth_reason"]
    assert d.summary(now + 2) is None                                # nothing new
    d.allow("192.168.1.99", now + 3)
    assert d.summary(now + 4) is None                                # at most one row a minute
    assert d.summary(now + 62)["auth_reason"].startswith("1 more")


def test_a_flood_of_refusals_writes_one_summary_row(stack):
    d = stack.gw.denylog = state.DenyLog(per_min=1000, global_per_min=5)
    d.last_summary = time.time()                    # no summary while the flood is sent: one row for all of it
    for _ in range(12):
        assert httpx.get(stack.url + "/v1/models").status_code == 401
    d.last_summary = 0
    t0 = time.time()
    while True:
        stack.flush()
        rows = stack.con.execute("SELECT rid, auth_reason FROM requests WHERE auth='denied'").fetchall()
        if any(r["rid"].startswith("deny_") for r in rows):
            break
        assert time.time() - t0 < 5, rows
        time.sleep(0.3)
    assert len([r for r in rows if not r["rid"].startswith("deny_")]) == 5
    summary = [r["auth_reason"] for r in rows if r["rid"].startswith("deny_")]
    assert len(summary) == 1 and summary[0].startswith("7 more") and "over 5 a minute" in summary[0]


# ------------------------------------------------------------------------------------- R2 #2 Strata's page

def test_strata_page_moves_to_the_console(stack):
    r = httpx.get(stack.url + "/")
    assert r.status_code == 302 and r.headers["location"] == "https://127.0.0.1/strata"
    me = f"{socket.gethostname().lower()}.local"                       # this machine's own name
    r = httpx.get(stack.url + "/", headers={"Host": f"{me}:8080"})
    assert r.headers["location"] == f"https://{me}/strata"
    r = httpx.get(stack.url + "/", headers={"Host": "evil.example"})      # never a redirect to someone else's name
    assert r.headers["location"] == f"https://{me}/strata"
    stack.gw.net.console_port = 8444
    assert httpx.get(stack.url + "/").headers["location"] == "https://127.0.0.1:8444/strata"
    assert not [x for x in stack.fake.state.seen if x["path"] in ("", "/")]           # Strata never asked
    assert httpx.get(stack.url + "/web/app.css").status_code == 200
    assert httpx.get(stack.url + "/api-monitor").status_code == 404                   # Strata's monitor page
    r = httpx.get(stack.ollama_url + "/")                                             # Ollama's probe: unchanged
    assert r.status_code == 200 and r.text == "Ollama is running"


# ------------------------------------------------------------------------------------------ R2 #3 capture

def test_capture_leaves_out_the_consoles_own_requests(stack):
    t = stack.token("app")
    _, ct = tokens.create(stack.con, stack.pepper, "console-playground", kind="console")
    cid = tokens.find(stack.con, "console-playground")["id"]
    stack.set("capture", {"enabled": True, "started_at": time.time() - 1})

    def captured(tok):
        rid = httpx.post(stack.url + "/v1/chat/completions", json=chat(), headers=auth(tok)).headers["x-request-id"]
        stack.recorded(rid)
        return bool(stack.con.execute("SELECT 1 FROM request_bodies WHERE request_rid=?", (rid,)).fetchone())

    assert captured(t)
    assert not captured(ct)
    stack.set("capture", {"enabled": True, "started_at": time.time() - 1, "token_id": cid})
    assert captured(ct)                                              # named explicitly
    assert not captured(t)


# ----------------------------------------------------------------------------------------- R2 #4 the budget

def test_the_body_budget_is_given_back_once_the_body_is_sent(stack):
    t = stack.token()
    httpx.post(stack.fake.url + "/_fake/config", json={"first_delay_s": 3})
    body = json.dumps(chat(pad="x" * 300_000)).encode()
    out = {}
    th = threading.Thread(target=lambda: out.update(r=httpx.post(stack.url + "/v1/chat/completions", content=body,
                                                                 headers=auth(t), timeout=30)))
    th.start()
    t0 = time.time()
    while not stack.gw.inflight:
        assert time.time() - t0 < 3
        time.sleep(0.02)
    time.sleep(0.8)                                                  # Strata is "reading the prompt"
    assert stack.gw.inflight and stack.gw.body_inflight == 0
    assert all(f.body is None for f in stack.gw.inflight.values())
    th.join(30)
    httpx.post(stack.fake.url + "/_fake/config", json={"first_delay_s": 0})
    assert out["r"].status_code == 200
    seen = [x for x in stack.fake.state.seen if x["path"] == "/v1/chat/completions"][-1]["headers"]
    low = {k.lower(): v for k, v in seen.items()}
    assert low["content-length"] == str(len(body)) and "transfer-encoding" not in low


def test_a_held_request_keeps_its_budget_until_sent(stack):
    t = stack.token()
    stack.control("POST", "/hold", {"reason": "switch", "max_s": 30})
    body = json.dumps(chat(pad="x" * 100_000)).encode()
    out = {}
    th = threading.Thread(target=lambda: out.update(r=httpx.post(stack.url + "/v1/chat/completions", content=body,
                                                                 headers=auth(t), timeout=30)))
    th.start()
    time.sleep(0.5)
    assert stack.gw.body_inflight == len(body)
    stack.control("POST", "/release", {})
    th.join(10)
    assert out["r"].status_code == 200
    time.sleep(0.2)
    assert stack.gw.body_inflight == 0
