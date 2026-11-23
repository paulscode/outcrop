#!/usr/bin/env python3
"""startos-soak.py [--minutes 25] [--conversations 4] --host YOUR-SERVER.local  - does a preset stay below StartOS's memory
line in use, not only at start?  Run from another computer, against the preset that runs now.

It rotates between several long conversations (each its own few-thousand-token document, growing a turn at a time), so
the engine keeps parking one conversation's state in its conversation cache to answer another: the cache fills as it
would with a few apps or chats in turn.  Meanwhile it samples the StartOS host every 5 s over ssh: the services' cgroup
(memory, anon, shmem, memory.high events, memory pressure) and IO pressure.  At the end it prints the worst moments and
writes bench/results/startos-soak-<host>-<date>.jsonl (one sample per line, the requests' timings among them).

The token comes from $OUTCROP_TOKEN_FILE (default ~/.config/outcrop-test/token), never from the command line.
"""
import argparse
import json
import os
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--minutes", type=float, default=25)
ap.add_argument("--conversations", type=int, default=4)
ap.add_argument("--host", default=os.environ.get("HOST"), required=not os.environ.get("HOST"),
                help="the StartOS server (or $HOST), e.g. YOUR-SERVER.local")
a = ap.parse_args()
TOKEN = Path(os.environ.get("OUTCROP_TOKEN_FILE") or Path.home() / ".config/outcrop-test/token").read_text().strip()
OUT = Path(__file__).resolve().parent / "results" / f"startos-soak-{a.host.split('.')[0]}-{time.strftime('%Y%m%d-%H%M', time.gmtime())}.jsonl"
SAMPLER = r'''
import json, time
def kv(p):
    return {l.split()[0]: int(l.split()[1]) for l in open(p) if len(l.split()) == 2}
def avg10(p, kind):
    for l in open(p):
        if l.startswith(kind):
            return float(l.split()[1].split("=")[1])
while True:
    st = kv("/sys/fs/cgroup/services.slice/memory.stat")
    print(json.dumps({"t": time.time(), "slice_gib": int(open("/sys/fs/cgroup/services.slice/memory.current").read()) / 2**30,
                      "anon_gib": st["anon"] / 2**30, "shmem_gib": st["shmem"] / 2**30, "file_gib": st["file"] / 2**30,
                      "high_events": kv("/sys/fs/cgroup/services.slice/memory.events")["high"],
                      "mem_full10": avg10("/sys/fs/cgroup/services.slice/memory.pressure", "full"),
                      "io_some10": avg10("/proc/pressure/io", "some")}), flush=True)
    time.sleep(5)
'''

samples, lock = [], threading.Lock()
# the sampler goes in on stdin: a multi-line `python3 -c` does not survive ssh's remote shell
proc = subprocess.Popen(["ssh", "-o", "BatchMode=yes", f"start9@{a.host}", "python3", "-u", "-"],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
proc.stdin.write(SAMPLER)
proc.stdin.close()


def read_samples():
    for ln in proc.stdout:
        try:
            s = json.loads(ln)
        except ValueError:
            continue
        with lock:
            samples.append(s)


threading.Thread(target=read_samples, daemon=True).start()


def doc(i: int) -> str:
    words = ["granite", "basalt", "shale", "quartz", "feldspar", "mica", "gneiss", "slate", "marble", "chalk"]
    return "".join(f"Field note {i}-{n:04d}: the {words[(i + n) % 10]} layer at depth {n * 3 + i} m shows "
                   f"{words[(i * 3 + n) % 10]} inclusions and a dip of {(n * 7 + i) % 90} degrees.\n" for n in range(180))


convs = [[{"role": "user", "content": doc(i) + "\nRead these field notes. Then answer briefly: which layer is at depth "
           f"{30 + i} m?"}] for i in range(a.conversations)]
ends = time.time() + a.minutes * 60
reqs, k = [], 0
print(f"soak: {a.conversations} conversations in turn for {a.minutes:g} min on {a.host}; samples every 5 s -> {OUT}")
while time.time() < ends:
    c = convs[k % len(convs)]
    body = {"model": "m", "messages": c, "max_tokens": 64, "temperature": 0,
            "chat_template_kwargs": {"enable_thinking": False}}
    t0 = time.time()
    try:
        req = urllib.request.Request(f"http://{a.host}:8080/v1/chat/completions", json.dumps(body).encode(),
                                     {"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
        r = json.load(urllib.request.urlopen(req, timeout=900))
        text = r["choices"][0]["message"]["content"] or ""
        usage = r.get("usage") or {}
        ok = True
    except Exception as e:  # noqa: BLE001 - a soak records failures, it does not stop at them
        text, usage, ok = f"{type(e).__name__}: {e}", {}, False
    dt = time.time() - t0
    reqs.append({"t": t0, "conv": k % len(convs), "turn": len(c) // 2 + 1, "ok": ok, "s": round(dt, 1),
                 "prompt_tokens": usage.get("prompt_tokens"), "cached": (usage.get("prompt_tokens_details") or {}).get("cached_tokens")})
    print(f"  conv {k % len(convs)} turn {len(c) // 2 + 1}: {'ok' if ok else 'FAILED'} {dt:.1f}s "
          f"prompt {usage.get('prompt_tokens')} cached {reqs[-1]['cached']}", flush=True)
    c += [{"role": "assistant", "content": text[:400]},
          {"role": "user", "content": f"And at depth {60 + k} m? One line."}]
    k += 1
time.sleep(6)
proc.terminate()
with lock:
    ss = list(samples)
with open(OUT, "w") as f:
    for s in ss:
        f.write(json.dumps({"kind": "sample", **s}) + "\n")
    for r in reqs:
        f.write(json.dumps({"kind": "request", **r}) + "\n")
if ss:
    worst = max(ss, key=lambda s: s["slice_gib"])
    print(f"samples {len(ss)}: slice max {worst['slice_gib']:.2f} GiB (anon {worst['anon_gib']:.2f}, shmem "
          f"{worst['shmem_gib']:.2f}); shmem max {max(s['shmem_gib'] for s in ss):.2f} GiB; memory.high events "
          f"+{ss[-1]['high_events'] - ss[0]['high_events']}; memory full avg10 max {max(s['mem_full10'] for s in ss):.1f}%; "
          f"IO some avg10 max {max(s['io_some10'] for s in ss):.1f}%")
print(f"requests {len(reqs)}, failed {sum(not r['ok'] for r in reqs)}, slowest {max((r['s'] for r in reqs), default=0):.0f} s")
