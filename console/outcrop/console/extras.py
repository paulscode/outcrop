"""Console API, part 2: logs, memory strata, energy, the benchmark lab, the playground, the preset editor, capture mode, and
Strata's own chat page.  Registered by app.create_app()."""
from __future__ import annotations

import asyncio
import contextlib
import difflib
import hashlib
import json
import os
import re
import secrets
import subprocess
import threading
import time
from pathlib import Path

import httpx
from fastapi import Body, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

from ..common import config, db, tokens
from .control import SP, units

# Strata's own page keeps its preferences in localStorage, which its sandbox (an opaque origin) does not have.  The
# console serves a stand-in for it: the page's preference keys are kept in the console's settings (dark until you flip
# it); anything else (the open chat, an API key) lives in memory for the visit, as it did before.
PAGE_KEYS = frozenset({"strata.theme", "strata.sampling", "strata.lang", "strata.sidebar"})
PAGE_STORE_JS = "web/__outcrop-storage.js"
PAGE_STORE = "web/__outcrop-storage"
PAGE_STORE_TEMPLATE = """// The console's stand-in for localStorage on Strata's page (its sandbox has none).
(function () {
  "use strict";
  var data = Object.create(null), seed = __SEED__, KEYS = __KEYS__, timer = null;
  Object.keys(seed).forEach(function (k) { data[k] = seed[k]; });
  try { if (window.localStorage) return; } catch (e) { /* blocked: the stand-in is needed */ }
  function save() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var out = {};
      KEYS.forEach(function (k) { if (k in data) out[k] = data[k]; });
      fetch("web/__outcrop-storage", {method: "POST", headers: {"Content-Type": "application/json"},
                                      body: JSON.stringify(out), keepalive: true}).catch(function () {});
    }, 250);
  }
  var kept = function (k) { return KEYS.indexOf(k) >= 0; };
  var store = {
    getItem: function (k) { k = String(k); return k in data ? data[k] : null; },
    setItem: function (k, v) { k = String(k); data[k] = String(v); if (kept(k)) save(); },
    removeItem: function (k) { k = String(k); if (k in data) { delete data[k]; if (kept(k)) save(); } },
    clear: function () { data = Object.create(null); save(); },
    key: function (i) { var ks = Object.keys(data); return i < ks.length ? ks[i] : null; },
    get length() { return Object.keys(data).length; }
  };
  try { Object.defineProperty(window, "localStorage", {value: store, configurable: true}); } catch (e) { /* ignore */ }
})();
"""


async def _close_both(resp, client) -> None:
    with contextlib.suppress(Exception):
        await resp.aclose()
    with contextlib.suppress(Exception):
        await client.aclose()


def _js_json(v) -> str:
    """JSON that is safe inside a script: no </script>, no line separators."""
    return (json.dumps(v).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
            .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))


SOURCES = {"strata": None, "gateway": "outcrop-gateway.service", "console": "outcrop-console.service",
           "bridge": "outcrop-ollama-bridge.service", "engine": None}
LEVEL_ERR = re.compile(r"\b(error|failed|traceback|exception|fatal)\b", re.I)
LEVEL_WARN = re.compile(r"\b(warn(ing)?|refused|denied|slow)\b", re.I)


def level_of(msg: str) -> str:
    return "error" if LEVEL_ERR.search(msg) else "warn" if LEVEL_WARN.search(msg) else "info"


def tail_file(path: Path, lines: int) -> list[str]:
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            block = min(size, max(65536, lines * 300))
            f.seek(size - block)
            data = f.read().decode("utf-8", "replace")
        return data.splitlines()[-lines:]
    except OSError:
        return []


