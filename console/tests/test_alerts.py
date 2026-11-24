"""Alerts fire and clear (scripted GPU temperature and service failure), and a Telegram failure shows without blocking."""
import json
import time
import types

import pytest

from outcrop.common import db
from outcrop.console import alerts as A


class FakeLive:
    def __init__(self):
        self.published = []

    def publish(self, topic, data, keep=True):
        self.published.append((topic, data))


@pytest.fixture
def eng(tmp_path, monkeypatch):
    con = db.connect(tmp_path / "a.db")
    ctx = types.SimpleNamespace(con=lambda: con)
    sent = []
    monkeypatch.setattr(A, "TG_FILE", tmp_path / "telegram.json")
    A.tg_save({"token": "123:abc", "chat_id": 42, "enabled": True})
    monkeypatch.setattr(A, "tg_send", lambda text, d=None, timeout=10.0: (sent.append(text) or (True, "sent")))
    e = A.Alerts(ctx, FakeLive())
    e.sent = sent
    e.con = con
    return e


def sample(t, temp, throttle=None, procs=None):
    return {"t": t, "gpu": {"temp": temp, "throttle": throttle or [], "procs": procs or [{"name": "strata-0211", "mem": 23000}]}}


def open_alerts(e):
    return [dict(r) for r in e.con.execute("SELECT * FROM alerts WHERE closed_at IS NULL")]


def test_gpu_temperature_fires_once_and_clears(eng):
    t0 = time.time()
    for i in range(0, 50, 5):
        eng.observe_sample(sample(t0 + i, 86))
    assert not open_alerts(eng)                                     # under a minute: nothing yet
    for i in range(50, 120, 5):
        eng.observe_sample(sample(t0 + i, 86))
    al = open_alerts(eng)
    assert len(al) == 1 and al[0]["rule"] == "gpu_hot" and "86 °C" in al[0]["summary"]
    assert len(eng.sent) == 1 and eng.sent[0].startswith("⚠") and "https://" in eng.sent[0]
    eng.observe_sample(sample(t0 + 130, 70))
    assert not open_alerts(eng)
    assert len(eng.sent) == 2 and eng.sent[1].startswith("✓")
    assert db.events(eng.con, 5, kinds=["alert.gpu_hot*"])


def test_throttling_alone_fires(eng):
    t0 = time.time()
    for i in range(0, 70, 5):
        eng.observe_sample(sample(t0 + i, 79, throttle=["thermal"]))
    assert open_alerts(eng)[0]["rule"] == "gpu_hot"


def test_service_failure_and_recovery(eng):
    up = {"outcrop-engine@quality.service": {"active": "active", "restarts": 0, "result": "success"},
          "outcrop-gateway.service": {"active": "active", "restarts": 0, "enabled": "enabled"}}
    crashed = {**up, "outcrop-engine@quality.service": {"active": "activating", "restarts": 1, "result": "exit-code"}}
    eng.observe_units(up, crashed)
    al = open_alerts(eng)
    assert len(al) == 1 and "crashed and is restarting" in al[0]["summary"] and eng.sent[-1].startswith("✗")
    eng.observe_units(crashed, crashed)                              # no repeat while it stays open
    assert len(eng.sent) == 1
    back = {**up, "outcrop-engine@quality.service": {"active": "active", "restarts": 1}}
    eng.observe_units(crashed, back)
    assert open_alerts(eng)                                          # running again, but not for long yet
    eng.stable_since["outcrop-engine@quality.service"] -= 200            # three minutes without a restart
    eng.observe_units(back, back)
    assert not open_alerts(eng) and eng.sent[-1].startswith("✓")


def test_a_crash_loop_is_one_alert(eng):
    u = "outcrop-ollama-bridge.service"
    n0 = len(eng.sent)
    for i in range(5):                                               # crashes every poll or two, comes back each time
        eng.observe_units({u: {"active": "active", "restarts": i}}, {u: {"active": "active", "restarts": i + 1}})
        eng.observe_units({u: {"active": "active", "restarts": i + 1}}, {u: {"active": "active", "restarts": i + 1}})
    assert len(open_alerts(eng)) == 1 and len(eng.sent) - n0 == 1


def test_a_unit_that_is_gone_clears(eng):
    up = {"outcrop-engine@speed.service": {"active": "failed", "restarts": 0, "result": "exit-code"}}
    eng.observe_units({}, up)
    assert open_alerts(eng)
    now = {"outcrop-engine@quality.service": {"active": "active", "restarts": 0}, "outcrop-console.service": {"active": "active"}}
    eng.observe_units(up, now)                                                                  # switched away
    assert open_alerts(eng)                                  # one poll could be a hiccup
    eng.observe_units(now, now)
    eng.observe_units(now, now)
    assert not open_alerts(eng)
    # an empty or partial poll (systemctl did not answer) changes nothing
    eng.observe_units({}, {"outcrop-engine@speed.service": {"active": "failed", "restarts": 0, "result": "exit-code"},
                           "outcrop-console.service": {"active": "active"}})
    n = len(open_alerts(eng))
    eng.observe_units({}, {})
    assert len(open_alerts(eng)) == n


