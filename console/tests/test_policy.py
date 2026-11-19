import pytest

from outcrop.common import policy
from outcrop.common.policy import ADMIN, INFERENCE, PUBLIC, TELEMETRY


@pytest.mark.parametrize("method,path,cls", [
    ("GET", "/", PUBLIC), ("GET", "/web/app.js", PUBLIC), ("GET", "/health", PUBLIC), ("OPTIONS", "/v1/x", PUBLIC),
    ("POST", "/v1/chat/completions", INFERENCE), ("POST", "/v1/chat/completions/", INFERENCE),
    ("POST", "/v1/messages", INFERENCE), ("POST", "/v1/messages/count_tokens", INFERENCE),
    ("POST", "/v1/responses", INFERENCE), ("GET", "/v1/responses/resp_1", INFERENCE), ("GET", "/v1/models", INFERENCE),
    ("GET", "/v1/models?x=1", INFERENCE), ("GET", "/metrics", TELEMETRY), ("GET", "/metrics?requests=all", TELEMETRY),
    ("GET", "/v1/telemetry", TELEMETRY), ("GET", "/props", TELEMETRY), ("GET", "/slots", TELEMETRY),
    ("GET", "/status", ADMIN), ("POST", "/unload", ADMIN), ("POST", "/settings", ADMIN), ("GET", "/config", ADMIN),
    ("POST", "/slots/0", ADMIN), ("GET", "/tool-media/abc", ADMIN), ("GET", "/api/requests", ADMIN),
])
def test_openai_routes(method, path, cls):
    r = policy.classify("openai", method, path)
    assert r is not None and r.cls == cls


@pytest.mark.parametrize("method,path", [
    ("GET", "/v1/chat/completions"), ("POST", "/v1/models"), ("GET", "/nope"), ("GET", "/v1/chat%2Fcompletions"),
    ("POST", "/v1/completions"), ("GET", "/web/../status"), ("GET", "//status"), ("GET", "/api/tags"),
    ("GET", "/web/%2e%2e/x"), ("DELETE", "/v1/models"), ("PUT", "/settings"),
])
def test_openai_denied(method, path):
    assert policy.classify("openai", method, path) is None


def test_ollama_routes():
    assert policy.classify("ollama", "POST", "/api/chat").target == policy.T_BRIDGE
    assert policy.classify("ollama", "GET", "/api/tags").cls == INFERENCE
    assert policy.classify("ollama", "GET", "/").cls == PUBLIC
    assert policy.classify("ollama", "POST", "/v1/chat/completions").target == policy.T_STRATA
    assert policy.classify("ollama", "GET", "/metrics") is None
    assert policy.classify("ollama", "POST", "/api/pull") is None
    assert policy.classify("ollama", "POST", "/unload") is None


def test_credentials():
    assert policy.credential([(b"authorization", b"Bearer abc")]) == "abc"
    assert policy.credential([(b"Authorization", b"bearer   abc  ")]) == "abc"
    assert policy.credential([(b"x-api-key", b"k1")]) == "k1"
    assert policy.credential([(b"authorization", b"Basic Zm9v")]) is None
    assert policy.credential([]) is None
    assert policy.credential([(b"authorization", b"Bearer ")]) is None
    assert policy.credential([(b"authorization", b"Bearer same"), (b"x-api-key", b"same")]) == "same"
    with pytest.raises(policy.BadCredential):
        policy.credential([(b"authorization", b"Bearer a"), (b"authorization", b"Bearer b")])
    assert policy.credentials([(b"authorization", b"Bearer a"), (b"x-api-key", b"b")]) == ["a", "b"]
    with pytest.raises(policy.BadCredential):
        policy.credential([(b"x-api-key", b"a\x01b")])
    with pytest.raises(policy.BadCredential):
        policy.credential([(b"x-api-key", b"x" * 600)])


def test_host_and_origin():
    names = {"myserver.local", "192.168.1.20", "localhost", "::1"}
    assert policy.host_allowed("myserver.local:8080", names)
    assert policy.host_allowed("[::1]:8080", names)
    assert policy.host_allowed(None, names)
    assert not policy.host_allowed("evil.example:8080", names)
    assert not policy.host_allowed("myserver.local.evil.example", names)
    assert policy.origin_allowed(None, "myserver.local:8080", names, [])
    assert policy.origin_allowed("http://myserver.local:8080", "myserver.local:8080", names, [])
    assert policy.origin_allowed("https://myserver.local", "192.168.1.20:8080", names, [])
    assert not policy.origin_allowed("https://evil.example", "myserver.local:8080", names, [])
    assert policy.origin_allowed("https://app.example", "myserver.local:8080", names, ["https://app.example"])
    assert not policy.origin_allowed("null", "myserver.local:8080", names, [])


def test_open_window_covers():
    import time
    w = policy.OpenWindow(time.time() + 60, policy.parse_networks(["192.168.1.50"]), frozenset({"ollama"}))
    now = time.time()
    assert w.covers("ollama", "192.168.1.50", now)
    assert not w.covers("openai", "192.168.1.50", now)
    assert not w.covers("ollama", "192.168.1.110", now)
    assert not w.covers("ollama", "192.168.1.50", now + 61)