class Logs:
    """Recent lines on request; a live tail while someone watches the Logs page."""

    def __init__(self, h):
        self.h = h
        self.task: asyncio.Task | None = None
        self.proc = None

    def unit_for(self, source: str) -> str | None:
        if source == "strata":
            cur = self.h.ctl.current() or self.h.ctl.default()
            return f"outcrop-engine@{cur}.service" if cur else None
        return SOURCES.get(source)

    def engine_log(self) -> Path:
        cur = self.h.ctl.current() or self.h.ctl.default() or "quality"
        return config.OUTCROP_HOME / "logs" / f"engine-{cur}.log"

    def dev_file(self, source: str) -> Path | None:
        d = self.h.ctx.opts.log_dir
        if not d:
            return None
        return Path(d) / {"engine": "strata.log"}.get(source, f"{source}.log")

    def recent(self, source: str, lines: int, q: str | None) -> list[dict]:
        out = []
        dev = self.dev_file(source)
        if dev is not None:
            for ln in tail_file(dev, lines * 3 if q else lines):
                out.append({"t": None, "msg": ln, "level": level_of(ln)})
        elif source == "engine":
            for ln in tail_file(self.engine_log(), lines * 3 if q else lines):
                out.append({"t": None, "msg": ln, "level": level_of(ln)})
        else:
            unit = self.unit_for(source)
            if unit:
                for t, msg in units.journal(unit, lines=lines * 3 if q else lines):
                    out.append({"t": t, "msg": msg, "level": level_of(msg)})
        if q:
            ql = q.lower()
            out = [x for x in out if ql in x["msg"].lower()]
        return out[-lines:]

    async def run(self) -> None:
        """Follow the journal of every LLM unit and the engine log while a browser is subscribed to `logs`."""
        live = self.h.live
        while True:
            watching = any("logs" in c.topics for c in live.clients)
            if watching and self.task is None:
                self.task = asyncio.create_task(self._follow())
            elif not watching and self.task is not None:
                self.task.cancel()
                self.task = None
            await asyncio.sleep(2.0)

    async def _follow(self) -> None:
        live = self.h.live
        tasks = []
        try:
            if self.h.ctx.opts.log_dir:
                for src in ("strata", "gateway", "console", "bridge"):
                    tasks.append(asyncio.create_task(self._follow_file(src, self.dev_file(src))))
            else:
                tasks.append(asyncio.create_task(self._follow_journal()))
                tasks.append(asyncio.create_task(self._follow_file("engine", None)))
            await asyncio.gather(*tasks)
        finally:
            for t in tasks:
                t.cancel()
            if self.proc is not None:
                proc, self.proc = self.proc, None
                with contextlib.suppress(ProcessLookupError):
                    proc.terminate()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(proc.wait(), 5)          # reaped, its pipe closed
        del live

    async def _follow_journal(self) -> None:
        """journalctl -f, started again if it ends (a journald restart, a rotation)."""
        while True:
            await self._follow_journal_once()
            await asyncio.sleep(2.0)

    async def _follow_journal_once(self) -> None:
        self.proc = await asyncio.create_subprocess_exec(
            *units.follow_cmd(["outcrop-engine@*", "outcrop-gateway.service", "outcrop-console.service",
                               "outcrop-ollama-bridge.service"], message_only=True),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        assert self.proc.stdout is not None
        while True:
            ln = await self.proc.stdout.readline()
            if not ln:
                return
            s = ln.decode("utf-8", "replace").rstrip()
            t, _, rest = s.partition(" ")
            head, _, msg = rest.partition(": ")
            src = ("strata" if "outcrop-serve" in head or "outcrop-engine" in head else "gateway" if "gateway" in head else
                   "console" if "console" in head else "bridge" if "bridge" in head else "strata")
            with contextlib.suppress(ValueError):
                self.h.live.publish("logs", {"source": src, "t": float(t), "msg": msg, "level": level_of(msg)}, keep=False)

    async def _follow_file(self, source: str, path: Path | None) -> None:
        pos = None
        cur_path = path
        while True:
            p = path or self.engine_log()
            if p != cur_path:
                cur_path, pos = p, None
            try:
                size = p.stat().st_size
                if pos is None or size < pos:
                    pos = size
                elif size > pos:
                    with open(p, "rb") as f:
                        f.seek(pos)
                        data = f.read(min(size - pos, 1 << 20))
                    pos += len(data)
                    for ln in data.decode("utf-8", "replace").splitlines():
                        if ln.strip():
                            self.h.live.publish("logs", {"source": source, "t": time.time(), "msg": ln,
                                                         "level": level_of(ln)}, keep=False)
            except OSError:
                pass
            await asyncio.sleep(0.5)


# ------------------------------------------------------------------------------------------------------------ memory

VRAM_RES = [("mtp", re.compile(r"draft layer loaded, ([\d.]+) MiB of VRAM")),
            ("dense", re.compile(r"native projection matrices, ([\d.]+) MiB of weights")),
            ("experts", re.compile(r"expert cache (\d+) slots, ([\d.]+) GiB of VRAM")),
            ("verify", re.compile(r"window up to \d+ tokens, ([\d.]+) MiB of device buffers")),
            ("draft_head", re.compile(r"draft head over \d+ tokens \(([\d.]+) MiB\)")),
            ("free", re.compile(r"([\d.]+) MiB of VRAM free with everything loaded")),
            ("ngram", re.compile(r"the table is ([\d.]+) GiB")),
            ("arena", re.compile(r"loaded ([\d.]+) GiB at [\d.]+ GiB/s"))]


def engine_start_facts(path: Path) -> dict:
    """The newest start's memory figures from the engine log."""
    lines = tail_file(path, 4000)
    start = 0
    for i, ln in enumerate(lines):
        if "engine started:" in ln or "starting the engine" in ln:
            start = i
    facts: dict = {}
    for ln in lines[start:]:
        for key, rx in VRAM_RES:
            m = rx.search(ln)
            if m:
                if key == "experts":
                    facts["experts_slots"] = int(m.group(1))
                    facts["experts_mib"] = float(m.group(2)) * 1024
                else:
                    facts[key] = float(m.group(1))
    return facts


def memory(h) -> dict:
    live = h.live
    e = (live.engine or {}).get("engine") or {}
    cc = (live.engine or {}).get("conversation_cache") or {}
    s = live.history[-1] if live.history else {}
    g = s.get("gpu") or {}
    facts = engine_start_facts(Logs(h).engine_log()) if not h.ctl.fake else {
        "mtp": 906, "dense": 2948.4, "experts_mib": 16138, "experts_slots": 8310, "verify": 111, "draft_head": 105.1,
        "free": 771, "ngram": 26.8, "arena": 46.84}
    # the card's size as the driver reports it; unknown (0) leaves the column as tall as its layers, rather than guessing
    total = g.get("mem_total") or live.gpu_static.get("vram_total_mib") or 0
    used = g.get("mem_used") or (total - (e.get("vram_free_mib") or facts.get("free") or 0))
    experts = e.get("expert_cache_mib") or facts.get("experts_mib") or 0
    dense = facts.get("dense") or 0
    mtp = (facts.get("mtp") or 0) + (facts.get("draft_head") or 0)
    others = sum(p.get("mem") or 0 for p in g.get("procs") or [] if "strata" not in (p.get("name") or ""))
    free = max(0.0, total - used)
    rest = max(0.0, used - experts - dense - mtp - others)
    slots = e.get("expert_slots") or facts.get("experts_slots")
    vram = [{"key": "experts", "label": "Expert cache", "mib": round(experts),
             "note": f"{slots:,} experts kept on the card" if slots else "the experts kept on the card"},
            {"key": "dense", "label": "Dense weights", "mib": round(dense), "note": "attention and shared layers, every token"},
            {"key": "kv", "label": "KV window and buffers", "mib": round(rest),
             "note": f"the newest {e.get('kv_resident') or 32768:,} context cells, prompt and verify buffers"},
            {"key": "mtp", "label": "MTP drafter", "mib": round(mtp), "note": "guesses the next tokens to check in one pass"},
            {"key": "other", "label": "Other processes", "mib": round(others), "note": "anything else on the GPU"},
            {"key": "free", "label": "Free", "mib": round(free), "note": "below 512 MiB the driver can start paging"}]
    mi = {}
    with contextlib.suppress(OSError):
        for ln in Path("/proc/meminfo").read_text().splitlines():
            k, _, v = ln.partition(":")
            mi[k] = int(v.split()[0]) / (1 << 20)
    gib_total = mi.get("MemTotal", 0)
    arena = (e.get("arena_mib") or 0) / 1024 or facts.get("arena") or 0
    convcache = (cc.get("bytes") or 0) / (1 << 30)
    ngram = facts.get("ngram") or 0
    cache = mi.get("Cached", 0) + mi.get("Buffers", 0)
    nonfree = max(0.0, gib_total - mi.get("MemFree", 0) - cache)
    # each layer is clamped to what it can hold, so the layers always add up to the RAM there is
    arena = min(arena, nonfree)
    convcache = min(convcache, nonfree - arena)
    ngram = min(ngram, cache)                      # file-backed and locked: counted in the page cache
    other = max(0.0, nonfree - arena - convcache)
    ram = [{"key": "arena", "label": "Expert arena", "gib": round(arena, 1), "note": "every expert, pinned for the GPU to fetch"},
           {"key": "ngram", "label": "n-gram table", "gib": round(ngram, 1), "note": "per-layer embeddings, read each token"},
           {"key": "convcache", "label": "Conversation cache", "gib": round(convcache, 1),
            "note": f"{cc.get('parked') or 0} of {cc.get('slots') or 16} recent conversations parked"},
           {"key": "pagecache", "label": "Page cache", "gib": round(max(0.0, cache - ngram), 1),
            "note": "model files kept in RAM, so a switch need not read the disk"},
           {"key": "other", "label": "Everything else", "gib": round(other, 1), "note": "the system, the console, other programs"},
           {"key": "free", "label": "Free", "gib": round(mi.get("MemFree", 0), 1), "note": "unused"}]
    unified = live.gpu_static.get("memory") == "unified"
    if unified:
        # One memory for the CPU and the GPU (a GB10): the GPU's layers are part of the "used" RAM, not a card of their
        # own.  The engine's KV cache and buffers are not reported separately, so they stay in "everything else".
        # Clamped like the other layers: together they hold at most the used RAM the conversation cache leaves.
        room = max(0.0, nonfree - convcache)
        gpu = []
        for lr in vram:
            if lr["key"] in ("experts", "dense", "mtp"):
                gib = min(lr["mib"] / 1024, room)
                room -= gib
                gpu.append({k: v for k, v in lr.items() if k != "mib"} | {"gib": round(gib, 1)})
        for lr in gpu:
            lr["note"] = lr["note"].replace("kept on the card", "kept in the GPU's share")
        for lr in ram:
            if lr["key"] == "other":
                lr["gib"] = round(room, 1)
                lr["note"] = "the engine's KV cache and buffers, the system, the console, other programs"
        ram = gpu + [lr for lr in ram if lr["key"] != "arena"]
        vram = []
    return {"unified": unified,
            "vram": {"total_mib": 0 if unified else round(total), "layers": vram},
            "ram": {"total_gib": round(gib_total, 1), "layers": ram},
            "conversation_cache": {"slots": cc.get("slots"), "budget_gib": round((cc.get("budget_mib") or 0) / 1024, 1),
                                   "parked": cc.get("parked"), "bytes": cc.get("bytes"), "requests": cc.get("requests"),
                                   "requests_reused": cc.get("requests_reused"), "reused_tokens": cc.get("reused_tokens"),
                                   "last_event": cc.get("last_event"), "last_at": cc.get("last_at"),
                                   "recent": recent_reuse(h.ctx.con())}}


RECENT_REUSE_N = 500


def recent_reuse(con, n: int = RECENT_REUSE_N) -> dict:
    """Prompt reuse over the gateway's last `n` requests that had a prompt, from its own log.  Strata's counters mix
    windows (its request counts cover its last 500, its token counts everything since it started), so the card's
    headline comes from here, where both cover the same requests."""
    r = con.execute("SELECT count(*), coalesce(sum(prompt_tokens), 0), coalesce(sum(min(coalesce(reused_tokens, 0), "
                    "prompt_tokens)), 0), coalesce(sum(reused_tokens > 0), 0) FROM (SELECT prompt_tokens, reused_tokens "
                    "FROM requests WHERE prompt_tokens > 0 ORDER BY started_at DESC LIMIT ?)", (n,)).fetchone()
    return {"requests": r[0], "prompt_tokens": r[1], "reused_tokens": r[2], "requests_reused": r[3]}


# ------------------------------------------------------------------------------------------------------------ energy

def energy(h, days: int) -> dict:
    con = h.ctx.con()
    since = time.time() - days * 86400
    per_day: dict[str, dict] = {}
    for r in con.execute("SELECT ts, data FROM metrics_1h WHERE ts >= ? ORDER BY ts", (since,)):
        d = json.loads(r["data"])
        p = d.get("gpu.power")
        if p is None:
            continue
        day = time.strftime("%Y-%m-%d", time.localtime(r["ts"]))
        per_day.setdefault(day, {"wh": 0.0})["wh"] += p          # one hour at that average
    # the current hour from the live samples
    if h.live.history:
        today = time.strftime("%Y-%m-%d")
        hour0 = time.time() // 3600 * 3600
        pts = [s for s in h.live.history if s["t"] >= hour0 and (s.get("gpu") or {}).get("power") is not None]
        if pts:
            per_day.setdefault(today, {"wh": 0.0})["wh"] += sum(s["gpu"]["power"] for s in pts) / 3600.0
    for r in con.execute("SELECT day, sum(requests) n, sum(output_tokens) o FROM usage_daily WHERE day >= ? GROUP BY day",
                         (time.strftime("%Y-%m-%d", time.localtime(since)),)):
        per_day.setdefault(r["day"], {"wh": None}).update(requests=r["n"], output_tokens=r["o"])
    price = db.get_setting(con, "energy.price", None)
    rows = []
    for day in sorted(per_day):
        d = per_day[day]
        kwh = round(d["wh"] / 1000.0, 3) if d.get("wh") is not None else None
        out = d.get("output_tokens") or 0
        rows.append({"day": day, "kwh": kwh, "requests": d.get("requests") or 0, "output_tokens": out,
                     "tokens_per_joule": round(out / (kwh * 3.6e6), 4) if kwh else None,
                     "cost": round(kwh * price, 3) if kwh is not None and price else None})
    today = rows[-1] if rows and rows[-1]["day"] == time.strftime("%Y-%m-%d") else None
    return {"days": rows, "today": today, "price_per_kwh": price,
            "note": "GPU only: NVML power, integrated over time. The VM cannot read the CPU's power."}


# ------------------------------------------------------------------------------------------------------------- bench

class Bench:
    KINDS = {"quickbench", "validate", "qualgate", "apitest"}

    def __init__(self, h):
        self.h = h
        self.cur: dict | None = None
        self.lock = threading.Lock()

    def local_token(self) -> str | None:
        return config.read_secret(config.LOCAL_TOKEN_FILE)

    def cmds(self, kind: str, cases: str, repeat: int, json_out: Path) -> list[list[str]]:
        b = config.PROJECT / "bench"
        url = self.h.gateway_url
        key: list[str] = []                    # the scripts read $OUTCROP_API_KEY (set below): never on the command line
        qb = ["python3", str(b / "quickbench.py"), "--url", url, *key, "--repeat", str(repeat), "--cases", cases,
              "--json", str(json_out)]
        port = url.rsplit(":", 1)[-1]
        api = ["python3", str(b / "apitest.py"), "--host", "127.0.0.1", "--port", port, "--ollama-port",
               str(self.h.gateway_ollama_port), "--fast", *key]
        qg = ["python3", str(b / "qualgate.py"), "--url", url, *key]
        return {"quickbench": [qb], "qualgate": [qg], "apitest": [api], "validate": [qg, api, qb]}[kind]

    def start(self, kind: str, cases: str, repeat: int, by: str) -> int:
        if kind not in self.KINDS:
            raise HTTPException(400, f"kind is one of {', '.join(sorted(self.KINDS))}")
        if not re.fullmatch(r"[a-z0-9,]+", cases or "") or not 1 <= repeat <= 10:
            raise HTTPException(400, "cases like chat,code,story,doc4k; repeat 1 to 10")
        with self.lock:
            if self.cur:
                raise HTTPException(409, "a benchmark is already running (one at a time: they share the GPU)")
            con = self.h.ctx.con()
            preset = self.h.ctl.current()
            rid = con.execute("INSERT INTO bench_runs(started_at, kind, preset, args, status) VALUES(?,?,?,?,?)",
                              (time.time(), kind, preset, json.dumps({"cases": cases, "repeat": repeat, "by": by}),
                               "running")).lastrowid
            self.cur = {"id": rid, "proc": None, "cancel": False, "contention": False, "lines": []}
        db.add_event(self.h.ctx.con(), "bench.start", f"{kind} started on {preset}", actor=by, details={"run": rid})
        threading.Thread(target=self._run, args=(rid, kind, cases, repeat), daemon=True).start()
        return rid

    def _emit(self, payload: dict) -> None:
        loop = self.h.loop
        if loop and not loop.is_closed():
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(self.h.live.publish, "bench", payload, False)

    def _run(self, rid: int, kind: str, cases: str, repeat: int) -> None:
        log_lines: list[str] = self.cur["lines"]          # readable while it runs (GET /api/bench/runs/{id})
        out_json = config.STATE / f"bench-{rid}.json"
        status, result = "ok", {}
        t0 = time.time()
        try:
            for cmd in self.cmds(kind, cases, repeat, out_json):
                if self.cur["cancel"]:
                    status = "cancelled"
                    break
                shown = " ".join("…" if (i > 0 and cmd[i - 1] == "--key") else x for i, x in enumerate(cmd))
                log_lines.append(f"$ {shown}")
                self._emit({"id": rid, "line": log_lines[-1]})
                env = dict(os.environ)
                tok = self.local_token()
                if tok:
                    env["OUTCROP_API_KEY"] = tok
                p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
                                     cwd=str(config.PROJECT / "bench"), env=env)
                self.cur["proc"] = p
                assert p.stdout is not None
                for ln in p.stdout:
                    ln = ln.rstrip("\n")
                    log_lines.append(ln)
                    self._emit({"id": rid, "line": ln})
                    procs = ((self.h.live.history[-1] if self.h.live.history else {}).get("gpu") or {}).get("procs") or []
                    if any("strata" not in (x.get("name") or "") for x in procs):
                        self.cur["contention"] = True
                p.wait()
                if self.cur["cancel"]:
                    status = "cancelled"
                    break
                m = re.search(r"(\d+) of (\d+) passed", "\n".join(log_lines[-5:]))
                if m:
                    result.setdefault("checks", []).append({"cmd": Path(cmd[1]).stem, "passed": int(m.group(1)),
                                                            "total": int(m.group(2))})
                if p.returncode != 0:
                    status = "failed"
            if out_json.exists():
                result["speed"] = summarize_quickbench(json.loads(out_json.read_text()))
                out_json.unlink()
        except Exception as e:
            status = "failed"
            log_lines.append(f"error: {e}")
        finally:
            con = self.h.ctx.con()
            con.execute("UPDATE bench_runs SET ended_at=?, status=?, result=?, log=?, contention=? WHERE id=?",
                        (time.time(), status, json.dumps(result), "\n".join(log_lines)[-200000:],
                         int(self.cur["contention"]), rid))
            db.add_event(con, "bench.end", f"{kind} {status} after {time.time() - t0:.0f} s", actor="console",
                         level="info" if status == "ok" else "warn", details={"run": rid, "result": result})
            self._emit({"id": rid, "status": status, "result": result})
            if time.time() - t0 > 60:
                with contextlib.suppress(Exception):
                    self.h.alerts.job_done(f"benchmark {kind} {status} ({time.time() - t0:.0f} s)", {"run": rid})
            self.cur = None

    def cancel(self, rid: int) -> bool:
        cur = self.cur
        if not cur or cur["id"] != rid:
            return False
        cur["cancel"] = True
        if cur["proc"] is not None:
            with contextlib.suppress(ProcessLookupError):
                cur["proc"].terminate()
        return True

    def import_results(self) -> int:
        """bench/results/*.json in quickbench's format, as history (once each)."""
        con = self.h.ctx.con()
        have = {r["source"] for r in con.execute("SELECT source FROM bench_runs WHERE source IS NOT NULL")}
        n = 0
        for f in sorted(config.BENCH_RESULTS.glob("*.json")):
            src = f"bench/results/{f.name}"
            if src in have:
                continue
            try:
                d = json.loads(f.read_text())
                speed = summarize_quickbench(d)
            except (OSError, ValueError, KeyError, TypeError):
                continue
            if not speed:
                continue
            m = re.match(r"validate-(.+)\.json", f.name) or re.match(r"ab-[^-]+-[^-]+-(.+)-r\d+\.json", f.name)
            con.execute("INSERT INTO bench_runs(started_at, ended_at, kind, preset, args, status, result, source) "
                        "VALUES(?,?,?,?,?,?,?,?)", (f.stat().st_mtime, f.stat().st_mtime, "import",
                                                    m.group(1) if m else None, "{}", "ok", json.dumps({"speed": speed}), src))
            n += 1
        return n


