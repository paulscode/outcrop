"""What the gateway reads and changes in a request body before Strata sees it.  Runs on a worker thread.

- `strata_mcp` is removed: no app may switch on the engine's own tools (docs/SECURITY.md, "Web access for the chat").
- Images must be data: URLs (or Ollama's base64, or Anthropic's base64 source): Strata reads a local file path given as
  an image and downloads an http(s) image URL itself, from a process that is not sandboxed, so an API token could read
  pictures on this computer or reach this machine's loopback services and the LAN.
- `model` and `stream` are noted for the request log.

The body is parsed exactly as Strata parses it (`json.loads` on the bytes, which also accepts a UTF-8 BOM and UTF-16/32),
so the two always agree on what it says.  A body Python cannot parse is passed on unchanged: Strata refuses it the same
way.  A body with too many JSON values is refused before it is parsed, since parsing it would take far more memory than
its size (64 MiB of `{},` is 1.7 GB of Python objects).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

# a request's JSON objects and arrays, and its values (commas): a 1M-token prompt has a few thousand of each
MAX_CONTAINERS = 500_000
MAX_COMMAS = 2_000_000

IMAGE_PARTS = ("image_url", "input_image", "image")      # Strata's serve/frontend.py IMAGE_PARTS
NOT_CONTENT = frozenset({"tools", "response_format", "format", "text", "tool_choice", "metadata", "json_schema"})
_B64 = re.compile(r"[A-Za-z0-9+/=_\-\s]*")


def _is_b64(s: str) -> bool:
    """Base64 data, not a file path that happens to use base64's letters (\"/etc/passwd\")."""
    import base64
    head = re.sub(r"\s", "", s[:4096])
    if not head or not _B64.fullmatch(head) or head.startswith("/") or "//" in head:
        return False
    try:
        base64.b64decode(head[: len(head) - len(head) % 4] or "AAAA", validate=True)
        return True
    except ValueError:
        try:
            base64.urlsafe_b64decode(head[: len(head) - len(head) % 4] or "AAAA")
            return True
        except ValueError:
            return False


class Refused(ValueError):
    """The body is refused: (HTTP status, message)."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


@dataclass
class Seen:
    body: bytes                 # the body to pass on (the same object when nothing changed)
    model: str | None = None
    stream: bool | None = None
    removed_mcp: bool = False
    parsed: bool = False


def _image_sources(part: dict) -> list:
    """The places an image part can name its source, as Strata reads them (serve/frontend.py _image_source: `source` for
    type "image", else `image_url`), both looked at whatever the type: None for inline base64 data."""
    out = []
    if part.get("type") == "image" or "source" in part:
        src = part.get("source")
        if isinstance(src, dict):
            out.append(None if src.get("type") == "base64" else (src.get("url") or src.get("path") or ""))
        else:
            out.append(src if isinstance(src, str) else "")
    if part.get("type") != "image" or "image_url" in part:
        url = part.get("image_url")
        if isinstance(url, dict):
            url = url.get("url")
        out.append(url if isinstance(url, str) else "")
    return out


def _image_problem(part: dict) -> str:
    """Why an image part is refused, in terms of what it sent."""
    src = part.get("source")
    if "file_id" in part or (isinstance(src, dict) and (src.get("type") == "file" or "file_id" in src)):
        return ("images by file ID (an uploaded file) are not supported here: send the picture itself as a data: URL "
                "(base64)")
    return ("an image must be sent as a data: URL (base64); this server does not read image files or download image "
            "links")


def check_images(obj, path: str = "") -> None:
    """Refuse an image part whose source is not a data: URL, anywhere in the conversation (messages, tool results,
    Responses input, system prompts); tool definitions and output formats are not looked at."""
    stack = [(obj, path)]
    while stack:
        o, p = stack.pop()
        if isinstance(o, dict):
            if o.get("type") in IMAGE_PARTS:
                if any(src is not None and not src.startswith("data:") for src in _image_sources(o)):
                    raise Refused(400, f"{p or 'the request'}: {_image_problem(o)}")
            for k, v in o.items():
                if k in NOT_CONTENT or not isinstance(v, (dict, list)):
                    continue
                stack.append((v, f"{p}.{k}" if p else k))
        elif isinstance(o, list):
            for i, v in enumerate(o):
                if isinstance(v, (dict, list)):
                    stack.append((v, f"{p}[{i}]"))


def check_ollama_images(req: dict) -> None:
    """Ollama's `images` are base64 strings (the bridge makes data: URLs of them): nothing else, no paths or links."""
    lists = [("images", req.get("images"))]
    for i, m in enumerate(req.get("messages") or []):
        if isinstance(m, dict):
            lists.append((f"messages[{i}].images", m.get("images")))
    for where, imgs in lists:
        if imgs is None:
            continue
        if not isinstance(imgs, list):
            raise Refused(400, f"{where} must be a list of base64 images")
        for j, b in enumerate(imgs):
            if not isinstance(b, str) or not (b.startswith("data:") or _is_b64(b)):
                raise Refused(400, f"{where}[{j}]: an image must be base64 data; this server does not read image "
                                   "files or download image links")


def inspect(body: bytes, ollama: bool, generating_ollama: bool) -> Seen:
    """Read one POST body (see the module's docstring).  Refused for a body that must not go on."""
    seen = Seen(body)
    if not body.strip():
        return seen
    if body.count(b"{") + body.count(b"[") > MAX_CONTAINERS or body.count(b",") > MAX_COMMAS:
        raise Refused(413, "the request body has too many JSON values")
    try:
        req = json.loads(body)
    except RecursionError:
        raise Refused(400, "the request body is nested too deeply") from None
    except ValueError:
        return seen                         # Strata cannot read it either, and answers 400
    seen.parsed = True
    if not isinstance(req, dict):
        return seen
    if "strata_mcp" in req:
        del req["strata_mcp"]
        seen.removed_mcp = True
    check_images(req)
    if ollama:
        check_ollama_images(req)
    if seen.removed_mcp:
        seen.body = json.dumps(req).encode()
    m = req.get("model")
    seen.model = str(m)[:120] if m is not None else None
    s = req.get("stream")
    seen.stream = bool(s) if s is not None else generating_ollama
    del req
    return seen
