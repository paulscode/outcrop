"""Console API part 2: logs, memory, energy, the lab's import, the preset editor, capture, Strata's page in a sandbox."""
import json
import os
import shutil
from pathlib import Path
import sqlite3
import time

import pytest
from fastapi.testclient import TestClient

from conftest import UPSTREAM_KEY
from fakestrata.server import FakeStrata
from outcrop.common import db
from outcrop.console import auth, extras
from outcrop.console.app import create_app
from outcrop.console.control import SP
from outcrop.console.ctx import Options

PW = "glacier lantern velvet orbit moss pilgrim"
H = {"X-Outcrop": "1", "Origin": "http://localhost"}


REF_PRESETS = Path(os.environ["OUTCROP_PRESETS"])    # conftest.py makes it from the m6000-256g profile


@pytest.fixture
def c(tmp_path, monkeypatch):
    fake = FakeStrata(api_key=UPSTREAM_KEY).start()
    monkeypatch.setattr("outcrop.common.config.upstream_key", lambda create=False: UPSTREAM_KEY)
    presets = tmp_path / "presets.json"
    shutil.copy(REF_PRESETS, presets)
    monkeypatch.setattr(SP, "PRESETS_FILE", presets)
    (tmp_path / "logs").mkdir()
    (tmp_path / "logs" / "gateway.log").write_text("INFO ready\nWARNING something slow\nERROR it failed\n")
    dbp = tmp_path / "c.db"
    con = db.connect(dbp)
    auth.set_password(con, "dev", PW)
    app = create_app(Options(dev=True, https=False, strata_url=fake.url, db_path=dbp, fake_units=True,
                             gateway_sock=tmp_path / "none.sock", web_dist=tmp_path / "dist", log_dir=tmp_path / "logs",
                             gateway_url="http://127.0.0.1:9"))
    with TestClient(app, base_url="http://localhost") as cl:
        cl.post("/api/auth/login", json={"username": "dev", "password": PW}, headers=H)
        cl.con, cl.presets = con, presets
        yield cl
    fake.stop()
    con.close()


def test_logs(c):
    r = c.get("/api/logs?source=gateway&lines=10").json()
    assert [x["level"] for x in r["lines"]] == ["info", "warn", "error"]
    assert len(c.get("/api/logs?source=gateway&q=slow").json()["lines"]) == 1
    assert c.get("/api/logs?source=nope").status_code == 400


def test_memory_layers(c):
    time.sleep(1.5)
    m = c.get("/api/memory").json()
    assert m["unified"] is False
    assert [x["key"] for x in m["vram"]["layers"]] == ["experts", "dense", "kv", "mtp", "other", "free"]
    assert [x["key"] for x in m["ram"]["layers"]] == ["arena", "ngram", "convcache", "pagecache", "other", "free"]
    total = sum(x["gib"] for x in m["ram"]["layers"])
    assert abs(total - m["ram"]["total_gib"]) < 2.0
    assert m["conversation_cache"]["recent"]["requests"] >= 0


def test_memory_unified(c):
    """A GB10: one memory for the CPU and the GPU, so the GPU's layers are carved out of the RAM, not counted twice."""
    time.sleep(1.5)
    live = c.app.state.live
    live.gpu_static = dict(live.gpu_static, memory="unified", vram_total_mib=None)
    m = c.get("/api/memory").json()
    assert m["unified"] and m["vram"]["layers"] == []
    keys = [x["key"] for x in m["ram"]["layers"]]
    assert keys[:3] == ["experts", "dense", "mtp"] and "arena" not in keys and keys[-1] == "free"
    total = sum(x["gib"] for x in m["ram"]["layers"])
    assert abs(total - m["ram"]["total_gib"]) < 2.0
    assert "GPU's share" in m["ram"]["layers"][0]["note"]


def test_energy_shape(c):
    e = c.get("/api/energy?days=7").json()
    assert "days" in e and "GPU only" in e["note"]
    assert c.put("/api/settings/energy", json={"price_per_kwh": 0.21}, headers=H).json()["price_per_kwh"] == 0.21
    assert c.put("/api/settings/energy", json={"price_per_kwh": "x"}, headers=H).status_code == 400


def test_bench_import(c):
    runs = c.get("/api/bench/runs").json()
    imported = [r for r in runs if r["source"]]
    assert imported, "bench/results should be imported at start"
    v = next(r for r in imported if r["source"].endswith("validate-quality.json"))
    assert v["preset"] == "quality" and v["result"]["speed"]["chat"]["decode"] > 0
    assert c.post("/api/bench/import", headers=H).json()["imported"] == 0          # once each
    assert c.post("/api/bench/runs", json={"kind": "rm -rf"}, headers=H).status_code == 400


