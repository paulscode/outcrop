"""Preset control for the console: systemd through lib/outcrop_control.py on the server, or a fake for development."""
from __future__ import annotations

import json
import random
import statistics
import sys
import threading
import time
from pathlib import Path

import httpx

from ..common import config

sys.path.insert(0, str(config.PROJECT / "lib"))
import outcrop_control as LC  # noqa: E402
import strata_presets as SP  # noqa: E402
import units  # noqa: E402,F401  (the service manager, for the console's other modules)


class Controller:
    """The real thing: systemd units, the state file for the boot default, the journal for phases."""
    fake = False

    def presets(self) -> dict:
        return SP.load()

    def current(self) -> str | None:
        return LC.current()

    def default(self) -> str | None:
        return LC.default_preset()

    def set_default(self, name: str, by: str, source: str) -> None:
        LC.set_default(name, by=by, source=source)

    def switch(self, name: str, *, cancel_inflight: bool, by: str, source: str, on, restart: bool = False,
               should_cancel=None) -> dict:
        return LC.switch(name, cancel_inflight=cancel_inflight, by=by, source=source, on=on, restart=restart,
                         should_cancel=should_cancel)

    def estimate(self, name: str, warm: float | None) -> float | None:
        return LC.estimate_s(name, warm)

    _warm_cache: dict = {}
    _warm_thread = None

    def _pack_of(self, name: str) -> str | None:
        p = SP.load()["presets"].get(name)
        return p["pack"] if p else None

    def _measure(self, name: str) -> float | None:
        try:
            return LC.page_cache_share(LC.pack_files(name))
        except Exception:
            return None

    def _refresh(self) -> None:
        while True:
            seen = set()
            for name in SP.names():
                pack = self._pack_of(name)
                if pack and pack not in seen:
                    seen.add(pack)
                    self._warm_cache[pack] = (time.time(), self._measure(name))
            time.sleep(60)

    def warm(self, name: str) -> float | None:
        """The share of the preset's model files in the page cache (a warm switch is quicker).  Measured per pack, about a
        second each, by a background thread every minute; the first ask for a pack measures it at once."""
        if Controller._warm_thread is None:
            Controller._warm_thread = threading.Thread(target=self._refresh, daemon=True, name="outcrop-warm")
            Controller._warm_thread.start()
        pack = self._pack_of(name)
        hit = self._warm_cache.get(pack)
        if hit is not None:
            return hit[1]
        v = self._measure(name)
        self._warm_cache[pack] = (time.time(), v)
        return v

    def stop(self, by: str) -> list[str]:
        return LC.stop_all(by=by)

    def restart_unit(self, unit: str) -> None:
        LC.systemctl("restart", unit)


class FakeController(Controller):
    """Development without systemd or a GPU: switches act out the real phases against the fake Strata."""
    fake = True
    time_scale = 1.0             # tests make the acted-out phases quicker

    def __init__(self, strata_url: str, gateway=None):
        self.strata_url = strata_url.rstrip("/")
        self.gateway = gateway                  # (method, path, body) -> dict | None: the gateway's control socket
        self._current = "quality"
        self._default = "quality"
        self.lock = threading.Lock()

    def current(self):
        return self._current

    def default(self):
        return self._default

    def set_default(self, name, by, source):
        if name not in SP.names():
            raise ValueError(f"unknown preset {name!r}")
        self._default = name
        LC.audit("preset.default", f"boot default set to {name}", actor=by, source=source)

    def warm(self, name):
        return {"quality": 0.98, "balanced": 0.41, "speed": 0.12}.get(name.replace("-1m", ""), 0.0)

    def estimate(self, name, warm):
        return 52.0 if (warm or 0) > 0.5 else 66.0

    def _fake(self, **kw):
        try:
            httpx.post(self.strata_url + "/_fake/config", json=kw, timeout=5)
        except httpx.HTTPError:
            pass

    def switch(self, name, *, cancel_inflight, by, source, on, restart=False, should_cancel=None):
        if name not in SP.names():
            raise LC.SwitchError(f"unknown preset {name!r}")
        t0 = time.time()
        rec = {"started_at": t0, "from": self._current, "to": name, "by": by, "phases": [], "ok": False, "error": None}
        speed = (1.0 if self.warm(name) > 0.5 else 1.4) * self.time_scale

        def phase(key, label, dur, **kw):
            now = time.time()
            if rec["phases"]:
                rec["phases"][-1]["end"] = now
            rec["phases"].append({"key": key, "label": label, "start": now, "end": None, **kw})
            on({"type": "phase", "phase": key, "label": label, "at": now, **kw})
            end = now + dur * speed
            while time.time() < end:
                on({"type": "tick", "elapsed_s": round(time.time() - t0, 1)})
                if key == "experts":
                    done = min(1.0, 1 - (end - time.time()) / (dur * speed))
                    on({"type": "progress", "phase": "experts", "rss_gib": round(46.8 * done, 2), "target_gib": 46.8})
                time.sleep(min(0.25, max(0.01, end - time.time())))

        try:
            warm = self.warm(name)
            on({"type": "plan", "preset": name, "from": self._current, "warm": warm, "estimate_s": self.estimate(name, warm),
                "ram_need_gib": 57, "ram_avail_gib": 150.0, "low_ram": False})
            hold_id = None
            if self.gateway is not None:            # like the real switch: new requests wait at the gateway
                hold_id = (self.gateway("POST", "/hold", {"reason": f"switching to {name}", "max_s": 300}) or {}).get("hold_id")
            rec["hold_id"] = hold_id
            phase("hold", "Hold new requests", 0.3)
            if should_cancel and should_cancel():          # as the real switch: cancelled before anything is stopped
                raise LC.SwitchCancelled("cancelled before the running preset was stopped")
            if self._current:
                phase("stop", f"Stop {self._current}", 2.5, preset=self._current)
            self._fake(loaded=False)
            phase("start", f"Start {name}", 0.6)
            phase("vision", "Picture encoder", 1.5)
            phase("weights", "Model weights", 3.0)
            phase("experts", "Experts into RAM", 6.0, gb="59")
            on({"type": "experts_loaded", "gib": "46.84", "rate": f"{random.uniform(5, 21):.2f}"})
            slots = {"speed": 12301, "balanced": 9736, "quality": 8310}.get(name.replace("-1m", ""), 8000)
            phase("gpu_cache", "GPU expert cache", 1.5, slots=str(slots), vram="15.76")
            phase("final", "Final checks", 1.0)
            self._fake(loaded=True, preset=name)
            self._current = name
            phase("ready", "Ready", 0.0)
            rec["phases"][-1]["end"] = time.time()
            rec["ok"] = True
            return rec
        except Exception as e:
            rec["error"] = str(e)
            raise
        finally:
            if rec.get("hold_id") and self.gateway is not None:
                self.gateway("POST", "/release", {"hold_id": rec.pop("hold_id")})
            rec.pop("hold_id", None)
            rec["ended_at"] = time.time()
            LC._record_switch(rec, source)
            on({"type": "done", "ok": rec["ok"], "error": rec["error"], "total_s": round(rec["ended_at"] - t0, 1)})

    def stop(self, by):
        self._fake(loaded=False)
        was, self._current = self._current, None
        return [was] if was else []

    def restart_unit(self, unit):
        pass


