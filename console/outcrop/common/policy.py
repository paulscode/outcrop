"""Route classes, credentials, and the access decision for one API request.  Standard library only.

Deny by default: a path that is not listed here gets a 404 from the gateway and never reaches Strata.  Paths are matched on the
raw (undecoded) path without the query and without trailing slashes, the same way Strata matches them, so the gateway and
Strata always agree on what a request is.
"""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass, field
from urllib.parse import urlsplit

PUBLIC, INFERENCE, TELEMETRY, ADMIN, WEB = "public", "inference", "telemetry", "admin", "web"
OPENAI, OLLAMA = "openai", "ollama"

# dialects, for the error format
D_OPENAI, D_ANTHROPIC, D_RESPONSES, D_OLLAMA, D_PLAIN = "openai", "anthropic", "responses", "ollama", "plain"

# targets
T_STRATA, T_BRIDGE, T_LOCAL = "strata", "bridge", "local"


@dataclass(frozen=True)
class Route:
    cls: str
    dialect: str
    target: str
    kind: str = ""          # chat | messages | responses | count | models | ollama-chat | ollama-generate | ... ("" = other)
    hold: bool = False      # wait while a switch or start is in progress


R = Route
_GET = frozenset({"GET", "HEAD"})
_POST = frozenset({"POST"})

# exact paths: path -> {methods -> Route}
_OPENAI_EXACT: dict[str, list[tuple[frozenset, Route]]] = {
    # Strata's chat page: not served here.  On plain HTTP any LAN device can claim this origin (mDNS spoofing) and read
    # a token pasted into the page, so the gateway redirects to the console's sandboxed view of it (HTTPS)
    "": [(_GET, R(PUBLIC, D_PLAIN, T_LOCAL, "home"))],
    "/health": [(_GET, R(PUBLIC, D_OPENAI, T_LOCAL, "health"))],
    "/api/health": [(_GET, R(PUBLIC, D_OPENAI, T_LOCAL, "health"))],
    "/v1/chat/completions": [(_POST, R(INFERENCE, D_OPENAI, T_STRATA, "chat", True))],
    "/v1/messages": [(_POST, R(INFERENCE, D_ANTHROPIC, T_STRATA, "messages", True))],
    "/v1/messages/count_tokens": [(_POST, R(INFERENCE, D_ANTHROPIC, T_STRATA, "count", True))],
    # an Anthropic client given ".../v1" as its base URL posts /v1/v1/messages; Strata answers both (V1_V1_ALIASES)
    "/v1/v1/messages": [(_POST, R(INFERENCE, D_ANTHROPIC, T_STRATA, "messages", True))],
    "/v1/v1/messages/count_tokens": [(_POST, R(INFERENCE, D_ANTHROPIC, T_STRATA, "count", True))],
    "/v1/responses": [(_POST, R(INFERENCE, D_RESPONSES, T_STRATA, "responses", True))],
    "/v1/models": [(_GET, R(INFERENCE, D_OPENAI, T_STRATA, "models", True))],
    "/models": [(_GET, R(INFERENCE, D_OPENAI, T_STRATA, "models", True))],
    "/v1/images/generations": [(_POST, R(INFERENCE, D_OPENAI, T_STRATA, "images", True))],
    "/metrics": [(_GET, R(TELEMETRY, D_OPENAI, T_STRATA))],
    "/metrics/prometheus": [(_GET, R(TELEMETRY, D_OPENAI, T_STRATA))],
    "/v1/telemetry": [(_GET, R(TELEMETRY, D_OPENAI, T_STRATA))],
    "/v1/status": [(_GET, R(TELEMETRY, D_OPENAI, T_STRATA))],
    "/slots": [(_GET, R(TELEMETRY, D_OPENAI, T_STRATA))],
    "/props": [(_GET, R(TELEMETRY, D_OPENAI, T_STRATA))],
    "/load": [(_POST, R(ADMIN, D_OPENAI, T_STRATA))],
    "/unload": [(_POST, R(ADMIN, D_OPENAI, T_STRATA))],
    "/v1/load": [(_POST, R(ADMIN, D_OPENAI, T_STRATA))],
    "/v1/unload": [(_POST, R(ADMIN, D_OPENAI, T_STRATA))],
    "/v1/vram": [(_POST, R(ADMIN, D_OPENAI, T_STRATA))],
    "/settings": [(_POST | _GET, R(ADMIN, D_OPENAI, T_STRATA))],
    "/config": [(_POST | _GET, R(ADMIN, D_OPENAI, T_STRATA))],
    "/status": [(_GET, R(ADMIN, D_OPENAI, T_STRATA))],                # #212: shows the tail of the last answer
    "/mcp": [(_GET, R(ADMIN, D_OPENAI, T_STRATA))],                  # Strata's own MCP servers' state
    "/tools/mcp": [(_POST | _GET, R(WEB, D_OPENAI, T_LOCAL, "mcp"))],  # web tools for apps (gateway/webmcp.py)
    "/api/requests": [(_GET, R(ADMIN, D_OPENAI, T_STRATA))],
}
# prefixes: (prefix, methods, Route)
_OPENAI_PREFIX: list[tuple[str, frozenset, Route]] = [
    ("/web/", _GET, R(PUBLIC, D_PLAIN, T_STRATA)),                    # the chat page's assets
    ("/fonts/", _GET, R(PUBLIC, D_PLAIN, T_STRATA)),
    ("/v1/responses/", frozenset({"GET", "POST", "DELETE"}), R(INFERENCE, D_RESPONSES, T_STRATA, "responses-sub")),
    ("/v1/images/files/", _GET, R(INFERENCE, D_OPENAI, T_STRATA)),
    ("/slots/", _POST, R(ADMIN, D_OPENAI, T_STRATA)),
    ("/tool-media/", _GET, R(ADMIN, D_OPENAI, T_STRATA)),
]

