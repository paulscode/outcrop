"""The console's API: sign-in, sessions, CSRF, lockout, tokens, access, presets and the live socket (fake units)."""
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from conftest import UPSTREAM_KEY
from fakestrata.server import FakeStrata
from outcrop.common import db
from outcrop.console import auth
from outcrop.console.app import create_app
from outcrop.console.ctx import Options

PW = "glacier lantern velvet orbit moss pilgrim"
H = {"X-Outcrop": "1", "Origin": "http://localhost"}


@pytest.fixture
def console(tmp_path, monkeypatch):
    fake = FakeStrata(api_key=UPSTREAM_KEY).start()
    monkeypatch.setattr("outcrop.common.config.upstream_key", lambda create=False: UPSTREAM_KEY)
    dbp = tmp_path / "c.db"
    con = db.connect(dbp)
    auth.set_password(con, "dev", PW)
    app = create_app(Options(dev=True, https=False, strata_url=fake.url, db_path=dbp, fake_units=True,
                             gateway_sock=tmp_path / "none.sock", web_dist=tmp_path / "dist",
                             extra_origins=["http://testserver"]))
    app.state.ctl.time_scale = 0.05
    with TestClient(app, base_url="http://localhost") as c:
        c.con = con
        c.fake = fake
        yield c
    fake.stop()
    con.close()


def login(c, pw=PW, user="dev", remember=False):
    return c.post("/api/auth/login", json={"username": user, "password": pw, "remember": remember}, headers=H)


def test_login_logout_and_cookie(console):
    assert console.get("/api/state").status_code == 401
    r = login(console, "wrong password entirely")
    assert r.status_code == 401 and r.json()["error"] == "wrong password"
    r2 = login(console, PW, user="nobody")
    assert r2.status_code == 401 and r2.json()["error"] == r.json()["error"]
    r = login(console)
    assert r.status_code == 200
    sc = r.headers["set-cookie"].lower()
    assert "httponly" in sc and "samesite=strict" in sc and "path=/" in sc and "max-age" not in sc
    st = console.get("/api/state").json()
    assert st["user"] == "dev" and st["server"]["preset"] == "quality"
    assert console.post("/api/auth/logout", headers=H).status_code == 200
    assert console.get("/api/state").status_code == 401


def test_remember_sets_max_age(console):
    r = login(console, remember=True)
    assert "max-age=2592000" in r.headers["set-cookie"].lower()


def test_lockout(console):
    for _ in range(5):
        assert login(console, "nope nope nope nope").status_code == 401
    r = login(console)
    assert r.status_code == 429 and "Retry-After" in r.headers
    assert db.events(console.con, 3, kinds=["signin.fail"])


def test_csrf_checks(console):
    login(console)
    body = {"name": "x"}
    assert console.post("/api/tokens", json=body, headers={"Origin": "http://localhost"}).status_code == 403
    assert console.post("/api/tokens", json=body, headers={"X-Outcrop": "1", "Origin": "https://evil.example"}).status_code == 403
    assert console.post("/api/tokens", json=body, headers={"X-Outcrop": "1"}).status_code == 403          # no Origin
    r = console.post("/api/tokens", content=b"name=x", headers={**H, "Content-Type": "application/x-www-form-urlencoded"})
    assert r.status_code == 403
    assert console.post("/api/tokens", json=body, headers=H).status_code == 200


def test_security_headers(console):
    r = console.get("/api/auth/session")
    for k in ("content-security-policy", "x-content-type-options", "referrer-policy", "x-frame-options"):
        assert k in r.headers
    assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
    assert "script-src 'self'" in r.headers["content-security-policy"]
    assert r.headers["cache-control"] == "no-store"


def test_tokens_api(console):
    login(console)
    r = console.post("/api/tokens", json={"name": "laptop", "expires": "30d", "cidrs": ["192.168.1.0/24"]}, headers=H)
    assert r.status_code == 200
    plain = r.json()["plaintext"]
    assert plain.startswith("lls_")
    lst = console.get("/api/tokens").json()
    assert plain not in str(lst) and lst[0]["hint"].endswith("…")
    tid = r.json()["token"]["id"]
    assert console.patch(f"/api/tokens/{tid}", json={"rpm": 30}, headers=H).json()["rpm"] == 30
    rot = console.post(f"/api/tokens/{tid}/rotate", json={"grace": "1h"}, headers=H).json()
    assert rot["plaintext"] != plain
    rev = console.post(f"/api/tokens/{tid}/revoke", json={"reason": "test"}, headers=H).json()
    assert rev["token"]["status"] == "revoked"
    assert console.post("/api/tokens", json={"name": "bad name/"}, headers=H).status_code == 400


def test_reauth_needed_for_wider_access(console):
    login(console)
    console.con.execute("UPDATE sessions SET reauth_at=?", (time.time() - 3600,))
    r = console.post("/api/tokens", json={"name": "auto", "scopes": ["admin"]}, headers=H)
    assert r.status_code == 403 and r.json()["detail"]["reauth"] is True
    r = console.put("/api/access/mode", json={"mode": "open", "minutes": 240}, headers=H)
    assert r.status_code == 403
    assert console.put("/api/access/mode", json={"mode": "open", "minutes": 30}, headers=H).status_code == 200
    assert console.post("/api/auth/reauth", json={"password": "wrong wrong wrong"}, headers=H).status_code == 403
    assert console.post("/api/auth/reauth", json={"password": PW}, headers=H).status_code == 200
    assert console.post("/api/tokens", json={"name": "auto", "scopes": ["admin"]}, headers=H).status_code == 200
    assert console.put("/api/access/mode", json={"mode": "open", "minutes": 2000}, headers=H).status_code == 400
    assert console.put("/api/access/mode", json={"mode": "enforced"}, headers=H).status_code == 200
    assert db.get_setting(console.con, "auth.mode")["mode"] == "enforced"


