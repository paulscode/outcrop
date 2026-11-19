"""Read a copy of each answer as it streams past: the first real token (not a keep-alive), where thinking ends, the usage and
Strata's timings at the end.  One parser per response; it never changes what is sent.

Formats: OpenAI chat (SSE or JSON), Anthropic messages (SSE or JSON), OpenAI Responses (SSE or JSON), Ollama (NDJSON or JSON).
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass

MAX_EVENT = 8 << 20        # an event larger than this is passed on but not parsed
MAX_JSON = 32 << 20        # a whole JSON answer larger than this is not parsed


@dataclass
class Stats:
    first_token_at: float | None = None      # the first token of any kind (thinking or answer)
    answer_at: float | None = None           # the first token of the visible answer (or a tool call)
    think_tokens: int = 0
    answer_tokens: int = 0
    prompt_tokens: int | None = None
    output_tokens: int | None = None
    reused_tokens: int | None = None
    prompt_ms: float | None = None
    prefill_tok_s: float | None = None
    decode_tok_s: float | None = None
    drafts_offered: int | None = None
    drafts_accepted: int | None = None
    finish: str | None = None
    error: str | None = None
    events: int = 0
    keepalives: int = 0

    @property
    def tokens_so_far(self) -> int:
        return self.think_tokens + self.answer_tokens

    @property
    def phase(self) -> str:
        if self.finish or self.error:
            return "done"
        if self.answer_at:
            return "answering"
        if self.first_token_at:
            return "thinking"
        return "waiting"


class Parser:
    def __init__(self, dialect: str, kind: str, content_type: str = "", clock=time.time):
        self.dialect = dialect          # openai | anthropic | responses | ollama
        self.kind = kind
        ct = (content_type or "").lower()
        if "text/event-stream" in ct:
            self.mode = "sse"
        elif "ndjson" in ct or (dialect == "ollama" and "json" not in ct and ct != ""):
            self.mode = "ndjson"
        elif dialect == "ollama" and kind in ("ollama-chat", "ollama-generate") and "application/json" not in ct:
            self.mode = "ndjson"
        else:
            self.mode = "json"
        self.buf = bytearray()
        self.skip = False
        self.stats = Stats()
        self.clock = clock
        self._block = None              # anthropic: the type of the open content block

    # ------------------------------------------------------------------------------------------------------------ feed
    def feed(self, data: bytes) -> None:
        """Never raises: an answer the parser does not understand stops the parsing, never the answer itself."""
        if self.skip or not data:
            return
        try:
            self._feed(data)
        except Exception:                                   # noqa: BLE001
            self.skip = True
            self.buf = bytearray()

    def _feed(self, data: bytes) -> None:
        self.buf += data
        if self.mode == "json":
            if len(self.buf) > MAX_JSON:
                self.skip = True
                self.buf = bytearray()
            return
        sep_events = self._split_sse if self.mode == "sse" else self._split_ndjson
        sep_events()
        if len(self.buf) > MAX_EVENT:
            self.skip = True
            self.buf = bytearray()

    def close(self) -> Stats:
        try:
            self._close()
        except Exception:                                   # noqa: BLE001
            pass
        self.buf = bytearray()
        return self.stats

    def _close(self) -> None:
        if not self.skip:
            if self.mode == "json" and self.buf:
                try:
                    obj = json.loads(bytes(self.buf))
                except ValueError:
                    obj = None
                if isinstance(obj, dict):
                    self._whole(obj)
            elif self.mode == "ndjson" and self.buf.strip():
                self._ndjson_line(bytes(self.buf))
            elif self.mode == "sse" and self.buf.strip():
                self._sse_event(bytes(self.buf))

    def _split_sse(self) -> None:
        while True:
            b = self.buf
            i = b.find(b"\n\n")
            j = b.find(b"\r\n\r\n")
            if i < 0 and j < 0:
                return
            if j >= 0 and (i < 0 or j < i):
                block, rest = b[:j], b[j + 4:]
            else:
                block, rest = b[:i], b[i + 2:]
            self.buf = bytearray(rest)
            self._sse_event(bytes(block))

    def _split_ndjson(self) -> None:
        while True:
            i = self.buf.find(b"\n")
            if i < 0:
                return
            line, self.buf = bytes(self.buf[:i]), bytearray(self.buf[i + 1:])
            if line.strip():
                self._ndjson_line(line)

    def _sse_event(self, block: bytes) -> None:
        data_lines, event = [], None
        for ln in block.replace(b"\r\n", b"\n").split(b"\n"):
            if ln.startswith(b":"):
                self.stats.keepalives += 1
                continue
            if ln.startswith(b"data:"):
                data_lines.append(ln[5:].lstrip(b" "))
            elif ln.startswith(b"event:"):
                event = ln[6:].strip().decode("utf-8", "replace")
        if not data_lines:
            return
        data = b"\n".join(data_lines)
        if data.strip() == b"[DONE]":
            return
        try:
            obj = json.loads(data)
        except ValueError:
            return
        if isinstance(obj, dict):
            self.stats.events += 1
            self._event(obj, event)

    def _ndjson_line(self, line: bytes) -> None:
        try:
            obj = json.loads(line)
        except ValueError:
            return
        if isinstance(obj, dict):
            self.stats.events += 1
            self._ollama(obj)

    # ------------------------------------------------------------------------------------------------------------ marks
    def _think(self, n: int = 1) -> None:
        s = self.stats
        if s.first_token_at is None:
            s.first_token_at = self.clock()
        s.think_tokens += n

    def _answer(self, n: int = 1) -> None:
        s = self.stats
        now = self.clock()
        if s.first_token_at is None:
            s.first_token_at = now
        if s.answer_at is None:
            s.answer_at = now
        s.answer_tokens += n

    def _timings(self, t: dict | None) -> None:
        if not isinstance(t, dict):
            return
        s = self.stats
        s.prompt_ms = _num(t.get("prompt_ms"), s.prompt_ms)
        s.prefill_tok_s = _num(t.get("prompt_per_second"), s.prefill_tok_s)
        s.decode_tok_s = _num(t.get("predicted_per_second"), s.decode_tok_s)
        if t.get("draft_n") is not None:
            s.drafts_offered = int(t["draft_n"])
        if t.get("draft_n_accepted") is not None:
            s.drafts_accepted = int(t["draft_n_accepted"])
        if t.get("cache_n") is not None and s.reused_tokens is None:
            s.reused_tokens = int(t["cache_n"])

    def _error(self, obj: dict) -> None:
        e = obj.get("error")
        if isinstance(e, dict):
            self.stats.error = str(e.get("message") or e.get("type") or "error")[:500]
        elif e:
            self.stats.error = str(e)[:500]

    # ------------------------------------------------------------------------------------------------------- dialects
    def _event(self, obj: dict, event: str | None) -> None:
        if self.dialect == "anthropic":
            self._anthropic(obj)
        elif self.dialect == "responses":
            self._responses(obj)
        elif self.dialect == "ollama":
            self._ollama(obj)
        else:
            self._openai_chunk(obj)

    def _openai_chunk(self, obj: dict) -> None:
        if "error" in obj:
            self._error(obj)
            return
        for ch in obj.get("choices") or []:
            d = ch.get("delta") or {}
            if d.get("reasoning_content") or d.get("reasoning"):
                self._think()
            if d.get("content") or d.get("tool_calls"):
                self._answer()
            if ch.get("finish_reason"):
                self.stats.finish = ch["finish_reason"]
        self._usage_openai(obj.get("usage"))
        self._timings(obj.get("timings"))

    def _usage_openai(self, u: dict | None) -> None:
        if not isinstance(u, dict):
            return
        s = self.stats
        if u.get("prompt_tokens") is not None:
            s.prompt_tokens = int(u["prompt_tokens"])
        if u.get("completion_tokens") is not None:
            s.output_tokens = int(u["completion_tokens"])
        cached = (u.get("prompt_tokens_details") or {}).get("cached_tokens")
        if cached is not None:
            s.reused_tokens = int(cached)

    def _anthropic(self, obj: dict) -> None:
        t = obj.get("type")
        s = self.stats
        if t == "message_start":
            self._usage_anthropic((obj.get("message") or {}).get("usage"))
        elif t == "content_block_start":
            self._block = (obj.get("content_block") or {}).get("type")
            if self._block == "tool_use":
                self._answer(0)
        elif t == "content_block_delta":
            d = obj.get("delta") or {}
            dt = d.get("type")
            if dt == "thinking_delta" and d.get("thinking"):
                self._think()
            elif dt in ("text_delta", "input_json_delta") and (d.get("text") or d.get("partial_json")):
                self._answer()
        elif t == "message_delta":
            d = obj.get("delta") or {}
            if d.get("stop_reason"):
                s.finish = d["stop_reason"]
            self._usage_anthropic(obj.get("usage"))
        elif t == "error":
            self._error(obj)
        elif t == "message" or "content" in obj and "role" in obj:
            self._whole(obj)

    def _usage_anthropic(self, u: dict | None) -> None:
        if not isinstance(u, dict):
            return
        s = self.stats
        parts = [u.get(k) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")]
        if any(p is not None for p in parts):
            total = sum(int(p or 0) for p in parts)
            if total:
                s.prompt_tokens = total
        if u.get("cache_read_input_tokens") is not None:
            s.reused_tokens = int(u["cache_read_input_tokens"])
        if u.get("output_tokens"):
            s.output_tokens = int(u["output_tokens"])

    def _responses(self, obj: dict) -> None:
        t = obj.get("type") or ""
        if t in ("response.reasoning_text.delta", "response.reasoning_summary_text.delta", "response.reasoning.delta"):
            self._think()
        elif t in ("response.output_text.delta", "response.function_call_arguments.delta", "response.refusal.delta"):
            self._answer()
        elif t in ("response.completed", "response.incomplete", "response.failed"):
            r = obj.get("response") or {}
            self._usage_responses(r.get("usage"))
            self.stats.finish = r.get("status") or t.split(".")[-1]
            if t == "response.failed":
                self._error(r)
            self._timings(obj.get("timings") or r.get("timings"))
        elif t == "error":
            self.stats.error = str(obj.get("message") or obj.get("code") or "error")[:500]
        elif obj.get("object") == "response":
            self._whole(obj)

    def _usage_responses(self, u: dict | None) -> None:
        if not isinstance(u, dict):
            return
        s = self.stats
        if u.get("input_tokens") is not None:
            s.prompt_tokens = int(u["input_tokens"])
        if u.get("output_tokens") is not None:
            s.output_tokens = int(u["output_tokens"])
        cached = (u.get("input_tokens_details") or {}).get("cached_tokens")
        if cached is not None:
            s.reused_tokens = int(cached)

    def _ollama(self, obj: dict) -> None:
        s = self.stats
        if obj.get("error"):
            self._error(obj)
            return
        msg = obj.get("message") or {}
        if msg.get("thinking") or obj.get("thinking"):
            self._think()
        if msg.get("content") or msg.get("tool_calls") or obj.get("response"):
            self._answer()
        if obj.get("done"):
            s.finish = obj.get("done_reason") or "stop"
            if obj.get("prompt_eval_count") is not None:
                s.prompt_tokens = int(obj["prompt_eval_count"])
            if obj.get("eval_count") is not None:
                s.output_tokens = int(obj["eval_count"])
            pe, ee = obj.get("prompt_eval_duration"), obj.get("eval_duration")
            if pe:
                s.prompt_ms = pe / 1e6
                if s.prompt_tokens:
                    s.prefill_tok_s = round(s.prompt_tokens / (pe / 1e9), 1)
            if ee and s.output_tokens:
                s.decode_tok_s = round(s.output_tokens / (ee / 1e9), 1)

    def _whole(self, obj: dict) -> None:
        """A non-streamed answer."""
        s = self.stats
        if "error" in obj and not obj.get("choices"):
            self._error(obj)
        if self.dialect == "ollama":
            self._ollama(obj)
            return
        if obj.get("type") == "message" or (self.dialect == "anthropic" and "content" in obj):
            kinds = [c.get("type") for c in obj.get("content") or [] if isinstance(c, dict)]
            if "thinking" in kinds:
                self._think(0)
            if "text" in kinds or "tool_use" in kinds:
                self._answer(0)
            s.finish = obj.get("stop_reason") or s.finish
            self._usage_anthropic(obj.get("usage"))
            return
        if obj.get("object") == "response":
            self._usage_responses(obj.get("usage"))
            s.finish = obj.get("status") or s.finish
            self._timings(obj.get("timings"))
            if any((o or {}).get("type") in ("message", "function_call") for o in obj.get("output") or []):
                self._answer(0)
            return
        for ch in obj.get("choices") or []:
            m = ch.get("message") or {}
            if m.get("reasoning_content"):
                self._think(0)
            if m.get("content") or m.get("tool_calls"):
                self._answer(0)
            s.finish = ch.get("finish_reason") or s.finish
        self._usage_openai(obj.get("usage"))
        self._timings(obj.get("timings"))


def _num(v, default):
    try:
        return float(v) if v is not None else default
    except (TypeError, ValueError):
        return default
