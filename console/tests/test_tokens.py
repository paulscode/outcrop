import time

import pytest

from outcrop.common import db, tokens
from outcrop.common.tokens import TokenError

PEPPER = b"x" * 32


@pytest.fixture
def con(tmp_path):
    c = db.connect(tmp_path / "t.db")
    yield c
    c.close()


def test_format_and_hash(con):
    pid, plain = tokens.new_secret()
    assert tokens.TOKEN_RE.match(plain)
    assert plain.startswith(f"lls_{pid}_") and len(plain) == 4 + 8 + 1 + 32
    assert tokens.digest(PEPPER, plain) != tokens.digest(b"y" * 32, plain)
    assert tokens.hint_of(plain) == f"lls_{pid}_…"
    assert tokens.hint_of("sk-abcdef0123456789xyz0123") == "sk-a…"


def test_create_stores_only_hmac(con):
    tok, plain = tokens.create(con, PEPPER, "laptop", by="test")
    row = con.execute("SELECT * FROM token_secrets WHERE token_id=?", (tok["id"],)).fetchone()
    assert row["hmac"] == tokens.digest(PEPPER, plain)
    dump = "\n".join(con.iterdump())
    assert plain not in dump and plain[13:] not in dump
    assert tok["scopes"] == ["inference"] and tok["listeners"] == ["openai", "ollama"]
    with pytest.raises(TokenError):
        tokens.create(con, PEPPER, "laptop")
    assert db.events(con, 5)[0]["kind"] == "token.create"


def test_import_rules(con):
    with pytest.raises(TokenError):
        tokens.create(con, PEPPER, "short", value="too-short")
    with pytest.raises(TokenError):
        tokens.create(con, PEPPER, "spaces", value="has a space in it 0123456789")
    tok, plain = tokens.create(con, PEPPER, "old-app", value="sk-legacy-0123456789-abcdefgh")
    assert tok["imported"] and plain == "sk-legacy-0123456789-abcdefgh" and tok["hint"] == "sk-l…"
    with pytest.raises(TokenError):
        tokens.create(con, PEPPER, "dup", value="sk-legacy-0123456789-abcdefgh")


def test_cache_statuses_and_rotation_grace(con):
    tok, plain = tokens.create(con, PEPPER, "a")
    cache = tokens.TokenCache(PEPPER)
    cache.load(con)
    assert cache.lookup(plain).status == "ok"
    assert cache.lookup("lls_nope0000_" + "0" * 32).status == "unknown"
    _, new = tokens.rotate(con, PEPPER, "a", grace_s=60)
    cache.load(con)
    assert cache.lookup(new).status == "ok"
    assert cache.lookup(plain).status == "ok"                   # in its grace
    assert cache.lookup(plain, now=time.time() + 61).status == "grace_ended"
    _, newer = tokens.rotate(con, PEPPER, "a", grace_s=0)
    cache.load(con)
    assert cache.lookup(newer).status == "ok"
    assert cache.lookup(new).status in ("grace_ended", "unknown")
    assert cache.lookup(plain).status in ("grace_ended", "unknown")
    tokens.revoke(con, "a")
    cache.load(con)
    assert cache.lookup(newer).status == "revoked"


def test_expiry(con):
    tok, plain = tokens.create(con, PEPPER, "short", expires_at=time.time() + 30)
    cache = tokens.TokenCache(PEPPER)
    cache.load(con)
    assert cache.lookup(plain).status == "ok"
    assert cache.lookup(plain, now=time.time() + 31).status == "expired"
    assert tokens.parse_expiry("never") is None
    assert abs(tokens.parse_expiry("30d", now=1000.0) - (1000.0 + 30 * 86400)) < 1
    with pytest.raises(TokenError):
        tokens.parse_expiry("2001-01-01")
    with pytest.raises(TokenError):
        tokens.parse_expiry("soon")


def test_update_and_validation(con):
    tokens.create(con, PEPPER, "x")
    t = tokens.update(con, "x", scopes="inference,telemetry", cidrs="192.168.1.0/24", rpm=60, listeners="ollama")
    assert t["scopes"] == ["inference", "telemetry"] and t["cidrs"] == ["192.168.1.0/24"] and t["rpm"] == 60
    assert t["listeners"] == ["ollama"]
    with pytest.raises(TokenError):
        tokens.update(con, "x", scopes="root")
    with pytest.raises(TokenError):
        tokens.update(con, "x", cidrs="not-a-net")
    with pytest.raises(TokenError):
        tokens.create(con, PEPPER, "")
    with pytest.raises(TokenError):
        tokens.create(con, PEPPER, "bad/name")


def test_find_by_id_prefix_and_name(con):
    tok, plain = tokens.create(con, PEPPER, "finder")
    assert tokens.find(con, "finder")["id"] == tok["id"]
    assert tokens.find(con, tok["id"])["id"] == tok["id"]
    assert tokens.find(con, plain[:13])["id"] == tok["id"]
    tokens.revoke(con, "finder")
    assert tokens.find(con, "finder") is None
    assert tokens.find(con, "finder", include_revoked=True)["id"] == tok["id"]
    tok2, _ = tokens.create(con, PEPPER, "finder")          # the name is free again
    assert tok2["id"] != tok["id"]


def test_token_scope_ip_rules(con):
    tokens.create(con, PEPPER, "lan", cidrs=["192.168.1.0/24"], scopes=["telemetry"])
    cache = tokens.TokenCache(PEPPER)
    cache.load(con)
    t = next(iter(cache.by_id.values()))
    assert t.allows_ip("192.168.1.9") and not t.allows_ip("10.0.0.1") and not t.allows_ip("garbage")
    assert t.allows_scope("telemetry") and not t.allows_scope("inference") and not t.allows_scope("admin")
