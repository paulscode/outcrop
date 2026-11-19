"""The gateway end to end: fake Strata + the real Ollama bridge + the gateway, over real sockets."""
import json
import socket
import threading
import time

import httpx
import pytest

from conftest import UPSTREAM_KEY, chat
from outcrop.common import db, tokens


def auth(t):
    return {"Authorization": f"Bearer {t}"}


# --------------------------------------------------------------------------------------------------------- basics

def test_no_token_401_in_each_format(stack):
    r = httpx.post(stack.url + "/v1/chat/completions", json=chat())
    assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_api_key"
    assert r.headers["www-authenticate"].startswith("Bearer")
    assert r.headers["x-request-id"].startswith("req_")
    r = httpx.post(stack.url + "/v1/messages", json={"model": "m", "max_tokens": 5, "messages": []})
    assert r.status_code == 401 and r.json()["type"] == "error" and r.json()["error"]["type"] == "authentication_error"
    r = httpx.post(stack.ollama_url + "/api/chat", json={"model": "m", "messages": []})
    assert r.status_code == 401 and isinstance(r.json()["error"], str)
    assert not [s for s in stack.fake.state.seen if s["path"].startswith("/v1/chat")]     # nothing reached Strata


def test_token_passes_and_headers_are_rewritten(stack):
    t = stack.token("laptop")
    r = httpx.post(stack.url + "/v1/chat/completions", json=chat(), headers={**auth(t), "Cookie": "a=b",
                                                                            "X-Forwarded-For": "6.6.6.6"})
    assert r.status_code == 200, r.text
    assert r.json()["choices"][0]["message"]["content"]
    seen = [s for s in stack.fake.state.seen if s["path"] == "/v1/chat/completions"][-1]["headers"]
    low = {k.lower(): v for k, v in seen.items()}
    assert low["authorization"] == f"Bearer {UPSTREAM_KEY}"
    assert "cookie" not in low and low["x-forwarded-for"] == "127.0.0.1"
    assert low["host"] == f"127.0.0.1:{stack.fake.port}"
    assert low["x-request-id"] == r.headers["x-request-id"]


def test_streams_pass_through_unchanged(stack):
    t = stack.token()
    with httpx.stream("POST", stack.url + "/v1/chat/completions", json=chat(stream=True), headers=auth(t)) as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
        body = b"".join(r.iter_raw())
    assert body.count(b"data: ") >= 13 and body.rstrip().endswith(b"data: [DONE]")
    with httpx.stream("POST", stack.url + "/v1/messages", headers=auth(t),
                      json={"model": "m", "max_tokens": 5, "stream": True,
                            "messages": [{"role": "user", "content": "hi"}]}) as r:
        body = b"".join(r.iter_raw())
    assert b"message_stop" in body


def test_x_api_key_and_keepalive_connection(stack):
    t = stack.token()
    with httpx.Client(base_url=stack.url, headers={"x-api-key": t}) as c:
        for _ in range(3):
            assert c.get("/v1/models").status_code == 200


def test_public_routes(stack):
    r = httpx.get(stack.url + "/")                         # Strata's page: in the console (tests: review 2, #2)
    assert r.status_code == 302 and r.headers["location"] == "https://127.0.0.1/strata"
    assert httpx.get(stack.url + "/web/app.css").status_code == 200
    h = httpx.get(stack.url + "/health").json()
    assert h["loaded"] is True and h["auth"] == "enforced" and h["api_key"] is True and h["model"]
    assert httpx.get(stack.ollama_url + "/").status_code == 200


def test_unknown_routes_and_methods(stack):
    t = stack.token()
    assert httpx.get(stack.url + "/nope", headers=auth(t)).status_code == 404
    assert httpx.get(stack.url + "/v1/chat/completions", headers=auth(t)).status_code == 405
    assert httpx.post(stack.url + "/v1/completions", headers=auth(t), json={}).status_code == 404
    assert httpx.get(stack.url + "/v1/telemetry?api_key=" + t).status_code == 401      # never from the query string
    for raw in (b"/web/../status", b"/web/%2e%2e/status", b"//status", b"/v1/chat%2Fcompletions"):
        s = socket.create_connection(("127.0.0.1", stack.openai_port))
        s.sendall(b"GET " + raw + b" HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer " + t.encode() + b"\r\n\r\n")
        head = s.recv(4096)
        s.close()
        assert head.startswith(b"HTTP/1.1 404"), (raw, head[:40])


# ------------------------------------------------------------------------------------------------------ token rules

