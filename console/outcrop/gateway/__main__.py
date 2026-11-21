"""outcrop-gateway [--listen ::] [--port 8080] [--ollama-port 11434] [--strata URL] [--bridge URL] [--socket PATH]

Run the API gateway: ports 8080 (OpenAI and Anthropic APIs) and 11434 (Ollama API) in front of Strata on loopback, and the
control socket.  Settings come from presets.json (`server`, `gateway`) and the state directory; flags override them.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import os
import signal
import socket
import sys
from pathlib import Path

import uvicorn

from ..common import config, tokens
from .app import Control, Gateway
from .conn import GatewayProtocol


class Server(uvicorn.Server):
    """uvicorn without its own signal handling: two servers share one process, and main() stops both."""

    @contextlib.contextmanager
    def capture_signals(self):
        yield

    def install_signal_handlers(self) -> None:   # uvicorn < 0.29
        pass


def tcp_socket(host: str, port: int) -> socket.socket:
    fam = socket.AF_INET6 if ":" in host else socket.AF_INET
    s = socket.socket(fam, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if fam == socket.AF_INET6:
        s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)     # "::" takes IPv4 too
    s.bind((host, port))
    s.listen(1024)
    s.setblocking(False)
    return s


def unix_socket(path: Path) -> socket.socket:
    path.parent.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(FileNotFoundError):
        path.unlink()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o117)
    try:
        s.bind(str(path))
    finally:
        os.umask(old)
    os.chmod(path, 0o660)
    s.listen(64)
    s.setblocking(False)
    return s


async def amain(a) -> int:
    net = config.net()
    if a.port:
        net.openai_port = a.port
    if a.ollama_port:
        net.ollama_port = a.ollama_port
    listen = a.listen or net.listen
    gw = Gateway(net, strata_url=a.strata, bridge_url=a.bridge,
                 db_path=Path(a.db) if a.db else None, searx_url=a.searx_url, fetch_sock=a.fetch_sock)
    await gw.start()
    socks = [tcp_socket(listen, net.openai_port), tcp_socket(listen, net.ollama_port)]
    if net.proxied_port:            # plain HTTP for a TLS-terminating proxy in front (StartOS); see gateway/app.py client_ip
        socks.append(tcp_socket(listen, net.proxied_port))
        logging.getLogger("outcrop.gateway").info("and port %d behind the proxy at %s", net.proxied_port,
                                                  ", ".join(net.trusted_proxies) or "(none trusted)")
    sock_path = Path(a.socket) if a.socket else config.GATEWAY_SOCK
    usock = unix_socket(sock_path)
    common = dict(ws="none", lifespan="off", proxy_headers=False, server_header=False, date_header=True,
                  access_log=False, log_level="warning", interface="asgi3")
    api = Server(uvicorn.Config(gw, http=GatewayProtocol, timeout_keep_alive=5, timeout_graceful_shutdown=20, **common))
    ctl = Server(uvicorn.Config(Control(gw), http="h11", timeout_graceful_shutdown=2, **common))
    servers = [(api, socks), (ctl, [usock])]
    chain, key = config.TLS_DIR / "server-chain.pem", config.TLS_DIR / "server.key"
    if net.https_port and chain.exists() and key.exists():
        tls = Server(uvicorn.Config(gw, http=GatewayProtocol, timeout_keep_alive=5, timeout_graceful_shutdown=20,
                                    ssl_certfile=str(chain), ssl_keyfile=str(key), **common))
        servers.append((tls, [tcp_socket(listen, net.https_port)]))
        logging.getLogger("outcrop.gateway").info("and HTTPS on port %d (the console's certificate)", net.https_port)
    elif net.https_port:
        logging.getLogger("outcrop.gateway").warning("no certificate in %s yet: HTTPS on %d is off", config.TLS_DIR,
                                                     net.https_port)
    loop = asyncio.get_running_loop()

    def stop(*_):
        logging.getLogger("outcrop.gateway").info("stopping")
        for srv, _ in servers:
            srv.should_exit = True

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop)
    logging.getLogger("outcrop.gateway").info(
        "listening on %s ports %d (OpenAI/Anthropic) and %d (Ollama); control socket %s", listen, net.openai_port,
        net.ollama_port, sock_path)
    try:
        await asyncio.gather(*(srv.serve(sockets=sk) for srv, sk in servers))
    finally:
        await gw.stop()
        with contextlib.suppress(OSError):
            sock_path.unlink()
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="outcrop-gateway", description=__doc__.split("\n\n")[1])
    ap.add_argument("--listen", help="address to listen on (default: presets.json gateway.listen)")
    ap.add_argument("--port", type=int, help="the OpenAI/Anthropic port (default 8080)")
    ap.add_argument("--ollama-port", type=int, help="the Ollama port (default 11434)")
    ap.add_argument("--strata", help="Strata's URL (default http://127.0.0.1:18080)")
    ap.add_argument("--bridge", help="the Ollama bridge's URL (default http://127.0.0.1:11435)")
    ap.add_argument("--socket", help="the control socket (default /run/outcrop/gateway.sock)")
    ap.add_argument("--db", help="the database (default ~/.outcrop/state/outcrop.db)")
    ap.add_argument("--searx-url", help="web tools for apps: SearXNG (default http://127.0.0.1:8888)")
    ap.add_argument("--fetch-sock", help="web tools for apps: the page fetcher (default /run/outcrop-fetch/fetch.sock)")
    a = ap.parse_args(argv)
    logging.basicConfig(level=os.environ.get("OUTCROP_LOG", "INFO"), stream=sys.stderr,
                        format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)       # not one line per upstream request
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    tokens.load_pepper()          # create it before the first request, with the right mode
    try:
        import uvloop
        return uvloop.run(amain(a))
    except ImportError:
        return asyncio.run(amain(a))


if __name__ == "__main__":
    sys.exit(main())
