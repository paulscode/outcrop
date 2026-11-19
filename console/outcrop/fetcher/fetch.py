"""The page fetcher (outcrop-fetch.service): opens one public web page for the chat's open_page tool and returns its readable
text.  It runs as its own user with no access to your files, and the kernel refuses its connections to your network
(systemd IPAddressDeny, see systemd/outcrop-fetch.service).  This code checks as well:

- http and https only, ports 80 and 443, no user:password@ in links; names are IDNA-encoded and paths percent-encoded;
- it resolves the name itself, refuses unless every address is public and none is this machine's own (its interfaces'
  addresses, and the home's public IPv4 when known: a router answers its admin page there, and port forwards hairpin
  back to this server), and connects to the address it checked, so a second lookup cannot swap in 192.168.x.x;
- redirects are followed by hand, at most 5, each checked the same way, never from https down to http;
- 15 s and 5 MB per download; HTML, text and PDF only, uncompressed; no cookies, no JavaScript, no Referer;
- the page is parsed in a separate process with CPU, memory and wall-clock limits (a hostile page cannot keep a CPU busy).
"""
from __future__ import annotations

import codecs
import ctypes
import ctypes.util
import ipaddress
import multiprocessing
import os
import re
import socket
import ssl
import threading
import time
from urllib.parse import quote, urljoin, urlsplit, urlunsplit

import anyio
import httpcore

MAX_BYTES = 5 << 20
TIMEOUT_S = 15.0
PARSE_S = 10.0                    # wall clock for turning a page into text, in its own process
PARSE_MEM = 640 << 20             # address space the parser may add
PARSE_WORKERS = 2
MAX_REDIRECTS = 5
PORTS = {"http": 80, "https": 443}
ALLOWED_PORTS = (80, 443)
UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"      # a common browser's, nothing more
TYPES = ("text/html", "application/xhtml+xml", "text/plain", "application/pdf", "text/markdown")
NAT64 = ipaddress.ip_network("64:ff9b::/96")
NAT64_LOCAL = ipaddress.ip_network("64:ff9b:1::/48")
V4COMPAT = ipaddress.ip_network("::/96")


class Refused(Exception):
    """A link the fetcher will not open, with the reason to show."""


# ---------------------------------------------------------------------------------------------- this machine's addresses

class _SockAddr(ctypes.Structure):
    _fields_ = [("sa_family", ctypes.c_ushort), ("sa_data", ctypes.c_char * 14)]


class _IfAddrs(ctypes.Structure):
    pass


_IfAddrs._fields_ = [("ifa_next", ctypes.POINTER(_IfAddrs)), ("ifa_name", ctypes.c_char_p), ("ifa_flags", ctypes.c_uint),
                     ("ifa_addr", ctypes.POINTER(_SockAddr)), ("ifa_netmask", ctypes.POINTER(_SockAddr)),
                     ("ifa_ifu", ctypes.POINTER(_SockAddr)), ("ifa_data", ctypes.c_void_p)]


def _getifaddrs() -> set[str]:
    """Every address on this machine's interfaces (libc getifaddrs, over netlink)."""
    libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)
    head = ctypes.POINTER(_IfAddrs)()
    if libc.getifaddrs(ctypes.byref(head)) != 0:
        raise OSError(ctypes.get_errno(), "getifaddrs")
    out = set()
    try:
        p = head
        while p:
            a = p.contents.ifa_addr
            if a:
                fam = a.contents.sa_family
                raw = ctypes.string_at(ctypes.addressof(a.contents), 28 if fam == socket.AF_INET6 else 16)
                if fam == socket.AF_INET:
                    out.add(socket.inet_ntop(socket.AF_INET, raw[4:8]))
                elif fam == socket.AF_INET6:
                    out.add(socket.inet_ntop(socket.AF_INET6, raw[8:24]))
            p = p.contents.ifa_next
    finally:
        libc.freeifaddrs(head)
    return out


def _source_addresses() -> set[str]:
    """The addresses this machine sends from to the internet (a UDP connect sends nothing): a fallback for getifaddrs."""
    out = set()
    for fam, dst in ((socket.AF_INET, "192.0.2.1"), (socket.AF_INET6, "2001:db8::1")):
        try:
            with socket.socket(fam, socket.SOCK_DGRAM) as s:
                s.connect((dst, 9))
                out.add(s.getsockname()[0])
        except OSError:
            pass
    return out


OWN = {"addrs": frozenset(), "at": 0.0, "wan": frozenset(), "how": "not looked up yet"}
_own_lock = threading.Lock()