def summarize_quickbench(d: dict) -> dict:
    import statistics
    out = {}
    for case, runs in d.items():
        if isinstance(runs, list) and runs and isinstance(runs[0], dict) and "decode_tps" in runs[0]:
            out[case] = {"decode": round(statistics.median(r["decode_tps"] for r in runs), 1),
                         "prompt": round(statistics.median(r["prompt_tps"] for r in runs), 1),
                         "ttft": round(statistics.median(r["ttft_s"] for r in runs), 2),
                         "runs": [round(r["decode_tps"], 1) for r in runs]}
    return out


# ---------------------------------------------------------------------------------------------------- preset editor

def validate_presets(text: str) -> dict:
    errors: list[str] = []
    try:
        cfg = json.loads(text)
    except json.JSONDecodeError as e:
        return {"ok": False, "errors": [f"line {e.lineno}, column {e.colno}: {e.msg}"], "rendered": {}}
    if not isinstance(cfg, dict) or not isinstance(cfg.get("presets"), dict) or not cfg["presets"]:
        return {"ok": False, "errors": ["the file needs a \"presets\" object with at least one preset"], "rendered": {}}
    rendered = {}
    packs = set(SP.FULL_ARENA_GIB)
    # an allowlist: the engine's own switches and a few thread and device settings.  Anything else could make the
    # engine load a library (LD_*, CUDA_INJECTION64_PATH, OMP_TOOL_LIBRARIES, OPENSSL_CONF, GLIBC_TUNABLES ...)
    ok_env = re.compile(r"^(STRATA_[A-Z0-9_]{1,60}|CUDA_VISIBLE_DEVICES|CUDA_DEVICE_ORDER|CUDA_MODULE_LOADING|"
                        r"OMP_NUM_THREADS|OMP_PROC_BIND|OMP_PLACES|OMP_WAIT_POLICY|MKL_NUM_THREADS|OPENBLAS_NUM_THREADS)$")
    # engine flags with plain values: no paths (a path could point the engine at a file of anyone's choosing)
    ok_arg = re.compile(r"^(--?[a-z0-9][a-z0-9-]{0,48}(=[A-Za-z0-9._:,+-]{0,64})?|[A-Za-z0-9._:,+-]{1,64})$")

    def check_args(where: str, args) -> None:
        if args is None:
            return
        if not isinstance(args, list):
            errors.append(f"{where}: args must be a list")
            return
        for a in args:
            for tok in (a.split() if isinstance(a, str) else [str(a)]):
                if not ok_arg.match(tok):
                    errors.append(f"{where}: the engine argument {tok!r} is not allowed here (flags and plain values; "
                                  f"no paths)")

    def check_engine(where: str, eng) -> None:
        if eng is None:
            return
        if not isinstance(eng, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", eng):
            errors.append(f"{where}: engine is a file name in {SP.ENGINE_DIR} (no paths)")
        elif SP.ENGINE_DIR.is_dir() and not (SP.ENGINE_DIR / eng).is_file():
            errors.append(f"{where}: there is no engine {eng!r} in {SP.ENGINE_DIR}")

    def check_env(where: str, env) -> None:
        if env is None:
            return
        if not isinstance(env, dict):
            errors.append(f"{where}: env must be an object")
            return
        for k in env:
            if not ok_env.match(str(k)):
                errors.append(f"{where}: the variable {k!r} is not allowed (STRATA_* and thread or device settings "
                              f"only)")

    check_engine("engine", cfg.get("engine"))
    check_env("common.env", (cfg.get("common") or {}).get("env"))
    check_args("common.args", (cfg.get("common") or {}).get("args"))
    if SP.gpu_problem((cfg.get("common") or {}).get("gpu")):
        errors.append(f"common: {SP.gpu_problem((cfg.get('common') or {}).get('gpu'))}")
    if (cfg.get("server") or {}).get("private"):
        errors.append("server.private is for bench/ab.py's own server, not for the running presets")
    if (cfg.get("gateway") or {}).get("enabled") is False:
        errors.append("gateway.enabled false would put Strata itself on the LAN: change it with the command line, "
                      "not the editor")
    for name, p in cfg["presets"].items():
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,40}", name):
            errors.append(f"{name!r}: a preset name is lowercase letters, digits and dashes")
        if not isinstance(p, dict):
            errors.append(f"{name}: must be an object")
            continue
        check_engine(name, p.get("engine"))
        check_env(name, p.get("env"))
        check_args(name, p.get("args"))
        if p.get("pack") not in packs:
            errors.append(f"{name}: pack must be one of {', '.join(sorted(packs))}")
        try:
            ctx = int(p.get("context"))
            if not 4096 <= ctx <= 1048576:
                errors.append(f"{name}: context must be 4,096 to 1,048,576")
        except (TypeError, ValueError):
            errors.append(f"{name}: context must be a number")
        rope = p.get("rope")
        if rope is not None and (not isinstance(rope, dict) or rope.get("scaling") not in ("yarn", "linear") or
                                 not isinstance(rope.get("scale"), (int, float))):
            errors.append(f"{name}: rope is {{\"scaling\": \"yarn\", \"scale\": 4}}")
        for k in ("parallel", "max_tokens", "idle_unload_s"):
            if k in p and (not isinstance(p[k], int) or p[k] < 0):
                errors.append(f"{name}: {k} must be a whole number")
        if "resident_budget_gib" in p and (not isinstance(p["resident_budget_gib"], int) or p["resident_budget_gib"] < 1):
            errors.append(f"{name}: resident_budget_gib (GiB of experts kept in RAM in low-RAM mode on StartOS) must be "
                          "a whole number, 1 or more")
        if SP.gpu_problem(p.get("gpu")):
            errors.append(f"{name}: {SP.gpu_problem(p.get('gpu'))}")
        try:
            # not strict: the RAM a preset's conversation slots need is counted at its start, not against what the running
            # engine holds while the file is edited
            args, env, notes = SP.engine_args(SP.with_settings(p, SP.settings(cfg)), cfg.get("common", {}), strict=False)
            rendered[name] = {"args": args, "env": env, "notes": notes}
        except Exception as e:
            errors.append(f"{name}: {type(e).__name__}: {e}")
    st = cfg.get("settings")
    if st is not None and not isinstance(st, dict):
        errors.append("settings must be an object")
    for k, v in (st if isinstance(st, dict) else {}).items():
        if k not in SP.SETTINGS:
            errors.append(f"settings: there is no setting {k!r} (there are {', '.join(SP.SETTINGS)})")
        elif str(v) not in SP.SETTINGS[k]["values"]:
            errors.append(f"settings.{k} is one of {', '.join(SP.SETTINGS[k]['values'])}")
    for k in ("server", "gateway"):
        if k in cfg and not isinstance(cfg[k], dict):
            errors.append(f"{k} must be an object")
    g = cfg.get("gateway", {})
    s = cfg.get("server", {})
    if g.get("enabled") and str(s.get("host", "")) not in ("127.0.0.1", "::1", "localhost"):
        errors.append("with the gateway enabled, server.host must be 127.0.0.1 (Strata must not be reachable around it)")
    return {"ok": not errors, "errors": errors, "rendered": rendered}