def test_restart_seen_only_as_a_count_still_clears(eng):
    a = {"outcrop-ollama-bridge.service": {"active": "active", "restarts": 0}}
    b = {"outcrop-ollama-bridge.service": {"active": "active", "restarts": 1}}      # the restarting state was missed
    eng.observe_units(a, b)
    assert open_alerts(eng)
    eng.observe_units(b, b)                                            # the next poll: active, no new restart
    eng.stable_since["outcrop-ollama-bridge.service"] -= 200
    eng.observe_units(b, b)
    assert not open_alerts(eng)


def test_gateway_down(eng):
    up = {"outcrop-gateway.service": {"active": "active", "enabled": "enabled"}}
    down = {"outcrop-gateway.service": {"active": "inactive", "enabled": "enabled"}}
    eng.observe_units(up, down)
    assert not open_alerts(eng)                                        # a restart that takes a moment: no alert
    eng.gw_down_since -= 11
    eng.observe_units(down, down)
    assert "the API is down" in open_alerts(eng)[0]["summary"]
    eng.observe_units(down, up)
    assert not open_alerts(eng)


def test_telegram_failure_shows_and_does_not_block(eng, monkeypatch):
    monkeypatch.setattr(A, "tg_send", lambda text, d=None, timeout=10.0: (False, "Unauthorized"))
    eng.observe_units({"outcrop-gateway.service": {"active": "active", "enabled": "enabled"}},
                      {"outcrop-gateway.service": {"active": "failed", "enabled": "enabled"}})
    eng.open("disk", "disk", "the disk is 95% full")                # a second alert still goes in
    assert len(open_alerts(eng)) >= 2
    pub = A.tg_public()
    assert pub["last_error"] == "Unauthorized" and pub["configured"]
    sent = [json.loads(r["sent"]) for r in eng.con.execute("SELECT sent FROM alerts")]
    assert all(s.get("telegram") == "Unauthorized" for s in sent)
    assert eng.summary()["telegram"]["last_error"] == "Unauthorized"


def test_rules_can_be_turned_off(eng):
    db.set_setting(eng.con, "alerts.rules", {"gpu_hot": {"telegram": False}})
    t0 = time.time()
    for i in range(0, 80, 5):
        eng.observe_sample(sample(t0 + i, 90))
    assert open_alerts(eng) and not eng.sent                         # in the console, not on Telegram


def test_contention(eng):
    t0 = time.time()
    other = [{"name": "strata-0211", "mem": 23000}, {"name": "gnome-remote-de", "mem": 300}]
    for i in range(0, 40, 5):
        eng.observe_sample(sample(t0 + i, 60, procs=other))
    al = open_alerts(eng)
    assert al and al[0]["rule"] == "gpu_contention" and "gnome-remote-de" in al[0]["summary"]


def test_token_never_in_messages(eng):
    eng.open("api_open", "x", "the API is open without tokens until 22:00", notify_only=True)
    assert all("123:abc" not in m for m in eng.sent)


def test_bursts_are_one_off_with_a_cooldown(eng):
    for _ in range(12):
        eng.observe_signin_fail("192.168.1.77")
    rows = [dict(r) for r in eng.con.execute("SELECT * FROM alerts WHERE rule='auth_burst'")]
    assert len(rows) == 1 and rows[0]["closed_at"] is not None           # sent once, nothing left open
    assert len(eng.sent) == 1 and "failed console sign-ins" in eng.sent[0]


def test_hardware_change_is_offered_once_and_a_move_told_once(eng, monkeypatch):
    import profiles as PF
    h = {"profile": "m6000-32g", "fits": "m6000-64g", "ram_gib": 63, "change": "more", "download_gb": 57,
         "message": "This server now has 63 GiB of RAM: hardware profile m6000-64g fits it."}
    monkeypatch.setattr(PF, "hardware", lambda *a, **k: dict(h))
    monkeypatch.setattr(PF, "last_move", lambda: None)
    monkeypatch.delenv("OUTCROP_PLATFORM", raising=False)
    eng._hardware()
    eng._hardware()                                     # once while it stays open
    rows = open_alerts(eng)
    assert [r["key"] for r in rows] == ["hardware:fits"]
    assert "outcrop profile apply m6000-64g" in rows[0]["summary"] and len(eng.sent) == 1
    monkeypatch.setenv("OUTCROP_PLATFORM", "startos")
    h.update(change="none", fits="m6000-64g", profile="m6000-64g")
    eng._hardware()
    assert open_alerts(eng) == [] and "fits this machine again" in eng.sent[-1]
    # a move made at a start: told once, however often the console restarts
    move = {"from": "m6000-128g", "to": "m6000-32g", "boot_from": "quality", "boot": "speed", "ram_gib": 31,
            "at": "2026-11-25T10:00:00"}
    monkeypatch.setattr(PF, "last_move", lambda: dict(move))
    n = len(eng.sent)
    eng._hardware()
    eng._hardware()
    assert len(eng.sent) == n + 1 and "moved from hardware profile m6000-128g to m6000-32g" in eng.sent[-1]
    assert "boot preset is now speed" in eng.sent[-1] and open_alerts(eng) == []