def own_addresses() -> frozenset:
    """This machine's addresses, looked up at most once a minute (IPv6 privacy addresses change), plus the WAN IPv4."""
    with _own_lock:
        if time.time() - OWN["at"] > 60:
            try:
                addrs, how = _getifaddrs(), "getifaddrs"
            except (OSError, AttributeError):
                addrs, how = set(), "routes"
            addrs |= _source_addresses()
            OWN.update(addrs=frozenset(_canon(a) for a in addrs), at=time.time(), how=how)
        return OWN["addrs"] | OWN["wan"]


def set_wan(ips) -> None:
    OWN["wan"] = frozenset(_canon(i) for i in ips)


def _canon(a: str) -> str:
    return str(ipaddress.ip_address(a.split("%")[0]))


def public(ip: str) -> bool:
    a = ipaddress.ip_address(ip.split("%")[0])
    if isinstance(a, ipaddress.IPv6Address):
        if a.ipv4_mapped is not None:
            a = a.ipv4_mapped
        elif a in NAT64:                                    # 64:ff9b::a.b.c.d reaches a.b.c.d through a NAT64 gateway
            a = ipaddress.IPv4Address(int(a) & 0xFFFFFFFF)
        elif a in NAT64_LOCAL or a in V4COMPAT:
            return False
        elif a.sixtofour is not None and not public(str(a.sixtofour)):
            return False
    if not a.is_global or a.is_multicast:
        return False
    return str(a) not in own_addresses()


# ---------------------------------------------------------------------------------------------- links

_SAFE_PATH = "/%:@!$&'()*+,;=-._~"
_SAFE_QUERY = _SAFE_PATH + "?"


_DEVIATIONS = frozenset("\u00df\u03c2\u200c\u200d")      # ß, final sigma, ZWNJ, ZWJ: IDNA2003 and 2008 disagree


def _idna(name: str) -> str:
    """A host name in ASCII the way browsers write it (UTS 46, nontransitional: straße.de is xn--strae-oqa.de, not
    strasse.de, which may be someone else's site).  Without the idna package, Python's IDNA 2003 codec, and the four
    characters on which the two differ are refused."""
    try:
        import idna
    except ImportError:
        idna = None
    try:
        if idna is not None:
            try:
                return idna.encode(name, uts46=True, transitional=False).decode("ascii").lower()
            except idna.IDNAError:
                # stricter than browsers (an underscore, "--" in places 3-4): label by label, as WHATWG URLs do
                out = []
                for label in name.split("."):
                    if not label or len(label) > 63:
                        raise Refused("a bad host name") from None
                    if label.isascii():
                        out.append(label.lower())
                    else:
                        out.append(idna.encode(label, uts46=True, transitional=False).decode("ascii").lower())
                return ".".join(out)
        if _DEVIATIONS & set(name):
            raise Refused("a host name with a character that browsers and this fetcher would read differently")
        return name.encode("idna").decode("ascii").lower()
    except (UnicodeError, ValueError):             # idna.IDNAError is a UnicodeError
        raise Refused("a bad host name") from None


def check_url(url: str) -> tuple[str, str, int, str]:
    """(scheme, host, port, the link in ASCII) or Refused."""
    try:
        u = urlsplit(url.strip())
        port_s = u.port
    except ValueError:
        raise Refused("a bad link or port") from None
    scheme = (u.scheme or "").lower()
    if scheme not in PORTS:
        raise Refused("only http and https links")
    if u.username or u.password or "@" in u.netloc:
        raise Refused("links with a user name or password are refused")
    raw = (u.hostname or "").rstrip(".").lower()
    if not raw:
        raise Refused("no host in the link")
    host = raw
    if not raw.startswith("[") and not raw.isascii():
        host = _idna(raw)
    port = port_s or PORTS[scheme]
    if port not in ALLOWED_PORTS:
        raise Refused("only ports 80 and 443")
    try:                                                  # a literal address must be public too
        if not public(host.strip("[]")):
            raise Refused("that address is inside a private network")
        literal = True
    except ValueError:
        literal = False
        if host == "localhost" or host.endswith((".local", ".localhost", ".internal", ".lan", ".home.arpa")):
            raise Refused("that name is inside a private network") from None
    netloc = (f"[{host}]" if literal and ":" in host else host) + (f":{port_s}" if port_s else "")
    path = quote(u.path or "/", safe=_SAFE_PATH)
    query = quote(u.query, safe=_SAFE_QUERY)
    return scheme, host, port, urlunsplit((scheme, netloc, path, query, ""))


