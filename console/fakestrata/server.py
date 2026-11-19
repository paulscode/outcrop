"""A fake Strata server for tests and UI development: same routes and formats, no GPU.

Like Strata 0.2.11's serve/server.py it answers HTTP/1.0 and closes every connection, takes one request at a time (others
wait and get keep-alives), streams OpenAI, Anthropic and Responses SSE with keep-alives while it "reads the prompt", keeps the
last requests in /metrics, and cancels a request within ~0.2 s of its client hanging up (counted in
/v1/telemetry work.client_disconnect_cancels).

Test controls (no key needed, fake only):
  POST /_fake/config {"prefill_tps": 2000, "decode_tps": 200, "loaded": true, "think_tokens": 0, "fail_next": 500, ...}
  GET  /_fake/seen      the last requests' method, path and headers as received
  POST /_fake/reset

  python -m fakestrata.server --port 18080 [--api-key KEY] [--slow]
"""
from __future__ import annotations

import argparse
import json
import re
import select
import socket
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FIX = Path(__file__).resolve().parent / "fixtures"


class State:
    def __init__(self, api_key=None, model="qwen3.8-flash-next", preset="quality"):
        self.api_key = api_key if isinstance(api_key, list) else ([api_key] if api_key else [])
        self.model = model
        self.preset = preset
        self.cfg = {"prefill_tps": 4000.0, "decode_tps": 400.0, "loaded": True, "think_tokens": 0, "answer_tokens": 12,
                    "fail_next": 0, "first_delay_s": 0.0, "keepalive_s": 0.2}
        self.lock = threading.Lock()          # one request at a time, like parallel: 1
        self.records: list[dict] = []
        self.seen: list[dict] = []
        self.cancels = 0
        self.totals = {"requests": 0, "prompt_tokens": 0, "output_tokens": 0}
        self.live = {"state": "idle", "prompt_read": None, "prompt_total": None, "generated": None}
        self.queued = 0
        self.boot = time.time()

    def metrics(self) -> dict:
        base = json.loads((FIX / "metrics.json").read_text())
        base["requests"] = self.records[-12:]
        base["live"] = {**base.get("live", {}), **self.live, "queued": self.queued}
        base["totals"] = {**base.get("totals", {}), **self.totals}
        base["time"] = time.time()
        return base

    def telemetry(self) -> dict:
        t = json.loads((FIX / "telemetry.json").read_text())
        t["sampled_at"] = time.time()
        t["model"]["loaded"] = self.cfg["loaded"]
        t["work"]["client_disconnect_cancels"] = self.cancels
        t["work"]["queued"] = self.queued
        t["work"]["active"] = 1 if self.live["state"] != "idle" else 0
        t["totals"] = {**t.get("totals", {}), **self.totals}
        t["recent"] = [{k: r.get(k) for k in ("id", "time", "duration_s", "finish", "prompt_tokens", "reused",
                                               "output_tokens", "prompt_ms", "decode_ms")} for r in self.records[-12:]][::-1]
        return t


class Gone(Exception):
    pass


