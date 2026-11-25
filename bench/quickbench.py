#!/usr/bin/env python3
"""Quick repeatable speed check against a running Strata server: greedy, thinking off, fixed prompts.

    quickbench.py [--url URL] [--tokens N] [--repeat N] [--cases a,b] [--json FILE]

Rates come from the engine's own `timings`.  This is a comparison tool for A/B runs on one machine, not the community
protocol; `strata bench run` remains the comparable measurement.
"""
import argparse
import json
import statistics
import time
import urllib.request

CASES = {
    "chat": "Explain how a hash table finds a value, including collisions and one small example.",
    "code": "Write a Python class implementing an LRU cache with get and put methods, using a dict and a doubly linked list. "
            "Include type hints and a short usage example.",
    "story": "Write a short story about a lighthouse keeper who discovers a message in a bottle.",
    "doc4k": "".join(f"record{i:06d}: alpha beta gamma delta epsilon zeta eta theta.\n" for i in range(1, 212))
             + "Summarize the structure of these records and explain how to look up a record by its ID.",
    "doc16k": "".join(f"record{i:06d}: alpha beta gamma delta epsilon zeta eta theta.\n" for i in range(1, 859))
              + "Summarize the structure of these records and explain how to look up a record by its ID.",
    "doc48k": "".join(f"record{i:06d}: alpha beta gamma delta epsilon zeta eta theta.\n" for i in range(1, 2501))
              + "Summarize the structure of these records and explain how to look up a record by its ID.",
    # about 190K tokens: for the 1M-token presets, past what their attention cache keeps on the card
    "doc192k": "".join(f"record{i:06d}: alpha beta gamma delta epsilon zeta eta theta.\n" for i in range(1, 10001))
               + "Summarize the structure of these records and explain how to look up a record by its ID.",
}

def default_key():
    """$OUTCROP_API_KEY, else the local-tools token outcrop keeps in ~/.outcrop/state/local_token (none if neither exists)."""
    import os
    from pathlib import Path
    k = os.environ.get("OUTCROP_API_KEY")
    if k:
        return k
    try:
        return (Path(os.environ.get("OUTCROP_HOME") or Path.home() / ".outcrop") / "state" / "local_token").read_text().strip() or None
    except OSError:
        return None


ap = argparse.ArgumentParser()
ap.add_argument("--url", default="http://127.0.0.1:8080")
ap.add_argument("--key", default=default_key(), help="API token (default: $OUTCROP_API_KEY or ~/.outcrop/state/local_token)")
ap.add_argument("--tokens", type=int, default=256)
ap.add_argument("--repeat", type=int, default=3)
ap.add_argument("--cases", default="chat,code,story,doc4k")
ap.add_argument("--json")
ap.add_argument("--print-text", action="store_true")
a = ap.parse_args()


def run(prompt, marker):
    body = {"model": "x", "messages": [{"role": "user", "content": f"[{marker}]\n{prompt}"}], "max_tokens": a.tokens, "stream": True,
            "temperature": 0, "presence_penalty": 0, "chat_template_kwargs": {"enable_thinking": False},
            "stream_options": {"include_usage": True}}
    req = urllib.request.Request(a.url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json",
                                 **({"Authorization": f"Bearer {a.key}"} if a.key else {})})
    t0 = time.monotonic()
    first = None
    text, timings, usage = [], {}, {}
    with urllib.request.urlopen(req, timeout=7200) as r:      # a 190K-token prompt on a slow card: up to an hour
        for raw in r:
            if not raw.startswith(b"data: ") or raw.startswith(b"data: [DONE]"):
                continue
            d = json.loads(raw[6:])
            timings = d.get("timings") or timings
            usage = d.get("usage") or usage
            for ch in d.get("choices") or []:
                c = (ch.get("delta") or {}).get("content") or (ch.get("delta") or {}).get("reasoning_content")
                if c:
                    first = first or time.monotonic()
                    text.append(c)
    return {"prompt_n": timings.get("prompt_n"), "prompt_tps": timings.get("prompt_per_second"), "decode_n": timings.get("predicted_n"),
            "decode_tps": timings.get("predicted_per_second"), "ttft_s": (first or t0) - t0, "total_s": time.monotonic() - t0, "text": "".join(text)}


out = {}
for name in a.cases.split(","):
    rows = [run(CASES[name], f"{name}-{time.time_ns()}") for _ in range(a.repeat)]
    out[name] = rows
    d = [r["decode_tps"] for r in rows if r["decode_tps"]]
    p = [r["prompt_tps"] for r in rows if r["prompt_tps"]]
    print(f"{name:6s} prompt {rows[0]['prompt_n']:>5} tok: {statistics.median(p) if p else 0:7.1f} tok/s   "
          f"decode {statistics.median(d) if d else 0:6.1f} tok/s  (runs {' '.join(f'{x:.1f}' for x in d)})   ttft {rows[-1]['ttft_s']:.2f}s", flush=True)
    if a.print_text:
        print("   >>", rows[-1]["text"][:600].replace("\n", " "))
if a.json:
    json.dump(out, open(a.json, "w"), indent=1)
