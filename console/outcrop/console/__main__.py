"""outcrop-console [--dev] [--port 443] [--http-port 80]  - the web console.

On the server: HTTPS on 443 with the private CA's certificate ($OUTCROP_HOME/state/tls), and port 80 serving the CA certificate,
its install steps, and a redirect to HTTPS for everything else.

--dev: plain HTTP on --port (default 8800) for development, e.g. against the fake Strata:
    python -m fakestrata.server --port 18080 --slow &
    OUTCROP_STATE=/tmp/oc python -m outcrop.console --dev --fake-units --strata http://127.0.0.1:18080
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import html
import logging
import os
import signal
import socket
import sys
from pathlib import Path

import uvicorn

from ..common import config
from . import tls
from .app import create_app
from .ctx import Options


class Server(uvicorn.Server):
    @contextlib.contextmanager
    def capture_signals(self):
        yield

    def install_signal_handlers(self) -> None:
        pass


def tcp_socket(host: str, port: int) -> socket.socket:
    fam = socket.AF_INET6 if ":" in host else socket.AF_INET
    s = socket.socket(fam, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if fam == socket.AF_INET6:
        s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    s.bind((host, port))
    s.listen(512)
    s.setblocking(False)
    return s


CA_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trust this server's certificate</title><style>
:root{{color-scheme:light dark;--bg:#0f1115;--fg:#e8e6e3;--mut:#9aa0a6;--line:#2a2e35;--acc:#5eead4}}
@media (prefers-color-scheme:light){{:root{{--bg:#fbfaf8;--fg:#1b1d21;--mut:#5f6368;--line:#e3e1dc;--acc:#0f766e}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}}
main{{max-width:760px;margin:0 auto;padding:32px 16px 64px}}h1{{font-size:1.6rem;margin:0 0 8px}}
h2{{font-size:1.05rem;margin:28px 0 6px}}p,li{{color:var(--fg)}}.mut{{color:var(--mut)}}
code,.fp{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}}
.fp{{display:block;padding:12px;border:1px solid var(--line);border-radius:8px;word-break:break-all;margin:8px 0}}
a.btn{{display:inline-block;margin:12px 0;padding:10px 16px;border-radius:8px;background:var(--acc);color:#0b0c0e;
text-decoration:none;font-weight:600}}ol{{padding-left:1.2em}}</style></head><body><main>
<h1>Trust {host}'s certificate</h1>
<p>The console at <b>https://{name}</b> uses a certificate from a private certificate authority made on this server. Install
that authority on each device you manage the server from, once. It can vouch only for this server's own names
({names}), so it cannot be used to impersonate any other site.</p>
<a class="btn" href="/ca.crt">Download the certificate</a>
<p>Before you trust it, compare its fingerprint with the one <code>outcrop console ca</code> prints over SSH:</p>
<span class="fp">SHA-256 {fp}</span>
<h2>macOS</h2><ol><li>Open the downloaded file; Keychain Access adds it to the <i>login</i> keychain.</li>
<li>Double-click the certificate, open <i>Trust</i>, set <i>When using this certificate</i> to <i>Always Trust</i>.</li></ol>
<h2>Windows</h2><ol><li>Open the file, choose <i>Install Certificate…</i>, <i>Current User</i>.</li>
<li>Choose <i>Place all certificates in the following store</i>, then <i>Trusted Root Certification Authorities</i>.</li></ol>
<h2>Linux (Chrome, system tools)</h2><ol><li><code>sudo cp {host}-ca.crt /usr/local/share/ca-certificates/{host}-ca.crt</code></li>
<li><code>sudo update-ca-certificates</code></li><li>Chrome on Linux also reads its own store: Settings, Privacy and security,
Security, Manage certificates, Authorities, Import.</li></ol>
<h2>Firefox (any system)</h2><ol><li>Settings, Privacy &amp; Security, Certificates, <i>View Certificates…</i></li>
<li><i>Authorities</i>, <i>Import…</i>, tick <i>Trust this CA to identify websites</i>.</li></ol>
<h2>iPhone and iPad</h2><ol><li>Open this page in Safari and download the certificate; allow the profile.</li>
<li>Settings, General, VPN &amp; Device Management: install the profile.</li>
<li>Settings, General, About, Certificate Trust Settings: turn on full trust for it.</li></ol>
<h2>Android</h2><ol><li>Download the certificate.</li><li>Settings, Security, Encryption &amp; credentials, Install a
certificate, CA certificate.</li></ol>
<p class="mut">Then open <a href="https://{name}/">https://{name}/</a>.</p></main></body></html>"""