def make_handler(st: State):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"
        server_version = "BaseHTTP/0.6"

        def log_message(self, *a):
            pass

        # -------------------------------------------------------------------------------------------------- helpers
        def _see(self):
            st.seen.append({"method": self.command, "path": self.path, "headers": dict(self.headers.items()),
                            "at": time.time()})
            del st.seen[:-50]

        def _json(self, code, obj, headers=None):
            b = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def _authorized(self) -> bool:
            if not st.api_key:
                return True
            a = self.headers.get("Authorization", "")
            given = a[7:].strip() if a.lower().startswith("bearer ") else self.headers.get("x-api-key", "")
            if given in st.api_key:
                return True
            self._json(401, {"error": {"type": "authentication_error", "message": "missing or wrong API key"}})
            return False

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            try:
                return json.loads(raw or b"{}")
            except ValueError:
                return {}

        def _client_gone(self) -> bool:
            try:
                r, _, _ = select.select([self.connection], [], [], 0)
                if r:
                    data = self.connection.recv(1, socket.MSG_PEEK)
                    return data == b""
            except OSError:
                return True
            return False

        def _write(self, b: bytes):
            try:
                self.wfile.write(b)
                self.wfile.flush()
            except OSError:
                raise Gone() from None

        def _sleep_watch(self, seconds: float, beat=None):
            """Sleep, sending keep-alives every keepalive_s if `beat`, and notice a client that left."""
            end = time.time() + seconds
            nxt = time.time() + st.cfg["keepalive_s"]
            while time.time() < end:
                if self._client_gone():
                    raise Gone()
                time.sleep(min(0.02, max(0.0, end - time.time())))
                if beat and time.time() >= nxt:
                    self._write(beat)
                    nxt = time.time() + st.cfg["keepalive_s"]

        # ----------------------------------------------------------------------------------------------------- GET
        def do_GET(self):
            self._see()
            path = self.path.split("?")[0].rstrip("/")
            if path == "/_fake/seen":
                return self._json(200, st.seen)
            if path == "":
                b = (b'<!doctype html>\n<html lang="en" data-theme="light">\n<head>\n<title>Strata</title>\n</head>\n'
                     b"<body><p>fake strata page</p></body></html>")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
                return
            if path.startswith("/web/"):
                b = b"/* asset */"
                self.send_response(200)
                self.send_header("Content-Type", "text/css")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
                return
            if path in ("/health", "/api/health"):
                return self._json(200, {"status": "ok", "max_context": 262144, "model": st.model, "images": True,
                                        "api_key": bool(st.api_key), "image_generation": False,
                                        "loaded": st.cfg["loaded"], "service": "strata"})
            if not self._authorized():
                return
            if path in ("/v1/models", "/models"):
                m = {"id": st.model, "object": "model", "meta": {"n_ctx": 262144},
                     "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]},
                     "aliases": [f"{st.model}:{st.preset}"]}
                data = [m, {**m, "id": f"{st.model}:{st.preset}", "alias_of": st.model}] if st.cfg["loaded"] else []
                return self._json(200, {"object": "list", "data": data})
            if path == "/metrics":
                return self._json(200, st.metrics())
            if path == "/metrics/prometheus":
                b = (FIX / "prom.txt").read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; version=0.0.4")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
                return
            if path == "/v1/telemetry":
                return self._json(200, st.telemetry())
            if path in ("/v1/status", "/status", "/slots", "/props", "/settings", "/config", "/mcp"):
                return self._json(200, {"path": path, "busy": st.live["state"] != "idle"})
            return self._json(404, {"error": {"message": "not found"}})

        # ---------------------------------------------------------------------------------------------------- POST
        def do_POST(self):
            self._see()
            path = self.path.split("?")[0].rstrip("/")
            req = self._body()
            if st.seen and isinstance(req, dict):
                st.seen[-1]["body_keys"] = sorted(req)
            if path == "/_fake/config":
                if "preset" in req:
                    st.preset = str(req.pop("preset"))
                st.cfg.update(req)
                return self._json(200, {**st.cfg, "preset": st.preset})
            if path == "/_fake/reset":
                st.records.clear(); st.seen.clear(); st.cancels = 0
                return self._json(200, {"ok": True})
            if not self._authorized():
                return
            if path in ("/load", "/unload", "/settings", "/config", "/v1/vram", "/v1/load", "/v1/unload"):
                return self._json(200, {"status": "ok", "path": path})
            if path == "/v1/messages/count_tokens":
                return self._json(200, {"input_tokens": self._prompt_tokens(req)})
            if path not in ("/v1/chat/completions", "/v1/messages", "/v1/responses"):
                return self._json(404, {"error": {"message": "not found"}})
            if st.cfg.get("fail_next"):
                code = int(st.cfg["fail_next"])
                st.cfg["fail_next"] = 0
                return self._json(code, {"error": {"type": "server_error", "message": "fake failure"}})
            self._generate(path, req)

        def _prompt_tokens(self, req) -> int:
            text = json.dumps(req.get("messages") or req.get("input") or "")
            return max(1, len(text) // 4)

        def _generate(self, path: str, req: dict):
            stream = bool(req.get("stream"))
            ptoks = self._prompt_tokens(req)
            n_think = int(st.cfg["think_tokens"])
            mt = req.get("max_tokens") or req.get("max_output_tokens") or req.get("max_completion_tokens")
            n_ans = int(st.cfg["answer_tokens"]) if not mt else max(1, min(int(st.cfg["answer_tokens"]), int(mt)))
            rid = uuid.uuid4().hex[:12]
            t_arrive = time.time()
            dialect = "anthropic" if path == "/v1/messages" else "responses" if path == "/v1/responses" else "openai"
            beat = b": keep-alive\n\n" if stream else None
            if stream:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
            st.queued += 1
            got = False
            try:
                while not got:
                    got = st.lock.acquire(timeout=0.05)
                    if not got:
                        if self._client_gone():
                            raise Gone()
                        if beat and time.time() - t_arrive > st.cfg["keepalive_s"]:
                            self._write(beat)
            except Gone:
                st.queued -= 1
                st.cancels += 1
                return
            st.queued -= 1
            out = 0
            finish = "stop"
            t_start = time.time()
            prompt_s = ptoks / float(st.cfg["prefill_tps"]) + float(st.cfg["first_delay_s"])
            try:
                st.live = {"state": "reading", "prompt_read": 0, "prompt_total": ptoks, "generated": 0}
                if stream:
                    self._write(self._start_event(dialect, rid, ptoks))
                self._sleep_watch(prompt_s, beat)
                st.live = {"state": "generating", "prompt_read": None, "prompt_total": None, "generated": 0}
                dt = 1.0 / float(st.cfg["decode_tps"])
                script = self._script(req) if dialect == "openai" else None
                words = (script["text"].split(" ") if script and script.get("text") is not None else None)
                n_out = n_think + (len(words) if words is not None else 0 if script else n_ans)
                for i in range(n_out):
                    self._sleep_watch(dt)
                    out += 1
                    st.live["generated"] = out
                    if stream:
                        piece = ("tok" + str(i) + " ") if (i < n_think or words is None) else \
                            (words[i - n_think] + (" " if i + 1 < n_out else ""))
                        self._write(self._delta(dialect, rid, i < n_think, piece))
                if script and script.get("call"):
                    finish = "tool_calls"
                    if stream:
                        self._write(self._sse({"id": "chatcmpl-" + rid, "object": "chat.completion.chunk", "model": st.model,
                                               "choices": [{"index": 0, "delta": {"tool_calls": [{
                                                   "index": 0, "id": "call_" + rid, "type": "function",
                                                   "function": script["call"]}]}, "finish_reason": None}]}))
                self._script_text = words
                t_end = time.time()
                rec = self._record(rid, t_arrive, t_start, t_end, ptoks, out, prompt_s, finish)
                if stream:
                    self._write(self._final(dialect, rid, ptoks, out, rec, finish))
                else:
                    self._json(200, self._whole(dialect, rid, ptoks, out, n_think, rec, finish))
            except Gone:
                st.cancels += 1
                self._record(rid, t_arrive, t_start, time.time(), ptoks, out, prompt_s, "cancel")
            finally:
                st.live = {"state": "idle", "prompt_read": None, "prompt_total": None, "generated": None}
                st.lock.release()

        def _record(self, rid, t_arrive, t_start, t_end, ptoks, out, prompt_s, finish) -> dict:
            dec = max(1e-6, t_end - t_start - prompt_s)
            rec = {"id": rid, "time": t_arrive, "duration_s": round(t_end - t_arrive, 3), "finish": finish,
                   "prompt_tokens": ptoks, "reused": 0, "output_tokens": out, "prompt_read": ptoks,
                   "prompt_ms": round(prompt_s * 1000, 1), "decode_ms": round(dec * 1000, 1),
                   "decode_tok_s": round(out / dec, 1) if out else 0.0, "hit_rate": 0.91, "pcie_share": 0.004,
                   "drafts_offered": out, "drafts_accepted": out // 2, "first_engine_token_s": round(prompt_s, 3)}
            st.records.append(rec)
            del st.records[:-100]
            st.totals["requests"] += 1
            st.totals["prompt_tokens"] += ptoks
            st.totals["output_tokens"] += out
            return rec

        def _script(self, req: dict) -> dict | None:
            """What the console's chat needs from a fake model: titles as JSON, summaries, and tool calls on cue.  A user
            message with [[call NAME {json}]] gets those calls, one per round; then an answer that says what the
            tools returned (so a test can see the results reached the model)."""
            msgs = req.get("messages") or []
            sys_text = " ".join(str(m.get("content")) for m in msgs if m.get("role") == "system")
            text_of = lambda m: m.get("content") if isinstance(m.get("content"), str) else " ".join(  # noqa: E731
                p.get("text", "") for p in m.get("content") or [] if isinstance(p, dict))
            if "You name chats" in sys_text:
                u = text_of(msgs[-1])
                m = re.search(r"^- (s[0-9a-f]+):", u, re.M)
                return {"text": json.dumps({"title": "Fake title " + str(len(u) % 97), "space": m.group(1) if m else None})}
            if "compact notes" in sys_text:
                return {"text": "- the goal: a fake summary"}
            last_user = max((i for i, m in enumerate(msgs) if m.get("role") == "user"), default=-1)
            if last_user < 0 or not req.get("tools"):
                return None
            calls = re.findall(r"\[\[call (\w+) (\{.*?\})\]\]", text_of(msgs[last_user]))
            done = [m for m in msgs[last_user + 1:] if m.get("role") == "tool"]
            if req.get("tool_choice") != "none" and len(done) < len(calls):
                name, args = calls[len(done)]                     # hxxp: a link the user did not write as a link
                return {"call": {"name": name, "arguments": args.replace("hxxp", "http")}, "text": None}
            if done and calls:
                return {"text": "Answer from the tools [1]. saw: " + " | ".join(str(m.get("content"))[:120] for m in done)}
            if not st.cfg.get("prose"):
                return None
            # development (--slow): search on its own when a question sounds like it needs the web, open the first
            # result, then answer in Markdown with citations
            q = text_of(msgs[last_user])
            if req.get("tool_choice") != "none" and re.search(r"(?i)\b(latest|today|news|current|price|weather|search|"
                                                             r"look up|this week|recent)\b", q):
                if not done:
                    return {"call": {"name": "web_search", "arguments": json.dumps({"query": q[:80]})}, "text": None}
                if len(done) == 1:
                    m = re.search(r"https?://\S+", str(done[0].get("content")))
                    if m:
                        return {"call": {"name": "open_page", "arguments": json.dumps({"url": m.group(0)})}, "text": None}
            return {"text": PROSE_WEB if done else PROSE}

        # ------------------------------------------------------------------------------------------------ formats
        def _sse(self, obj, event=None) -> bytes:
            return (f"event: {event}\n" if event else "").encode() + b"data: " + json.dumps(obj).encode() + b"\n\n"

        def _start_event(self, dialect, rid, ptoks) -> bytes:
            if dialect == "anthropic":
                return self._sse({"type": "message_start", "message": {
                    "id": "msg_" + rid, "type": "message", "role": "assistant", "model": st.model, "content": [],
                    "stop_reason": None, "usage": {"input_tokens": ptoks, "output_tokens": 0}}}, "message_start")
            if dialect == "responses":
                return self._sse({"type": "response.created", "response": {"id": "resp_" + rid, "object": "response",
                                                                           "status": "in_progress"}},
                                 "response.created")
            return self._sse({"id": "chatcmpl-" + rid, "object": "chat.completion.chunk", "model": st.model,
                              "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""},
                                           "finish_reason": None}]})

        def _delta(self, dialect, rid, thinking, text) -> bytes:
            if dialect == "anthropic":
                d = {"type": "thinking_delta", "thinking": text} if thinking else {"type": "text_delta", "text": text}
                return self._sse({"type": "content_block_delta", "index": 0 if thinking else 1, "delta": d},
                                 "content_block_delta")
            if dialect == "responses":
                t = "response.reasoning_text.delta" if thinking else "response.output_text.delta"
                return self._sse({"type": t, "delta": text}, t)
            d = {"reasoning_content": text} if thinking else {"content": text}
            return self._sse({"id": "chatcmpl-" + rid, "object": "chat.completion.chunk", "model": st.model,
                              "choices": [{"index": 0, "delta": d, "finish_reason": None}]})

        def _timings(self, ptoks, out, rec):
            return {"cache_n": 0, "prompt_n": ptoks, "prompt_ms": rec["prompt_ms"],
                    "prompt_per_second": round(ptoks / max(1e-6, rec["prompt_ms"] / 1000), 1), "predicted_n": out,
                    "predicted_per_second": rec["decode_tok_s"], "draft_n": rec["drafts_offered"],
                    "draft_n_accepted": rec["drafts_accepted"]}

        def _final(self, dialect, rid, ptoks, out, rec, finish) -> bytes:
            if dialect == "anthropic":
                return (self._sse({"type": "message_delta", "delta": {"stop_reason": "end_turn"},
                                   "usage": {"input_tokens": ptoks, "output_tokens": out}}, "message_delta")
                        + self._sse({"type": "message_stop"}, "message_stop"))
            if dialect == "responses":
                return self._sse({"type": "response.completed", "response": {
                    "id": "resp_" + rid, "object": "response", "status": "completed",
                    "usage": {"input_tokens": ptoks, "input_tokens_details": {"cached_tokens": 0},
                              "output_tokens": out}}, "timings": self._timings(ptoks, out, rec)}, "response.completed")
            return (self._sse({"id": "chatcmpl-" + rid, "object": "chat.completion.chunk", "model": st.model,
                               "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                               "usage": {"prompt_tokens": ptoks, "completion_tokens": out,
                                         "total_tokens": ptoks + out, "prompt_tokens_details": {"cached_tokens": 0}},
                               "timings": self._timings(ptoks, out, rec)}) + b"data: [DONE]\n\n")

        def _whole(self, dialect, rid, ptoks, out, n_think, rec, finish) -> dict:
            text = " ".join(f"tok{i}" for i in range(n_think, out)) + " "
            if getattr(self, "_script_text", None) is not None:
                text = " ".join(self._script_text)
            if dialect == "anthropic":
                content = ([{"type": "thinking", "thinking": "hmm", "signature": ""}] if n_think else []) + \
                          [{"type": "text", "text": text}]
                return {"id": "msg_" + rid, "type": "message", "role": "assistant", "model": st.model,
                        "content": content, "stop_reason": "end_turn",
                        "usage": {"input_tokens": ptoks, "output_tokens": out}}
            if dialect == "responses":
                return {"id": "resp_" + rid, "object": "response", "status": "completed", "model": st.model,
                        "output": [{"type": "message", "role": "assistant",
                                    "content": [{"type": "output_text", "text": text}]}],
                        "usage": {"input_tokens": ptoks, "input_tokens_details": {"cached_tokens": 0},
                                  "output_tokens": out}, "timings": self._timings(ptoks, out, rec)}
            return {"id": "chatcmpl-" + rid, "object": "chat.completion", "model": st.model,
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                                 "finish_reason": finish}],
                    "usage": {"prompt_tokens": ptoks, "completion_tokens": out, "total_tokens": ptoks + out,
                              "prompt_tokens_details": {"cached_tokens": 0}},
                    "timings": self._timings(ptoks, out, rec)}

    return H