# The Ollama port: Ollama's API (answered by the bridge) and the OpenAI-style routes Ollama also serves (answered by Strata).
_OLLAMA_EXACT: dict[str, list[tuple[frozenset, Route]]] = {
    "": [(_GET, R(PUBLIC, D_PLAIN, T_BRIDGE))],                       # "Ollama is running"
    "/health": [(_GET, R(PUBLIC, D_OLLAMA, T_LOCAL, "health"))],
    "/api/version": [(_GET, R(INFERENCE, D_OLLAMA, T_BRIDGE, "ollama-meta"))],
    "/api/tags": [(_GET, R(INFERENCE, D_OLLAMA, T_BRIDGE, "ollama-meta", True))],
    "/api/ps": [(_GET, R(INFERENCE, D_OLLAMA, T_BRIDGE, "ollama-meta", True))],
    "/api/show": [(_POST, R(INFERENCE, D_OLLAMA, T_BRIDGE, "ollama-meta", True))],
    "/api/chat": [(_POST, R(INFERENCE, D_OLLAMA, T_BRIDGE, "ollama-chat", True))],
    "/api/generate": [(_POST, R(INFERENCE, D_OLLAMA, T_BRIDGE, "ollama-generate", True))],
    "/v1/chat/completions": [(_POST, R(INFERENCE, D_OPENAI, T_STRATA, "chat", True))],
    "/v1/messages": [(_POST, R(INFERENCE, D_ANTHROPIC, T_STRATA, "messages", True))],
    "/v1/responses": [(_POST, R(INFERENCE, D_RESPONSES, T_STRATA, "responses", True))],
    "/v1/models": [(_GET, R(INFERENCE, D_OPENAI, T_STRATA, "models", True))],
}
_OLLAMA_PREFIX: list[tuple[str, frozenset, Route]] = []

GENERATING = frozenset({"chat", "messages", "responses", "ollama-chat", "ollama-generate"})


