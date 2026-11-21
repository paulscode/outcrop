"""The console behind StartOS's TLS-terminating proxy: the real client and the https scheme, only from the proxy itself.

Sign-in lockouts are per client address, so behind a proxy that address must be the client's, not the proxy's (else one
person's typos would lock everyone out), and the session cookie must stay the Secure __Host- one.
"""
import pytest
from conftest import UPSTREAM_KEY
from fakestrata.server import FakeStrata
from fastapi.testclient import TestClient

from outcrop.common import db
from outcrop.console import auth
from outcrop.console.__main__ import behind_proxy, proxy_peers
from outcrop.console.app import create_app
from outcrop.console.ctx import Options

PW = "glacier lantern velvet orbit moss pilgrim"
FWD = {"X-Forwarded-For": "192.168.1.35", "X-Forwarded-Proto": "https"}
H = {"X-Outcrop": "1", "Origin": "https://localhost"}


def test_proxy_peers():
    assert proxy_peers(["10.0.3.1", "fd00:3::1"]) == ["10.0.3.1", "::ffff:10.0.3.1", "fd00:3::1"]


@pytest.fixture
def app(tmp_path, monkeypatch):
    fake = FakeStrata(api_key=UPSTREAM_KEY).start()
    monkeypatch.setattr("outcrop.common.config.upstream_key", lambda create=False: UPSTREAM_KEY)
    dbp = tmp_path / "c.db"
    con = db.connect(dbp)
    auth.set_password(con, "dev", PW)
    a = create_app(Options(https=False, strata_url=fake.url, db_path=dbp, fake_units=True,
                           gateway_sock=tmp_path / "none.sock", web_dist=tmp_path / "dist"))
    a.state.ctl.time_scale = 0.05
    yield behind_proxy(a, ["10.0.3.1"]), con
    fake.stop()
    con.close()


def client(app, peer):
    return TestClient(app[0], base_url="http://localhost", client=(peer, 40000))


@pytest.mark.parametrize("peer", ["10.0.3.1", "::ffff:10.0.3.1"])
def test_through_the_proxy(app, peer):
    con = app[1]
    with client(app, peer) as c:
        r = c.post("/api/auth/login", json={"username": "dev", "password": "wrong password entirely"}, headers={**H, **FWD})
        assert r.status_code == 401
        r = c.post("/api/auth/login", json={"username": "dev", "password": PW}, headers={**H, **FWD})
        assert r.status_code == 200
        sc = r.headers["set-cookie"]
        assert sc.startswith("__Host-outcrop=") and "secure" in sc.lower()
    ev = con.execute("SELECT source FROM events WHERE kind = 'signin.fail' ORDER BY id DESC LIMIT 1").fetchone()
    assert ev[0] == "192.168.1.35"
    assert con.execute("SELECT ip FROM sessions ORDER BY created_at DESC LIMIT 1").fetchone()[0] == "192.168.1.35"


def test_not_the_proxy(app):
    """Another container on the bridge sends the same headers: they are its own claims, and ignored."""
    con = app[1]
    with client(app, "10.0.3.77") as c:
        r = c.post("/api/auth/login", json={"username": "dev", "password": "wrong password entirely"}, headers={**H, **FWD})
        assert r.status_code == 401
        r = c.post("/api/auth/login", json={"username": "dev", "password": PW}, headers={**H, **FWD})
        assert r.status_code == 200
        sc = r.headers["set-cookie"]
        assert not sc.startswith("__Host-") and "secure" not in sc.lower()        # plain http, as it really is
    assert con.execute("SELECT source FROM events WHERE kind = 'signin.fail' ORDER BY id DESC LIMIT 1").fetchone()[0] == \
        "10.0.3.77"


def test_forwarded_is_never_read(app):
    con = app[1]
    with client(app, "10.0.3.1") as c:
        r = c.post("/api/auth/login", json={"username": "dev", "password": "wrong password entirely"},
                   headers={**H, "Forwarded": "for=192.168.1.35;proto=https", "X-Real-IP": "192.168.1.35"})
        assert r.status_code == 401
    assert con.execute("SELECT source FROM events WHERE kind = 'signin.fail' ORDER BY id DESC LIMIT 1").fetchone()[0] == \
        "10.0.3.1"
