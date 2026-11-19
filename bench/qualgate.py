#!/usr/bin/env python3
"""qualgate.py [--url URL]  - a small answer-quality gate for kernel and quantization changes.

Not an evaluation of the model: it only catches a change that breaks arithmetic.  Each prompt has a machine-checkable answer,
and a needle test checks that long-context recall still works.  Exit 0 only if every check passes.
"""
import argparse
import json
import re
import sys
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
a = ap.parse_args()


def ask(prompt, tokens=64):
    body = {"model": "x", "messages": [{"role": "user", "content": prompt}], "max_tokens": tokens, "temperature": 0,
            "presence_penalty": 0, "chat_template_kwargs": {"enable_thinking": False}}
    req = urllib.request.Request(a.url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json",
                                 **({"Authorization": f"Bearer {a.key}"} if a.key else {})})
    with urllib.request.urlopen(req, timeout=1800) as r:
        return json.load(r)["choices"][0]["message"].get("content") or ""


records = "".join(f"record{i:06d}: alpha beta gamma delta epsilon zeta eta theta.\n" for i in range(1, 212))
needle = records.split("\n")
needle.insert(105, "access_code = ORBIT-731")
needle = "\n".join(needle)
CHECKS = [
    ("capital", "What is the capital of France? Answer with one word.", r"\bParis\b"),
    ("math", "What is 17 times 23? Reply with only the number.", r"\b391\b"),
    ("json", "Return only a JSON object with ok set to true and count set to the integer 3. No other keys.", r'"count"\s*:\s*3'),
    ("sort", "Sort these integers in ascending order and remove duplicates: 9, 2, -4, 2, 1. Return only a JSON array.", r"-4,\s*1,\s*2,\s*9"),
    ("prime", "Write a Python function is_prime(n). Only the code.", r"def is_prime"),
    ("needle-4k", needle + "\nWhat is access_code? Reply only with its value.", r"ORBIT-731"),
]
fails = 0
for name, prompt, want in CHECKS:
    got = ask(prompt, 128 if name == "prime" else 48)
    ok = re.search(want, got) is not None
    fails += not ok
    print(f"{'PASS' if ok else 'FAIL'} {name:10s} {got[:70]!r}", flush=True)
print("QUALITY_OK" if fails == 0 else f"QUALITY_FAIL {fails}")
sys.exit(1 if fails else 0)
