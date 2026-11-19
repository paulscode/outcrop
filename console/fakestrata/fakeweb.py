"""fakeweb.py --searx-port N --fetch-sock PATH  - a fake SearXNG and a fake page fetcher for the dev stack (console/dev.py),
so the chat's web tools work without the internet.  Results and pages are made up, and say so."""
import argparse
import json
import os
import re
import socketserver
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

SITES = [("en.wikipedia.org", "Wikipedia"), ("docs.example.org", "Example Docs"), ("forum.example.net", "Example Forum"),
         ("news.example.com", "Example News"), ("blog.example.dev", "A developer's blog")]


class Base(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def address_string(self):
        return "local"

    def send(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


class Searx(Base):
    def do_GET(self):
        u = urlsplit(self.path)
        if u.path == "/healthz":
            return self.send("OK")
        q = parse_qs(u.query).get("q", [""])[0]
        slug = re.sub(r"[^a-z0-9]+", "-", q.lower()).strip("-")[:50] or "page"
        self.send({"query": q, "results": [
            {"url": f"https://{host}/{slug}", "title": f"{q[:60]} - {name}", "engine": "fake",
             "content": f"A made-up result from {name} about “{q[:80]}”, for developing the console."}
            for host, name in SITES]})


class Fetch(Base):
    def do_GET(self):
        self.send({"ok": True})

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        url = str(req.get("url") or "")
        host = urlsplit(url).hostname or "?"
        self.send({"ok": True, "url": url, "title": f"A page on {host}", "type": "text/html",
                   "text": f"This is a made-up page at {url}. It explains the topic in three paragraphs.\n\n"
                           "The value changed this week, and the newest release fixes it."})


class UnixHTTP(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--searx-port", type=int, default=18888)
    ap.add_argument("--fetch-sock", required=True)
    a = ap.parse_args()
    s = ThreadingHTTPServer(("127.0.0.1", a.searx_port), Searx)
    if os.path.exists(a.fetch_sock):
        os.remove(a.fetch_sock)
    f = UnixHTTP(a.fetch_sock, Fetch)
    threading.Thread(target=f.serve_forever, daemon=True).start()
    print(f"fake SearXNG on http://127.0.0.1:{a.searx_port}, fake fetcher on {a.fetch_sock}", flush=True)
    s.serve_forever()


if __name__ == "__main__":
    main()
