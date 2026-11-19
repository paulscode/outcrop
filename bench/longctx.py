#!/usr/bin/env python3
"""longctx.py [--url URL] [--tokens N] [--depth 0.5] [--json FILE]  - one long-context check against a running server.

Builds a document of about N tokens (numbered records, each with a different fact), hides one key at the given depth, and asks
for it.  Prints prompt size, prompt speed, time to first token, decode speed and whether the answer is right.  Greedy, thinking
off.  At about 200 prompt tokens/s on this card, 250,000 tokens take about 20 minutes.
"""
import argparse
import json
import random
import time
import urllib.request

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
ap.add_argument("--tokens", type=int, default=100000)
ap.add_argument("--depth", type=float, default=0.5)
ap.add_argument("--seed", type=int, default=7)
ap.add_argument("--json")
a = ap.parse_args()

rng = random.Random(a.seed)
CITIES = ["Lisbon", "Osaka", "Quito", "Tallinn", "Accra", "Perth", "Bergen", "Cusco", "Hanoi", "Lyon", "Tbilisi", "Windhoek"]
ITEMS = ["copper wire", "maple syrup", "glass beads", "wool socks", "tin cans", "rice paper", "brass hinges", "olive oil"]
# about 38 tokens a line with this tokenizer (measured: 9,615 lines made 367,834 tokens); a prompt the server finds too long
# for the context is rebuilt shorter, from the token count in its refusal
lines = [f"Record {i:07d}: shipment of {rng.randint(2, 900)} crates of {rng.choice(ITEMS)} left {rng.choice(CITIES)} "
         f"on day {rng.randint(1, 365)} with code {rng.randint(10000, 99999)}." for i in range(int(a.tokens / 38.3))]
key = f"{rng.choice(['AMBER', 'COBALT', 'SAFFRON', 'VIOLET'])}-{rng.randint(100, 999)}"
lines.insert(int(len(lines) * a.depth), f"Note for auditors: the vault access code is {key}.")
prompt = "\n".join(lines) + "\n\nWhat is the vault access code mentioned in the note for auditors? Reply with the code only."
body = {"model": "x", "messages": [{"role": "user", "content": prompt}], "max_tokens": 32, "temperature": 0, "stream": True,
        "chat_template_kwargs": {"enable_thinking": False}, "stream_options": {"include_usage": True}}
import re  # noqa: E402
import urllib.error  # noqa: E402
for _ in range(3):
    req = urllib.request.Request(a.url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json",
                                 **({"Authorization": f"Bearer {a.key}"} if a.key else {})})
    try:
        r = urllib.request.urlopen(req, timeout=4 * 3600)
        break
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="replace")
        m = re.search(r"prompt \((\d+) tokens\).*?context \((\d+)\)", msg)
        if e.code != 400 or not m:
            raise SystemExit(f"HTTP {e.code}: {msg[:300]}")
        keep = int(len(lines) * a.tokens / int(m.group(1)))      # the same share of lines as a.tokens is of what was sent
        print(f"prompt was {m.group(1)} tokens for a {m.group(2)}-token context: rebuilding with {keep} lines", flush=True)
        lines = [x for x in lines if not x.startswith("Note for auditors")][:keep]
        lines.insert(int(len(lines) * a.depth), f"Note for auditors: the vault access code is {key}.")
        prompt = "\n".join(lines) + "\n\nWhat is the vault access code mentioned in the note for auditors? Reply with the code only."
        body["messages"][0]["content"] = prompt
t0 = time.monotonic()
first, text, timings, usage = None, [], {}, {}
with r:
    for raw in r:
        if not raw.startswith(b"data: ") or raw.startswith(b"data: [DONE]"):
            continue
        d = json.loads(raw[6:])
        timings = d.get("timings") or timings
        usage = d.get("usage") or usage
        for ch in d.get("choices") or []:
            c = (ch.get("delta") or {}).get("content")
            if c:
                first = first or time.monotonic()
                text.append(c)
answer = "".join(text).strip()
res = {"prompt_tokens": usage.get("prompt_tokens") or timings.get("prompt_n"), "depth": a.depth, "key": key, "answer": answer,
       "correct": key in answer, "prompt_tps": timings.get("prompt_per_second"), "decode_tps": timings.get("predicted_per_second"),
       "ttft_s": round((first or time.monotonic()) - t0, 1), "total_s": round(time.monotonic() - t0, 1)}
print(json.dumps(res))
if a.json:
    with open(a.json, "a") as f:
        f.write(json.dumps(res) + "\n")