PROSE = """Here is a short answer, written by the **fake model** for development.

## The idea

A slow drop usually has one of three causes:

1. a weeping valve,
2. the expansion vessel losing its charge,
3. a tiny leak somewhere in the pipework.

| Check | How | Time |
| --- | --- | --- |
| Valves | look for drips | 5 min |
| Vessel | tyre gauge on the Schrader valve | 10 min |

```python
def bar_to_psi(bar: float) -> float:
    return bar * 14.5038
```

The pressure follows $p = \\rho g h$ for the static part, so a metre of water is about 0.1 bar."""

PROSE_WEB = """According to the pages I read, the answer has two parts [1].

- The first source says the value changed this week [1].
- A second one adds the details and a date [2].

So, in short: it depends on the version you have, and the newest release fixes it [2]."""


class FakeStrata:
    """Run in a thread (tests) or as a program."""

    def __init__(self, host="127.0.0.1", port=0, api_key=None, preset="quality"):
        self.state = State(api_key, preset=preset)
        self.httpd = ThreadingHTTPServer((host, port), make_handler(self.state))
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.thread = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> "FakeStrata":
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        return self

    def set(self, **cfg) -> None:
        """Change how the fake behaves (speeds, token counts, fail_next...), as POST /_fake/config does."""
        self.state.cfg.update(cfg)

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18080)
    ap.add_argument("--api-key", action="append")
    ap.add_argument("--preset", default="quality")
    ap.add_argument("--slow", action="store_true", help="realistic speeds: 190 tok/s prefill, 40 tok/s decode")
    a = ap.parse_args()
    fs = FakeStrata(a.host, a.port, a.api_key, a.preset)
    if a.slow:
        fs.state.cfg.update(prefill_tps=190.0, decode_tps=40.0, answer_tokens=80, think_tokens=20, prose=True)
    print(f"fake strata on {fs.url}", flush=True)
    fs.httpd.serve_forever()


if __name__ == "__main__":
    main()
