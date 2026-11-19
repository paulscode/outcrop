#!/usr/bin/env python3
"""soak.py [--hours 8] [--every 30]  - a light, steady mix of requests through the gateway, and a record of whether the
gateway and the console keep their memory, files and connections steady.  Run on the server.

Each round: a short streamed chat, a plain one, the Ollama API, the model list; every 10th round a client that hangs up
mid-answer and one with a wrong key.  Every 10 minutes it writes one line to --csv: RSS and open files of outcrop-gateway,
outcrop-console and the bridge, connections to Strata, the database size.  At the end it prints the growth.
"""
import argparse
import csv
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--hours", type=float, default=8)
ap.add_argument("--every", type=float, default=30, help="seconds between rounds")
ap.add_argument("--csv", default=str(Path(__file__).resolve().parent / "results" / "soak.csv"))
a = ap.parse_args()
HOME = Path(os.environ.get("OUTCROP_HOME") or Path.home() / ".outcrop")
KEY = (HOME / "state" / "local_token").read_text().strip()
H = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json", "User-Agent": "soak.py"}
NOTHINK = {"chat_template_kwargs": {"enable_thinking": False}}


def req(url, body=None, headers=H, timeout=120):
    r = urllib.request.Request(url, json.dumps(body).encode() if body is not None else None, headers)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except OSError:
        return 0, b""


def hang_up():
    body = json.dumps({"model": "x", "stream": True, "max_tokens": 300, "messages": [{"role": "user", "content":
                      "Write a long story."}], **NOTHINK}).encode()
    s = socket.create_connection(("127.0.0.1", 8080))
    s.sendall(b"POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer " + KEY.encode() +
              b"\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
    s.settimeout(30)
    got = b""
    while got.count(b"data: ") < 10:
        chunk = s.recv(65536)
        if not chunk:
            break
        got += chunk
    s.close()


def proc(unit):
    pid = subprocess.run(["systemctl", "show", unit, "-p", "MainPID", "--value"], capture_output=True, text=True).stdout.strip()
    try:
        rss = int(next(ln.split()[1] for ln in open(f"/proc/{pid}/status") if ln.startswith("VmRSS:"))) / 1024
        fds = len(os.listdir(f"/proc/{pid}/fd"))
    except (OSError, StopIteration, ValueError):
        return None, None
    return round(rss, 1), fds


def snapshot():
    row = {"t": time.strftime("%Y-%m-%d %H:%M:%S")}
    for u in ("outcrop-gateway", "outcrop-console", "outcrop-ollama-bridge"):
        row[f"{u}_rss_mib"], row[f"{u}_fds"] = proc(u + ".service")
    ss = subprocess.run(["ss", "-tn", "state", "established"], capture_output=True, text=True).stdout
    row["conns_to_strata"] = sum(1 for ln in ss.splitlines() if ":18080" in ln)
    row["db_mb"] = round(sum(f.stat().st_size for f in (HOME / "state").glob("outcrop.db*")) / 1e6, 2)
    return row


end = time.time() + a.hours * 3600
rows, n, errors = [snapshot()], 0, 0
next_snap = time.time() + 600
Path(a.csv).parent.mkdir(parents=True, exist_ok=True)
with open(a.csv, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerow(rows[0])
    f.flush()
    while time.time() < end:
        n += 1
        chat = {"model": "x", "max_tokens": 8, "messages": [{"role": "user", "content": f"Say {n}."}], **NOTHINK}
        codes = [req("http://127.0.0.1:8080/v1/chat/completions", {**chat, "stream": True})[0],
                 req("http://127.0.0.1:8080/v1/chat/completions", chat)[0],
                 req("http://127.0.0.1:11434/api/chat", {"model": "qwen3.8-flash-next", "stream": False, "think": False,
                                                         "messages": [{"role": "user", "content": "Say hi."}],
                                                         "options": {"num_predict": 8}})[0],
                 req("http://127.0.0.1:8080/v1/models")[0]]
        errors += sum(1 for c in codes if c != 200)
        if n % 10 == 0:
            try:
                hang_up()
            except OSError:
                errors += 1
            if req("http://127.0.0.1:8080/v1/models", headers={**H, "Authorization": "Bearer wrong-key"})[0] != 401:
                errors += 1
        if time.time() >= next_snap:
            rows.append(snapshot())
            w.writerow(rows[-1])
            f.flush()
            next_snap += 600
        time.sleep(a.every)
rows.append(snapshot())
first, last = rows[0], rows[-1]
print(f"{n} rounds over {a.hours} h, {errors} unexpected answers")
for k in first:
    if k != "t" and isinstance(first[k], (int, float)) and isinstance(last[k], (int, float)):
        print(f"  {k:28s} {first[k]:>8} -> {last[k]:>8}")
sys.exit(1 if errors else 0)
