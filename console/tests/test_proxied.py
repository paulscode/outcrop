"""The gateway behind StartOS's reverse proxy: X-Forwarded-For is believed only on the proxied port, only from the proxy."""
import time

import httpx
import pytest
from conftest import Stack

from outcrop.gateway.app import client_ip

PROXY = frozenset({"10.0.3.1"})


@pytest.mark.parametrize("peer, headers, proxied, want", [
    ("10.0.3.1", {"x-forwarded-for": "192.168.1.35"}, True, "192.168.1.35"),               # the proxy says who
    ("::ffff:10.0.3.1", {"x-forwarded-for": "192.168.1.35"}, True, "192.168.1.35"),        # IPv4-mapped peer
    ("10.0.3.1", {"x-forwarded-for": "6.6.6.6, 192.168.1.35"}, True, "192.168.1.35"),      # the last entry is the proxy's
    ("10.0.3.1", {"x-forwarded-for": "::ffff:192.168.1.35"}, True, "192.168.1.35"),
    ("10.0.3.1", {}, True, "10.0.3.1"),                                                     # no header: the proxy
    ("10.0.3.1", {"x-forwarded-for": "not-an-address"}, True, "10.0.3.1"),
    ("10.0.3.1", {"x-forwarded-for": "192.168.1.35"}, False, "10.0.3.1"),                  # not the proxied port
    ("10.0.3.77", {"x-forwarded-for": "192.168.1.35"}, True, "10.0.3.77"),                 # another container
    ("192.168.1.35", {"x-forwarded-for": "127.0.0.1"}, False, "192.168.1.35"),              # a LAN client on a raw port
    ("10.0.3.1", {"forwarded": "for=192.168.1.35", "x-real-ip": "192.168.1.35"}, True, "10.0.3.1"),  # never read
])
def test_client_ip(peer, headers, proxied, want):
    assert client_ip(peer, headers, proxied, PROXY) == want


@pytest.fixture
def pstack(tmp_path):
    s = Stack(tmp_path, proxied=True)
    try:
        yield s
    finally:
        s.stop()


def chat(port, token, **headers):
    return httpx.post(f"http://127.0.0.1:{port}/v1/chat/completions", timeout=20,
                      headers={"Authorization": f"Bearer {token}", **headers},
                      json={"model": "m", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 4})


def test_a_cidr_token_behind_the_proxy(pstack):
    t = pstack.token("lan-app", cidrs=["192.0.2.10/32"])
    # through the proxy, from the address the token allows
    assert chat(pstack.proxied_port, t, **{"X-Forwarded-For": "192.0.2.10"}).status_code == 200
    # through the proxy, from another address
    assert chat(pstack.proxied_port, t, **{"X-Forwarded-For": "198.51.100.7"}).status_code == 403
    # on the raw port the header is the client's own claim: ignored (the peer, 127.0.0.1, is outside the CIDR)
    assert chat(pstack.openai_port, t, **{"X-Forwarded-For": "192.0.2.10"}).status_code == 403
    # Forwarded is never believed, even on the proxied port
    assert chat(pstack.proxied_port, t, Forwarded="for=192.0.2.10").status_code == 403
    for _ in range(100):                     # an answered request is recorded when its response has finished
        pstack.flush()
        ips = [r[0] for r in pstack.con.execute("SELECT client_ip FROM requests ORDER BY started_at")]
        if len(ips) == 4:
            break
        time.sleep(0.05)
    assert ips == ["192.0.2.10", "198.51.100.7", "127.0.0.1", "127.0.0.1"]


def test_strata_sees_the_gateways_forwarding_only(pstack):
    """Whatever the client or the proxy sent, Strata gets the gateway's own X-Forwarded-For: the real client."""
    t = pstack.token("app")
    r = chat(pstack.proxied_port, t, **{"X-Forwarded-For": "192.0.2.10", "Forwarded": "for=6.6.6.6", "X-Real-IP": "6.6.6.6"})
    assert r.status_code == 200
    seen = {k.lower(): v for k, v in [x for x in pstack.fake.state.seen if x["path"].startswith("/v1/chat")][-1]["headers"].items()}
    assert seen.get("x-forwarded-for") == "192.0.2.10"
    assert "forwarded" not in seen and "x-real-ip" not in seen
