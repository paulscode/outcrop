#!/usr/bin/env python3
"""apitest.py [--host 192.168.1.20] [--port 8080] [--ollama-port 11434] [--key TOKEN] [--fast]  - check every API an app
might use.  --key defaults to $OUTCROP_API_KEY or the local-tools token in ~/.outcrop/state/local_token; --no-key sends none.

OpenAI chat (plain, streamed, a tool call, a picture), OpenAI Responses, Anthropic Messages, and the Ollama bridge (tags, chat
streamed and not, generate).  Thinking is off for speed except in one check.  Exit 0 only if every check passes.
"""
import argparse
import base64
import json
import struct
import sys
import time
import urllib.request
import zlib


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
ap.add_argument("--host", default="127.0.0.1")
ap.add_argument("--port", type=int, default=8080)
ap.add_argument("--ollama-port", type=int, default=11434)
ap.add_argument("--fast", action="store_true", help="skip the thinking and picture checks")
ap.add_argument("--key", default=default_key(), help="API token (default: $OUTCROP_API_KEY or ~/.outcrop/state/local_token)")
ap.add_argument("--no-key", action="store_true", help="send no token (to check that the server refuses, or in open mode)")
a = ap.parse_args()
AUTH = {"Authorization": f"Bearer {a.key}"} if a.key and not a.no_key else {}
BASE = f"http://{a.host}:{a.port}"
OLL = f"http://{a.host}:{a.ollama_port}"
NOTHINK = {"chat_template_kwargs": {"enable_thinking": False}}


def post(url, body, headers=None, stream=False, timeout=600):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json", **AUTH, **(headers or {})})
    r = urllib.request.urlopen(req, timeout=timeout)
    return r if stream else json.load(r)


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=AUTH), timeout=30) as r:
        return json.load(r)


def png(w=64, h=64, rgb=(220, 20, 20)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)  # noqa: E731
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + \
        chunk(b"IEND", b"")


results = []


def check(name, fn):
    t0 = time.time()
    try:
        ok, info = fn()
    except Exception as e:  # report and go on
        ok, info = False, f"{type(e).__name__}: {e}"
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'} {name:28s} {time.time() - t0:6.1f}s  {str(info)[:110]!r}", flush=True)


def models():
    d = get(BASE + "/v1/models")
    ids = [m["id"] for m in d["data"]]
    return any(i.startswith("qwen3.8-flash-next") for i in ids), ids


def chat_plain():
    r = post(BASE + "/v1/chat/completions", {"model": "anything", "messages": [{"role": "user", "content": "What is 12*12? Answer with the number only."}],
                                              "max_tokens": 20, **NOTHINK})
    t = r["choices"][0]["message"]["content"]
    return "144" in t, t


def chat_stream():
    r = post(BASE + "/v1/chat/completions", {"model": "x", "stream": True, "max_tokens": 30, **NOTHINK,
                                              "messages": [{"role": "user", "content": "Say the word 'banana' and nothing else."}]}, stream=True)
    text = ""
    for raw in r:
        if raw.startswith(b"data: ") and not raw.startswith(b"data: [DONE]"):
            for ch in json.loads(raw[6:]).get("choices") or []:
                text += (ch.get("delta") or {}).get("content") or ""
    return "banana" in text.lower(), text


def chat_thinking():
    r = post(BASE + "/v1/chat/completions", {"model": "x", "max_tokens": 1500,
                                              "messages": [{"role": "user", "content": "Which is larger, 9.11 or 9.9? Reply with the number."}]})
    m = r["choices"][0]["message"]
    return "9.9" in (m.get("content") or "") and bool(m.get("reasoning_content")), (m.get("content") or "")[-60:]


