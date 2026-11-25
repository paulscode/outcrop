#!/usr/bin/env python3
"""concurrent.py --url URL [--streams 1,2,4] [--tokens N] [--rounds N] [--json FILE]  - total throughput with several
conversations at once: N requests sent together (greedy, thinking off, different prompts), each one's decode rate from
the engine's own timings, and the total of tokens written over the wall time from the first request to the last
answer.  For a preset with "parallel" (Strata's --batch): with one slot, the requests simply queue.

$OUTCROP_API_KEY is the token (as quickbench.py)."""
import argparse
import json
import os
import statistics
import threading
import time
import urllib.request

PROMPTS = [
    "Explain how a hash table finds a value, including collisions and one small example.",
    "Write a Python function that merges two sorted lists, with a short explanation of its complexity.",
    "Describe how a bicycle's gears change the effort needed to pedal uphill.",
    "Summarize the causes of the seasons on Earth for a ten-year-old.",
    "Write a short story about a robot that learns to paint.",
    "Explain the difference between TCP and UDP with one use case each.",
    "Give a recipe for a simple vegetable soup, step by step.",
    "Explain what a binary search does and when it fails.",
]

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="http://127.0.0.1:8080")
ap.add_argument("--streams", default="1,2,4")
ap.add_argument("--tokens", type=int, default=256)
ap.add_argument("--rounds", type=int, default=3)
ap.add_argument("--json")
a = ap.parse_args()
KEY = os.environ.get("OUTCROP_API_KEY")


def one(i: int, out: list) -> None:
    try:
        _one(i, out)
    except Exception as e:                  # noqa: BLE001  (recorded: a run with failures says how many)
        out.append({"stream": i, "error": f"{type(e).__name__}: {e}"})


def _one(i: int, out: list) -> None:
    body = {"model": "x", "messages": [{"role": "user", "content": PROMPTS[i % len(PROMPTS)]}], "max_tokens": a.tokens,
            "temperature": 0, "stream": False, "chat_template_kwargs": {"enable_thinking": False}}
    h = {"Content-Type": "application/json", **({"Authorization": f"Bearer {KEY}"} if KEY else {})}
    t0 = time.monotonic()
    req = urllib.request.Request(a.url + "/v1/chat/completions", json.dumps(body).encode(), h)
    with urllib.request.urlopen(req, timeout=1800) as r:
        d = json.loads(r.read())
    t = d.get("timings") or {}
    n = t.get("predicted_n") or (d.get("usage") or {}).get("completion_tokens") or 0
    out.append({"stream": i, "tokens": n, "decode_tps": t.get("predicted_per_second"), "start": t0, "end": time.monotonic()})


res = {}
for n in [int(x) for x in a.streams.split(",")]:
    rounds = []
    for r in range(a.rounds):
        got: list = []
        th = [threading.Thread(target=one, args=(r * n + i, got)) for i in range(n)]
        for x in th:
            x.start()
        for x in th:
            x.join()
        okay = [g for g in got if "error" not in g]
        if not okay:
            rounds.append({"streams": got, "wall_s": None, "total_tps": 0.0, "per_stream_tps": [], "failed": len(got)})
            continue
        wall = max(g["end"] for g in okay) - min(g["start"] for g in okay)
        total = sum(g["tokens"] for g in okay)
        rounds.append({"streams": got, "wall_s": round(wall, 2), "total_tps": round(total / wall, 1),
                       "per_stream_tps": [round(g["decode_tps"] or 0, 1) for g in okay], "failed": len(got) - len(okay)})
    med = statistics.median(x["total_tps"] for x in rounds)
    res[n] = {"rounds": rounds, "total_tps_median": med}
    bad = sum(x["failed"] for x in rounds)
    print(f"{n} stream(s): total {med} tok/s (rounds {[x['total_tps'] for x in rounds]}), per stream "
          f"{[x['per_stream_tps'] for x in rounds]}" + (f", {bad} request(s) FAILED" if bad else ""), flush=True)
if a.json:
    json.dump(res, open(a.json, "w"), indent=1)