def test_preset_editor(c):
    raw = c.get("/api/presets/raw").json()
    v = c.post("/api/presets/validate", json={"text": raw["text"]}, headers=H).json()
    assert v["ok"] and "quality" in v["rendered"] and "--pack" in v["rendered"]["quality"]["args"]
    bad = c.post("/api/presets/validate", json={"text": raw["text"][:-10]}, headers=H).json()
    assert not bad["ok"] and "line" in bad["errors"][0]
    cfg = json.loads(raw["text"])
    cfg["presets"]["quality"]["pack"] = "fp64"
    cfg["server"]["host"] = "0.0.0.0"
    bad = c.post("/api/presets/validate", json={"text": json.dumps(cfg)}, headers=H).json()
    assert not bad["ok"] and any("pack" in e for e in bad["errors"]) and any("127.0.0.1" in e for e in bad["errors"])
    cfg = json.loads(raw["text"])
    cfg["presets"]["quality"]["description"] = "edited"
    new = json.dumps(cfg, indent=2)
    v = c.post("/api/presets/validate", json={"text": new}, headers=H).json()
    assert v["ok"] and "+      \"description\": \"edited\"" in v["diff"]
    assert c.put("/api/presets/raw", json={"text": new, "hash": "stale"}, headers=H).status_code == 409
    r = c.put("/api/presets/raw", json={"text": new, "hash": raw["hash"]}, headers=H)
    assert r.status_code == 200, r.text
    assert json.loads(c.presets.read_text())["presets"]["quality"]["description"] == "edited"
    assert REF_PRESETS.read_text() != c.presets.read_text()        # the reference file is untouched


def test_capture(c):
    assert c.get("/api/capture").json()["enabled"] is False
    r = c.put("/api/capture", json={"enabled": True, "minutes": 30, "max_requests": 5}, headers=H).json()
    assert r["enabled"] and r["max_requests"] == 5 and r["until"] > time.time()
    assert db.events(c.con, 3, kinds=["capture.on"])
    assert c.put("/api/capture", json={"enabled": False}, headers=H).json()["enabled"] is False


def test_strata_page_is_sandboxed(c):
    url = c.get("/api/strata-view").json()["url"]
    assert url.startswith("/strata/") and url.endswith("/")
    r = c.get(url)
    assert r.status_code == 200 and "fake strata page" in r.text
    csp = r.headers["content-security-policy"]
    assert csp.startswith("sandbox ") and "allow-same-origin" not in csp
    h = c.get(url + "health")
    assert h.status_code == 200 and h.json()["model"]
    assert c.get("/strata/not-a-key/health").status_code == 403
    c.post("/api/auth/logout", headers=H)
    assert c.get(url + "health").status_code == 403                           # ends with the session


def test_strata_page_keeps_its_preferences(c):
    """Its sandbox has no localStorage: the console's stand-in loads first, dark until flipped, and remembers the flip."""
    url = c.get("/api/strata-view").json()["url"]
    page = c.get(url).text
    assert '<html data-theme="dark"' in page and '<script src="web/__outcrop-storage.js"></script>' in page
    js = c.get(url + "web/__outcrop-storage.js")
    assert js.status_code == 200 and js.headers["content-type"].startswith("text/javascript")
    assert '{"strata.theme": "dark"}' in js.text
    r = c.post(url + "web/__outcrop-storage", json={"strata.theme": "light", "strata.apikey": "secret",
                                                    "strata.sampling": '{"temperature":0.7}', "strata.lang": "</script>"})
    assert r.status_code == 204
    assert '<html data-theme="light"' in c.get(url).text
    js = c.get(url + "web/__outcrop-storage.js").text
    assert "secret" not in js and "</script>" not in js and "\\u003c/script\\u003e" in js and "temperature" in js
    c.post(url + "web/__outcrop-storage", json={"strata.theme": "\"><script>"})          # not a theme: not kept
    assert '<html data-theme="dark"' in c.get(url).text
    assert c.post("/strata/not-a-key/web/__outcrop-storage", json={}).status_code == 403


def test_playground_without_gateway_is_502(c):
    r = c.post("/api/playground/chat", json={"model": "x", "messages": [{"role": "user", "content": "hi"}]}, headers=H)
    assert r.status_code == 502


def test_validate_presets_unit():
    good = REF_PRESETS.read_text()
    assert extras.validate_presets(good)["ok"]
    assert not extras.validate_presets("[]")["ok"]


def test_editor_refuses_foreign_engines_and_loader_variables():
    cfg = json.loads(REF_PRESETS.read_text())
    cfg["presets"]["quality"]["engine"] = "../../../usr/bin/python3"
    cfg["presets"]["speed"]["env"] = {"LD_PRELOAD": "/tmp/x.so"}
    cfg["common"]["env"]["PYTHONPATH"] = "/tmp"
    v = extras.validate_presets(json.dumps(cfg))
    assert not v["ok"]
    joined = " ".join(v["errors"])
    assert "no paths" in joined and "LD_PRELOAD" in joined and "PYTHONPATH" in joined


def test_recent_reuse():
    con = sqlite3.connect(":memory:")
    con.execute("CREATE TABLE requests (started_at REAL, prompt_tokens INTEGER, reused_tokens INTEGER)")
    con.executemany("INSERT INTO requests VALUES (?, ?, ?)",
                    [(1, 1000, 0),        # the oldest: outside a window of 3
                     (2, 1000, 900), (3, 1000, 8), (4, 500, None), (5, None, None), (6, 0, 0)])
    assert extras.recent_reuse(con, 3) == {"requests": 3, "prompt_tokens": 2500, "reused_tokens": 908, "requests_reused": 2}
    assert extras.recent_reuse(con)["requests"] == 4
    con.execute("DELETE FROM requests")
    assert extras.recent_reuse(con) == {"requests": 0, "prompt_tokens": 0, "reused_tokens": 0, "requests_reused": 0}