def test_scopes(stack):
    inf = stack.token("inf")
    tel = stack.token("tel", scopes=["telemetry"])
    adm = stack.token("adm", scopes=["admin"])
    assert httpx.get(stack.url + "/metrics", headers=auth(inf)).status_code == 403
    assert httpx.get(stack.url + "/v1/telemetry", headers=auth(tel)).status_code == 200
    assert httpx.post(stack.url + "/v1/chat/completions", json=chat(), headers=auth(tel)).status_code == 403
    assert httpx.get(stack.url + "/status", headers=auth(inf)).status_code == 403
    assert httpx.get(stack.url + "/status", headers=auth(tel)).status_code == 403
    assert httpx.get(stack.url + "/status", headers=auth(adm)).status_code == 200
    assert httpx.post(stack.url + "/unload", headers=auth(adm), json={}).status_code == 200


def test_listener_and_network_limits(stack):
    only_ollama = stack.token("ol", listeners=["ollama"])
    r = httpx.post(stack.url + "/v1/chat/completions", json=chat(), headers=auth(only_ollama))
    assert r.status_code == 403 and "port" in r.json()["error"]["message"]
    assert httpx.get(stack.ollama_url + "/api/tags", headers=auth(only_ollama)).status_code == 200
    far = stack.token("far", cidrs=["10.0.0.0/8"])
    r = httpx.post(stack.url + "/v1/chat/completions", json=chat(), headers=auth(far))
    assert r.status_code == 403 and "127.0.0.1" in r.json()["error"]["message"]


def test_bad_credentials(stack):
    t = stack.token()
    r = httpx.get(stack.url + "/v1/models", headers=[("Authorization", f"Bearer {t}"), ("Authorization", "Bearer x")])
    assert r.status_code == 401
    # both headers (Claude Code with ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN): either one may be the token
    assert httpx.get(stack.url + "/v1/models", headers={"Authorization": f"Bearer {t}", "x-api-key": "other"}).status_code == 200
    assert httpx.get(stack.url + "/v1/models", headers={"Authorization": "Bearer junk", "x-api-key": t}).status_code == 200
    assert httpx.get(stack.url + "/v1/models", headers={"Authorization": "Bearer a", "x-api-key": "b"}).status_code == 401
    assert httpx.get(stack.url + "/v1/models", headers={"Authorization": f"Basic {t}"}).status_code == 401
    assert httpx.get(stack.url + "/v1/models", headers={"Authorization": f"Bearer {t}x"}).status_code == 401
    assert httpx.get(stack.url + "/v1/models", headers={"Authorization": f"bearer {t}"}).status_code == 200


def test_revocation_within_a_second(stack):
    t = stack.token("rev")
    assert httpx.get(stack.url + "/v1/models", headers=auth(t)).status_code == 200
    other = db.connect(stack.db_path)              # as the console or outcrop would
    tokens.revoke(other, "rev", by="test")
    other.close()
    t0 = time.time()
    while httpx.get(stack.url + "/v1/models", headers=auth(t)).status_code == 200:
        assert time.time() - t0 < 1.5, "still accepted after 1.5 s"
        time.sleep(0.05)
    r = httpx.get(stack.url + "/v1/models", headers=auth(t))
    assert r.status_code == 401 and "revoked" in r.json()["error"]["message"]


def test_rotation_grace(stack):
    t = stack.token("rot")
    _, new = tokens.rotate(stack.con, stack.pepper, "rot", grace_s=1.5)
    stack.reload()
    assert httpx.get(stack.url + "/v1/models", headers=auth(t)).status_code == 200
    assert httpx.get(stack.url + "/v1/models", headers=auth(new)).status_code == 200
    time.sleep(1.7)
    r = httpx.get(stack.url + "/v1/models", headers=auth(t))
    assert r.status_code == 401 and "rotated" in r.json()["error"]["message"]
    assert httpx.get(stack.url + "/v1/models", headers=auth(new)).status_code == 200


def test_expiry(stack):
    t = stack.token("exp", expires_at=time.time() + 1.0)
    assert httpx.get(stack.url + "/v1/models", headers=auth(t)).status_code == 200
    time.sleep(1.2)
    r = httpx.get(stack.url + "/v1/models", headers=auth(t))
    assert r.status_code == 401 and "expired" in r.json()["error"]["message"]


def test_rate_limit(stack):
    t = stack.token("rl", rpm=2)
    codes = [httpx.get(stack.url + "/v1/models", headers=auth(t)).status_code for _ in range(3)]
    assert codes == [200, 200, 429]


