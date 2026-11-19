"""The console's password policy and its private CA."""
import datetime as dt
import ipaddress

import pytest
from cryptography import x509
from cryptography.x509.verification import PolicyBuilder, Store, VerificationError

from outcrop.console import passwords, tls

WEAK = ["Summer2026!Summer2026!", "correcthorsebatterystaple", "correct horse battery staple", "password1234567890",
        "qwertyuiopasdfghjkl", "outcrop-is-my-server-2026", "MyStrataServer!!2026", "aaaaaaaaaaaaaaaaaaaa",
        "iloveyou1234567890", "short", "Tr0ub4dor&3Tr0ub4dor&3", "alicealicealice1", "1qaz2wsx3edc4rfv5tgb"]


@pytest.mark.parametrize("pw", WEAK)
def test_weak_passwords_are_refused(pw):
    v = passwords.check(pw, username="dev")
    assert not v.ok, (pw, v)
    assert v.reasons


def test_generated_passphrases_pass():
    for _ in range(10):
        pw = passwords.generate(username="dev")
        assert len(pw.split()) == 6
        v = passwords.check(pw, username="dev")
        assert v.ok, (pw, v.reasons)


def test_unicode_and_spaces_allowed():
    v = passwords.check("ünïcødé glacier lantern velvet orbit", username="dev")
    assert v.ok, v.reasons


def test_hashing():
    h = passwords.hash_password("x" * 20)
    assert h.startswith("$argon2id$") and "m=65536,t=3,p=4" in h
    assert passwords.verify_password(h, "x" * 20) and not passwords.verify_password(h, "y" * 20)
    assert not passwords.verify_password("garbage", "x")


def _verifier(ca, name):
    store = Store([ca])
    b = PolicyBuilder().store(store).time(dt.datetime.now(dt.timezone.utc))
    return b.build_server_verifier(name)


def test_ca_name_constraints():
    names = tls.Names(["myserver.local", "myserver", "localhost"], ["127.0.0.1", "192.168.1.20"])
    ca_key, ca = tls.make_ca(names)
    nc = ca.extensions.get_extension_for_class(x509.NameConstraints)
    assert nc.critical
    # the server certificate verifies for its own names
    _, leaf = tls.make_server(ca_key, ca, names)
    _verifier(ca, x509.DNSName("myserver.local")).verify(leaf, [])
    _verifier(ca, x509.IPAddress(ipaddress.ip_address("192.168.1.20"))).verify(leaf, [])
    # a certificate the CA signs for another site does not
    _, evil = tls.make_server(ca_key, ca, tls.Names(["example.com"], []))
    with pytest.raises(VerificationError):
        _verifier(ca, x509.DNSName("example.com")).verify(evil, [])
    _, evil_ip = tls.make_server(ca_key, ca, tls.Names(["myserver.local"], ["8.8.8.8"]))
    with pytest.raises(VerificationError):
        _verifier(ca, x509.IPAddress(ipaddress.ip_address("8.8.8.8"))).verify(evil_ip, [])
    # and the leaf is valid 397 days, the CA 10 years
    assert 396 <= (leaf.not_valid_after_utc - leaf.not_valid_before_utc).days <= 398
    assert (ca.not_valid_after_utc - ca.not_valid_before_utc).days >= 3649


def test_ensure_creates_and_renews(tmp_path, monkeypatch):
    monkeypatch.setattr(tls.config, "TLS_DIR", tmp_path / "tls")
    a = tls.ensure()
    assert a["made"] == ["ca", "server"] and a["ca_fingerprint"].count(":") == 31
    assert oct((tmp_path / "tls" / "ca.key").stat().st_mode)[-3:] == "600"
    assert oct((tmp_path / "tls").stat().st_mode)[-3:] == "700"
    b = tls.ensure()
    assert b["made"] == [] and b["ca_fingerprint"] == a["ca_fingerprint"]
    c = tls.ensure(force_server=True)
    assert c["made"] == ["server"] and c["ca_fingerprint"] == a["ca_fingerprint"]
    st = tls.status()
    assert st["ca"] and st["days_left"] >= 396
