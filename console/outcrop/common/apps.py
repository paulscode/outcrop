"""Which app sent a request, from its User-Agent and SDK headers.  Standard library only."""
from __future__ import annotations

import re

# (pattern on the User-Agent, app name); the first match wins
_UA = [
    (r"claude-cli|claude-code|ClaudeCode", "Claude Code"),
    (r"open-webui|OpenWebUI", "Open WebUI"),
    (r"LibreChat", "LibreChat"),
    (r"HomeAssistant|home-assistant", "Home Assistant"),
    (r"\bn8n\b", "n8n"),
    (r"Continue", "Continue"),
    (r"\bCline\b", "Cline"),
    (r"aider", "Aider"),
    (r"\bZed\b", "Zed"),
    (r"Obsidian", "Obsidian"),
    (r"Raycast", "Raycast"),
    (r"Enchanted", "Enchanted"),
    (r"Jan/|janhq", "Jan"),
    (r"LangChain|langchain", "LangChain"),
    (r"ollama-python", "ollama-python"),
    (r"ollama-js", "ollama-js"),
    (r"^OpenAI/Python", "openai-python"),
    (r"^OpenAI/JS", "openai-node"),
    (r"^Anthropic/Python", "anthropic-python"),
    (r"^Anthropic/JS", "anthropic-node"),
    (r"outcrop-console", "Console"),
    (r"strata-bench|quickbench|qualgate|apitest|longctx", "bench"),
    (r"outcrop", "outcrop"),
    (r"Prometheus", "Prometheus"),
    (r"Grafana", "Grafana"),
    (r"^curl/", "curl"),
    (r"^Wget", "wget"),
    (r"python-httpx", "httpx"),
    (r"python-requests", "requests"),
    (r"aiohttp", "aiohttp"),
    (r"Python-urllib", "urllib"),
    (r"^Go-http-client", "Go"),
    (r"node-fetch|undici|^node$", "Node.js"),
    (r"okhttp", "OkHttp"),
    (r"Mozilla/5\.0", "Browser"),
]
_UA_RE = [(re.compile(p, re.I), name) for p, name in _UA]


def recognize(user_agent: str | None, headers: dict | None = None) -> str:
    ua = (user_agent or "").strip()
    for rx, name in _UA_RE:
        if rx.search(ua):
            return name
    h = headers or {}
    lang = h.get("x-stainless-lang")
    if lang:
        pkg = h.get("x-stainless-package-version", "")
        return f"SDK ({lang}{' ' + pkg if pkg else ''})"
    if not ua:
        return "unknown"
    return ua.split("/", 1)[0][:32] or "unknown"
