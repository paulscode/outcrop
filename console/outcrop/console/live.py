"""Live data for the console: collectors (Strata, the GPU, the host, the units, the gateway) and the WebSocket fan-out.

One sample a second goes to every browser subscribed to `metrics`; the last hour of samples stays in memory for the charts, and
rollups go to SQLite (10 s, 1 min, 1 h).  Gateway events (request start, first byte, progress, end; refusals; holds) are
passed on as they come.  A slow browser gets the newest state, never a backlog.
"""
from __future__ import annotations

import asyncio
import collections
import contextlib
import json
import logging
import os
import re
import time
from pathlib import Path

import httpx

from ..common import config
from .control import units

log = logging.getLogger("outcrop.console")

UNITS = ["outcrop-gateway.service", "outcrop-console.service", "outcrop-ollama-bridge.service", "outcrop-boot.service",
         "outcrop-fetch.service", "outcrop-searxng.service"]
TOPICS = {"metrics", "engine", "units", "gateway", "requests", "auth", "switch", "alerts", "events", "logs", "bench",
          "chats"}


class Client:
    def __init__(self, session_hash: str):
        self.session_hash = session_hash
        self.topics: set[str] = set()
        self.q: asyncio.Queue = asyncio.Queue(500)

    def put(self, msg: dict) -> None:
        if self.q.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self.q.get_nowait()
        self.q.put_nowait(msg)


