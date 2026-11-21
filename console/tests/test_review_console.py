"""Fixes from the review: the password again for wide tokens, a body limit before anything parses, one password check
at a time per address, the Strata page's CSP, presets editor allowlists."""
import threading
import time


from outcrop.console import auth
from outcrop.console.extras import validate_presets
from test_console_extras import H, PW, c  # noqa: F401,F811 - the fixture


def stale(cl):
    """As if the password was entered more than 10 minutes ago."""
    cl.con.execute("UPDATE sessions SET reauth_at=?", (time.time() - 3600,))


def test_wide_tokens_need_the_password_again(c):  # noqa: F811
    adm = c.post("/api/tokens", json={"name": "auto", "scopes": ["admin"]}, headers=H).json()
    plain = c.post("/api/tokens", json={"name": "plain"}, headers=H).json()
    stale(c)
    tid = adm["token"]["id"]
    # rotating an admin token hands out a new secret; widening its networks widens what it can do
    assert c.post(f"/api/tokens/{tid}/rotate", json={}, headers=H).status_code == 403
    assert c.patch(f"/api/tokens/{tid}", json={"cidrs": []}, headers=H).status_code == 403
    # giving the web scope (the internet) too
    pid = plain["token"]["id"]
    assert c.patch(f"/api/tokens/{pid}", json={"scopes": ["inference", "web"]}, headers=H).status_code == 403
    assert c.post("/api/tokens", json={"name": "w", "scopes": ["web"]}, headers=H).status_code == 403
    # an ordinary token is still changed without it
    assert c.patch(f"/api/tokens/{pid}", json={"notes": "laptop"}, headers=H).status_code == 200
    assert c.post(f"/api/tokens/{pid}/rotate", json={}, headers=H).status_code == 200
    # with the password again, all of it works
    assert c.post("/api/auth/reauth", json={"password": PW}, headers=H).status_code == 200
    assert c.post(f"/api/tokens/{tid}/rotate", json={}, headers=H).status_code == 200


def test_bodies_are_limited_before_anything_reads_them(c):  # noqa: F811
    big = b'{"username": "dev", "password": "' + b"x" * (2 << 20) + b'"}'
    r = c.post("/api/auth/login", content=big, headers={**H, "Content-Type": "application/json"})
    assert r.status_code == 413
    # without a Content-Length (chunked) too
    def chunks():
        for _ in range(3):
            yield b"x" * (1 << 20)
    r = c.post("/api/auth/login", content=chunks(), headers={**H, "Content-Type": "application/json"})
    assert r.status_code == 413
    # the chat takes pictures: 32 MB there
    assert c.post("/api/chats", content=b'{"content": "' + b"y" * (3 << 20) + b'"}',
                  headers={**H, "Content-Type": "application/json"}).status_code != 413


def test_one_password_check_at_a_time_per_address(monkeypatch, tmp_path):
    started, release = threading.Event(), threading.Event()

    def slow_verify(h, pw):
        started.set()
        release.wait(5)
        return False

    monkeypatch.setattr(auth.passwords, "verify_password", slow_verify)
    from outcrop.common import db
    con = db.connect(tmp_path / "t.db")
    auth.set_password(con, "dev", PW)
    errs = []

    def first():
        try:
            auth.login(con, "dev", "wrong", ip="192.168.1.30")
        except auth.AuthError as e:
            errs.append(("first", e.status))

    t = threading.Thread(target=first)
    t.start()
    started.wait(5)
    try:
        auth.login(con, "dev", "wrong", ip="192.168.1.30")           # a parallel guess from the same address
    except auth.AuthError as e:
        errs.append(("second", e.status))
    release.set()
    t.join(5)
    assert ("second", 429) in errs and ("first", 401) in errs
    # per address: two devices on the same IPv6 LAN are not one (a guest can't lock the owner out)
    assert auth.ip_key("fd12:3456:789a:1::1") != auth.ip_key("fd12:3456:789a:1:abcd::99")
    assert auth.ip_key("::ffff:192.168.1.30") == "192.168.1.30"


def test_strata_page_loads_nothing_from_elsewhere(c):  # noqa: F811
    url = c.get("/api/strata-view").json()["url"]
    csp = c.get(url).headers["content-security-policy"]
    assert "default-src 'self'" in csp and "img-src 'self' data: blob:" in csp and "connect-src 'self'" in csp


def test_presets_editor_allowlists():
    base = '{"presets": {"q": {"pack": "%s", "context": 32768%s}}%s}'
    from outcrop.console.control import SP
    pack = sorted(SP.FULL_ARENA_GIB)[0]
    ok = validate_presets(base % (pack, ', "env": {"STRATA_EXP_MODE": "1"}, "args": ["--adapt-async 1"]', ""))
    assert ok["errors"] == [] or all("engine" in e for e in ok["errors"])
    for extra, top in ((', "env": {"CUDA_INJECTION64_PATH": "/tmp/x.so"}', ""), (', "env": {"OPENSSL_CONF": "/x"}', ""),
                       (', "args": ["--mcp-config /tmp/evil.json"]', ""), ("", ', "server": {"private": true}'),
                       ("", ', "gateway": {"enabled": false}')):
        r = validate_presets(base % (pack, extra, top))
        assert not r["ok"], extra + top


def test_a_switch_cancelled_while_it_holds_stops_nothing(c):  # noqa: F811
    ctl = c.app.state.ctl
    ctl.time_scale = 10.0                                   # the acted-out hold lasts 3 s
    before = ctl.current()
    assert c.post("/api/presets/speed/switch", json={"when": "now"}, headers=H).status_code == 200
    for _ in range(100):
        cur = c.get("/api/switches/current").json()
        if (cur or {}).get("phase") == "hold":
            break
        time.sleep(0.05)
    assert c.post("/api/switches/current/cancel", headers=H).json() == {"ok": True}
    for _ in range(200):
        cur = c.get("/api/switches/current").json()
        if cur.get("status") not in ("running", "waiting"):
            break
        time.sleep(0.05)
    assert cur["status"] == "cancelled" and ctl.current() == before
    # once the old preset is being stopped, cancel is refused
    ctl.time_scale = 0.05


def test_strata_page_requests_get_the_gateways_checks(c):  # noqa: F811
    url = c.get("/api/strata-view").json()["url"]
    bad = {"model": "x", "messages": [{"role": "user", "content": [
        {"type": "text", "text": "hi"}, {"type": "image_url", "image_url": {"url": "/home/dev/secret.png"}}]}]}
    r = c.post(url + "v1/chat/completions", json=bad)
    assert r.status_code == 400 and "image" in r.text
