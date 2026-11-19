#!/usr/bin/env python3
"""ab.py PLAN.json [arm ...]  - run Strata configs one after another on a private port and tabulate their speed.

PLAN: {"base": "<preset>", "cases": "chat,code,story,doc4k", "repeat": 3, "tokens": 256, "rounds": 1,
       "arms": [{"name": "x", "engine": "strata-pin", "env": {...}, "args": ["--flag v"], "context": 131072, ...}, ...]}
An arm overrides fields of the base preset from presets.json ("preset" in an arm picks another base for that arm): "env" is merged
into the preset's env (a null value removes a variable), "args" are appended to its args, anything else replaces the field.  "pre"/"post" are shell commands run around the arm.  Each arm gets a fresh server on port 8095
(127.0.0.1, pictures off), a warm-up request, then quickbench (greedy, thinking off).  With "rounds" > 1 the arms are interleaved.
Results go to bench/results/<plan>.jsonl, a table to stdout.  Name arms on the command line to run only those.
"""
import copy
import json
import os
import re
import signal
import statistics
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lib"))
import strata_presets as SP  # noqa: E402

PORT = int(os.environ.get("AB_PORT", "8095"))
URL = f"http://127.0.0.1:{PORT}"
plan_path = Path(sys.argv[1])
plan = json.load(open(plan_path))
only = set(sys.argv[2:])
tag = plan_path.stem
(HERE / "results").mkdir(exist_ok=True)
out = open(HERE / "results" / f"{tag}.jsonl", "a")
CASES = os.environ.get("AB_CASES", plan.get("cases", "chat,code,story,doc4k"))
REPEAT = str(plan.get("repeat", 3))
TOKENS = str(plan.get("tokens", 256))
PY = str(SP.STRATA / ".venv" / "bin" / "python")


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)


def gpu():
    return sh("nvidia-smi --query-gpu=temperature.gpu,clocks.sm,power.draw,memory.used,clocks_event_reasons.active "
              "--format=csv,noheader,nounits").stdout.strip()


def health():
    try:
        with urllib.request.urlopen(URL + "/health", timeout=3) as r:
            return json.load(r)
    except Exception:
        return None


def start(name, preset):
    cfg_all = SP.load()
    cfg_all["presets"] = {name: preset}
    cfg_all["server"] = {**cfg_all.get("server", {}), "host": "127.0.0.1", "port": PORT, "private": True, "api_key": "none"}
    path, notes = SP.render(name, cfg_all)
    log = open(SP.OUTCROP_HOME / "logs" / f"server-{name}.log", "w")
    p = subprocess.Popen([PY, "serve/server.py", "--engine", "strata", "--config", str(path), "--port", str(PORT), "--host", "127.0.0.1"],
                         cwd=SP.STRATA, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                         env={**os.environ, "LD_LIBRARY_PATH": SP.CUDA_LIB})
    t0 = time.time()
    while time.time() - t0 < 1200:
        h = health()
        if h and h.get("loaded"):
            return p, time.time() - t0, notes
        if p.poll() is not None:
            return None, time.time() - t0, notes
        time.sleep(2)
    stop(p)
    return None, time.time() - t0, notes


