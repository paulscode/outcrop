#!/usr/bin/env python3
"""overhead.py --a URL --b URL [--n 30]  - the gateway's cost: first-token time and decode speed, A against B, interleaved.

Each round sends the same short streamed request (greedy, thinking off) to A then B; first token is the first content chunk.
--key defaults to $OUTCROP_API_KEY or ~/.outcrop/state/local_token (sent to both; a server without a key ignores it).
"""
import argparse
import json
import os
import statistics
import time
import urllib.request
from pathlib import Path


def default_key():
    k = os.environ.get("OUTCROP_API_KEY")
    if k:
        return k
    try:
        return (Path(os.environ.get("OUTCROP_HOME") or Path.home() / ".outcrop") / "state" / "local_token").read_text().strip() or None
    except OSError:
        return None


ap = argparse.ArgumentParser()
ap.add_argument("--a", required=True, help="e.g. http://127.0.0.1:18080 (Strata direct)")
ap.add_argument("--b", required=True, help="e.g. http://127.0.0.1:8080 (through the gateway)")
ap.add_argument("--key-a", default=None)
ap.add_argument("--key-b", default=None)
ap.add_argument("--n", type=int, default=30)
ap.add_argument("--tokens", type=int, default=64)
a = ap.parse_args()
KA = a.key_a or default_key()
KB = a.key_b or default_key()


def one(url, key):
    body = {"model": "x", "stream": True, "max_tokens": a.tokens, "temperature": 0,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "user", "content": "Count from one to forty in words, separated by commas."}]}
    h = {"Content-Type": "application/json", **({"Authorization": f"Bearer {key}"} if key else {})}
    req = urllib.request.Request(url + "/v1/chat/completions", json.dumps(body).encode(), h)
    t0 = time.perf_counter()
    first = None
    n = 0
    with urllib.request.urlopen(req, timeout=300) as r:
        for line in r:
            if not line.startswith(b"data: ") or line.strip() == b"data: [DONE]":
                continue
            d = json.loads(line[6:])
            for ch in d.get("choices") or []:
                if (ch.get("delta") or {}).get("content"):
                    n += 1
                    if first is None:
                        first = time.perf_counter()
    end = time.perf_counter()
    return (first - t0) * 1000, (n - 1) / (end - first) if n > 1 else 0.0


one(a.a, KA), one(a.b, KB)            # warm-up
res = {"a": [], "b": []}
for i in range(a.n):
    order = (("a", a.a, KA), ("b", a.b, KB)) if i % 2 == 0 else (("b", a.b, KB), ("a", a.a, KA))
    for k, url, key in order:
        res[k].append(one(url, key))
for k, url in (("a", a.a), ("b", a.b)):
    ft = [x[0] for x in res[k]]
    ds = [x[1] for x in res[k]]
    print(f"{k} {url:28s} first token median {statistics.median(ft):7.1f} ms (p10 {sorted(ft)[len(ft) // 10]:.1f}, "
          f"p90 {sorted(ft)[len(ft) * 9 // 10]:.1f})   chunks/s median {statistics.median(ds):5.1f}")
d_ft = statistics.median([x[0] for x in res["b"]]) - statistics.median([x[0] for x in res["a"]])
d_ds = statistics.median([x[1] for x in res["b"]]) / max(1e-9, statistics.median([x[1] for x in res["a"]])) - 1
print(f"b - a: first token {d_ft:+.1f} ms, stream rate {d_ds * 100:+.1f}%")
