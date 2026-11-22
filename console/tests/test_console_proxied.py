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


def test_server_names_on_startos(monkeypatch):
    """In the container, apps are told the names StartOS published (gateway.hosts), not the container's own."""
    from outcrop.common import config
    net = config.Net(extra_hosts=["fd12:3456:789a:1:8226:5289:a554:40c8", "192.168.1.66", "YOUR-SERVER.local",
                                  "abcdefghij.onion"])
    monkeypatch.setenv("OUTCROP_PLATFORM", "startos")
    assert config.server_names(net) == ("YOUR-SERVER.local", ["192.168.1.66", "fd12:3456:789a:1:8226:5289:a554:40c8"])
    monkeypatch.delenv("OUTCROP_PLATFORM")
    import socket
    assert config.server_names(net)[0] == f"{socket.gethostname()}.local"


def test_security_checks_per_platform(monkeypatch):
    """The security page checks what this platform lets Outcrop secure: on StartOS the host is StartOS's."""
    from outcrop.common import config
    from outcrop.console import system

    class Ctx:
        net = config.Net(console_proxied_port=8800, proxied_port=8443)

        @staticmethod
        def con():
            return db.connect(":memory:")

    class Live:
        units = {"outcrop-gateway.service": {"active": "active"}}

    monkeypatch.setattr(system, "_cached", lambda key, ttl, fn: fn())
    monkeypatch.setattr(system, "listening_ports", lambda: [{"port": p, "address": "::", "lan": True}
                                                             for p in (8080, 11434, 8443, 8800)])
    monkeypatch.setenv("OUTCROP_PLATFORM", "startos")
    keys = {c["key"]: c for c in system.posture(Ctx, Live)}
    assert "firewall" not in keys and "ssh" not in keys and "rdp" not in keys
    assert keys["host"]["ok"] and keys["https"]["ok"] and "StartOS" in keys["https"]["detail"]
    assert keys["ports"]["ok"]                                                    # 8443 and 8800 are expected there
    monkeypatch.delenv("OUTCROP_PLATFORM")
    keys = {c["key"] for c in system.posture(Ctx, Live)}
    assert {"firewall", "rdp", "ssh", "https"} <= keys and "host" not in keys


def test_ubuntu_only_commands_say_so_on_startos(monkeypatch, capsys):
    from outcrop import cli
    from outcrop.console import admin
    monkeypatch.setenv("OUTCROP_PLATFORM", "startos")
    assert cli.main(["desktop", "status"]) == 2 and "Ubuntu" in capsys.readouterr().err
    assert admin.main(["ca"]) == 2 and "StartOS's certificate" in capsys.readouterr().err
    assert admin.main(["tls", "ensure"]) == 2


def _app(tmp_path, monkeypatch, startos):
    if startos:
        monkeypatch.setenv("OUTCROP_PLATFORM", "startos")
    else:
        monkeypatch.delenv("OUTCROP_PLATFORM", raising=False)
    fake = FakeStrata(api_key=UPSTREAM_KEY).start()
    monkeypatch.setattr("outcrop.common.config.upstream_key", lambda create=False: UPSTREAM_KEY)
    con = db.connect(tmp_path / "c.db")
    auth.set_password(con, "admin", PW)
    a = create_app(Options(dev=True, https=False, strata_url=fake.url, db_path=tmp_path / "c.db", fake_units=True,
                           gateway_sock=tmp_path / "none.sock", web_dist=tmp_path / "dist", extra_origins=["http://testserver"]))
    return a, fake, con


def test_signin_without_a_username_on_startos(tmp_path, monkeypatch):
    a, fake, con = _app(tmp_path, monkeypatch, startos=True)
    h = {"X-Outcrop": "1", "Origin": "http://localhost"}
    try:
        with TestClient(a, base_url="http://localhost") as c:
            assert c.get("/api/auth/options").json() == {"platform": "startos"}
            assert c.post("/api/auth/login", json={"password": "wrong password entirely"}, headers=h).status_code == 401
            r = c.post("/api/auth/login", json={"password": PW}, headers=h)
            assert r.status_code == 200 and r.json()["user"] == "admin"
            assert c.post("/api/auth/login", json={"username": "admin", "password": PW}, headers=h).status_code == 200
            assert c.post("/api/auth/login", json={"username": "someone", "password": PW}, headers=h).status_code == 401
        ev = con.execute("SELECT actor FROM events WHERE kind='signin.fail' ORDER BY id LIMIT 1").fetchone()
        assert ev[0] == "admin"                      # the failed attempt is recorded against the account
    finally:
        fake.stop()


def test_no_username_on_ubuntu_either(tmp_path, monkeypatch):
    """One account everywhere: the password alone signs in; a username that is given must still match."""
    a, fake, con = _app(tmp_path, monkeypatch, startos=False)
    h = {"X-Outcrop": "1", "Origin": "http://localhost"}
    try:
        with TestClient(a, base_url="http://localhost") as c:
            assert c.get("/api/auth/options").json() == {"platform": "server"}
            assert c.post("/api/auth/login", json={"password": PW}, headers=h).status_code == 200
            assert c.post("/api/auth/login", json={"username": "admin", "password": PW}, headers=h).status_code == 200
            assert c.post("/api/auth/login", json={"username": "someone", "password": PW}, headers=h).status_code == 401
    finally:
        fake.stop()