def resolve(host: str, port: int) -> str:
    """The address to connect to: refused unless every address the name has is public."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError):
        raise Refused(f"the name {host} does not resolve") from None
    addrs = sorted({i[4][0] for i in infos}, key=lambda a: ":" in a)     # IPv4 first
    if not addrs:
        raise Refused(f"the name {host} does not resolve")
    bad = [a for a in addrs if not public(a)]
    if bad:
        raise Refused(f"{host} points inside a private network or at this server ({bad[0]})")
    return addrs[0]


class PinnedBackend(httpcore.AsyncNetworkBackend):
    """Connects to the address check_url/resolve approved, never to a second lookup.  TLS still checks the certificate
    against the name (httpcore starts TLS with server_hostname=the host)."""

    def __init__(self):
        self.inner = httpcore.AnyIOBackend()

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        ip = await anyio.to_thread.run_sync(resolve, host, port, abandon_on_cancel=True)
        return await self.inner.connect_tcp(ip, port, timeout=timeout, local_address=local_address,
                                            socket_options=socket_options)

    async def connect_unix_socket(self, *a, **kw):
        raise Refused("no local sockets")

    async def sleep(self, seconds):
        await self.inner.sleep(seconds)


# ---------------------------------------------------------------------------------------------- fetching

async def fetch(url: str) -> dict:
    """{ok, url (after redirects), title, text, type, bytes, ms} or {ok: False, error}."""
    t0 = time.time()
    try:
        with anyio.fail_after(TIMEOUT_S):
            got = await download(url)
        if not got["ok"]:
            return got
        title, text = await parse(got.pop("data"), got["type"], got.pop("charset"))
        return got | {"title": title, "text": text, "ms": int((time.time() - t0) * 1000)}
    except Refused as e:
        return {"ok": False, "error": str(e)}
    except TimeoutError:
        return {"ok": False, "error": f"the page took longer than {int(TIMEOUT_S)} s"}
    except (httpcore.ConnectError, httpcore.ConnectTimeout, OSError) as e:
        return {"ok": False, "error": f"could not connect ({type(e).__name__})"}
    except (httpcore.ProtocolError, httpcore.NetworkError, httpcore.TimeoutException) as e:
        return {"ok": False, "error": f"the site answered badly ({type(e).__name__})"}
    except ssl.SSLError:
        return {"ok": False, "error": "the site's certificate is not valid"}
    except Exception as e:                                   # noqa: BLE001 - every page gets an answer, never a 500
        return {"ok": False, "error": f"the page could not be opened ({type(e).__name__})"}


async def download(url: str, max_bytes: int | None = None) -> dict:
    """{ok, url, type, charset, data, bytes} or {ok: False, error}: the raw page, after checked redirects."""
    max_bytes = max_bytes or MAX_BYTES
    ctx = ssl.create_default_context()
    async with httpcore.AsyncConnectionPool(ssl_context=ctx, network_backend=PinnedBackend(), max_connections=4,
                                            retries=0, http2=False) as pool:
        prev_scheme = None
        for _hop in range(MAX_REDIRECTS + 1):
            scheme, _host, _port, url = check_url(url)
            if prev_scheme == "https" and scheme == "http":
                raise Refused("a redirect from https down to http")
            prev_scheme = scheme
            headers = [(b"User-Agent", UA.encode()), (b"Accept", b"text/html,application/xhtml+xml,text/plain;q=0.9,"
                                                                b"application/pdf;q=0.8,*/*;q=0.1"),
                       (b"Accept-Language", b"en;q=0.9,*;q=0.5"), (b"Accept-Encoding", b"identity")]
            async with pool.stream("GET", url, headers=headers) as r:
                if r.status in (301, 302, 303, 307, 308):
                    loc = dict((k.lower(), v) for k, v in r.headers).get(b"location")
                    if not loc:
                        raise Refused("a redirect without a location")
                    try:
                        loc_s = loc.decode("utf-8")
                    except UnicodeDecodeError:
                        loc_s = loc.decode("latin-1")
                    url = urljoin(url, loc_s.strip())
                    continue
                if r.status >= 400:
                    return {"ok": False, "error": f"the site answered {r.status}"}
                h = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in r.headers}
                ctype = h.get("content-type", "").split(";")[0].strip().lower()
                if ctype and not ctype.startswith(TYPES):
                    return {"ok": False, "error": f"not a page ({ctype})"}
                enc = h.get("content-encoding", "identity").strip().lower()
                if enc not in ("", "identity"):
                    return {"ok": False, "error": f"the site sent the page compressed ({enc[:20]}) when asked not to"}
                try:
                    declared = int(h.get("content-length") or 0)
                except ValueError:
                    declared = 0
                if declared > max_bytes:
                    return {"ok": False, "error": "the page is larger than 5 MB"}
                buf = bytearray()
                async for chunk in r.aiter_stream():
                    buf += chunk
                    if len(buf) > max_bytes:
                        return {"ok": False, "error": "the page is larger than 5 MB"}
                m = re.search(r"charset=\"?([\w.:-]{1,40})", h.get("content-type", ""))
                return {"ok": True, "url": url, "type": ctype or "text/html", "charset": m.group(1) if m else None,
                        "data": bytes(buf), "bytes": len(buf)}
        raise Refused(f"more than {MAX_REDIRECTS} redirects")


# ---------------------------------------------------------------------------------------------- parsing, in a child

_mp = None
_SLOTS = threading.BoundedSemaphore(PARSE_WORKERS)        # at most this many parser processes at once


def _context():
    global _mp
    if _mp is None:
        try:
            _mp = multiprocessing.get_context("forkserver")
            _mp.set_forkserver_preload([__name__, "trafilatura", "pypdf"])     # each parse then forks in ms
        except ValueError:                                   # no forkserver here
            _mp = multiprocessing.get_context("spawn")
    return _mp


def _child(conn, mem: int, cpu_s: int) -> None:
    """The parser process: its own limits, one page, then it exits."""
    try:
        import resource
        try:
            with open("/proc/self/statm") as f:
                vsz = int(f.read().split()[0]) * os.sysconf("SC_PAGE_SIZE")
        except OSError:
            vsz = 0
        if vsz:
            resource.setrlimit(resource.RLIMIT_AS, (vsz + mem, vsz + mem))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_s, cpu_s + 2))
    except (ImportError, ValueError, OSError):
        pass                                                 # the wall clock below still holds
    try:
        data, ctype, charset = conn.recv()
        conn.send(("ok", readable(data, ctype, charset)))
    except MemoryError:
        conn.send(("error", "the page needed too much memory to read"))
    except Exception as e:                                   # noqa: BLE001
        conn.send(("error", f"the page could not be read ({type(e).__name__})"))
    finally:
        conn.close()


def parse_blocking(data: bytes, ctype: str, charset: str | None, limit_s: float | None = None) -> tuple[str, str]:
    """readable() in a fresh process (forked from a preloaded server): killed when it runs past the wall clock."""
    limit_s = PARSE_S if limit_s is None else limit_s
    mp = _context()
    parent, child = mp.Pipe()
    p = mp.Process(target=_child, args=(child, PARSE_MEM, max(1, int(limit_s))), daemon=True)
    p.start()
    child.close()
    try:
        try:
            parent.send((data, ctype, charset))
        except OSError:
            raise Refused("the page reader did not start") from None
        if not parent.poll(limit_s):
            raise Refused(f"reading the page took longer than {int(limit_s)} s")
        try:
            kind, val = parent.recv()
        except EOFError:
            raise Refused("reading the page needed too much memory or time") from None
        if kind != "ok":
            raise Refused(val)
        return val
    finally:
        parent.close()
        if p.is_alive():
            p.kill()
        p.join(2)


def _parse_slot(data: bytes, ctype: str, charset: str | None) -> tuple[str, str]:
    if not _SLOTS.acquire(timeout=PARSE_S):
        raise Refused("the page reader is busy: try again")
    try:
        return parse_blocking(data, ctype, charset)
    finally:
        _SLOTS.release()


async def parse(data: bytes, ctype: str, charset: str | None) -> tuple[str, str]:
    """Bounded in time whatever the page holds: the parser process is killed at PARSE_S."""
    return await anyio.to_thread.run_sync(_parse_slot, data, ctype, charset, abandon_on_cancel=True)


_TITLE = re.compile(r"(?i)<title(?:\s[^<>]{0,500})?>")
_BLOCK = re.compile(r"(?i)<(script|style|noscript)\b")
_TAG = re.compile(r"<[^<>]{0,2000}>")


def _decode(data: bytes, charset: str | None) -> str:
    enc = "utf-8"
    if charset:
        try:
            info = codecs.lookup(charset)
            if getattr(info, "_is_text_encoding", True):
                enc = info.name
        except LookupError:
            pass
    return data.decode(enc, "replace")


def _title(html: str) -> str:
    m = _TITLE.search(html)
    if not m:
        return ""
    end = html.lower().find("</title", m.end(), m.end() + 2000)
    return re.sub(r"\s+", " ", html[m.end():end if end >= 0 else m.end() + 300]).strip()


def _strip_blocks(html: str) -> str:
    """Scripts, styles and noscript removed, in one pass (no regex that rescans to the end for every opening tag)."""
    low, out, i = html.lower(), [], 0
    while True:
        m = _BLOCK.search(low, i)
        if not m:
            out.append(html[i:])
            break
        out.append(html[i:m.start()])
        end = low.find("</" + m.group(1).lower(), m.end())
        if end < 0:
            break                                            # never closed: the rest is script
        close = low.find(">", end)
        i = len(low) if close < 0 else close + 1
    return " ".join(out)


def readable(data: bytes, ctype: str, charset: str | None) -> tuple[str, str]:
    """The title and the readable text: menus, scripts and ads removed (trafilatura); a PDF's text (its first 40 pages).
    Runs in the parser process (parse_blocking)."""
    if ctype == "application/pdf" or data[:5] == b"%PDF-":
        import io

        from pypdf import PdfReader
        try:
            rd = PdfReader(io.BytesIO(data))
            title = str((rd.metadata or {}).get("/Title") or "")
            text = "\n\n".join((p.extract_text() or "") for p in rd.pages[:40])
        except MemoryError:
            raise
        except Exception as e:                               # noqa: BLE001 - a broken PDF is an answer, not a crash
            return "", f"(the PDF could not be read: {type(e).__name__})"
        return title.strip()[:300], _tidy(text)
    html = _decode(data, charset)
    if ctype in ("text/plain", "text/markdown"):
        return "", _tidy(html)
    import trafilatura
    title = _title(html)
    text = trafilatura.extract(html, include_comments=False, include_tables=True, include_links=False,
                               favor_recall=True, deduplicate=True) or ""
    if len(text) < 1500:
        # trafilatura found (almost) no article: the page's own text, rows kept on their lines, when that says much
        # more, and only for a page that is mostly a table or a list (kernel.org's releases, a status page) or where
        # trafilatura found next to nothing.  A short article keeps trafilatura's text, without the site's menus.
        plain = _plain_text(html)
        if len(plain) > max(2 * len(text), len(text) + 500) and (len(text.strip()) < 200 or _tabular(html)):
            text = plain
    import html as htmlmod
    return htmlmod.unescape(title)[:300], _tidy(htmlmod.unescape(text) if "<" not in text else text)


_BLOCK_END = re.compile(r"<(?:/(?:tr|p|div|li|ul|ol|table|section|article|h[1-6]|dd|dt|pre|blockquote)|br|hr)\b[^<>]{0,200}>",
                        re.I)
_CELL_END = re.compile(r"</t[dh]\s*>", re.I)


_ANY_TAG = re.compile(r"<(/?)([a-zA-Z][a-zA-Z0-9-]{0,20})\b[^<>]{0,2000}>")
_LISTS = frozenset({"table", "ul", "ol", "dl"})
_CHROME = frozenset({"nav", "header", "footer", "aside"})


def _tabular(html: str, share: float = 0.6) -> bool:
    """Whether most of the page's text (menus, headers and footers left out) is in tables or lists.  One pass over the
    tags, counting the letters between them."""
    t = _strip_blocks(html)
    in_list = in_chrome = 0
    inside = total = 0
    pos = 0
    for m in _ANY_TAG.finditer(t):
        if not in_chrome:
            n = len(t[pos:m.start()].split())             # words, not characters: whitespace is not text
            total += n
            if in_list:
                inside += n
        pos = m.end()
        name, closing = m.group(2).lower(), m.group(1) == "/"
        if name in _LISTS:
            in_list = max(0, in_list - 1) if closing else in_list + 1
        elif name in _CHROME:
            in_chrome = max(0, in_chrome - 1) if closing else in_chrome + 1
    if not in_chrome:
        n = len(t[pos:].split())
        total += n
        inside += n if in_list else 0
    return total > 0 and inside >= share * total


def _plain_text(html: str) -> str:
    """The page's text without scripts, styles and tags; block ends become line breaks and table cells " | " (linear)."""
    t = _strip_blocks(html)
    t = _CELL_END.sub(" | ", t)
    t = _BLOCK_END.sub("\n", t)
    return _TAG.sub(" ", t)


def _tidy(t: str) -> str:
    t = re.sub(r"[ \t\r\f\v]+", " ", t)
    t = re.sub(r"\n\s*\n\s*\n+", "\n\n", t)
    return t.strip()[:400_000]