def http_app(names: set[str]):
    """Port 80: the CA certificate and its install steps; everything else goes to HTTPS."""
    async def app(scope, receive, send):
        if scope["type"] != "http":
            return
        path = scope["path"]
        hdrs = {k.decode().lower(): v.decode("latin-1") for k, v in scope.get("headers") or []}
        host = (hdrs.get("host") or "").split(":")[0].strip("[]").lower()
        safe_host = host if host in names else f"{socket.gethostname()}.local"
        base = [(b"x-content-type-options", b"nosniff"), (b"referrer-policy", b"no-referrer"),
                (b"x-frame-options", b"DENY")]
        if path == "/ca.crt":
            pem = tls.ca_pem()
            if pem:
                await send({"type": "http.response.start", "status": 200, "headers": base + [
                    (b"content-type", b"application/x-x509-ca-cert"), (b"content-length", str(len(pem)).encode()),
                    (b"content-disposition", f'attachment; filename="{socket.gethostname()}-ca.crt"'.encode())]})
                await send({"type": "http.response.body", "body": pem})
                return
        if path in ("/ca", "/ca/") or (path == "/" and not tls.ca_pem()):
            st = tls.status()
            body = CA_PAGE.format(host=html.escape(socket.gethostname()), name=html.escape(safe_host),
                                  names=html.escape(", ".join(st.get("constraints") or [])),
                                  fp=html.escape(st.get("ca_fingerprint") or "(no CA yet)")).encode()
            await send({"type": "http.response.start", "status": 200, "headers": base + [
                (b"content-type", b"text/html; charset=utf-8"), (b"content-length", str(len(body)).encode()),
                (b"content-security-policy", b"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")]})
            await send({"type": "http.response.body", "body": body})
            return
        loc = f"https://{safe_host}{path if path.startswith('/') else '/'}"
        await send({"type": "http.response.start", "status": 301, "headers": base + [
            (b"location", loc.encode()), (b"content-length", b"0")]})
        await send({"type": "http.response.body", "body": b""})
    return app


async def amain(a) -> int:
    opts = Options(dev=a.dev, https=not a.dev, port=a.port or (8800 if a.dev else 443), http_port=a.http_port or 80,
                   host=a.listen or "::", strata_url=a.strata, gateway_sock=Path(a.gateway_sock) if a.gateway_sock else None,
                   web_dist=Path(a.web_dist) if a.web_dist else None, fake_units=a.fake_units,
                   extra_origins=a.origin or [], gateway_url=a.gateway_url, log_dir=Path(a.log_dir) if a.log_dir else None,
                   gateway_ollama_port=a.gateway_ollama_port, searx_url=a.searx_url,
                   fetch_sock=Path(a.fetch_sock) if a.fetch_sock else None)
    app = create_app(opts)
    common = dict(ws="websockets-sansio", lifespan="on", proxy_headers=False, server_header=False, access_log=False,
                  log_level="warning", timeout_keep_alive=30)
    servers = []
    if a.dev:
        servers.append((Server(uvicorn.Config(app, http="httptools", **common)), [tcp_socket(opts.host, opts.port)]))
    else:
        info = tls.ensure()
        p = tls.paths()
        servers.append((Server(uvicorn.Config(app, http="httptools", ssl_certfile=str(p["chain"]), ssl_keyfile=str(p["key"]),
                                              **common)), [tcp_socket(opts.host, opts.port)]))
        names = config.own_host_names() | {n.lower() for n in info.get("names") or []}
        servers.append((Server(uvicorn.Config(http_app(names), http="h11", ws="none", lifespan="off", proxy_headers=False,
                                              server_header=False, access_log=False, log_level="warning")),
                        [tcp_socket(opts.host, opts.http_port)]))
    loop = asyncio.get_running_loop()

    def stop(*_):
        for s, _ in servers:
            s.should_exit = True

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop)
    logging.getLogger("outcrop.console").info("console on %s port %d%s", opts.host, opts.port,
                                              " (development, plain HTTP)" if a.dev else f" (HTTPS) and {opts.http_port}")
    await asyncio.gather(*(s.serve(sockets=socks) for s, socks in servers))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="outcrop-console")
    ap.add_argument("--dev", action="store_true", help="plain HTTP for development")
    ap.add_argument("--fake-units", action="store_true", help="development: no systemd, switches act out their phases")
    ap.add_argument("--listen")
    ap.add_argument("--port", type=int)
    ap.add_argument("--http-port", type=int)
    ap.add_argument("--strata", help="Strata's URL (default http://127.0.0.1:18080)")
    ap.add_argument("--gateway-sock")
    ap.add_argument("--web-dist")
    ap.add_argument("--origin", action="append", help="another allowed origin (development)")
    ap.add_argument("--gateway-url", help="the gateway's OpenAI port (default http://127.0.0.1:8080)")
    ap.add_argument("--log-dir", help="development: read logs from these files instead of the journal")
    ap.add_argument("--gateway-ollama-port", type=int, help="the gateway's Ollama port (default 11434)")
    ap.add_argument("--searx-url", help="the chat's web search, SearXNG (default http://127.0.0.1:8888)")
    ap.add_argument("--fetch-sock", help="the page fetcher's socket (default /run/outcrop-fetch/fetch.sock)")
    a = ap.parse_args(argv)
    logging.basicConfig(level=os.environ.get("OUTCROP_LOG", "INFO"), stream=sys.stderr,
                        format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    try:
        import uvloop
        return uvloop.run(amain(a))
    except ImportError:
        return asyncio.run(amain(a))


if __name__ == "__main__":
    sys.exit(main())