def norm_path(raw_path: str) -> str:
    """The path as Strata sees it: no query, no trailing slashes."""
    return raw_path.split("?", 1)[0].rstrip("/")


def _dot_segment(path: str) -> bool:
    """A "." or ".." segment: the HTTP client that passes the request on removes them (RFC 3986), so Strata would see
    another path than the one classified here (/v1/responses/. becomes /v1/responses)."""
    return any(seg in (".", "..") for seg in path.split("/"))


def classify(listener: str, method: str, raw_path: str) -> Route | None:
    """The route for a request, or None (404).  OPTIONS (CORS preflight) is answered by the gateway itself."""
    path = norm_path(raw_path)
    method = method.upper()
    if method == "OPTIONS":
        return R(PUBLIC, D_OPENAI, T_LOCAL, "preflight")
    if _dot_segment(path):
        return None
    exact, prefixes = (_OLLAMA_EXACT, _OLLAMA_PREFIX) if listener == OLLAMA else (_OPENAI_EXACT, _OPENAI_PREFIX)
    for methods, route in exact.get(path, ()):
        if method in methods:
            return route
    for prefix, methods, route in prefixes:
        if path.startswith(prefix) and method in methods:
            rest = path[len(prefix):]
            if ".." in path or "//" in path or "\\" in path or (route.cls == PUBLIC and "%" in rest):
                return None
            return route
    return None


def known_path(listener: str, raw_path: str) -> bool:
    """Whether the path exists for some method (405 rather than 404)."""
    path = norm_path(raw_path)
    if ".." in path or "//" in path or "\\" in path or "%" in path or _dot_segment(path):
        return False
    exact, prefixes = (_OLLAMA_EXACT, _OLLAMA_PREFIX) if listener == OLLAMA else (_OPENAI_EXACT, _OPENAI_PREFIX)
    return path in exact or any(path.startswith(p) for p, _, _ in prefixes)


# --------------------------------------------------------------------------------------------------------- credentials

class BadCredential(ValueError):
    pass


def credentials(headers: list[tuple[bytes, bytes]]) -> list[str]:
    """The API token(s) from `Authorization: Bearer …` and `x-api-key: …` (never the query string), bearer first.

    Some clients send both (Claude Code with ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN set); the gateway accepts the
    request when either is a valid token.  The same header twice is refused, and so is a malformed value."""
    auths = [v for k, v in headers if k.lower() == b"authorization"]
    keys = [v for k, v in headers if k.lower() == b"x-api-key"]
    if len(auths) > 1 or len(keys) > 1:
        raise BadCredential("send one Authorization or x-api-key header")
    out: list[str] = []
    if auths:
        v = auths[0].decode("latin-1").strip()
        scheme, _, rest = v.partition(" ")
        if scheme.lower() == "bearer" and rest.strip():
            out.append(rest.strip())
    if keys:
        k = keys[0].decode("latin-1").strip()
        if k and k not in out:
            out.append(k)
    for tok in out:
        if len(tok) > 512 or any(c.isspace() or ord(c) < 33 for c in tok):
            raise BadCredential("malformed API key")
    return out


def credential(headers: list[tuple[bytes, bytes]]) -> str | None:
    """The first credential (see credentials())."""
    c = credentials(headers)
    return c[0] if c else None


# ---------------------------------------------------------------------------------------------------- browser checks

def host_of(host_header: str | None) -> str | None:
    if not host_header:
        return None
    h = host_header.strip().lower()
    if h.startswith("["):                      # [::1]:8080
        end = h.find("]")
        return h[1:end] if end > 0 else h
    if h.count(":") == 1:
        h = h.split(":", 1)[0]
    return h.rstrip(".")


def host_allowed(host_header: str | None, names: set[str]) -> bool:
    """DNS rebinding: a browser that reached us under a name we do not answer to is refused.  No Host (HTTP/1.0 tools): ok."""
    h = host_of(host_header)
    return h is None or h in names