def stop(p):
    if p is None:
        return
    try:
        os.killpg(p.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(90):
        if p.poll() is not None:
            break
        time.sleep(1)
    else:
        os.killpg(p.pid, signal.SIGKILL)
    # the engine is in the same session; make sure it is gone and the card is free before the next arm
    for _ in range(60):
        if not sh(f"pgrep -f '^{SP.OUTCROP_HOME}/bin/strata-'").stdout.strip():
            break
        time.sleep(1)
    sh(f"pkill -9 -f '^{SP.OUTCROP_HOME}/bin/strata-'")


def engine_stats(name):
    try:
        log = open(SP.OUTCROP_HOME / "logs" / f"engine-{name}.log", errors="replace").read()
    except OSError:
        return {}
    st = {}
    m = re.findall(r"(\d[\d,]*) experts? (?:in|on) (?:VRAM|the GPU|the card)", log)
    if m:
        st["vram_experts"] = m[-1]
    timing = re.findall(r"strata decode timing: .*", log)
    tw = [float(x) for x in re.findall(r"([\d.]+) tokens/window", " ".join(timing))]
    if tw:
        st["tok_per_window"] = round(statistics.median(tw), 2)
    hit = re.findall(r"hit(?: rate)?[ =:]+([\d.]+)%", log)
    if hit:
        st["hit_pct"] = hit[-1]
    return st


def run_arm(arm, rnd):
    base = copy.deepcopy(SP.load()["presets"][arm.get("preset", plan.get("base"))])
    preset = copy.deepcopy(base)
    for k, v in arm.items():
        if k in ("name", "pre", "post", "preset"):
            continue
        if k == "env":                     # a null value drops a variable the preset or common section sets
            preset["env"] = {**preset.get("env", {}), **v}
            preset["drop_env"] = [e for e, x in v.items() if x is None]
        elif k == "args":
            preset["args"] = preset.get("args", []) + v
        else:
            preset[k] = v
    preset.setdefault("vision", "off")
    name = f"ab-{tag}-{arm['name']}"
    if arm.get("pre"):
        sh(arm["pre"])
    p, load_s, notes = start(name, preset)
    if p is None:
        tail = sh(f"tail -5 {SP.OUTCROP_HOME}/logs/server-{name}.log; tail -5 {SP.OUTCROP_HOME}/logs/engine-{name}.log").stdout
        print(f"{arm['name']:24s} FAILED to start after {load_s:.0f}s\n{tail}", flush=True)
        out.write(json.dumps({"arm": arm, "round": rnd, "failed": True, "tail": tail, "time": time.time()}) + "\n")
        out.flush()
        return
    res_json = HERE / "results" / f"{name}-r{rnd}.json"
    sh(f"{sys.executable} {HERE}/quickbench.py --url {URL} --tokens 64 --repeat 1 --cases code")   # warm-up, not recorded
    q = sh(f"{sys.executable} {HERE}/quickbench.py --url {URL} --tokens {TOKENS} --repeat {REPEAT} --cases {CASES} --json {res_json}",
           timeout=7200)
    g = gpu()
    stop(p)
    try:
        r = json.load(open(res_json))
    except (OSError, ValueError):
        print(f"{arm['name']:24s} bench failed: {q.stdout[-400:]} {q.stderr[-400:]}", flush=True)
        return
    med = lambda xs: statistics.median(xs) if xs else 0  # noqa: E731
    row = {c: med([x["decode_tps"] for x in r[c] if x["decode_tps"]]) for c in r}
    prompt = {c: med([x["prompt_tps"] for x in r[c] if x["prompt_tps"]]) for c in r if c.startswith("doc")}
    st = engine_stats(name)
    print(f"{arm['name']:24s} r{rnd} " + " ".join(f"{row.get(c, 0):7.1f}" for c in CASES.split(",")) +
          "  | prompt " + " ".join(f"{c}:{v:.0f}" for c, v in prompt.items()) +
          f"  | load {load_s:4.0f}s  {st}  gpu {g}", flush=True)
    out.write(json.dumps({"arm": arm, "round": rnd, "decode": row, "prompt": prompt, "load_s": load_s, "stats": st, "gpu": g,
                          "notes": notes, "time": time.time()}) + "\n")
    out.flush()
    if arm.get("post"):
        sh(arm["post"])


print(f"plan {tag}: base {plan['base']}, cases {CASES}, repeat {REPEAT}, tokens {TOKENS}", flush=True)
print(f"{'arm':24s}    " + " ".join(f"{c:>7s}" for c in CASES.split(",")), flush=True)
for rnd in range(1, int(plan.get("rounds", 1)) + 1):
    for arm in plan["arms"]:
        if only and arm["name"] not in only:
            continue
        run_arm(arm, rnd)
print("AB_DONE", flush=True)