class Live:
    def __init__(self, ctx):
        self.ctx = ctx
        self.clients: set[Client] = set()
        self.snap: dict[str, object] = {}
        self.history: collections.deque = collections.deque(maxlen=3600)
        self.engine: dict = {}
        self.telemetry: dict = {}
        self.units: dict = {}
        self.gateway: dict = {}
        self.recent_requests: collections.deque = collections.deque(maxlen=200)
        self.inflight: dict[str, dict] = {}
        self.tasks: list[asyncio.Task] = []
        self.nvml = None
        self.gpu_static: dict = {}
        self.energy_j = 0.0
        self._last_io = None
        self._last_net = None
        self._last_pcie = None
        self.numa = _numa_nodes()
        self.alerts = None          # set by the app (alerts.Alerts)
        self.loop: asyncio.AbstractEventLoop | None = None
        self._roll = {"10s": [], "1m": [], "1h": []}

    # ---------------------------------------------------------------------------------------------------- fan-out
    def publish(self, topic: str, data, keep: bool = True) -> None:
        """To every client subscribed to `topic`.  Safe from any thread: from a worker thread (alerts, Telegram, sync
        routes) it is handed to the event loop, since the clients' asyncio queues belong to it."""
        loop = self.loop
        if loop is not None and not loop.is_closed():
            # always through the loop's queue, from its own thread too: events then go out in the order they were
            # published, whichever thread published them (an older alerts summary can't overtake a newer one)
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(self._publish, topic, data, keep)
            return
        self._publish(topic, data, keep)

    def _publish(self, topic: str, data, keep: bool = True) -> None:
        msg = {"t": topic, "d": data, "at": time.time()}
        if keep:
            self.snap[topic] = data
        for c in list(self.clients):
            if topic in c.topics:
                c.put(msg)

    def subscribe(self, c: Client, topics) -> None:
        new = {t for t in topics if t in TOPICS} - c.topics
        c.topics |= new
        for t in new:
            if t in self.snap:
                c.put({"t": t, "d": self.snap[t], "at": time.time(), "snapshot": True})
            if t == "metrics" and self.history:
                c.put({"t": "metrics.history", "d": list(self.history)[-600:], "at": time.time()})
            if t == "requests":
                c.put({"t": "requests.snapshot", "d": {"inflight": list(self.inflight.values()),
                                                         "recent": list(self.recent_requests)[-50:]}, "at": time.time()})

    # ---------------------------------------------------------------------------------------------------- startup
    async def start(self) -> None:
        self.loop = asyncio.get_running_loop()
        self._nvml_init()
        for coro in (self._strata_loop(), self._sample_loop(), self._units_loop(), self._gateway_loop(),
                     self._rollup_loop(), self._events_loop()):
            self.tasks.append(asyncio.create_task(coro))

    async def stop(self) -> None:
        for t in self.tasks:
            t.cancel()
        if self.nvml is not None:
            with contextlib.suppress(Exception):
                self.nvml.nvmlShutdown()

    # ----------------------------------------------------------------------------------------------------- Strata
    async def _strata_loop(self) -> None:
        n = 0
        while True:
            try:
                tel = await self.ctx.strata_get("/v1/telemetry", timeout=3)
                if tel:
                    self.telemetry = tel
                if n % 5 == 0 or not self.engine:
                    m = await self.ctx.strata_get("/metrics", timeout=5)
                    if m:
                        self.engine = summarize_metrics(m)
                        self.publish("engine", self.engine)
            except Exception:
                log.debug("strata poll failed", exc_info=True)
            n += 1
            await asyncio.sleep(1.0)

    # --------------------------------------------------------------------------------------------- the 1 s sample
    async def _sample_loop(self) -> None:
        while True:
            t0 = time.time()
            try:
                s = await asyncio.to_thread(self._sample)
                self.history.append(s)
                for k in self._roll:
                    self._roll[k].append(s)
                self.publish("metrics", s)
                if self.alerts is not None:
                    self.alerts.observe_sample(s)
            except Exception:
                log.exception("sampling failed")
            await asyncio.sleep(max(0.05, 1.0 - (time.time() - t0)))

    def _nvml_init(self) -> None:
        try:
            import pynvml as N
            N.nvmlInit()
            self.nvml = N
            # the card(s) the engine uses: presets.json names them when the machine has more than one (lib/profiles.py):
            # a two-card profile's "gpu" (nvidia-smi's numbers), else the one-card pin's UUID
            try:
                common = config.load_presets().get("common") or {}
            except (OSError, ValueError):
                common = {}
            gpu = str((common.get("env") or {}).get("CUDA_VISIBLE_DEVICES", ""))
            # a two-card profile's cards by UUID (the numbers shift when a card is added in a lower slot), else by number
            cards = [u for u in (common.get("gpu_uuids") or []) if isinstance(u, str) and u.startswith("GPU-")]
            cards = cards or [i for i in (common.get("gpu") or []) if isinstance(i, int) and not isinstance(i, bool)]

            def handle(c):
                return N.nvmlDeviceGetHandleByUUID(c) if isinstance(c, str) else N.nvmlDeviceGetHandleByIndex(c)
            try:
                h = (handle(cards[0]) if cards else
                     N.nvmlDeviceGetHandleByUUID(gpu) if gpu.startswith("GPU-") else N.nvmlDeviceGetHandleByIndex(0))
            except N.NVMLError:                          # that card is gone (swapped): the first one, as before
                h = N.nvmlDeviceGetHandleByIndex(0)
            self._gpus_more = []                         # the other cards of a two-card profile
            seen = {_try(lambda: _s(N.nvmlDeviceGetUUID(h)))}
            for i, c in enumerate(cards[1:], start=1):
                try:
                    hh = handle(c)
                except N.NVMLError:                      # a card that is gone: not sampled
                    continue
                u = _try(lambda hh=hh: _s(N.nvmlDeviceGetUUID(hh)))
                if u not in seen:                        # never the same card twice (the first card's stand-in, card 0)
                    seen.add(u)
                    self._gpus_more.append((i, hh))
            name = N.nvmlDeviceGetName(h)
            # A GB10 shares the system's memory with the CPU: NVML has no memory figures for it ("Not Supported")
            mem = _try(lambda: N.nvmlDeviceGetMemoryInfo(h))
            cuda = _try(N.nvmlSystemGetCudaDriverVersion)
            self.gpu_static = {"name": name.decode() if isinstance(name, bytes) else name,
                               "driver": _s(N.nvmlSystemGetDriverVersion()),
                               "cuda": f"{cuda // 1000}.{cuda % 1000 // 10}" if cuda else None,
                               "memory": "discrete" if mem is not None else "unified",
                               "vram_total_mib": mem.total // (1 << 20) if mem is not None else None,
                               "power_limit_w": _try(lambda: N.nvmlDeviceGetEnforcedPowerLimit(h) / 1000.0),
                               "pcie_gen_max": _try(lambda: N.nvmlDeviceGetMaxPcieLinkGeneration(h)),
                               "pcie_width_max": _try(lambda: N.nvmlDeviceGetMaxPcieLinkWidth(h))}
            self._gpu = h
        except Exception as e:
            log.warning("NVML is not available (%s); GPU numbers come from Strata's telemetry", e)
            self.nvml = None

    def _sample(self) -> dict:
        now = time.time()
        s: dict = {"t": round(now, 3)}
        s["gpu"] = self._gpu_sample(now)
        s["host"] = self._host_sample(now)
        live = (self.engine.get("live") or {}) if self.engine else {}
        w = (self.telemetry or {}).get("work") or {}
        s["engine"] = {"state": live.get("state"), "phase": live.get("phase"), "queued": w.get("queued"),
                       "active": w.get("active"), "prompt_read": live.get("prompt_read"),
                       "prompt_total": live.get("prompt_total"), "generated": live.get("generated"),
                       "tok_s": live.get("tok_s"), "loaded": ((self.telemetry or {}).get("model") or {}).get("loaded")}
        s["gw"] = {"inflight": len(self.inflight), "held": (self.gateway or {}).get("hold", {}).get("waiting", 0)}
        return s

    def _gpu_sample(self, now: float) -> dict:
        # presets.json changed (a hardware profile applied, on Ubuntu while the console runs): the cards are looked up
        # again, at most once a minute
        if now - getattr(self, "_cards_checked", 0) > 60:
            self._cards_checked = now
            try:
                m = config.PRESETS_FILE.stat().st_mtime
            except OSError:
                m = None
            if getattr(self, "_cards_mtime", m) != m:
                self._nvml_init()
            self._cards_mtime = m
        N = self.nvml
        if N is None:
            d = ((self.telemetry or {}).get("devices") or [{}])[0]
            return {"util": d.get("util"), "mem_used": (d.get("mem_used") or 0) // (1 << 20),
                    "mem_total": (d.get("mem_total") or 0) // (1 << 20), "temp": d.get("temp"), "power": d.get("power")}
        h = self._gpu
        g: dict = {}
        u = _try(lambda: N.nvmlDeviceGetUtilizationRates(h))
        if u is not None:
            g["util"], g["mem_util"] = u.gpu, u.memory
        # version 2 leaves out the driver's reserved memory, as nvidia-smi does (version 1 reads about 110 MiB higher)
        m = _try(lambda: N.nvmlDeviceGetMemoryInfo(h, version=N.nvmlMemory_v2)) or _try(lambda: N.nvmlDeviceGetMemoryInfo(h))
        if m is not None:
            g["mem_used"], g["mem_total"] = m.used // (1 << 20), m.total // (1 << 20)
        g["temp"] = _try(lambda: N.nvmlDeviceGetTemperature(h, N.NVML_TEMPERATURE_GPU))
        p = _try(lambda: N.nvmlDeviceGetPowerUsage(h))
        g["power"] = round(p / 1000.0, 1) if p is not None else None
        g["sm_clock"] = _try(lambda: N.nvmlDeviceGetClockInfo(h, N.NVML_CLOCK_SM))
        g["mem_clock"] = _try(lambda: N.nvmlDeviceGetClockInfo(h, N.NVML_CLOCK_MEM))
        g["fan"] = _try(lambda: N.nvmlDeviceGetFanSpeed(h))
        g["pcie_gen"] = _try(lambda: N.nvmlDeviceGetCurrPcieLinkGeneration(h))
        g["pcie_width"] = _try(lambda: N.nvmlDeviceGetCurrPcieLinkWidth(h))
        reasons = _try(lambda: N.nvmlDeviceGetCurrentClocksThrottleReasons(h))
        g["throttle"] = _throttle_names(N, reasons) if reasons is not None else None
        # PCIe throughput (KB/s), clamped to what the link can carry: Strata's own samples show impossible spikes
        rx = _try(lambda: N.nvmlDeviceGetPcieThroughput(h, N.NVML_PCIE_UTIL_RX_BYTES))
        tx = _try(lambda: N.nvmlDeviceGetPcieThroughput(h, N.NVML_PCIE_UTIL_TX_BYTES))
        cap = _pcie_cap_mbs(g.get("pcie_gen") or 3, g.get("pcie_width") or 16)
        g["pcie_rx"] = round(min(rx / 1024.0, cap), 1) if rx is not None else None
        g["pcie_tx"] = round(min(tx / 1024.0, cap), 1) if tx is not None else None
        procs = []
        for fn in ("nvmlDeviceGetComputeRunningProcesses", "nvmlDeviceGetGraphicsRunningProcesses"):
            for pr in _try(lambda fn=fn: getattr(N, fn)(h)) or []:
                procs.append({"pid": pr.pid, "mem": (pr.usedGpuMemory or 0) // (1 << 20), "name": _proc_name(pr.pid),
                              "kind": "compute" if "Compute" in fn else "graphics"})
        hidden = tuple(sorted(p["pid"] for p in procs if p["name"] is None))
        if hidden:
            # NVML's pids are the host's: in a container (StartOS) ours are not in our /proc.  Which of our own
            # processes hold the GPU is looked up again only when that set of pids changes.
            if getattr(self, "_hidden_key", None) != hidden:
                self._hidden_key, self._ours_on_gpu = hidden, _gpu_holders()
            _name_hidden(procs, self._ours_on_gpu)
        g["procs"] = procs
        if getattr(self, "_gpus_more", None):
            # two cards: one entry per card in "cards", and the figures the pages and alerts read made for both: power
            # and memory added up (the Energy and Memory pages), the hotter card's temperature and every card's limits
            # (gpu_hot), every card's processes (gpu_contention), utilisation the busier card's
            cards = [{"card": 0, "temp": g.get("temp"), "power": g.get("power"), "util": g.get("util"),
                      "mem_used": g.get("mem_used"), "mem_total": g.get("mem_total"), "throttle": g.get("throttle")}]
            for i, hh in self._gpus_more:
                t = _try(lambda hh=hh: N.nvmlDeviceGetTemperature(hh, N.NVML_TEMPERATURE_GPU))
                pw = _try(lambda hh=hh: N.nvmlDeviceGetPowerUsage(hh))
                uu = _try(lambda hh=hh: N.nvmlDeviceGetUtilizationRates(hh))
                mm = (_try(lambda hh=hh: N.nvmlDeviceGetMemoryInfo(hh, version=N.nvmlMemory_v2))
                      or _try(lambda hh=hh: N.nvmlDeviceGetMemoryInfo(hh)))
                rr = _try(lambda hh=hh: N.nvmlDeviceGetCurrentClocksThrottleReasons(hh))
                cards.append({"card": i, "temp": t, "power": round(pw / 1000.0, 1) if pw is not None else None,
                              "util": uu.gpu if uu is not None else None,
                              "mem_used": mm.used // (1 << 20) if mm is not None else None,
                              "mem_total": mm.total // (1 << 20) if mm is not None else None,
                              "throttle": _throttle_names(N, rr) if rr is not None else None})
                for fn in ("nvmlDeviceGetComputeRunningProcesses", "nvmlDeviceGetGraphicsRunningProcesses"):
                    for pr in _try(lambda fn=fn, hh=hh: getattr(N, fn)(hh)) or []:
                        if all(x["pid"] != pr.pid for x in procs):
                            procs.append({"pid": pr.pid, "mem": (pr.usedGpuMemory or 0) // (1 << 20),
                                          "name": _proc_name(pr.pid), "kind": "compute" if "Compute" in fn else "graphics"})
            if any(x["name"] is None for x in procs):
                _name_hidden(procs, getattr(self, "_ours_on_gpu", None) or _gpu_holders())
            g["cards"] = cards

            def total(k):
                v = [c[k] for c in cards if c[k] is not None]
                return round(sum(v), 1) if v else g.get(k)
            g["power"], g["mem_used"], g["mem_total"] = total("power"), total("mem_used"), total("mem_total")
            temps = [c["temp"] for c in cards if c["temp"] is not None]
            if temps:
                g["temp"] = max(temps)
            utils = [c["util"] for c in cards if c["util"] is not None]
            if utils:
                g["util"] = max(utils)
            if any(c["throttle"] is not None for c in cards):
                g["throttle"] = sorted({n for c in cards for n in (c["throttle"] or [])})
        if g.get("power") is not None:
            last = getattr(self, "_last_power_t", None)
            if last is not None:
                self.energy_j += g["power"] * min(5.0, now - last)
            self._last_power_t = now
        g["energy_j"] = round(self.energy_j, 1)
        return g

    def _host_sample(self, now: float) -> dict:
        import psutil
        h: dict = {}
        per = psutil.cpu_percent(percpu=True)
        h["cpu"] = round(sum(per) / max(1, len(per)), 1)
        if self.numa:
            h["cpu_nodes"] = [round(sum(per[c] for c in cpus if c < len(per)) / max(1, len(cpus)), 1)
                              for cpus in self.numa]
        mi = _meminfo()
        gib = 1 << 20
        h["ram_total"] = round(mi.get("MemTotal", 0) / gib, 1)
        h["ram_available"] = round(mi.get("MemAvailable", 0) / gib, 1)
        h["ram_used"] = round((mi.get("MemTotal", 0) - mi.get("MemAvailable", 0)) / gib, 1)
        h["cached"] = round((mi.get("Cached", 0) + mi.get("Buffers", 0)) / gib, 1)
        h["anon"] = round(mi.get("AnonPages", 0) / gib, 1)
        h["mlocked"] = round(mi.get("Mlocked", 0) / gib, 1)
        io = _try(psutil.disk_io_counters)
        if io is not None:
            if self._last_io:
                dt = max(1e-3, now - self._last_io[0])
                h["disk_read"] = round((io.read_bytes - self._last_io[1]) / dt / 1e6, 1)
                h["disk_write"] = round((io.write_bytes - self._last_io[2]) / dt / 1e6, 1)
            self._last_io = (now, io.read_bytes, io.write_bytes)
        net = _try(psutil.net_io_counters)
        if net is not None:
            if self._last_net:
                dt = max(1e-3, now - self._last_net[0])
                h["net_rx"] = round((net.bytes_recv - self._last_net[1]) / dt / 1e6, 2)
                h["net_tx"] = round((net.bytes_sent - self._last_net[2]) / dt / 1e6, 2)
            self._last_net = (now, net.bytes_recv, net.bytes_sent)
        h["load"] = round(os.getloadavg()[0], 2)
        return h

    # --------------------------------------------------------------------------------------------------- units
    async def _units_loop(self) -> None:
        while True:
            try:
                u = await asyncio.to_thread(getattr(self, "_units_override", None) or unit_states)
                prev = self.units
                if u != prev:
                    self.units = u
                    self.publish("units", u)
                if self.alerts is not None and prev:
                    await asyncio.to_thread(self.alerts.observe_units, prev, u)
            except Exception:
                log.debug("unit poll failed", exc_info=True)
            await asyncio.sleep(2.0)

    # ------------------------------------------------------------------------------------------------- gateway
    async def _gateway_loop(self) -> None:
        while True:
            try:
                tr = httpx.AsyncHTTPTransport(uds=str(self.ctx.gateway_sock))
                async with httpx.AsyncClient(transport=tr, base_url="http://gateway", timeout=None) as c:
                    async with c.stream("GET", "/events") as r:
                        buf = b""
                        async for chunk in r.aiter_raw():
                            buf += chunk
                            while b"\n\n" in buf:
                                block, buf = buf.split(b"\n\n", 1)
                                for ln in block.split(b"\n"):
                                    if ln.startswith(b"data: "):
                                        with contextlib.suppress(ValueError):
                                            self._gateway_event(json.loads(ln[6:]))
            except Exception:
                self.gateway = {**(self.gateway or {}), "up": False}
                self.publish("gateway", self.gateway)
            await asyncio.sleep(2.0)

    def _gateway_event(self, ev: dict) -> None:
        t = ev.get("type")
        if t == "hello":
            ev.pop("type", None)
            self.gateway = {**ev, "up": True}
            self.inflight = {f["rid"]: f for f in ev.get("inflight") or []}
            self.publish("gateway", self.gateway)
            return
        if t and t.startswith("request."):
            rid = ev.get("rid")
            if t == "request.start":
                self.inflight[rid] = ev
            elif t in ("request.held", "request.first_byte", "request.progress") and rid in self.inflight:
                self.inflight[rid] = {**self.inflight[rid], **{k: v for k, v in ev.items() if k not in ("type", "seq")}}
            elif t == "request.end":
                base = self.inflight.pop(rid, {})
                done = {**base, **ev}
                self.recent_requests.append(done)
                if self.alerts is not None:
                    self.alerts.observe_request(done)
            elif t == "request.stats":
                for r in reversed(self.recent_requests):
                    if r.get("rid") == rid:
                        r.update({k: v for k, v in ev.items() if k not in ("type", "seq", "at")})
                        break
            self.publish("requests", ev, keep=False)
            return
        if t == "auth.fail":
            self.publish("auth", ev, keep=False)
            if self.alerts is not None:
                self.alerts.observe_auth_fail(ev)
            return
        if t in ("auth.mode", "hold", "release", "strata", "db.error"):
            if t == "auth.mode":
                self.gateway.setdefault("auth", {})["mode"] = ev.get("mode")
                self.gateway["auth"]["until"] = ev.get("until")
                if self.alerts is not None:
                    self.alerts.observe_mode(ev)
            elif t in ("hold", "release"):
                self.gateway.setdefault("hold", {}).update(ready=(t == "release"), reason=ev.get("reason"),
                                                           waiting=ev.get("waiting", 0))
            elif t == "strata":
                self.gateway["strata"] = {k: ev.get(k) for k in ("up", "loaded", "preset")}
            self.publish("gateway", self.gateway)
            self.publish("events", {"type": t, **ev}, keep=False)

    # ------------------------------------------------------------------------------------------------ audit log
    async def _events_loop(self) -> None:
        """New rows of the audit log (written by the console, the gateway or outcrop) go out on the `events` topic."""
        def newest():
            return self.ctx.con().execute("SELECT coalesce(max(id), 0) FROM events").fetchone()[0]

        def after(n):
            rows = self.ctx.con().execute("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 200", (n,)).fetchall()
            return [dict(r) | {"details": json.loads(r["details"] or "{}")} for r in rows]

        last = await asyncio.to_thread(newest)
        while True:
            await asyncio.sleep(2.0)
            try:
                rows = await asyncio.to_thread(after, last)
            except Exception:
                continue
            for r in rows:
                last = max(last, r["id"])
                self.publish("events", {"type": "audit", **r}, keep=False)

    # ------------------------------------------------------------------------------------------------- rollups
    async def _rollup_loop(self) -> None:
        last = {"10s": time.time(), "1m": time.time(), "1h": time.time()}
        span = {"10s": 10, "1m": 60, "1h": 3600}
        n = 0
        while True:
            await asyncio.sleep(1.0)
            now = time.time()
            for k, sec in span.items():
                if now - last[k] >= sec and self._roll[k]:
                    rows, self._roll[k] = self._roll[k], []
                    last[k] = now
                    agg = aggregate(rows)
                    with contextlib.suppress(Exception):
                        await asyncio.to_thread(self.ctx.write_rollup, k, int(now // sec * sec), agg)
            n += 1
            if n % 3600 == 10:
                with contextlib.suppress(Exception):
                    await asyncio.to_thread(self.ctx.retention)


# ------------------------------------------------------------------------------------------------------- helpers

def _s(x):
    return x.decode() if isinstance(x, bytes) else x


def _try(fn):
    try:
        return fn()
    except Exception:
        return None


def _pcie_cap_mbs(gen: int, width: int) -> float:
    per_lane = {1: 250, 2: 500, 3: 985, 4: 1969, 5: 3938}.get(int(gen or 3), 985)
    return float(per_lane * int(width or 16))


def _throttle_names(N, reasons: int) -> list[str]:
    names = []
    for attr, label in (("nvmlClocksThrottleReasonGpuIdle", "idle"),
                        ("nvmlClocksThrottleReasonApplicationsClocksSetting", "app clocks"),
                        ("nvmlClocksThrottleReasonSwPowerCap", "power cap"),
                        ("nvmlClocksThrottleReasonHwSlowdown", "hardware slowdown"),
                        ("nvmlClocksThrottleReasonSyncBoost", "sync boost"),
                        ("nvmlClocksThrottleReasonSwThermalSlowdown", "thermal (software)"),
                        ("nvmlClocksThrottleReasonHwThermalSlowdown", "thermal"),
                        ("nvmlClocksThrottleReasonHwPowerBrakeSlowdown", "power brake")):
        bit = getattr(N, attr, None)
        if bit and reasons & bit:
            names.append(label)
    return names


def _proc_name(pid: int) -> str | None:
    try:
        return Path(f"/proc/{pid}/comm").read_text().strip()
    except OSError:
        return None


def _gpu_holders(proc: Path = Path("/proc")) -> list[str]:
    """The names of our engines (strata-*) that have the GPU open (/dev/nvidia-uvm).  Only the engines put work on the
    GPU: the console and Strata's server open the device too, to read NVML, but never show up in NVML's process list."""
    out = []
    for d in proc.glob("[0-9]*"):
        try:
            name = (d / "comm").read_text().strip()
            if "strata" in name and any(os.readlink(f) == "/dev/nvidia-uvm" for f in (d / "fd").iterdir()):
                out.append(name)
        except OSError:
            continue
    return sorted(out)


def _name_hidden(procs: list[dict], ours: list[str]) -> None:
    """GPU processes not in our /proc get our engines' names, the largest first (an engine is the big one); any left
    over really are outside (another service on the GPU), and are named by their host pid."""
    hidden = sorted((p for p in procs if p["name"] is None), key=lambda p: -(p.get("mem") or 0))
    left = list(ours)
    for p in hidden:
        p["name"] = left.pop(0) if left else f"pid {p['pid']}"


def _meminfo() -> dict:
    out = {}
    for ln in Path("/proc/meminfo").read_text().splitlines():
        k, _, v = ln.partition(":")
        with contextlib.suppress(ValueError, IndexError):
            out[k] = int(v.split()[0])
    return out


def _numa_nodes() -> list[list[int]]:
    nodes = []
    base = Path("/sys/devices/system/node")
    for d in sorted(base.glob("node[0-9]*"), key=lambda p: int(p.name[4:])):
        try:
            nodes.append(_cpulist((d / "cpulist").read_text().strip()))
        except OSError:
            pass
    return nodes


def _cpulist(s: str) -> list[int]:
    out = []
    for part in s.split(","):
        if "-" in part:
            a, b = part.split("-")
            out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return out


def unit_states() -> dict:
    """The LLM units' states: {unit: {active, sub, since, pid, restarts, result}}."""
    names = list(UNITS) + [u for u, _, _ in units.list_engine()]
    shown = units.show(names, ["ActiveState", "SubState", "ActiveEnterTimestamp", "MainPID", "NRestarts", "Result",
                               "UnitFileState"])
    return {uid: {"active": cur.get("ActiveState"), "sub": cur.get("SubState"),
                  "since": cur.get("ActiveEnterTimestamp") or None, "pid": int(cur.get("MainPID") or 0),
                  "restarts": int(cur.get("NRestarts") or 0), "result": cur.get("Result"), "enabled": cur.get("UnitFileState")}
            for uid, cur in shown.items()}


def summarize_metrics(m: dict) -> dict:
    """What the console needs from Strata's /metrics: settings, live state, the conversation cache, totals, last requests."""
    e = m.get("engine") or {}
    keep = ("model", "version", "context", "kv", "kv_resident", "expert_slots", "expert_cache_mib", "vram_free_mib",
            "arena_mib", "pool_workers", "spec", "mtp_max", "drafting", "conversation_cache_mib", "conversation_cache_slots",
            "prefill_cap")
    return {"engine": {k: e.get(k) for k in keep}, "live": m.get("live") or {},
            "conversation_cache": m.get("conversation_cache") or {}, "totals": m.get("totals") or {},
            "requests": (m.get("requests") or [])[-12:], "hardware_static": m.get("hardware_static") or {},
            "at": m.get("time")}


ROLLUP_FIELDS = ("gpu.util", "gpu.temp", "gpu.power", "gpu.mem_used", "gpu.sm_clock", "gpu.fan", "gpu.pcie_rx",
                 "host.cpu", "host.ram_used", "host.cached", "host.disk_read", "host.disk_write", "host.net_rx", "host.net_tx",
                 "engine.tok_s", "engine.queued", "engine.generated", "gw.inflight")
ROLLUP_MAX = ("gpu.temp", "gpu.power", "gpu.util", "engine.tok_s")


def aggregate(rows: list[dict]) -> dict:
    """Averages (and maxima for a few) of 1 s samples, for the charted fields only: about 500 bytes a row, so 7 days at
    10 s (30 MB), 90 days at 1 min (65 MB) and 2 years at 1 h (9 MB) stay near 100 MB together."""
    acc: dict[str, list] = {}
    for r in rows:
        for sect in ("gpu", "host", "engine", "gw"):
            for k, v in (r.get(sect) or {}).items():
                key = f"{sect}.{k}"
                if key in ROLLUP_FIELDS and isinstance(v, (int, float)) and not isinstance(v, bool):
                    acc.setdefault(key, []).append(float(v))
    out = {k: round(sum(v) / len(v), 1) for k, v in acc.items()}
    for k in ROLLUP_MAX:
        if k in acc:
            out[k + ".max"] = round(max(acc[k]), 1)
    out["n"] = len(rows)
    return out


TOK_RE = re.compile(r"done: (\d+) tokens in (\d+) s \(([\d.]+) tok/s\).*?expert cache ([\d.]+)% hit")
