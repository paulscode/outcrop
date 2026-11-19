"""The stream parsers, on answers recorded from the real server (fakestrata/fixtures)."""
from pathlib import Path

from outcrop.gateway.streams import Parser

FIX = Path(__file__).resolve().parents[1] / "fakestrata" / "fixtures"


def feed(p: Parser, data: bytes, step: int = 7):
    for i in range(0, len(data), step):        # small pieces: events split across reads
        p.feed(data[i:i + step])
    return p.close()


def test_openai_stream():
    s = feed(Parser("openai", "chat", "text/event-stream"), (FIX / "openai_chat_stream.txt").read_bytes())
    assert s.first_token_at and s.answer_at and s.think_tokens == 0
    assert s.prompt_tokens == 18 and s.output_tokens == 8 and s.finish == "stop"
    assert s.decode_tok_s == 25.4 and s.drafts_offered == 7 and s.drafts_accepted == 3
    assert s.keepalives >= 2


def test_openai_stream_thinking():
    s = feed(Parser("openai", "chat", "text/event-stream"), (FIX / "openai_chat_stream_usage_thinking.txt").read_bytes())
    assert s.think_tokens > 0 and s.answer_tokens >= 1
    assert s.answer_at >= s.first_token_at
    assert s.prompt_tokens == 62 and s.output_tokens == 33


def test_openai_json():
    s = feed(Parser("openai", "chat", "application/json"), (FIX / "openai_chat.json").read_bytes())
    assert s.prompt_tokens == 15 and s.output_tokens == 10 and s.finish == "stop" and s.decode_tok_s == 39.3


def test_anthropic_stream():
    s = feed(Parser("anthropic", "messages", "text/event-stream"), (FIX / "anthropic_stream.txt").read_bytes())
    assert s.prompt_tokens == 62 and s.output_tokens == 30 and s.finish == "end_turn"
    assert s.think_tokens > 0 and s.answer_tokens > 0


def test_anthropic_json():
    s = feed(Parser("anthropic", "messages", "application/json"), (FIX / "anthropic.json").read_bytes())
    assert s.output_tokens and s.finish


def test_responses_stream_and_json():
    s = feed(Parser("responses", "responses", "text/event-stream"), (FIX / "responses_stream.txt").read_bytes())
    assert s.prompt_tokens == 18 and s.output_tokens == 8 and s.reused_tokens == 11 and s.finish == "completed"
    assert s.answer_tokens == 7 and s.decode_tok_s == 28.7
    s = feed(Parser("responses", "responses", "application/json"), (FIX / "responses.json").read_bytes())
    assert s.output_tokens and s.finish == "completed"


def test_ollama_ndjson_and_json():
    s = feed(Parser("ollama", "ollama-chat", "application/x-ndjson"), (FIX / "ollama_chat_stream.txt").read_bytes())
    assert s.prompt_tokens == 18 and s.output_tokens == 9 and s.finish == "stop" and s.answer_tokens >= 5
    assert s.decode_tok_s and s.prefill_tok_s
    s = feed(Parser("ollama", "ollama-generate", "application/json"), (FIX / "ollama_generate.json").read_bytes())
    assert s.prompt_tokens == 15 and s.output_tokens == 11


def test_garbage_is_harmless():
    p = Parser("openai", "chat", "text/event-stream")
    p.feed(b"data: {not json}\n\n: keep-alive\n\ndata: [DONE]\n\n")
    s = p.close()
    assert s.output_tokens is None and s.keepalives == 1