def chat_tools():
    tools = [{"type": "function", "function": {"name": "get_weather", "description": "Current weather for a city",
                                                "parameters": {"type": "object", "properties": {"city": {"type": "string"}},
                                                               "required": ["city"]}}}]
    r = post(BASE + "/v1/chat/completions", {"model": "x", "max_tokens": 200, "tools": tools, **NOTHINK,
                                              "messages": [{"role": "user", "content": "What is the weather in Zagreb right now? Use the tool."}]})
    calls = r["choices"][0]["message"].get("tool_calls") or []
    ok = bool(calls) and calls[0]["function"]["name"] == "get_weather" and "zagreb" in calls[0]["function"]["arguments"].lower()
    return ok, calls[0]["function"] if calls else r["choices"][0]["message"].get("content")


def chat_picture():
    b64 = base64.b64encode(png()).decode()
    r = post(BASE + "/v1/chat/completions", {"model": "x", "max_tokens": 30, **NOTHINK, "messages": [{"role": "user", "content": [
        {"type": "text", "text": "What color is this image? One word."},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}]})
    t = r["choices"][0]["message"]["content"]
    return "red" in t.lower(), t


def responses():
    r = post(BASE + "/v1/responses", {"model": "x", "input": "What is the capital of Japan? One word.", "max_output_tokens": 300,
                                       "reasoning": {"effort": "none"}})
    t = r.get("output_text") or "".join(c.get("text", "") for o in r.get("output", []) for c in o.get("content", []) or [])
    return "tokyo" in t.lower(), t


def anthropic():
    r = post(BASE + "/v1/messages", {"model": "claude-x", "max_tokens": 300, "thinking": {"type": "disabled"},
                                      "messages": [{"role": "user", "content": "What is the capital of Italy? One word."}]},
             {"x-api-key": "anything", "anthropic-version": "2023-06-01"})
    t = "".join(c.get("text", "") for c in r.get("content", []) if c.get("type") == "text")
    return "rome" in t.lower(), t


def ollama_tags():
    d = get(OLL + "/api/tags")
    names = [m["name"] for m in d["models"]]
    return bool(names), names


def ollama_chat():
    d = post(OLL + "/api/chat", {"model": "qwen3.8-flash-next:latest", "stream": False, "think": False,
                                 "messages": [{"role": "user", "content": "What is 7+8? Number only."}], "options": {"num_predict": 20}})
    return "15" in d["message"]["content"] and d["done"], d["message"]["content"]


def ollama_chat_stream():
    r = post(OLL + "/api/chat", {"model": "qwen3.8-flash-next:latest", "think": False,
                                 "messages": [{"role": "user", "content": "Name a primary color. One word."}]}, stream=True)
    text, done = "", False
    for line in r:
        d = json.loads(line)
        text += d.get("message", {}).get("content", "")
        done = done or d.get("done")
    return done and len(text.strip()) > 0, text


def ollama_generate():
    d = post(OLL + "/api/generate", {"model": "qwen3.8-flash-next:latest", "prompt": "Complete: The quick brown fox jumps over the lazy",
                                     "stream": False, "think": False, "options": {"num_predict": 10}})
    return "dog" in d["response"].lower(), d["response"]


def ollama_openai_passthrough():
    r = post(OLL + "/v1/chat/completions", {"model": "x", "max_tokens": 10, **NOTHINK, "messages": [{"role": "user", "content": "Say OK."}]})
    return "ok" in r["choices"][0]["message"]["content"].lower(), r["choices"][0]["message"]["content"]


check("GET /v1/models", models)
check("chat completion", chat_plain)
check("chat streamed", chat_stream)
check("chat tool call", chat_tools)
if not a.fast:
    check("chat thinking", chat_thinking)
    check("chat picture", chat_picture)
check("responses API", responses)
check("anthropic messages", anthropic)
check("ollama /api/tags", ollama_tags)
check("ollama /api/chat", ollama_chat)
check("ollama /api/chat streamed", ollama_chat_stream)
check("ollama /api/generate", ollama_generate)
check("ollama /v1 passthrough", ollama_openai_passthrough)
print(f"{sum(results)} of {len(results)} passed")
sys.exit(0 if all(results) else 1)