def measured(name: str) -> dict:
    """The latest measured decode speeds for a preset (bench/results/validate-<preset>.json, quickbench's format)."""
    p = config.BENCH_RESULTS / f"validate-{name}.json"
    try:
        d = json.loads(p.read_text())
    except (OSError, ValueError):
        return {}
    out = {"at": p.stat().st_mtime}
    for case, runs in d.items():
        if isinstance(runs, list) and runs:
            out[case] = {"decode": round(statistics.median(r["decode_tps"] for r in runs), 1),
                         "prompt": round(statistics.median(r["prompt_tps"] for r in runs), 1),
                         "ttft": round(statistics.median(r["ttft_s"] for r in runs), 2)}
    return out


def last_switch_info(con, name: str) -> dict:
    """Expert slots and VRAM from the newest successful start of this preset."""
    r = con.execute("SELECT phases, started_at, ended_at FROM switches WHERE to_preset=? AND ok=1 ORDER BY started_at DESC "
                    "LIMIT 1", (name,)).fetchone()
    if r is None:
        return {}
    info = {"last_switch_s": round(r["ended_at"] - r["started_at"], 1), "last_switch_at": r["ended_at"]}
    for ph in json.loads(r["phases"] or "[]"):
        if ph.get("key") == "gpu_cache":
            info["expert_slots"] = int(ph.get("slots") or 0) or None
            info["expert_vram_gib"] = float(ph.get("vram") or 0) or None
        if ph.get("key") == "experts" and ph.get("gib"):
            info["arena_gib"] = float(ph["gib"])
            info["load_rate"] = float(ph.get("rate") or 0) or None
    return info


def parse_description(desc: str) -> dict:
    import re
    out = {}
    m = re.search(r"task average ([\d.]+)", desc or "")
    if m:
        out["quality"] = float(m.group(1))
    m = re.search(r"([\d.]+) bits/weight", desc or "")
    if m:
        out["bits"] = float(m.group(1))
    return out


FALLBACK_SLOTS = {"speed": 12301, "balanced": 9736, "quality": 8310, "speed-1m": 11018, "balanced-1m": 8720,
                  "quality-1m": 7449}
FALLBACK_QUALITY = {"q2_0": (89.1, 2.4), "iq3_xxs": (92.6, 3.0), "iq3_s": (93.3, 3.5)}


def preset_cards(ctl: Controller, con) -> list[dict]:
    cfg = SP.load()
    cur, dflt = ctl.current(), ctl.default()
    cards = []
    for name, p in cfg["presets"].items():
        desc = p.get("description", "")
        q = parse_description(desc)
        fq = FALLBACK_QUALITY.get(p["pack"], (None, None))
        base = name.replace("-1m", "")
        warm = ctl.warm(name)
        info = last_switch_info(con, name)
        cards.append({"name": name, "pack": p["pack"], "description": desc, "context": int(p["context"]),
                      "rope": p.get("rope"), "quality": q.get("quality", fq[0]), "bits": q.get("bits", fq[1]),
                      "running": name == cur, "default": name == dflt, "warm": warm,
                      "estimate_s": ctl.estimate(name, warm), "expert_slots": info.get("expert_slots")
                      or FALLBACK_SLOTS.get(name), "measured": measured(base) if name == base else measured(base),
                      "measured_from": base, **{k: v for k, v in info.items() if k != "expert_slots"}})
    return cards


def page_cache_note(warm: float | None) -> str:
    if warm is None:
        return "unknown"
    return "warm" if warm > 0.8 else "partly warm" if warm > 0.3 else "cold"


Path  # noqa: B018  (re-exported for callers)
