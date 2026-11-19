"""API tokens: format, hashing, and the operations on the `tokens` and `token_secrets` tables.  Standard library only.

A token looks like `lls_` + an 8-character public ID + `_` + 32 random base62 characters (about 190 bits).  Only an
HMAC-SHA256 of it, keyed with the pepper in $OUTCROP_HOME/state/pepper, is stored.  An imported token is any value of at least
24 characters that you choose; it gets its own public ID.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import re
import secrets
import sqlite3
import string
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from . import config, db

ALPHABET = string.ascii_letters + string.digits
PREFIX = "lls_"
TOKEN_RE = re.compile(r"^lls_([A-Za-z0-9]{8})_[A-Za-z0-9]{32}$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,63}$")
SCOPES = ("inference", "telemetry", "admin", "web")   # web: the web tools for apps (POST /tools/mcp)
LISTENERS = ("openai", "ollama")
IMPORT_MIN = 24
GRACE_CHOICES = {"none": 0, "0": 0, "1h": 3600, "24h": 86400, "7d": 7 * 86400}


class TokenError(ValueError):
    """A request about tokens that cannot be done; the message is for the user."""


def _rand(n: int) -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(n))


def new_secret(public_id: str | None = None) -> tuple[str, str]:
    pid = public_id or _rand(8)
    return pid, f"{PREFIX}{pid}_{_rand(32)}"


def load_pepper(path: Path | None = None, create: bool = True) -> bytes:
    path = path or config.PEPPER_FILE
    try:
        data = path.read_bytes()
        if len(data) >= 32:
            return data
    except OSError:
        pass
    if not create:
        raise TokenError(f"no pepper at {path}")
    data = secrets.token_bytes(32)
    config.write_secret(path, data)
    return data


def digest(pepper: bytes, token: str) -> str:
    return hmac.new(pepper, token.encode("utf-8"), hashlib.sha256).hexdigest()


def hint_of(token: str) -> str:
    """What may be shown of a token: its public ID for ours, the first 4 characters of an imported one."""
    m = TOKEN_RE.match(token)
    return f"{PREFIX}{m.group(1)}_…" if m else token[:4] + "…"


# ------------------------------------------------------------------------------------------------------------- parsing

def parse_expiry(text: str | None, now: float | None = None) -> float | None:
    """never | 7d | 30d | 90d | 365d | 12h | 2027-01-31 (end of that day, local time) -> a Unix time, or None."""
    if text is None:
        return None
    t = str(text).strip().lower()
    if t in ("", "never", "none", "0"):
        return None
    now = now or time.time()
    m = re.fullmatch(r"(\d+)\s*([mhdw])", t)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        return now + n * {"m": 60, "h": 3600, "d": 86400, "w": 7 * 86400}[unit]
    try:
        d = datetime.strptime(t, "%Y-%m-%d")
    except ValueError:
        raise TokenError(f"expiry {text!r}: use never, 7d, 30d, 90d, 365d, 12h or a date like 2027-01-31") from None
    end = d + timedelta(days=1)
    ts = end.timestamp()
    if ts <= now:
        raise TokenError(f"expiry {text!r} is in the past")
    return ts


def parse_duration(text: str) -> float:
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(s|m|min|h|d)?\s*", str(text).lower())
    if not m:
        raise TokenError(f"duration {text!r}: use for example 15m, 1h or 4h")
    n = float(m.group(1))
    unit = m.group(2) or "m"
    return n * {"s": 1, "m": 60, "min": 60, "h": 3600, "d": 86400}[unit]


def parse_grace(text: str | None) -> float:
    if text is None:
        return 0.0
    t = str(text).strip().lower()
    if t in GRACE_CHOICES:
        return float(GRACE_CHOICES[t])
    return parse_duration(t)


def norm_scopes(scopes) -> list[str]:
    if isinstance(scopes, str):
        scopes = [s for s in re.split(r"[,\s]+", scopes) if s]
    scopes = list(dict.fromkeys(scopes or ["inference"]))
    bad = [s for s in scopes if s not in SCOPES]
    if bad:
        raise TokenError(f"unknown scope {bad[0]!r}: use {', '.join(SCOPES)}")
    return scopes


def norm_listeners(listeners) -> list[str]:
    if isinstance(listeners, str):
        listeners = [s for s in re.split(r"[,\s]+", listeners) if s]
    if not listeners or listeners == ["both"] or listeners == ["all"]:
        return list(LISTENERS)
    listeners = list(dict.fromkeys(listeners))
    bad = [s for s in listeners if s not in LISTENERS]
    if bad:
        raise TokenError(f"unknown listener {bad[0]!r}: use openai (port 8080), ollama (port 11434) or both")
    return listeners


def norm_cidrs(cidrs) -> list[str]:
    if isinstance(cidrs, str):
        cidrs = [s for s in re.split(r"[,\s]+", cidrs) if s]
    out = []
    for c in cidrs or []:
        try:
            out.append(str(ipaddress.ip_network(c, strict=False)))
        except ValueError:
            raise TokenError(f"{c!r} is not an address or network like 192.168.1.0/24") from None
    return out


def check_name(name: str) -> str:
    name = (name or "").strip()
    if not NAME_RE.match(name):
        raise TokenError("a token name is 1 to 64 letters, digits, spaces or . _ @ -, starting with a letter or digit")
    return name


# --------------------------------------------------------------------------------------------------------------- store

def _row(r: sqlite3.Row | None) -> dict | None:
    if r is None:
        return None
    d = dict(r)
    d["scopes"] = [s for s in d["scopes"].split(",") if s]
    d["listeners"] = [s for s in d["listeners"].split(",") if s]
    d["cidrs"] = json.loads(d["cidrs"] or "[]")
    d["imported"] = bool(d["imported"])
    return d


def find(con: sqlite3.Connection, ref: str, include_revoked: bool = False) -> dict | None:
    """A token by public ID, by `lls_<id>_…` prefix, or by name (active ones first)."""
    ref = (ref or "").strip()
    m = re.match(r"^lls_([A-Za-z0-9]{8})", ref)
    if m:
        ref = m.group(1)
    r = con.execute("SELECT * FROM tokens WHERE id=?", (ref,)).fetchone()
    if r is None:
        r = con.execute("SELECT * FROM tokens WHERE name=? AND revoked_at IS NULL", (ref,)).fetchone()
    if r is None and include_revoked:
        r = con.execute("SELECT * FROM tokens WHERE name=? ORDER BY revoked_at DESC LIMIT 1", (ref,)).fetchone()
    return _row(r)


def get(con: sqlite3.Connection, token_id: str) -> dict | None:
    return _row(con.execute("SELECT * FROM tokens WHERE id=?", (token_id,)).fetchone())


def list_tokens(con: sqlite3.Connection, include_revoked: bool = True) -> list[dict]:
    q = "SELECT * FROM tokens" + ("" if include_revoked else " WHERE revoked_at IS NULL")
    q += " ORDER BY revoked_at IS NOT NULL, created_at"
    return [_row(r) for r in con.execute(q)]


def _new_id(con: sqlite3.Connection) -> str:
    while True:
        pid = _rand(8)
        if con.execute("SELECT 1 FROM tokens WHERE id=?", (pid,)).fetchone() is None:
            return pid


def create(con: sqlite3.Connection, pepper: bytes, name: str, *, scopes=None, listeners=None, cidrs=None,
           expires_at: float | None = None, rpm: int | None = None, concurrency: int | None = None, notes: str = "",
           by: str = "", source: str = "", kind: str = "user", value: str | None = None) -> tuple[dict, str]:
    """Create a token.  `value`: import that value instead of generating one.  Returns (token, plaintext)."""
    name = check_name(name)
    scopes, listeners, cidrs = norm_scopes(scopes), norm_listeners(listeners), norm_cidrs(cidrs)
    if rpm is not None and int(rpm) <= 0 or concurrency is not None and int(concurrency) <= 0:
        raise TokenError("limits must be positive numbers")
    now = time.time()
    if expires_at is not None and expires_at <= now:
        raise TokenError("the expiry is in the past")
    with db.tx(con):
        if con.execute("SELECT 1 FROM tokens WHERE name=? AND revoked_at IS NULL", (name,)).fetchone():
            raise TokenError(f"a token named {name!r} already exists")
        pid = _new_id(con)
        if value is None:
            pid, plain = new_secret(pid)
            imported = 0
        else:
            plain = value.strip()
            if len(plain) < IMPORT_MIN:
                raise TokenError(f"an imported token must be at least {IMPORT_MIN} characters")
            if any(c.isspace() for c in plain) or not plain.isprintable():
                raise TokenError("an imported token cannot contain spaces or control characters")
            imported = 1
        h = digest(pepper, plain)
        if con.execute("SELECT 1 FROM token_secrets WHERE hmac=?", (h,)).fetchone():
            raise TokenError("that value is already in use by another token")
        con.execute("INSERT INTO tokens(id, name, notes, kind, scopes, listeners, cidrs, expires_at, rpm, concurrency, "
                    "imported, hint, created_at, created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (pid, name, notes or "", kind, ",".join(scopes), ",".join(listeners), json.dumps(cidrs), expires_at,
                     rpm, concurrency, imported, hint_of(plain) if imported else f"{PREFIX}{pid}_…", now, by))
        con.execute("INSERT INTO token_secrets(hmac, token_id, created_at) VALUES(?,?,?)", (h, pid, now))
        what = "imported" if imported else "created"
        db.add_event(con, "token.import" if imported else "token.create",
                     f"token {name!r} {what} ({', '.join(scopes)}"
                     + (f", expires {datetime.fromtimestamp(expires_at):%Y-%m-%d %H:%M}" if expires_at else ", no expiry")
                     + ")", actor=by, source=source, details={"token_id": pid, "scopes": scopes, "listeners": listeners,
                                                              "cidrs": cidrs, "expires_at": expires_at, "kind": kind})
    return get(con, pid), plain


def rotate(con: sqlite3.Connection, pepper: bytes, ref: str, grace_s: float = 0.0, by: str = "",
           source: str = "") -> tuple[dict, str]:
    """A new secret for the same token.  The old secret keeps working for `grace_s` seconds."""
    tok = find(con, ref)
    if tok is None or tok["revoked_at"]:
        raise TokenError(f"no active token {ref!r}")
    now = time.time()
    pid, plain = new_secret(tok["id"])
    with db.tx(con):
        until = now + max(0.0, grace_s)
        # every older secret ends at the grace's end (or now), never later than it already would
        con.execute("UPDATE token_secrets SET expires_at=CASE WHEN expires_at IS NULL OR expires_at > ? THEN ? "
                    "ELSE expires_at END WHERE token_id=?", (until, until, pid))
        con.execute("DELETE FROM token_secrets WHERE token_id=? AND expires_at <= ?", (pid, now))
        con.execute("INSERT INTO token_secrets(hmac, token_id, created_at) VALUES(?,?,?)", (digest(pepper, plain), pid, now))
        con.execute("UPDATE tokens SET rotated_at=?, rotated_by=?, imported=0, hint=? WHERE id=?",
                    (now, by, f"{PREFIX}{pid}_…", pid))
        g = f"; the old value works for {_fmt_dur(grace_s)} more" if grace_s > 0 else "; the old value stopped now"
        db.add_event(con, "token.rotate", f"token {tok['name']!r} rotated{g}", actor=by, source=source,
                     details={"token_id": pid, "grace_s": grace_s})
    return get(con, pid), plain


def revoke(con: sqlite3.Connection, ref: str, by: str = "", source: str = "", reason: str = "") -> dict:
    tok = find(con, ref)
    if tok is None:
        raise TokenError(f"no token {ref!r}")
    if tok["revoked_at"]:
        raise TokenError(f"token {tok['name']!r} is already revoked")
    now = time.time()
    with db.tx(con):
        con.execute("UPDATE tokens SET revoked_at=?, revoked_by=?, revoke_reason=? WHERE id=?",
                    (now, by, reason or None, tok["id"]))
        db.add_event(con, "token.revoke", f"token {tok['name']!r} revoked" + (f" ({reason})" if reason else ""),
                     actor=by, source=source, level="warn", details={"token_id": tok["id"]})
    return get(con, tok["id"])


def update(con: sqlite3.Connection, ref: str, *, by: str = "", source: str = "", **fields) -> dict:
    """Change a token's settings: name, notes, scopes, listeners, cidrs, expires_at, rpm, concurrency."""
    tok = find(con, ref)
    if tok is None or tok["revoked_at"]:
        raise TokenError(f"no active token {ref!r}")
    sets, args, changed = [], [], {}
    for k, v in fields.items():
        if v is None and k not in ("expires_at", "rpm", "concurrency"):
            continue
        if k == "name":
            v = check_name(v)
            if v != tok["name"] and con.execute("SELECT 1 FROM tokens WHERE name=? AND revoked_at IS NULL",
                                                (v,)).fetchone():
                raise TokenError(f"a token named {v!r} already exists")
            sets.append("name=?"); args.append(v)
        elif k == "notes":
            sets.append("notes=?"); args.append(str(v))
        elif k == "scopes":
            v = norm_scopes(v); sets.append("scopes=?"); args.append(",".join(v))
        elif k == "listeners":
            v = norm_listeners(v); sets.append("listeners=?"); args.append(",".join(v))
        elif k == "cidrs":
            v = norm_cidrs(v); sets.append("cidrs=?"); args.append(json.dumps(v))
        elif k in ("expires_at", "rpm", "concurrency"):
            if v is not None and (k != "expires_at" and int(v) <= 0):
                raise TokenError("limits must be positive numbers")
            sets.append(f"{k}=?"); args.append(v)
        else:
            raise TokenError(f"unknown token field {k!r}")
        changed[k] = v
    if not sets:
        return tok
    with db.tx(con):
        con.execute(f"UPDATE tokens SET {', '.join(sets)} WHERE id=?", (*args, tok["id"]))
        db.add_event(con, "token.update", f"token {tok['name']!r} changed: {', '.join(changed)}", actor=by, source=source,
                     details={"token_id": tok["id"], "changes": changed})
    return get(con, tok["id"])


