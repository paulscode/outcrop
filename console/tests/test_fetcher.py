"""The page fetcher refuses anything inside your network: private addresses, names that resolve there (DNS rebinding),
redirects into it, odd schemes and ports.  And it turns pages into readable text."""
import asyncio
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from outcrop.fetcher import __main__ as svc
from outcrop.fetcher import fetch as F

PAGE = b"""<!doctype html><html><head><title>Boiler pressure &amp; you</title><script>steal()</script></head>
<body><nav>Home | About | Shop</nav><article><h1>Why the pressure drops</h1>
<p>A slow drop overnight usually means the expansion vessel has lost its charge. Check it with a tyre gauge.</p>
<p>A weeping valve is the second most common cause, and the easiest to fix.</p></article>
<footer>Cookie banner</footer></body></html>"""


class Site(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        p = self.path
        if p == "/page":
            self._send(200, PAGE, "text/html; charset=utf-8")
        elif p == "/to-lan":
            self.send_response(302)
            self.send_header("Location", "http://192.168.1.1/admin")
            self.end_headers()
        elif p == "/to-rebind":
            self.send_response(301)
            self.send_header("Location", "http://rebind.test/x")
            self.end_headers()
        elif p == "/loop":
            self.send_response(302)
            self.send_header("Location", "/loop")
            self.end_headers()
        elif p == "/big":
            self._send(200, b"x" * 3000, "text/plain")
        elif p == "/gzip":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", "4")
            self.end_headers()
            self.wfile.write(b"\x1f\x8b\x08\x00")
        elif p == "/odd-charset":
            self._send(200, PAGE, "text/html; charset=rot13")
        elif p == "/to-unicode":
            self.send_response(302)
            self.send_header("Location", "/b%C3%BCcher")
            self.end_headers()
        elif p.startswith("/b%C3%BCcher"):
            self._send(200, b"Books, in German.", "text/plain")
        elif p == "/png":
            self._send(200, b"\x89PNG....", "image/png")
        else:
            self._send(404, b"no", "text/plain")

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def site(monkeypatch):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    real = socket.getaddrinfo

    def fake_dns(host, p, *a, **kw):
        if host == "site.test":                       # a "public" site that is really this test server
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", p))]
        if host == "rebind.test":                     # a public name that resolves into the LAN
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.168.1.30", p))]
        return real(host, p, *a, **kw)

    monkeypatch.setattr(F.socket, "getaddrinfo", fake_dns)
    monkeypatch.setattr(F, "ALLOWED_PORTS", (80, 443, port))
    orig_public = F.public
    monkeypatch.setattr(F, "public", lambda ip: ip == "127.0.0.1" or orig_public(ip))   # only the test server
    yield f"http://site.test:{port}"
    srv.shutdown()


def run(url):
    return asyncio.run(F.fetch(url))


@pytest.mark.parametrize("url,why", [
    ("ftp://example.com/x", "only http and https"),
    ("file:///etc/passwd", "only http and https"),
    ("http://user:pw@example.com/", "user name or password"),
    ("http://localhost/", "private network"),
    ("http://127.0.0.1/", "private network"),
    ("http://192.168.1.1/", "private network"),
    ("http://10.1.2.3/", "private network"),
    ("http://[::1]/", "private network"),
    ("http://[::ffff:192.168.1.1]/", "private network"),
    ("http://169.254.169.254/latest/meta-data", "private network"),
    ("http://100.64.0.1/", "private network"),
    ("http://myserver.local/", "private network"),
    ("http://example.com:8080/", "ports 80 and 443"),
])
def test_refused_links(url, why):
    out = run(url)
    assert out["ok"] is False and why in out["error"]


def test_public_addresses():
    assert F.public("8.8.8.8") and F.public("2606:4700::1111")
    for ip in ("192.168.1.20", "fdd7:403d:7b78:1::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1", "0.0.0.0"):
        assert not F.public(ip), ip


def test_a_page_becomes_readable_text(site):
    out = run(site + "/page")
    assert out["ok"] and out["title"] == "Boiler pressure & you"
    assert "expansion vessel" in out["text"] and "steal()" not in out["text"]


def test_redirects_into_the_lan_are_refused(site):
    assert "private network" in run(site + "/to-lan")["error"]
    assert "points inside a private network" in run(site + "/to-rebind")["error"]       # DNS rebinding
    assert "redirects" in run(site + "/loop")["error"]


def test_limits(site, monkeypatch):
    monkeypatch.setattr(F, "MAX_BYTES", 1000)
    assert "larger than" in run(site + "/big")["error"]
    assert "not a page" in run(site + "/png")["error"]
    assert "404" in run(site + "/nope")["error"]


def test_not_isolated_means_nothing_is_fetched(monkeypatch):
    monkeypatch.setitem(svc.STATE, "isolated", False)
    monkeypatch.setitem(svc.STATE, "allow_unisolated", False)
    sent = []

    async def call():
        msgs = iter([{"type": "http.request", "body": json.dumps({"url": "https://example.com/"}).encode()}])

        async def receive():
            return next(msgs)

        async def send(m):
            sent.append(m)

        await svc.app({"type": "http", "path": "/fetch", "method": "POST"}, receive, send)

    asyncio.run(call())
    body = json.loads(sent[-1]["body"])
    assert body["ok"] is False and "not isolated" in body["error"]


def test_isolation_check_sees_an_open_network():
    # here (no systemd rule) the connections are not refused by the kernel, so it must say so
    r = svc.isolation_check()
    assert r["isolated"] is False and r["checked"]


# ------------------------------------------------------------------------------------------- review fixes (2026-11-07)

def test_addresses_that_wrap_a_private_one():
    for ip in ("64:ff9b::c0a8:401", "64:ff9b:1::1", "::c0a8:401", "2002:c0a8:401::1", "64:ff9b::7f00:1"):
        assert not F.public(ip), ip
    assert F.public("64:ff9b::808:808")                    # NAT64 to a public address is public


def test_this_machines_own_addresses_are_refused(monkeypatch):
    monkeypatch.setitem(F.OWN, "addrs", frozenset({"2a01:4f8::1234", "8.8.4.4"}))
    monkeypatch.setitem(F.OWN, "at", 1e18)                  # no refresh during the test
    assert not F.public("2a01:4f8::1234") and not F.public("8.8.4.4") and F.public("8.8.8.8")
    F.set_wan(["1.1.1.1"])
    try:
        assert not F.public("1.1.1.1")
        with pytest.raises(F.Refused):
            F.check_url("http://1.1.1.1/")
    finally:
        F.set_wan([])
    assert F.public("1.1.1.1")


def test_this_machines_addresses_are_found():
    own = F.own_addresses()
    assert "127.0.0.1" in own or F.OWN["how"] == "routes"


def test_links_become_ascii():
    assert F.check_url("http://bücher.example/straße?q=ü x")[3] == \
        "http://xn--bcher-kva.example/stra%C3%9Fe?q=%C3%BC%20x"
    with pytest.raises(F.Refused):
        F.check_url("http://ⓛocalhost/")                    # IDNA turns it into localhost
    with pytest.raises(F.Refused):
        F.check_url("http://@example.com/")


def test_odd_pages_get_an_answer_not_a_crash(site):
    assert "compressed" in run(site + "/gzip")["error"]
    out = run(site + "/odd-charset")
    assert out["ok"] and "expansion vessel" in out["text"]
    out = run(site + "/to-unicode")
    assert out["ok"] and out["text"] == "Books, in German." and out["url"].endswith("/b%C3%BCcher")
    assert run(site + "/über")["ok"] is False                 # a 404, not a TypeError


def test_hostile_pages_parse_in_linear_time():
    import time
    for blob in (b"<title>" * 700_000, b"<script>" * 600_000, b"<" * 3_000_000):
        t = time.time()
        F.readable(blob, "text/html", None)
        assert time.time() - t < 8, blob[:10]


def test_the_parser_is_killed_at_its_time_limit():
    import multiprocessing
    with pytest.raises(F.Refused, match="longer than"):
        F.parse_blocking(PAGE * 2000, "text/html", None, limit_s=0.001)
    assert F.parse_blocking(PAGE, "text/html", "utf-8")[0] == "Boiler pressure & you"
    time.sleep(0.2)
    assert not [p for p in multiprocessing.active_children() if p.name.startswith("Process")]


def test_only_the_host_is_logged(site, caplog, monkeypatch):
    monkeypatch.setitem(svc.STATE, "isolated", True)
    sent = []

    async def call():
        msgs = iter([{"type": "http.request", "body": json.dumps({"url": site + "/nope?secret=1"}).encode()}])

        async def receive():
            return next(msgs)

        async def send(m):
            sent.append(m)
        await svc.app({"type": "http", "path": "/fetch", "method": "POST"}, receive, send)

    with caplog.at_level("INFO", logger="outcrop.fetcher"):
        asyncio.run(call())
    assert "404" in json.loads(sent[-1]["body"])["error"]
    assert "site.test" in caplog.text and "secret" not in caplog.text and "/nope" not in caplog.text


def test_isolation_is_checked_again_while_it_fails(monkeypatch):
    calls = []
    monkeypatch.setattr(svc, "isolation_check", lambda: calls.append(1) or {"isolated": True, "checked": [],
                                                                              "checked_at": time.time()})
    monkeypatch.setitem(svc.STATE, "isolated", False)
    monkeypatch.setitem(svc.STATE, "checked_at", time.time())
    assert asyncio.run(svc.ensure_isolated()) is False and calls == []           # not before a minute
    monkeypatch.setitem(svc.STATE, "checked_at", time.time() - 61)
    assert asyncio.run(svc.ensure_isolated()) is True and calls == [1]
    assert asyncio.run(svc.ensure_isolated()) is True and calls == [1]           # isolated: no more checks


def test_the_isolation_check_probes_ipv6():
    assert any(r["target"] == "[::1]:443" for r in svc.isolation_check()["checked"])


def test_a_page_that_is_mostly_a_table_keeps_its_rows():
    """trafilatura finds no article in a release table (kernel.org): the page's own text is used, rows intact."""
    rows = "".join(f"<tr><td>stable:</td><td>7.{i}.3</td><td>2026-11-0{i}</td></tr>" for i in range(1, 8))
    html = (f"<html><head><title>Releases</title><script>var x='<tr>'</script></head><body><nav>Home | About</nav>"
            f"<table>{rows}</table></body></html>").encode()
    title, text = F.readable(html, "text/html", "utf-8")
    assert title == "Releases" and "7.3.3" in text and "2026-11-03" in text and "var x" not in text


def test_a_short_article_keeps_trafilaturas_text_without_the_menu():
    """A short article on a site with a big menu: trafilatura's article, not the whole page's text."""
    menu = "".join(f"<li><a href='/s{i}'>Section number {i} of the site</a></li>" for i in range(150))
    body = ("The council voted on Tuesday to extend the library's opening hours through the winter. "
            "Residents had asked for evening hours since the spring, and the new schedule starts next month. ") * 3
    html = (f"<html><head><title>Library hours</title></head><body><nav><ul>{menu}</ul></nav>"
            f"<article><h1>Library hours extended</h1><p>{body}</p></article>"
            f"<footer><ul>{menu}</ul></footer></body></html>").encode()
    title, text = F.readable(html, "text/html", "utf-8")
    assert "opening hours" in text and "Section number" not in text


def test_a_list_page_and_a_page_with_almost_no_article_use_the_plain_text():
    items = "".join(f"<li>service {i}: operational since 2026-11-0{i % 9 + 1}</li>" for i in range(60))
    html = f"<html><body><nav>Home</nav><ul>{items}</ul></body></html>".encode()
    assert "service 59: operational" in F.readable(html, "text/html", "utf-8")[1]
    assert F._tabular(html.decode())
    article = "<html><body><nav><ul><li>a</li><li>b</li></ul></nav><p>" + "words in a paragraph " * 50 + "</p></body></html>"
    assert not F._tabular(article)


def test_host_names_are_encoded_as_browsers_do():
    assert F.check_url("https://straße.de/x")[1] == "xn--strae-oqa.de"
    assert F.check_url("https://Bücher.de/")[1] == "xn--bcher-kva.de"
    with pytest.raises(F.Refused):
        F.check_url("https://a..bü/")