def test_password_change_and_check(console):
    login(console)
    chk = console.post("/api/auth/password/check", json={"password": "Summer2026!Summer2026!"}, headers=H).json()
    assert chk["ok"] is False and chk["reasons"]
    gen = console.get("/api/auth/generate").json()["passphrase"]
    assert console.post("/api/auth/password/check", json={"password": gen}, headers=H).json()["ok"] is True
    bad = console.post("/api/auth/password", json={"current": PW, "new": "short"}, headers=H)
    assert bad.status_code == 400
    ok = console.post("/api/auth/password", json={"current": PW, "new": gen}, headers=H)
    assert ok.status_code == 200
    assert console.get("/api/state").status_code == 200          # this session stays


def test_presets_and_fake_switch(console):
    login(console)
    p = console.get("/api/presets").json()
    names = [x["name"] for x in p["presets"]]
    assert "quality" in names and p["current"] == "quality"
    q = next(x for x in p["presets"] if x["name"] == "quality")
    assert q["quality"] == 93.3 and q["bits"] == 3.5 and q["running"] and q["default"]
    r = console.post("/api/presets/speed/switch", json={"when": "now"}, headers=H)
    assert r.status_code == 200
    assert console.post("/api/presets/balanced/switch", json={}, headers=H).status_code == 409
    for _ in range(200):
        cur = console.get("/api/switches/current").json()
        if cur["status"] in ("done", "failed"):
            break
        time.sleep(0.1)
    assert cur["status"] == "done", cur
    keys = [e.get("phase") for e in cur["events"] if e.get("type") == "phase"]
    assert keys[:4] == ["hold", "stop", "start", "vision"] and "ready" in keys
    assert console.get("/api/presets").json()["current"] == "speed"
    assert console.get("/api/switches").json()[0]["to_preset"] == "speed"
    assert console.put("/api/presets/default", json={"name": "balanced"}, headers=H).json()["default"] == "balanced"


def test_live_socket_checks(console):
    # the test client always connects sockets as Host "testserver", allowed here as a development origin
    with pytest.raises(WebSocketDisconnect) as e:
        with console.websocket_connect("/api/live", headers={"Origin": "http://testserver"}) as ws:
            ws.receive_json()
    assert e.value.code == 4401
    login(console)
    cookie = {"Cookie": f"outcrop={console.cookies.get('outcrop')}"}
    with pytest.raises(WebSocketDisconnect) as e:
        with console.websocket_connect("/api/live", headers={"Origin": "https://evil.example", **cookie}) as ws:
            ws.receive_json()
    assert e.value.code == 4403
    with console.websocket_connect("/api/live", headers={"Origin": "http://testserver", **cookie}) as ws:
        ws.send_json({"op": "sub", "topics": ["metrics", "units"]})
        got = set()
        for _ in range(10):
            m = ws.receive_json()
            got.add(m["t"])
            if {"metrics", "units"} <= got:
                break
        assert "metrics" in got or "metrics.history" in got


def test_events_and_access_view(console):
    login(console)
    console.post("/api/tokens", json={"name": "ev"}, headers=H)
    ev = console.get("/api/events?limit=5").json()
    assert any(e["kind"] == "token.create" for e in ev)
    a = console.get("/api/access").json()
    assert a["mode"]["mode"] == "enforced" and a["tokenless"]["enabled"] is False


def test_new_session_id_at_every_sign_in(console):
    login(console)
    first = console.cookies.get("outcrop")
    login(console)
    second = console.cookies.get("outcrop")
    assert first and second and first != second                   # session fixation does not work
    n = console.con.execute("SELECT count(*) FROM sessions").fetchone()[0]
    assert n == 2


def test_admin_token_for_automation(console):
    from outcrop.common import tokens
    pepper = tokens.load_pepper()
    _, adm = tokens.create(console.con, pepper, "home-assistant", scopes=["admin"])
    _, inf = tokens.create(console.con, pepper, "plain", scopes=["inference"])
    console.cookies.clear()
    assert console.get("/api/state", headers={"Authorization": f"Bearer {inf}"}).status_code == 401
    st = console.get("/api/state", headers={"Authorization": f"Bearer {adm}"})
    assert st.status_code == 200 and st.json()["user"] == "token:home-assistant"
    # no CSRF headers needed (no cookie), but nothing that widens access
    r = console.put("/api/access/mode", json={"mode": "open", "minutes": 30}, headers={"Authorization": f"Bearer {adm}"})
    assert r.status_code == 200
    r = console.put("/api/access/mode", json={"mode": "open", "minutes": 240}, headers={"Authorization": f"Bearer {adm}"})
    assert r.status_code == 403
    r = console.post("/api/tokens", json={"name": "more", "scopes": ["admin"]}, headers={"Authorization": f"Bearer {adm}"})
    assert r.status_code == 403
    assert console.get("/api/backup", headers={"Authorization": f"Bearer {adm}"}).status_code == 403
    ev = db.events(console.con, 5, kinds=["auth.open"])
    assert ev and ev[0]["actor"] == "token:home-assistant"