LOOPBACK_NAMES = frozenset({"localhost", "127.0.0.1", "::1"})


def origin_allowed(origin: str | None, host_header: str | None, names: set[str], cors_origins: list[str],
                   ports: set[int] | frozenset[int] | None = None) -> bool:
    """A browser request from another site is refused unless its origin is listed for CORS.  No Origin: not a browser
    page (or a same-origin GET), allowed.

    Besides the request's own origin, a page on one of this server's names is accepted only on one of `ports` (the
    gateway's and the console's; None: any port), and never a loopback name: a page on http://localhost:3000 is a page on
    the browser's own computer, not this server."""
    if origin is None:
        return True
    o = origin.strip().rstrip("/")
    if o.lower() == "null":
        return False
    if o in cors_origins or "*" in cors_origins:
        return True
    try:
        u = urlsplit(o)
    except ValueError:
        return False
    host = (u.hostname or "").lower()
    if not host:
        return False
    # same origin as the request (Strata's own page on :8080), or one of this server's own names (the console)
    if host_header and u.netloc.lower() == host_header.strip().lower():
        return True
    if host not in names or host in LOOPBACK_NAMES:
        return False
    if ports is None:
        return True
    try:
        port = u.port or {"http": 80, "https": 443}.get(u.scheme.lower())
    except ValueError:
        return False
    return port in ports


# ------------------------------------------------------------------------------------------------------------ decision

@dataclass
class OpenWindow:
    until: float
    addresses: list = field(default_factory=list)   # ip_network objects; empty: anyone on the LAN
    listeners: frozenset = frozenset({OPENAI, OLLAMA})
    by: str = ""

    def covers(self, listener: str, ip: str, now: float) -> bool:
        if now >= self.until or listener not in self.listeners:
            return False
        return ip_in(ip, self.addresses) if self.addresses else True


def addr_keys(ip: str | None) -> list[tuple[str, int]]:
    """The keys a per-address limit counts against, each with a multiplier of the limit: the address itself (x1), and
    for IPv6 also its /64 (x4).  Per address, so the devices of one home LAN (one /64) don't share a limit; per /64 at
    four times the limit, so one device can't escape by rotating through its /64's addresses."""
    if not ip:
        return []
    try:
        a = ipaddress.ip_address(ip.split("%", 1)[0])
    except ValueError:
        return [(ip, 1)]
    if isinstance(a, ipaddress.IPv6Address):
        if a.ipv4_mapped:
            return [(str(a.ipv4_mapped), 1)]
        return [(str(a), 1), ("net " + str(ipaddress.ip_network(f"{a}/64", strict=False)), 4)]
    return [(str(a), 1)]


def addr_key(ip: str | None) -> str:
    """The key for per-address limits: an IPv4 address (IPv4-mapped ones as IPv4) as it is, an IPv6 address by its /64,
    since one device can take any number of addresses in its /64 (privacy addresses, or on purpose)."""
    if not ip:
        return ""
    try:
        a = ipaddress.ip_address(ip.split("%", 1)[0])
    except ValueError:
        return ip
    if isinstance(a, ipaddress.IPv6Address):
        if a.ipv4_mapped:
            return str(a.ipv4_mapped)
        return str(ipaddress.ip_network(f"{a}/64", strict=False))
    return str(a)


def ip_in(ip: str, networks) -> bool:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(a in n for n in networks)


def parse_networks(items) -> list:
    out = []
    for x in items or []:
        try:
            out.append(ipaddress.ip_network(str(x), strict=False))
        except ValueError:
            pass
    return out


@dataclass
class Decision:
    allowed: bool
    mode: str                       # public | token | open | tokenless | denied
    status: int = 200               # 401, 403 or 429 when refused
    message: str = ""
    reason: str = ""                # for the log: why it was allowed or refused
    token: object | None = None     # tokens.Token
    retry_after: float | None = None


def unknown_hint(presented: str | None) -> str:
    if not presented:
        return ""
    return presented[:4] + "…"