def test_body_limit(stack):
    t = stack.token()
    big = {"model": "m", "messages": [{"role": "user", "content": "x" * (2 << 20)}]}
    r = httpx.post(stack.url + "/v1/chat/completions", json=big, headers=auth(t))
    assert r.status_code == 413


def test_engine_side_tools_cannot_be_switched_on(stack):
    """Strata runs MCP tools inside the engine for "strata_mcp": true; the gateway removes it from every request."""
    t = stack.token()
    r = httpx.post(stack.url + "/v1/chat/completions", json={**chat(), "strata_mcp": True}, headers=auth(t))
    assert r.status_code == 200
    seen = httpx.get(stack.fake.url + "/_fake/seen").json()
    last = [x for x in seen if x["path"].startswith("/v1/chat/completions")][-1]
    assert "strata_mcp" not in last["body_keys"] and "messages" in last["body_keys"]


# --------------------------------------------------------------------------------------------------------- open mode

def test_open_mode_and_its_limits(stack):
    stack.set("auth.mode", {"mode": "open", "until": time.time() + 60, "at": time.time()})
    r = httpx.post(stack.url + "/v1/chat/completions", json=chat())
    assert r.status_code == 200
    assert httpx.post(stack.url + "/v1/chat/completions", json=chat(),
                      headers={"Authorization": "Bearer sk-anything-at-all"}).status_code == 200
    assert httpx.get(stack.url + "/health").json()["auth"] == "open"
    assert httpx.get(stack.url + "/status").status_code == 401                         # admin never opens
    r = httpx.post(stack.url + "/v1/chat/completions", json=chat(), headers={"Host": "evil.example"})
    assert r.status_code == 403 and "host" in r.json()["error"]["message"]
    r = httpx.post(stack.url + "/v1/chat/completions", json=chat(), headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    r = httpx.post(stack.url + "/v1/chat/completions", json=chat(),
                   headers={"Origin": f"http://127.0.0.1:{stack.openai_port}"})
    assert r.status_code == 200                                                        # Strata's own page
    stack.flush()
    time.sleep(0.2)
    stack.flush()
    rows = stack.con.execute("SELECT auth, auth_reason FROM requests WHERE path='/v1/chat/completions'").fetchall()
    assert any(r["auth"] == "open" and "unknown key sk-a" in r["auth_reason"] for r in rows)


def test_open_mode_closes_on_time(stack):
    stack.set("auth.mode", {"mode": "open", "until": time.time() + 1.0, "at": time.time()})
    assert httpx.get(stack.url + "/v1/models").status_code == 200
    time.sleep(1.1)
    assert httpx.get(stack.url + "/v1/models").status_code == 401
    time.sleep(1.5)
    assert db.get_setting(stack.con, "auth.mode")["mode"] == "enforced"
    assert db.events(stack.con, 5, kinds=["auth.close"])


def test_open_mode_scope(stack):
    stack.set("auth.mode", {"mode": "open", "until": time.time() + 60, "listeners": ["ollama"]})
    assert httpx.get(stack.url + "/v1/models").status_code == 401
    assert httpx.get(stack.ollama_url + "/api/tags").status_code == 200
    stack.set("auth.mode", {"mode": "open", "until": time.time() + 60, "addresses": ["192.168.1.50"]})
    assert httpx.get(stack.url + "/v1/models").status_code == 401


def test_tokenless_ollama_option(stack):
    assert httpx.post(stack.ollama_url + "/api/chat", json={"model": "m", "stream": False,
                                                             "messages": [{"role": "user", "content": "hi"}]}).status_code == 401
    stack.set("ollama.tokenless", {"enabled": True, "addresses": ["127.0.0.1"]})
    r = httpx.post(stack.ollama_url + "/api/chat", json={"model": "m", "stream": False,
                                                          "messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 200 and r.json()["done"] is True
    assert httpx.post(stack.url + "/v1/chat/completions", json=chat()).status_code == 401    # 8080 unaffected
    stack.set("ollama.tokenless", {"enabled": True, "addresses": ["192.168.1.30"]})
    assert httpx.get(stack.ollama_url + "/api/tags").status_code == 401
    stack.set("ollama.tokenless", {"enabled": False, "addresses": ["127.0.0.1"]})
    assert httpx.get(stack.ollama_url + "/api/tags").status_code == 401


# ------------------------------------------------------------------------------------------------------ Ollama bridge

def test_ollama_through_bridge(stack):
    t = stack.token()
    tags = httpx.get(stack.ollama_url + "/api/tags", headers=auth(t)).json()
    assert any("qwen3.8-flash-next" in m["name"] for m in tags["models"])
    lines = []
    with httpx.stream("POST", stack.ollama_url + "/api/chat", headers=auth(t),
                      json={"model": "qwen3.8-flash-next", "messages": [{"role": "user", "content": "hi"}]}) as r:
        assert r.status_code == 200
        for ln in r.iter_lines():
            if ln:
                lines.append(json.loads(ln))
    assert lines[-1]["done"] is True and len(lines) > 3
    r = httpx.post(stack.ollama_url + "/v1/chat/completions", json=chat(), headers=auth(t))
    assert r.status_code == 200


# ---------------------------------------------------------------------------------------------- disconnects, holds

def _cancels(stack):
    return stack.fake.state.cancels


def test_disconnect_mid_prompt_cancels_upstream(stack):
    t = stack.token()
    httpx.post(stack.fake.url + "/_fake/config", json={"first_delay_s": 10})
    for stream in (True, False):
        before = _cancels(stack)
        s = socket.create_connection(("127.0.0.1", stack.openai_port))
        body = json.dumps(chat(stream=stream)).encode()
        s.sendall(b"POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer " + t.encode() +
                  b"\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
        time.sleep(0.6)
        s.close()
        t0 = time.time()
        while _cancels(stack) == before:
            assert time.time() - t0 < 1.0, f"Strata not cancelled within 1 s (stream={stream})"
            time.sleep(0.02)
    httpx.post(stack.fake.url + "/_fake/config", json={"first_delay_s": 0})


def test_hold_while_not_loaded(stack):
    t = stack.token()
    httpx.post(stack.fake.url + "/_fake/config", json={"loaded": False})
    time.sleep(1.3)
    out = {}

    def call():
        out["r"] = httpx.post(stack.url + "/v1/chat/completions", json=chat(), headers=auth(t), timeout=30)

    th = threading.Thread(target=call)
    th.start()
    time.sleep(1.0)
    assert th.is_alive(), "the request should wait while the model is not loaded"
    httpx.post(stack.fake.url + "/_fake/config", json={"loaded": True})
    th.join(10)
    assert out["r"].status_code == 200


def test_explicit_hold_and_timeout(stack):
    t = stack.token()
    h = stack.control("POST", "/hold", {"reason": "switch to speed", "max_s": 30})
    assert h["hold_id"].startswith("hold_")
    st = stack.control("GET", "/state")
    assert st["hold"]["ready"] is False and st["hold"]["reason"] == "switch to speed"
    t0 = time.time()
    r = httpx.post(stack.url + "/v1/chat/completions", json=chat(), headers=auth(t), timeout=30)
    assert r.status_code == 503 and r.headers["retry-after"] == "10"
    assert 2.5 < time.time() - t0 < 6                                      # hold_max_s is 3 in the tests
    out = {}
    th = threading.Thread(target=lambda: out.setdefault(
        "r", httpx.post(stack.url + "/v1/chat/completions", json=chat(), headers=auth(t), timeout=30)))
    th.start()
    time.sleep(0.5)
    assert stack.control("POST", "/release", {"hold_id": h["hold_id"]})["released"] == 1
    th.join(10)
    assert out["r"].status_code == 200


def test_cancel_through_control(stack):
    t = stack.token("victim")
    httpx.post(stack.fake.url + "/_fake/config", json={"first_delay_s": 10})
    got = {}

    def call():
        with httpx.stream("POST", stack.url + "/v1/chat/completions", json=chat(stream=True), headers=auth(t),
                          timeout=30) as r:
            got["body"] = b"".join(r.iter_raw())

    th = threading.Thread(target=call)
    th.start()
    for _ in range(50):
        st = stack.control("GET", "/state")
        if st["inflight"]:
            break
        time.sleep(0.05)
    assert st["inflight"][0]["token"] == "victim"
    tok_id = st["inflight"][0]["token_id"]
    assert stack.control("POST", "/cancel", {"token_id": tok_id})["cancelled"] == 1
    th.join(5)
    assert b"cancelled by the server" in got["body"]
    httpx.post(stack.fake.url + "/_fake/config", json={"first_delay_s": 0})


# ------------------------------------------------------------------------------------------------------- recording

def test_requests_are_recorded_with_engine_stats(stack):
    t = stack.token("rec")
    httpx.post(stack.url + "/v1/chat/completions", json=chat(stream=True), headers={**auth(t), "User-Agent": "OpenAI/Python 1.2"})
    httpx.post(stack.url + "/v1/chat/completions", json=chat())                                     # denied
    for _ in range(30):
        stack.flush()
        rows = stack.con.execute("SELECT * FROM requests ORDER BY id").fetchall()
        ok = [r for r in rows if r["auth"] == "token"]
        if ok and ok[0]["hit_rate"] is not None:
            break
        time.sleep(0.2)
    r = ok[0]
    assert r["app"] == "openai-python" and r["prompt_tokens"] and r["output_tokens"] == 12 and r["status"] == 200
    assert r["hit_rate"] == 0.91 and r["strata_id"] and r["ttft_ms"] is not None and r["outcome"] == "ok"
    assert any(x["auth"] == "denied" and x["status"] == 401 for x in rows)
    u = stack.con.execute("SELECT * FROM usage_daily WHERE token_id=?", (r["token_id"],)).fetchone()
    assert u["requests"] == 1 and u["output_tokens"] == 12
    tok = tokens.find(stack.con, "rec")
    assert tok["last_used_at"] and tok["last_app"] == "openai-python"


def test_upstream_down_is_a_clean_503(stack):
    t = stack.token()
    stack.fake.stop()
    time.sleep(1.3)
    r = httpx.post(stack.url + "/v1/chat/completions", json=chat(), headers=auth(t), timeout=30)
    assert r.status_code == 503 and r.headers.get("retry-after")
    assert httpx.get(stack.url + "/health").json()["status"] == "unavailable"
    stack.fake.httpd = None
    stack.fake.stop = lambda: None


@pytest.mark.parametrize("path", ["/v1/chat/completions", "/v1/responses", "/v1/messages"])
def test_dialects_non_stream(stack, path):
    t = stack.token()
    body = {"model": "m", "max_tokens": 5, "messages": [{"role": "user", "content": "hi"}]}
    if path == "/v1/responses":
        body = {"model": "m", "input": "hi"}
    r = httpx.post(stack.url + path, json=body, headers=auth(t))
    assert r.status_code == 200, r.text


# ------------------------------------------------------------------------------------------------ header tricks

def _raw(stack, headers: bytes) -> bytes:
    s = socket.create_connection(("127.0.0.1", stack.openai_port))
    s.sendall(b"GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\n" + headers + b"\r\n")
    s.settimeout(5)
    head = s.recv(4096)
    s.close()
    return head


def test_header_tricks(stack):
    t = stack.token().encode()
    assert _raw(stack, b"authorization: BEARER " + t + b"\r\n").startswith(b"HTTP/1.1 200")
    assert _raw(stack, b"Authorization: Bearer   " + t + b"   \r\n").startswith(b"HTTP/1.1 200")
    assert _raw(stack, b"AUTHORIZATION: Bearer " + t + b"\r\n").startswith(b"HTTP/1.1 200")
    assert _raw(stack, b"Authorization: Bearer" + t + b"\r\n").startswith(b"HTTP/1.1 401")          # no space: not bearer
    assert _raw(stack, b"Authorization: Bearer " + t[:-1] + b"\r\n").startswith(b"HTTP/1.1 401")
    assert _raw(stack, b"X-Api-Key: " + t + b"\r\nAuthorization: Bearer " + t + b"\r\n").startswith(b"HTTP/1.1 200")
    dup = b"Authorization: Bearer " + t + b"\r\nAuthorization: Bearer " + t + b"\r\n"
    assert _raw(stack, dup).startswith(b"HTTP/1.1 401")                                                # twice: refused
    # 70 KB of headers: refused before any auth or upstream work
    pad = b"".join(b"x-pad-%d: %s\r\n" % (i, b"y" * 1000) for i in range(70))
    assert _raw(stack, pad + b"Authorization: Bearer " + t + b"\r\n")[:12] in (b"HTTP/1.1 431", b"HTTP/1.1 400")


def test_forwarded_headers_from_clients_are_not_trusted(stack):
    t = stack.token("netlimited", cidrs=["10.9.9.9/32"])
    r = httpx.get(stack.url + "/v1/models", headers={"Authorization": f"Bearer {t}", "X-Forwarded-For": "10.9.9.9",
                                                     "X-Real-IP": "10.9.9.9", "Forwarded": "for=10.9.9.9"})
    assert r.status_code == 403                                   # the real address is 127.0.0.1


def test_open_mode_accepts_the_address_the_request_came_in_on(stack):
    stack.gw.names = {"localhost"}                      # as if `hostname -I` had found nothing
    stack.set("auth.mode", {"mode": "open", "until": time.time() + 60})
    stack.gw.names = {"localhost"}
    r = httpx.get(stack.url + "/v1/models", headers={"Host": f"127.0.0.1:{stack.openai_port}"})
    assert r.status_code == 200
    assert httpx.get(stack.url + "/v1/models", headers={"Host": "evil.example"}).status_code == 403
