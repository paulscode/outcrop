#!/usr/bin/env python3
"""gatewaytest.py [--switch-to speed]  - checks of the gateway against the real server.  Run on the server.

  1. a client that hangs up mid-prompt, or mid-answer, is cancelled in Strata within 1 s (Strata's own counter,
     /v1/telemetry work.client_disconnect_cancels)
  2. a revoked token is refused within 1 s
  3. the token-less Ollama option: off, a request without a token to :11434 gets a 401; on for one address, only that one
  4. a preset switch with requests arriving: every request is answered, by the new preset (then it switches back)

Uses outcrop for tokens and switches, and the local-tools token for telemetry.
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--host", default="127.0.0.1")
ap.add_argument("--port", type=int, default=8080)
ap.add_argument("--ollama-port", type=int, default=11434)
ap.add_argument("--switch-to", default="speed", help="the preset for the switch check ('' to skip it)")
a = ap.parse_args()
BASE = f"http://{a.host}:{a.port}"
LOCAL = (Path(os.environ.get("OUTCROP_HOME") or Path.home() / ".outcrop") / "state" / "local_token").read_text().strip()
results = []


def check(name, ok, info=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'} {name:52s} {info}", flush=True)


def req(path, body=None, key=LOCAL, port=None, timeout=60):
    url = f"http://{a.host}:{port or a.port}{path}"
    h = {"Content-Type": "application/json", **({"Authorization": f"Bearer {key}"} if key else {})}
    r = urllib.request.Request(url, json.dumps(body).encode() if body is not None else None, h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, None


def cancels():
    return req("/v1/telemetry")[1]["work"]["client_disconnect_cancels"]


def outcrop(*args):
    return subprocess.run(["outcrop", *args], capture_output=True, text=True)


def idle(timeout=180):
    """Wait until the engine is doing nothing (a cancelled prompt chunk still finishes on the GPU)."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        m = req("/metrics")[1] or {}
        if (m.get("live") or {}).get("state") == "idle":
            return True
        time.sleep(0.5)
    return False