# ------------------------------------------------------------------------------------------------------- registration

def register(app, h) -> None:
    ctx, _live = h.ctx, h.live
    logs = Logs(h)
    bench = Bench(h)
    h.bench = bench
    views: dict[str, tuple[str, float]] = {}            # Strata page keys: key -> (session hash, expiry)

    @app.get("/api/logs")
    def get_logs(source: str = "strata", lines: int = 300, q: str | None = None, s=Depends(h.session_dep)):
        if source not in SOURCES:
            raise HTTPException(400, f"source is one of {', '.join(SOURCES)}")
        return {"source": source, "lines": logs.recent(source, max(1, min(lines, 5000)), q)}

    @app.get("/api/memory")
    def get_memory(s=Depends(h.session_dep)):
        return memory(h)

    @app.get("/api/energy")
    def get_energy(days: int = 30, s=Depends(h.session_dep)):
        return energy(h, max(1, min(days, 730)))

    def engine_settings() -> dict:
        cfg = SP.load()
        cur = SP.settings(cfg)
        running = h.ctl.current()
        # does the running preset have them yet?  Its engine config (written at its start) against what they make it now
        pending = None
        if running and running in cfg.get("presets", {}):
            try:
                run = json.loads((SP.OUTCROP_HOME / "cfg" / f"{running}.json").read_text(encoding="utf-8"))
                want = SP.with_settings(cfg["presets"][running], cur)
                args = run.get("args") or []
                ctx_now = int(args[args.index("--max-context") + 1]) if "--max-context" in args else None
                skip_now = (run.get("env") or {}).get("STRATA_ROUTE_TAIL_SKIP")
                pending = ctx_now != int(want["context"]) or skip_now != want["env"].get("STRATA_ROUTE_TAIL_SKIP")
            except (OSError, ValueError, KeyError, IndexError):
                pending = None
        return {"settings": [{"key": k, "title": d["title"], "about": d["about"], "default": d["default"],
                              "value": cur[k], "values": [{"value": v, "label": lab} for v, lab in d["values"].items()]}
                             for k, d in SP.SETTINGS.items()],
                "running": running, "pending": pending}

    @app.get("/api/settings/engine")
    def get_engine_settings(s=Depends(h.session_dep)):
        return engine_settings()

    @app.put("/api/settings/engine")
    def put_engine_setting(request: Request, body: dict = Body(...), s=Depends(h.session_dep)):
        key, value = str(body.get("key") or ""), str(body.get("value") or "")
        before = SP.settings(SP.load())
        try:
            now = SP.set_setting(key, value)
        except (KeyError, ValueError) as e:
            raise HTTPException(400, e.args[0]) from None
        if now != before:
            db.add_event(ctx.con(), "settings.engine", f"setting {key} changed to {now[key]}", actor=s.username,
                         source=h.ip_of(request), details={"key": key, "from": before.get(key), "to": now[key]})
        return engine_settings()

    @app.put("/api/settings/energy")
    def set_energy(body: dict = Body(...), s=Depends(h.session_dep)):
        price = body.get("price_per_kwh")
        if price is not None:
            try:
                price = float(price)
                assert 0 <= price < 100
            except (TypeError, ValueError, AssertionError):
                raise HTTPException(400, "a price per kWh, like 0.15") from None
        db.set_setting(ctx.con(), "energy.price", price, by=s.username)
        return {"price_per_kwh": price}

    # ------------------------------------------------------------------------------------------------------ bench
    @app.get("/api/bench/runs")
    def bench_runs(limit: int = 100, s=Depends(h.session_dep)):
        rows = ctx.con().execute("SELECT id, started_at, ended_at, kind, preset, args, status, result, contention, source "
                                 "FROM bench_runs ORDER BY started_at DESC LIMIT ?", (min(limit, 500),)).fetchall()
        return [dict(r) | {"args": json.loads(r["args"] or "{}"), "result": json.loads(r["result"] or "{}")} for r in rows]

    @app.post("/api/bench/runs")
    def bench_start(body: dict = Body(...), s=Depends(h.session_dep)):
        rid = bench.start(str(body.get("kind") or ""), str(body.get("cases") or "chat,code,story,doc4k"),
                          int(body.get("repeat") or 3), s.username)
        return {"id": rid}

    @app.get("/api/bench/runs/{rid}")
    def bench_get(rid: int, s=Depends(h.session_dep)):
        r = ctx.con().execute("SELECT * FROM bench_runs WHERE id=?", (rid,)).fetchone()
        if r is None:
            raise HTTPException(404, "no such run")
        out = dict(r) | {"args": json.loads(r["args"] or "{}"), "result": json.loads(r["result"] or "{}")}
        cur = bench.cur
        if cur and cur["id"] == rid:
            out["log"] = "\n".join(cur["lines"])         # the lines so far, for a browser that opens the Lab mid-run
        return out

    @app.post("/api/bench/runs/{rid}/cancel")
    def bench_cancel(rid: int, s=Depends(h.session_dep)):
        if not bench.cancel(rid):
            raise HTTPException(409, "that run is not running")
        return {"ok": True}

    @app.post("/api/bench/import")
    def bench_import(s=Depends(h.session_dep)):
        return {"imported": bench.import_results()}

    # ------------------------------------------------------------------------------------------------- playground
    @app.post("/api/playground/chat")
    async def playground(request: Request, s=Depends(h.session_dep)):
        body = await request.body()
        if len(body) > 32 << 20:
            raise HTTPException(413, "too large")
        tok = await asyncio.to_thread(h.console_token)
        headers = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json",
                   "User-Agent": f"outcrop-console/{config.VERSION} (playground; {s.username})"}
        client = httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=None), trust_env=False)
        req = client.build_request("POST", h.gateway_url + "/v1/chat/completions", content=body, headers=headers)
        try:
            resp = await client.send(req, stream=True)
        except httpx.HTTPError as e:
            await client.aclose()
            return JSONResponse({"error": f"the gateway did not answer: {type(e).__name__}"}, status_code=502)

        async def gen():
            try:
                async for chunk in resp.aiter_raw():
                    yield chunk
            finally:
                await resp.aclose()
                await client.aclose()

        out_h = {"Cache-Control": "no-store", "X-Accel-Buffering": "no"}
        if resp.headers.get("x-request-id"):
            out_h["X-Request-Id"] = resp.headers["x-request-id"]
        return StreamingResponse(gen(), status_code=resp.status_code, headers=out_h,
                                 background=BackgroundTask(_close_both, resp, client),
                                 media_type=resp.headers.get("content-type", "application/json"))

    # ---------------------------------------------------------------------------------------------- preset editor
    def presets_current() -> None:
        """The console sees presets.json through a bind mount of the file: if something replaced the file instead of
        writing it in place, this is the old, deleted one.  Refuse rather than show stale text or save into a file
        nobody reads."""
        if os.stat(SP.PRESETS_FILE).st_nlink == 0:
            raise HTTPException(409, "presets.json was replaced on disk: restart the console to see the new file "
                                     "(sudo systemctl restart outcrop-console)")

    @app.get("/api/presets/raw")
    def presets_raw(s=Depends(h.session_dep)):
        presets_current()
        text = SP.PRESETS_FILE.read_text(encoding="utf-8")
        return {"text": text, "hash": hashlib.sha256(text.encode()).hexdigest(), "path": str(SP.PRESETS_FILE)}

    @app.post("/api/presets/validate")
    def presets_validate(body: dict = Body(...), s=Depends(h.session_dep)):
        text = str(body.get("text") or "")
        cur = SP.PRESETS_FILE.read_text(encoding="utf-8")
        v = validate_presets(text)
        v["diff"] = "".join(difflib.unified_diff(cur.splitlines(True), text.splitlines(True), "presets.json (now)",
                                                 "presets.json (edited)"))
        return v

    @app.put("/api/presets/raw")
    def presets_put(request: Request, body: dict = Body(...), s=Depends(h.session_dep)):
        h.need_reauth(s)
        presets_current()
        text = str(body.get("text") or "")
        cur = SP.PRESETS_FILE.read_text(encoding="utf-8")
        if hashlib.sha256(cur.encode()).hexdigest() != body.get("hash"):
            raise HTTPException(409, "presets.json changed since you opened it; reload it and edit again")
        v = validate_presets(text)
        if not v["ok"]:
            raise HTTPException(400, "; ".join(v["errors"]))
        backup = config.STATE / f"presets-backup-{time.strftime('%Y%m%d-%H%M%S')}.json"
        for old in sorted(config.STATE.glob("presets-backup-*.json"))[:-29]:     # the last 30 are kept
            with contextlib.suppress(OSError):
                old.unlink()
        config.write_secret(backup, cur)
        with open(SP.PRESETS_FILE, "r+", encoding="utf-8") as f:   # in place: the file is a bind mount in the sandbox
            f.seek(0)
            f.write(text if text.endswith("\n") else text + "\n")
            f.truncate()
        diff = "".join(difflib.unified_diff(cur.splitlines(True), text.splitlines(True)))
        db.add_event(ctx.con(), "presets.edit", "presets.json edited in the console", actor=s.username,
                     source=h.ip_of(request), level="warn", details={"backup": backup.name, "diff": diff[:20000]})
        new = SP.PRESETS_FILE.read_text(encoding="utf-8")
        return {"ok": True, "hash": hashlib.sha256(new.encode()).hexdigest(), "backup": backup.name,
                "note": "`Restart` on the Presets page applies it to the running preset"}

    # -------------------------------------------------------------------------------------------------- capture
    @app.get("/api/capture")
    def get_capture(s=Depends(h.session_dep)):
        c = db.get_setting(ctx.con(), "capture")
        n = 0
        if c.get("started_at"):
            n = ctx.con().execute("SELECT count(*) FROM request_bodies WHERE created_at >= ?",
                                  (c["started_at"],)).fetchone()[0]
        on = bool(c.get("enabled")) and (not c.get("until") or c["until"] > time.time()) and \
            (not c.get("max_requests") or n < c["max_requests"])
        return {**c, "enabled": on, "count": n}

    @app.put("/api/capture")
    def put_capture(request: Request, body: dict = Body(...), s=Depends(h.session_dep)):
        on = bool(body.get("enabled"))
        if on:
            h.need_reauth(s)                              # it keeps prompts and answers
            minutes = float(body.get("minutes") or 60)
            if not 1 <= minutes <= 7 * 1440:
                raise HTTPException(400, "capture for 1 minute to 7 days")
            mx = body.get("max_requests")
            tid = body.get("token_id")
            if tid and tokens.get(ctx.con(), tid) is None:
                raise HTTPException(400, "no such token")
            c = {"enabled": True, "until": time.time() + minutes * 60, "token_id": tid or None,
                 "max_requests": int(mx) if mx else None, "started_at": time.time(), "by": s.username}
            what = "requests" + (f" from token {tid}" if tid else "") + (f", the next {mx}" if mx else "")
            db.set_setting(ctx.con(), "capture", c, by=s.username)
            db.add_event(ctx.con(), "capture.on", f"capturing the bodies of {what} for {minutes:.0f} min",
                         actor=s.username, source=h.ip_of(request), level="warn", details=c)
        else:
            c = {"enabled": False}
            db.set_setting(ctx.con(), "capture", c, by=s.username)
            db.add_event(ctx.con(), "capture.off", "capture turned off", actor=s.username, source=h.ip_of(request))
        h.poke()
        return get_capture(s)

    # -------------------------------------------------------------------------------- Strata's own chat page
    @app.get("/api/strata-view")
    def strata_view(s=Depends(h.session_dep)):
        now = time.time()
        for k in [k for k, v in views.items() if v[1] < now]:
            views.pop(k, None)
        key = secrets.token_urlsafe(24)
        views[key] = (s.id_hash, now + 12 * 3600)
        return {"url": f"/strata/{key}/"}

    async def strata_proxy(key: str, path: str, request: Request):
        v = views.get(key)
        if v is None or v[1] < time.time():
            return Response("This view has expired: reopen it from the console.", status_code=403,
                            media_type="text/plain")
        ok = await asyncio.to_thread(lambda: ctx.con().execute("SELECT 1 FROM sessions WHERE id_hash=? AND expires_at>?",
                                                               (v[0], time.time())).fetchone() is not None)
        if not ok:
            views.pop(key, None)
            return Response("Signed out.", status_code=403, media_type="text/plain")
        if path in (PAGE_STORE_JS, PAGE_STORE):
            return await page_store(path, request)
        url = ctx.strata_url + "/" + path + (("?" + request.url.query) if request.url.query else "")
        body = await request.body() if request.method == "POST" else None
        if body:
            # the same checks as the gateway's: this goes to Strata with its internal key, around the gateway (no
            # engine-side tools; pictures as data, never a file path or a link Strata would fetch itself)
            from ..gateway.bodies import Refused, inspect
            try:
                body = (await asyncio.to_thread(inspect, body, False, False)).body
            except Refused as e:
                return JSONResponse({"error": {"message": str(e)}}, status_code=e.status,
                                    headers={"Access-Control-Allow-Origin": "null", "Cache-Control": "no-store"})
        fwd = {k: v for k, v in request.headers.items() if k.lower() in ("content-type", "accept", "accept-language")}
        fwd.update(ctx.strata_headers())
        client = httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=None), trust_env=False)
        try:
            resp = await client.send(client.build_request(request.method, url, content=body, headers=fwd), stream=True)
        except httpx.HTTPError:
            await client.aclose()
            return Response("Strata is not answering.", status_code=502, media_type="text/plain")

        # An opaque-origin sandbox: the page runs its scripts but cannot reach the console's cookie or API.  Its own files
        # are fetched from that opaque origin, so they must allow being loaded cross-origin (the key in the URL is the access).
        # Its own files only: no remote images, scripts or connections, so an answer it renders can't send the chat
        # anywhere (a markdown image pointing at another site, say).  The page has an inline script (the theme).
        hdrs = {"Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; "
                                           "default-src 'self'; script-src 'self' 'unsafe-inline'; "
                                           "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
                                           "media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
                                           "worker-src 'self' blob:; frame-src 'none'; frame-ancestors 'self'; "
                                           "form-action 'self'; base-uri 'none'",
                "X-Frame-Options": "SAMEORIGIN", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "null",
                "Cross-Origin-Resource-Policy": "cross-origin"}
        ctype = resp.headers.get("content-type", "application/octet-stream")
        if request.method == "GET" and resp.status_code == 200 and path in ("", "web/app.js"):
            # SVG <use> cannot reference another document from an opaque origin: put the icon sprite in the page instead
            try:
                body = await resp.aread()
            finally:
                await resp.aclose()
                await client.aclose()
            text = body.decode("utf-8", "replace")
            if path == "":
                # the page's preferences (theme, sampling, language) are kept by the console: its storage is blocked
                # in the sandbox.  The stand-in loads before the page's own scripts; the theme is set before first paint.
                theme = (await asyncio.to_thread(page_prefs)).get("strata.theme")
                theme = theme if theme in ("dark", "light") else "dark"
                text = re.sub(r'(<html[^>]*?)\sdata-theme="[a-z]*"', r"\1", text, count=1)
                text = re.sub(r"<html", f'<html data-theme="{theme}"', text, count=1)
                tag = f'<script src="{PAGE_STORE_JS}"></script>'
                text, n = re.subn(r"(<head[^>]*>)", lambda m: m.group(1) + tag, text, count=1)
                if not n:
                    text = re.sub(r"(<!doctype[^>]*>|^)", lambda m: m.group(1) + tag, text, count=1, flags=re.I)
                sprite = await sprite_svg()
                text = text.replace('href="web/sprite.svg#', 'href="#')
                if sprite:
                    text = re.sub(r"(<body[^>]*>)", lambda m: m.group(1) + '<div hidden aria-hidden="true">' + sprite + "</div>",
                                  text, count=1)
            else:
                text = text.replace('const SPRITE = "web/sprite.svg";', 'const SPRITE = "";')
            return Response(text.encode(), status_code=200, headers=hdrs, media_type=ctype)

        async def gen():
            try:
                async for chunk in resp.aiter_raw():
                    yield chunk
            finally:
                await resp.aclose()
                await client.aclose()

        # closed by the generator, or (a browser gone before the first chunk never starts it) after the response
        return StreamingResponse(gen(), status_code=resp.status_code, headers=hdrs, media_type=ctype,
                                 background=BackgroundTask(_close_both, resp, client))

    def page_prefs() -> dict:
        d = db.get_setting(ctx.con(), "strata_page.prefs", {}) or {}
        return {k: v for k, v in d.items() if k in PAGE_KEYS and isinstance(v, str)}

    async def page_store(path: str, request: Request) -> Response:
        hdrs = {"Cache-Control": "no-store", "Access-Control-Allow-Origin": "null",
                "Cross-Origin-Resource-Policy": "cross-origin"}
        if path == PAGE_STORE_JS:
            if request.method != "GET":
                return Response(status_code=405)
            seed = {"strata.theme": "dark", **(await asyncio.to_thread(page_prefs))}
            js = PAGE_STORE_TEMPLATE.replace("__SEED__", _js_json(seed)).replace("__KEYS__", _js_json(sorted(PAGE_KEYS)))
            return Response(js, headers=hdrs, media_type="text/javascript")
        if request.method != "POST":
            return Response(status_code=405)
        raw = await request.body()
        try:
            got = json.loads(raw) if len(raw) <= 64 * 1024 else None
        except ValueError:
            got = None
        if not isinstance(got, dict):
            return Response("send a JSON object", status_code=400, headers=hdrs, media_type="text/plain")
        keep = {k: v for k, v in got.items() if k in PAGE_KEYS and isinstance(v, str) and len(v) <= 16 * 1024}
        if keep.get("strata.theme") not in (None, "dark", "light"):
            keep.pop("strata.theme")
        await asyncio.to_thread(lambda: db.set_setting(ctx.con(), "strata_page.prefs", keep, by="strata page"))
        return Response(status_code=204, headers=hdrs)

    sprite_cache: dict = {}

    async def sprite_svg() -> str:
        if "svg" in sprite_cache and time.time() - sprite_cache["at"] < 3600:
            return sprite_cache["svg"]
        try:
            r = await ctx.client.get(ctx.strata_url + "/web/sprite.svg", headers=ctx.strata_headers(), timeout=5)
            svg = r.text if r.status_code == 200 else ""
        except httpx.HTTPError:
            svg = ""
        svg = re.sub(r"<\?xml[^>]*>", "", svg).strip()
        sprite_cache.update(svg=svg, at=time.time())
        return svg

    @app.api_route("/strata/{key}/{path:path}", methods=["GET", "POST", "OPTIONS"])
    async def strata_page(key: str, path: str, request: Request):
        if request.method == "OPTIONS":
            return Response(status_code=204, headers={"Access-Control-Allow-Origin": "null",
                                                      "Access-Control-Allow-Methods": "GET, POST",
                                                      "Access-Control-Allow-Headers": "content-type, authorization"})
        return await strata_proxy(key, path, request)

    @app.get("/api/backup")
    def get_backup(request: Request, secrets: int = 0, chats: int = 1, s=Depends(h.session_dep)):
        h.need_reauth(s)
        from . import backup
        data, meta = backup.make(secrets=bool(secrets), chats=bool(chats))
        db.add_event(ctx.con(), "backup.make", f"backup downloaded{' with secrets' if secrets else ''}", actor=s.username,
                     source=h.ip_of(request), level="warn" if secrets else "info")
        name = f"outcrop-backup-{time.strftime('%Y%m%d-%H%M%S')}{'-with-secrets' if secrets else ''}.tar.gz"
        return Response(data, media_type="application/gzip",
                        headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})

    h.start_tasks = [logs.run]
    with contextlib.suppress(Exception):
        bench.import_results()
