#!/usr/bin/env python3
"""dev.py  - the whole stack on a development machine, no GPU: the fake Strata, the Ollama bridge, the gateway and the console,
with a few tokens and a traffic generator, so the UI has live data.

    cd console && uv run python dev.py            # console on http://localhost:8800, UI dev server: cd web && pnpm dev

State goes to /tmp/outcrop-dev (deleted with --fresh).  Sign in as `dev` with the password printed at start.
Ports: fake Strata 18090, bridge 11445, gateway 18088 (OpenAI/Anthropic) and 11444 (Ollama), console 8800.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
STATE = Path(os.environ.get("OUTCROP_DEV_STATE", "/tmp/outcrop-dev"))
PW = "harbor glacier lantern velvet orbit moss"
PORTS = {"strata": 18090, "bridge": 11445, "gw": 18088, "gw_ollama": 11444, "console": 8800, "searx": 18889}

ap = argparse.ArgumentParser()
ap.add_argument("--fresh", action="store_true", help="start from an empty state")
ap.add_argument("--no-traffic", action="store_true")
ap.add_argument("--rate", type=float, default=0.25, help="requests a second from the traffic generator")
a = ap.parse_args()

if a.fresh and STATE.exists():
    shutil.rmtree(STATE)
(STATE / "state").mkdir(parents=True, exist_ok=True)
(STATE / "run").mkdir(parents=True, exist_ok=True)
(STATE / "home").mkdir(parents=True, exist_ok=True)
if not (STATE / "home" / "presets.json").exists():         # as ./setup.sh makes it on the reference system
    sys.path.insert(0, str(HERE.parent / "lib"))
    import profiles  # noqa: E402
    (STATE / "home" / "presets.json").write_text(json.dumps(profiles.render("m6000-256g"), indent=2) + "\n")
env = {**os.environ, "OUTCROP_STATE": str(STATE / "state"), "OUTCROP_RUN": str(STATE / "run"), "OUTCROP_HOME": str(STATE / "home"),
       "PYTHONPATH": str(HERE), "PYTHONUNBUFFERED": "1"}
os.environ.update({k: env[k] for k in ("OUTCROP_STATE", "OUTCROP_RUN", "OUTCROP_HOME")})
sys.path.insert(0, str(HERE))

from outcrop.common import config, db, tokens  # noqa: E402
from outcrop.console import auth  # noqa: E402

key = config.upstream_key(create=True)
con = db.connect()
pepper = tokens.load_pepper()
if auth.get_user(con) is None:
    auth.set_password(con, "dev", PW, actor="dev")
made = {}
for name, kw in [("laptop", {"cidrs": [], "notes": "a laptop: Claude Code"}),
                 ("open-webui", {"expires_at": time.time() + 80 * 86400}),
                 ("home-assistant", {"listeners": ["ollama"]}),
                 ("grafana", {"scopes": ["telemetry"]}),
                 ("n8n", {"rpm": 60, "expires_at": time.time() + 5 * 86400})]:
    if tokens.find(con, name) is None:
        _, made[name] = tokens.create(con, pepper, name, by="dev", **kw)
tok_file = STATE / "tokens.json"
if made:
    tok_file.write_text(json.dumps({**(json.loads(tok_file.read_text()) if tok_file.exists() else {}), **made}))
toks = json.loads(tok_file.read_text()) if tok_file.exists() else {}
tokens.ensure_local_token(con, pepper, by="dev")
con.close()

py = sys.executable
procs = []


def start(name, argv):
    p = subprocess.Popen(argv, env=env, cwd=HERE, stdout=open(STATE / f"{name}.log", "ab"), stderr=subprocess.STDOUT)
    procs.append((name, p))
    return p


start("strata", [py, "-m", "fakestrata.server", "--port", str(PORTS["strata"]), "--api-key", key, "--slow"])
start("web", [py, "-m", "fakestrata.fakeweb", "--searx-port", str(PORTS["searx"]), "--fetch-sock",
              str(STATE / "run" / "fetch.sock")])
start("bridge", [py, str(ROOT / "bin" / "outcrop-ollama-bridge"), "--listen", "127.0.0.1", "--port", str(PORTS["bridge"]),
                 "--upstream", f"http://127.0.0.1:{PORTS['strata']}"])
time.sleep(1.0)
start("gateway", [py, "-m", "outcrop.gateway", "--listen", "127.0.0.1", "--port", str(PORTS["gw"]), "--ollama-port",
                  str(PORTS["gw_ollama"]), "--strata", f"http://127.0.0.1:{PORTS['strata']}", "--bridge",
                  f"http://127.0.0.1:{PORTS['bridge']}", "--socket", str(STATE / "run" / "gateway.sock"),
                  "--searx-url", f"http://127.0.0.1:{PORTS['searx']}", "--fetch-sock", str(STATE / "run" / "fetch.sock")])
start("console", [py, "-m", "outcrop.console", "--dev", "--fake-units", "--port", str(PORTS["console"]), "--listen", "127.0.0.1",
                  "--strata", f"http://127.0.0.1:{PORTS['strata']}", "--gateway-sock", str(STATE / "run" / "gateway.sock"),
                  "--web-dist", str(ROOT / "web" / "dist"), "--gateway-url", f"http://127.0.0.1:{PORTS['gw']}",
                  "--gateway-ollama-port", str(PORTS["gw_ollama"]), "--log-dir", str(STATE),
                  "--searx-url", f"http://127.0.0.1:{PORTS['searx']}", "--fetch-sock", str(STATE / "run" / "fetch.sock")])

print(f"""
  console   http://localhost:{PORTS['console']}   (UI dev server: cd web && pnpm dev  ->  http://localhost:5173)
  sign in   dev / {PW}
  gateway   http://127.0.0.1:{PORTS['gw']}/v1  and  http://127.0.0.1:{PORTS['gw_ollama']} (Ollama)
  tokens    {', '.join(f'{k}={v[:13]}…' for k, v in toks.items())}   (all in {tok_file})
  logs      {STATE}/*.log      Ctrl-C stops everything
""", flush=True)

APPS = [("laptop", "claude-cli/2.1.0 (external, cli)", "/v1/messages", "anthropic"),
        ("open-webui", "Python/3.11 aiohttp/3.9.5 open-webui", "/v1/chat/completions", "openai"),
        ("n8n", "n8n", "/v1/chat/completions", "openai"),
        ("home-assistant", "HomeAssistant/2026.11 ollama-python/0.4.7", "/api/chat", "ollama")]


def traffic():
    import httpx
    time.sleep(3)
    while True:
        try:
            r = random.random()
            name, ua, path, kind = random.choice(APPS)
            t = toks.get(name)
            words = random.choice([20, 40, 80, 400, 1500]) if r > 0.08 else 6000
            text = " ".join(random.choice(["rock", "layer", "river", "shale", "quartz", "basalt"]) for _ in range(words))
            stream = random.random() > 0.3
            port = PORTS["gw_ollama"] if kind == "ollama" else PORTS["gw"]
            if kind == "anthropic":
                body = {"model": "x", "max_tokens": 60, "stream": stream, "messages": [{"role": "user", "content": text}]}
            elif kind == "ollama":
                body = {"model": "qwen3.8-flash-next", "stream": stream, "messages": [{"role": "user", "content": text}]}
            else:
                body = {"model": "x", "max_tokens": 60, "stream": stream, "messages": [{"role": "user", "content": text}]}
            h = {"User-Agent": ua}
            if random.random() < 0.06:
                h["Authorization"] = "Bearer sk-old-key-" + "x" * 20           # an app not migrated yet
            elif t:
                h["Authorization"] = f"Bearer {t}"
            with httpx.Client(timeout=600) as c:
                if stream:
                    with c.stream("POST", f"http://127.0.0.1:{port}{path}", json=body, headers=h) as resp:
                        for _ in resp.iter_raw():
                            pass
                else:
                    c.post(f"http://127.0.0.1:{port}{path}", json=body, headers=h)
            if random.random() < 0.15 and toks.get("grafana"):
                c = httpx.Client(timeout=10)
                c.get(f"http://127.0.0.1:{PORTS['gw']}/metrics", headers={"Authorization": f"Bearer {toks['grafana']}",
                                                                          "User-Agent": "Prometheus/2.53"})
        except Exception as e:
            print("traffic:", type(e).__name__, e, flush=True)
        time.sleep(random.expovariate(a.rate))


if not a.no_traffic:
    threading.Thread(target=traffic, daemon=True).start()


def stop(*_):
    for _, p in procs:
        p.terminate()
    for _, p in procs:
        try:
            p.wait(5)
        except subprocess.TimeoutExpired:
            p.kill()
    sys.exit(0)


signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
while True:
    time.sleep(1)
    for name, p in procs:
        if p.poll() is not None:
            print(f"{name} exited ({p.returncode}); see {STATE}/{name}.log", flush=True)
            stop()