def hang_up(stream: bool, after_s: float, prompt_words: int, max_tokens: int, after_events: int = 0):
    """Send a chat request on a raw socket, hang up after `after_s` (or after `after_events` streamed events), and time
    Strata's cancel."""
    idle()
    before = cancels()
    text = " ".join(f"line {i}: the quick brown fox jumps over the lazy dog." for i in range(prompt_words // 10))
    body = json.dumps({"model": "x", "stream": stream, "max_tokens": max_tokens, "temperature": 0,
                       "chat_template_kwargs": {"enable_thinking": False},
                       "messages": [{"role": "user", "content": text + "\nNow write a long story about it."}]}).encode()
    s = socket.create_connection((a.host, a.port))
    s.sendall(f"POST /v1/chat/completions HTTP/1.1\r\nHost: {a.host}\r\nAuthorization: Bearer {LOCAL}\r\n"
              f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
    s.settimeout(0.2)
    t_end = time.time() + after_s
    got = b""
    while time.time() < t_end or (after_events and got.count(b"data: ") < after_events and time.time() < t_end + 60):
        try:
            got += s.recv(65536)
        except socket.timeout:
            pass
        if after_events and got.count(b"data: ") >= after_events:
            break
    s.close()
    t0 = time.time()
    while time.time() - t0 < 5:
        if cancels() > before:
            return time.time() - t0, got.count(b"data: ")
        time.sleep(0.05)
    return None, got.count(b"data: ")


# 1. disconnects
dt, n = hang_up(stream=True, after_s=3, prompt_words=6000, max_tokens=50)
check("hang-up mid-prompt (streamed) cancels in Strata", dt is not None and dt <= 1.0, f"{dt:.2f} s" if dt else "no cancel")
time.sleep(1)
dt, n = hang_up(stream=False, after_s=3, prompt_words=6000, max_tokens=50)
check("hang-up mid-prompt (not streamed) cancels in Strata", dt is not None and dt <= 1.0, f"{dt:.2f} s" if dt else "no cancel")
time.sleep(1)
dt, n = hang_up(stream=True, after_s=0, prompt_words=40, max_tokens=800, after_events=20)
check("hang-up mid-answer cancels in Strata", dt is not None and dt <= 1.0 and n >= 20,
      (f"{dt:.2f} s" if dt else "no cancel") + f" after {n} events")
time.sleep(1)

# 2. revocation
r = outcrop("token", "create", "gwtest-revoke", "--cidr", "127.0.0.1")
tok = next((w for w in r.stdout.split() if w.startswith("lls_")), None)
ok = tok is not None and req("/v1/models", key=tok)[0] == 200
stop = threading.Event()
first_401 = {}


def hammer():
    while not stop.is_set():
        if req("/v1/models", key=tok)[0] == 401 and "t" not in first_401:
            first_401["t"] = time.time()
            return
        time.sleep(0.02)


th = threading.Thread(target=hammer)
th.start()
time.sleep(0.5)
t_rev = time.time()
outcrop("token", "revoke", "gwtest-revoke")
th.join(5)
stop.set()
d = first_401.get("t", 1e9) - t_rev
check("a revoked token is refused within 1 s", ok and d <= 1.0, f"{d:.2f} s after `outcrop token revoke`")

# 3. the token-less Ollama option
code_off = req("/api/tags", key=None, port=a.ollama_port)[0]
outcrop("auth", "tokenless", "on", "--only", "192.168.1.250")
time.sleep(1.2)
code_other = req("/api/tags", key=None, port=a.ollama_port)[0]
outcrop("auth", "tokenless", "on", "--only", "127.0.0.1")
time.sleep(1.2)
code_me = req("/api/tags", key=None, port=a.ollama_port)[0]
code_8080 = req("/v1/models", key=None)[0]
outcrop("auth", "tokenless", "off")
time.sleep(1.2)
code_after = req("/api/tags", key=None, port=a.ollama_port)[0]
check("token-less option off: no token on :11434 gets 401", code_off == 401, str(code_off))
check("on for another address: still 401 here", code_other == 401, str(code_other))
check("on for this address: allowed, Ollama port only", code_me == 200 and code_8080 == 401, f"{code_me}, 8080: {code_8080}")
check("off again: 401", code_after == 401, str(code_after))

# 4. a switch with requests arriving
if a.switch_to:
    before = subprocess.run(["outcrop", "list"], capture_output=True, text=True).stdout
    back = next((ln.split()[1] for ln in before.splitlines() if ln.startswith(">")), "quality")
    answers = []

    def ask(i):
        st, body = req("/v1/chat/completions", {"model": "x", "max_tokens": 8, "temperature": 0,
                                                "chat_template_kwargs": {"enable_thinking": False},
                                                "messages": [{"role": "user", "content": f"Say {i}."}]}, timeout=300)
        answers.append((i, st, time.time()))

    sw = subprocess.Popen(["outcrop", "switch", a.switch_to], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    t_sw = time.time()
    threads = []
    for i in range(6):                              # one every 8 s, through the whole switch
        time.sleep(8)
        th = threading.Thread(target=ask, args=(i,))
        th.start()
        threads.append(th)
    sw.wait(600)
    for th in threads:
        th.join(300)
    took = time.time() - t_sw
    ok_all = len(answers) == 6 and all(st == 200 for _, st, _ in answers)
    models = req("/v1/models")[1] or {}
    alias = [m["id"] for m in models.get("data", []) if ":" in m["id"]]
    check(f"switch to {a.switch_to} with 6 requests arriving: all answered", ok_all,
          f"{sum(st == 200 for _, st, _ in answers)} of 6 answered; switch {took:.0f} s; now {alias}")
    time.sleep(2.5)                                  # the gateway writes its log once a second
    import sqlite3
    con = sqlite3.connect(f"file:{Path(os.environ.get('OUTCROP_HOME') or Path.home() / '.outcrop') / 'state' / 'outcrop.db'}?mode=ro",
                          uri=True)
    rows = con.execute("SELECT preset, held_ms FROM requests WHERE path='/v1/chat/completions' AND started_at >= ? "
                       "AND started_at <= ? AND status=200 ORDER BY started_at", (t_sw, t_sw + took)).fetchall()
    held = [r[1] for r in rows if r[1]]
    check(f"... and answered by {a.switch_to}", len(rows) >= 6 and all(r[0] == a.switch_to for r in rows[-6:]),
          f"presets {[r[0] for r in rows[-6:]]}; {len(held)} waited at the gateway, up to {max(held or [0]) / 1000:.0f} s")
    subprocess.run(["outcrop", "switch", back], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

print(f"{sum(results)} of {len(results)} passed")
sys.exit(0 if all(results) else 1)