def _fmt_dur(s: float) -> str:
    if s >= 86400 and s % 86400 == 0:
        return f"{int(s // 86400)} d"
    if s >= 3600:
        return f"{s / 3600:g} h"
    if s >= 60:
        return f"{s / 60:g} min"
    return f"{s:g} s"


# --------------------------------------------------------------------------------------------- the in-memory cache

@dataclass
class Token:
    id: str
    name: str
    kind: str
    scopes: frozenset
    listeners: frozenset
    networks: tuple
    expires_at: float | None
    rpm: int | None
    concurrency: int | None
    revoked_at: float | None

    def allows_scope(self, route_class: str) -> bool:
        if "admin" in self.scopes:
            return True
        return route_class in self.scopes

    def allows_ip(self, ip: str) -> bool:
        if not self.networks:
            return True
        try:
            a = ipaddress.ip_address(ip)
        except ValueError:
            return False
        return any(a in n for n in self.networks)


@dataclass
class Lookup:
    token: Token | None
    status: str          # ok | unknown | revoked | expired | grace_ended


@dataclass
class TokenCache:
    """What the gateway checks each request against: HMAC -> (token, the secret's own end).  Rebuilt from the DB."""
    pepper: bytes
    by_hmac: dict = field(default_factory=dict)
    by_id: dict = field(default_factory=dict)

    def load(self, con: sqlite3.Connection) -> None:
        by_id = {}
        for r in con.execute("SELECT * FROM tokens"):
            nets = []
            for c in json.loads(r["cidrs"] or "[]"):
                try:
                    nets.append(ipaddress.ip_network(c, strict=False))
                except ValueError:
                    pass
            by_id[r["id"]] = Token(r["id"], r["name"], r["kind"], frozenset(s for s in r["scopes"].split(",") if s),
                                   frozenset(s for s in r["listeners"].split(",") if s), tuple(nets), r["expires_at"],
                                   r["rpm"], r["concurrency"], r["revoked_at"])
        by_hmac = {}
        for r in con.execute("SELECT hmac, token_id, expires_at FROM token_secrets"):
            t = by_id.get(r["token_id"])
            if t is not None:
                by_hmac[r["hmac"]] = (t, r["expires_at"])
        self.by_id, self.by_hmac = by_id, by_hmac

    def lookup(self, presented: str, now: float | None = None) -> Lookup:
        now = now or time.time()
        hit = self.by_hmac.get(digest(self.pepper, presented))
        if hit is None:
            return Lookup(None, "unknown")
        tok, secret_end = hit
        if tok.revoked_at is not None and tok.revoked_at <= now:
            return Lookup(tok, "revoked")
        if tok.expires_at is not None and tok.expires_at <= now:
            return Lookup(tok, "expired")
        if secret_end is not None and secret_end <= now:
            return Lookup(tok, "grace_ended")
        return Lookup(tok, "ok")


# --------------------------------------------------------------------------------------------- the local-tools token

def ensure_local_token(con: sqlite3.Connection, pepper: bytes, by: str = "install") -> str:
    """The `local-tools` token outcrop and bench/ use on this machine, kept in $OUTCROP_HOME/state/local_token (0600)."""
    plain = config.read_secret(config.LOCAL_TOKEN_FILE)
    if plain:
        r = con.execute("SELECT t.revoked_at FROM token_secrets s JOIN tokens t ON t.id=s.token_id WHERE s.hmac=?",
                        (digest(pepper, plain),)).fetchone()
        if r is not None and r["revoked_at"] is None:
            return plain
    old = con.execute("SELECT id FROM tokens WHERE kind='local-tools' AND revoked_at IS NULL").fetchall()
    for r in old:
        revoke(con, r["id"], by=by, reason="replaced")
    _, plain = create(con, pepper, "local-tools", scopes=["inference", "telemetry"], listeners=["openai", "ollama"],
                      cidrs=["127.0.0.0/8", "::1/128"], notes="outcrop and bench/ on this machine", by=by,
                      kind="local-tools")
    config.write_secret(config.LOCAL_TOKEN_FILE, plain + "\n")
    return plain
