"""The console's private certificate authority and server certificate.

The CA is ECDSA P-256, valid 10 years, and carries X.509 name constraints: it can sign only for this server's own names
(HOSTNAME.local, HOSTNAME, localhost) and addresses.  So even if its key leaked, it could not be used to impersonate any other
site to a device that trusts it.  The server certificate is valid 397 days (Apple's limit) and is renewed 30 days before it
ends.  Everything lives in $OUTCROP_HOME/state/tls/ (keys 0600); the CA key is never served.
"""
from __future__ import annotations

import datetime as dt
import ipaddress
import json
import os
import socket
from dataclasses import dataclass
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from ..common import config

CA_DAYS = 3650
SERVER_DAYS = 397
RENEW_BEFORE_DAYS = 30


def tls_dir() -> Path:
    d = config.TLS_DIR
    d.mkdir(parents=True, exist_ok=True)
    os.chmod(d, 0o700)
    return d


@dataclass
class Names:
    dns: list[str]
    ips: list[str]

    @classmethod
    def default(cls, extra: list[str] | None = None) -> "Names":
        h = socket.gethostname().lower()
        dns = list(dict.fromkeys([f"{h}.local", h, "localhost"]))
        ips = ["127.0.0.1", "::1"] + [a for a in config.lan_addresses() if ":" not in a]
        for x in extra or []:
            try:
                ipaddress.ip_address(x)
                ips.append(x)
            except ValueError:
                dns.append(x.lower())
        return cls(list(dict.fromkeys(dns)), list(dict.fromkeys(ips)))

    def sans(self) -> list[x509.GeneralName]:
        return [x509.DNSName(d) for d in self.dns] + [x509.IPAddress(ipaddress.ip_address(i)) for i in self.ips]


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _write(path: Path, data: bytes, mode: int) -> None:
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def make_ca(names: Names) -> tuple[ec.EllipticCurvePrivateKey, x509.Certificate]:
    key = ec.generate_private_key(ec.SECP256R1())
    host = socket.gethostname()
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"Outcrop local CA ({host})"),
                         x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Outcrop")])
    permitted = [x509.DNSName(d) for d in names.dns]
    for i in names.ips:
        a = ipaddress.ip_address(i)
        permitted.append(x509.IPAddress(ipaddress.ip_network(f"{a}/{a.max_prefixlen}")))
    now = _now()
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - dt.timedelta(minutes=5))
            .not_valid_after(now + dt.timedelta(days=CA_DAYS))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=False, content_commitment=False, key_encipherment=False,
                                         data_encipherment=False, key_agreement=False, key_cert_sign=True, crl_sign=True,
                                         encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.NameConstraints(permitted_subtrees=permitted, excluded_subtrees=None), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256()))
    return key, cert


def make_server(ca_key, ca_cert: x509.Certificate, names: Names, days: int = SERVER_DAYS):
    key = ec.generate_private_key(ec.SECP256R1())
    now = _now()
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, names.dns[0])]))
            .issuer_name(ca_cert.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(minutes=5)).not_valid_after(now + dt.timedelta(days=days))
            .add_extension(x509.SubjectAlternativeName(names.sans()), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                                         data_encipherment=False, key_agreement=False, key_cert_sign=False, crl_sign=False,
                                         encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    return key, cert


def pem_key(key) -> bytes:
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())


def pem_cert(cert: x509.Certificate) -> bytes:
    return cert.public_bytes(serialization.Encoding.PEM)


def fingerprint(cert: x509.Certificate) -> str:
    h = cert.fingerprint(hashes.SHA256()).hex().upper()
    return ":".join(h[i:i + 2] for i in range(0, len(h), 2))


def paths() -> dict:
    d = tls_dir()
    return {"ca_key": d / "ca.key", "ca_crt": d / "ca.crt", "key": d / "server.key", "crt": d / "server.crt",
            "chain": d / "server-chain.pem", "meta": d / "meta.json"}


def load_ca():
    p = paths()
    if not (p["ca_key"].exists() and p["ca_crt"].exists()):
        return None, None
    key = serialization.load_pem_private_key(p["ca_key"].read_bytes(), password=None)
    return key, x509.load_pem_x509_certificate(p["ca_crt"].read_bytes())


def load_server() -> x509.Certificate | None:
    p = paths()
    if not p["crt"].exists():
        return None
    return x509.load_pem_x509_certificate(p["crt"].read_bytes())


def ca_constraints(ca_cert: x509.Certificate) -> Names:
    nc = ca_cert.extensions.get_extension_for_class(x509.NameConstraints).value
    dns = [g.value for g in nc.permitted_subtrees if isinstance(g, x509.DNSName)]
    ips = [str(g.value.network_address) for g in nc.permitted_subtrees if isinstance(g, x509.IPAddress)]
    return Names(dns, ips)


def ensure(force_server: bool = False, extra: list[str] | None = None) -> dict:
    """Create the CA (once) and a server certificate when it is missing, ends within 30 days, or `force_server`."""
    p = paths()
    ca_key, ca_cert = load_ca()
    made = []
    if ca_key is None:
        ca_key, ca_cert = make_ca(Names.default(extra))
        _write(p["ca_key"], pem_key(ca_key), 0o600)
        _write(p["ca_crt"], pem_cert(ca_cert), 0o644)
        made.append("ca")
    allowed = ca_constraints(ca_cert)
    want = Names.default(extra)
    # only names the CA may sign for (an address outside them needs a new CA: outcrop console ca --new)
    names = Names([d for d in want.dns if _dns_ok(d, allowed.dns)], [i for i in want.ips if i in allowed.ips])
    outside = [d for d in want.dns if d not in names.dns] + [i for i in want.ips if i not in names.ips]
    srv = load_server()
    due = srv is None or srv.not_valid_after_utc - _now() < dt.timedelta(days=RENEW_BEFORE_DAYS)
    if srv is not None and not due:
        have = srv.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        have_names = set(have.get_values_for_type(x509.DNSName)) | {str(i) for i in have.get_values_for_type(x509.IPAddress)}
        due = not set(names.dns + names.ips) <= have_names
    if due or force_server:
        key, cert = make_server(ca_key, ca_cert, names)
        _write(p["key"], pem_key(key), 0o600)
        _write(p["crt"], pem_cert(cert), 0o644)
        _write(p["chain"], pem_cert(cert) + pem_cert(ca_cert), 0o644)
        made.append("server")
        srv = cert
    meta = {"ca_fingerprint": fingerprint(ca_cert), "server_not_after": srv.not_valid_after_utc.isoformat(),
            "names": names.dns + names.ips, "outside_ca": outside}
    _write(p["meta"], json.dumps(meta, indent=1).encode(), 0o644)
    return {**meta, "made": made}


def _dns_ok(name: str, permitted: list[str]) -> bool:
    return any(name == p or name.endswith("." + p) for p in permitted)


def status() -> dict:
    ca_key, ca_cert = load_ca()
    srv = load_server()
    if ca_cert is None:
        return {"ca": False}
    out = {"ca": True, "ca_fingerprint": fingerprint(ca_cert), "ca_subject": ca_cert.subject.rfc4514_string(),
           "ca_not_after": ca_cert.not_valid_after_utc.isoformat(),
           "constraints": ca_constraints(ca_cert).dns + ca_constraints(ca_cert).ips}
    if srv is not None:
        san = srv.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        out.update(server_not_after=srv.not_valid_after_utc.isoformat(),
                   server_names=list(san.get_values_for_type(x509.DNSName))
                   + [str(i) for i in san.get_values_for_type(x509.IPAddress)],
                   days_left=(srv.not_valid_after_utc - _now()).days)
    return out


def ca_pem() -> bytes | None:
    p = paths()["ca_crt"]
    return p.read_bytes() if p.exists() else None
