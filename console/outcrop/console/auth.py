"""Console sign-in: the account, sessions, lockout, and the checks every change must pass (CSRF, origin).

- One admin account; its password is set over SSH (`outcrop console passwd`), never through a first-run web page.
- Sessions: a 256-bit random ID in the cookie, stored only as its SHA-256.  `__Host-outcrop` on HTTPS (Secure, HttpOnly,
  SameSite=Strict, Path=/).  12 h idle, or 30 days with "remember this device"; 30 days at most either way.  A new ID at every
  sign-in.  Changing the password ends every other session.
- Lockout per address: after 5 failures in 24 h, a wait that starts at 1 minute and doubles up to 1 hour; above 20 failures
  an hour from anywhere, every attempt is slowed down.  A wrong user gets the same answer, in the same time, as a wrong password.
- Every change (POST/PUT/PATCH/DELETE) needs JSON, the header `X-Outcrop: 1`, and an Origin equal to the console's own.
- Actions that widen access need the password again when it was last entered more than 10 minutes ago.
"""
from __future__ import annotations

import contextlib
import hashlib
import ipaddress
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

from ..common import db
from . import passwords

IDLE_S = 12 * 3600
REMEMBER_S = 30 * 86400
MAX_S = 30 * 86400
REAUTH_S = 600
FAIL_FREE = 5
FAIL_WINDOW_S = 24 * 3600
GLOBAL_SLOW = 20
COOKIE_SECURE = "__Host-outcrop"
COOKIE_PLAIN = "outcrop"


class AuthError(Exception):
    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra


def sid_hash(sid: str) -> str:
    return hashlib.sha256(sid.encode()).hexdigest()


@dataclass
class Session:
    id_hash: str
    user_id: int
    username: str
    created_at: float
    last_seen_at: float
    expires_at: float
    remember: bool
    ip: str | None
    user_agent: str | None
    reauth_at: float | None

    @property
    def reauth_ok(self) -> bool:
        return bool(self.reauth_at and time.time() - self.reauth_at < REAUTH_S)


# ----------------------------------------------------------------------------------------------------------- account

def get_user(con: sqlite3.Connection, username: str | None = None):
    if username is None:
        return con.execute("SELECT * FROM users ORDER BY id LIMIT 1").fetchone()
    return con.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()


def set_password(con: sqlite3.Connection, username: str, password: str, *, actor: str = "cli", source: str = "",
                 check: bool = True, keep_session: str | None = None) -> None:
    if check:
        v = passwords.check(password, username)
        if not v.ok:
            raise AuthError(400, "; ".join(v.reasons), verdict=v.public())
    h = passwords.hash_password(password)
    now = time.time()
    with db.tx(con):
        row = get_user(con, username)
        if row is None:
            if con.execute("SELECT count(*) FROM users").fetchone()[0] > 0:
                # one account: renaming is done by setting the password for the new name
                con.execute("DELETE FROM users")
            con.execute("INSERT INTO users(username, pw_hash, created_at, pw_changed_at) VALUES(?,?,?,?)",
                        (username, h, now, now))
            summary = f"console account {username!r} created"
        else:
            con.execute("UPDATE users SET pw_hash=?, pw_changed_at=? WHERE id=?", (h, now, row["id"]))
            summary = f"console password changed for {username!r}"
        # every other session ends
        if keep_session:
            con.execute("DELETE FROM sessions WHERE id_hash != ?", (keep_session,))
        else:
            con.execute("DELETE FROM sessions")
        db.add_event(con, "account.password", summary + "; other sessions ended", actor=actor, source=source, level="warn")


# ---------------------------------------------------------------------------------------------------------- lockout

# Password checks: argon2id takes ~250 ms and 64 MiB each.  At most 3 run at once (a burst of sign-ins can't take the
# console's memory), and one at a time per address (so parallel guesses can't all pass the lockout check before the
# first failure is recorded).  Per address: not per IPv6 /64, which on a home LAN is every device, so one guest's
# wrong guesses would lock the owner out everywhere (the global slowdown covers address rotation).
_CHECKS = threading.BoundedSemaphore(3)
_BUSY: set[str] = set()
_BUSY_LOCK = threading.Lock()


def ip_key(ip: str) -> str:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped is not None:
        return str(a.ipv4_mapped)
    return str(a)


@contextlib.contextmanager
def _one_check(ip: str):
    key = ip_key(ip)
    with _BUSY_LOCK:
        if key in _BUSY:
            raise AuthError(429, "a sign-in from this address is already being checked; try again in a moment",
                            retry_after=2)
        _BUSY.add(key)
    try:
        if not _CHECKS.acquire(timeout=10):
            raise AuthError(429, "the console is busy checking passwords; try again in a moment", retry_after=5)
        try:
            yield
        finally:
            _CHECKS.release()
    finally:
        with _BUSY_LOCK:
            _BUSY.discard(key)


def lockout_wait(con: sqlite3.Connection, ip: str, now: float | None = None) -> float:
    """Seconds this address must wait before its next attempt (0: it may try now)."""
    now = now or time.time()
    rows = con.execute("SELECT at, ok FROM login_attempts WHERE ip=? AND at > ? ORDER BY at",
                       (ip_key(ip), now - FAIL_WINDOW_S)).fetchall()
    fails, last = 0, 0.0
    for r in rows:
        if r["ok"]:
            fails = 0
        else:
            fails += 1
            last = r["at"]
    if fails < FAIL_FREE:
        return 0.0
    wait = min(3600.0, 60.0 * 2 ** (fails - FAIL_FREE))
    return max(0.0, last + wait - now)


def global_slowdown(con: sqlite3.Connection, now: float | None = None) -> float:
    now = now or time.time()
    n = con.execute("SELECT count(*) FROM login_attempts WHERE ok=0 AND at > ?", (now - 3600,)).fetchone()[0]
    return 2.0 if n > GLOBAL_SLOW else 0.0


def record_attempt(con: sqlite3.Connection, ip: str, username: str, ok: bool) -> None:
    con.execute("INSERT INTO login_attempts(at, ip, username, ok) VALUES(?,?,?,?)",
                (time.time(), ip_key(ip), username[:64], int(ok)))
    con.execute("DELETE FROM login_attempts WHERE at < ?", (time.time() - 30 * 86400,))


# ----------------------------------------------------------------------------------------------------------- sign-in

def login(con: sqlite3.Connection, username: str, password: str, *, ip: str, user_agent: str = "",
          remember: bool = False, single_user: bool = False) -> tuple[str, Session]:
    """Check the password and start a session.  Raises AuthError (401 or 429).

    single_user: an empty username means the console's one account (the sign-in page asks only for the password); a
    username that is given must match."""
    with _one_check(ip):
        wait = lockout_wait(con, ip)
        if wait > 0:
            raise AuthError(429, f"too many failed sign-ins from {ip}; try again in {int(wait // 60) + 1} min",
                            retry_after=int(wait) + 1)
        username = (username or "").strip()
        if not username and single_user:
            first = get_user(con)
            username = first["username"] if first else ""
        row = get_user(con, username)
        if row is None:
            passwords.burn_time(password or "")
            ok = False
        else:
            ok = passwords.verify_password(row["pw_hash"], password or "")
        with db.tx(con):
            record_attempt(con, ip, username, ok)
            if not ok:
                db.add_event(con, "signin.fail", f"failed sign-in as {username[:40]!r}", actor=username[:40],
                             source=ip, level="warn", details={"user_agent": user_agent[:200]})
    if not ok:
        raise AuthError(401, "wrong password")
    if passwords.needs_rehash(row["pw_hash"]):
        con.execute("UPDATE users SET pw_hash=? WHERE id=?", (passwords.hash_password(password), row["id"]))
    sid = secrets.token_urlsafe(32)
    now = time.time()
    exp = now + (REMEMBER_S if remember else IDLE_S)
    with db.tx(con):
        con.execute("INSERT INTO sessions(id_hash, user_id, created_at, last_seen_at, expires_at, remember, ip, user_agent, "
                    "reauth_at) VALUES(?,?,?,?,?,?,?,?,?)",
                    (sid_hash(sid), row["id"], now, now, min(exp, now + MAX_S), int(remember), ip, user_agent[:300], now))
        con.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        db.add_event(con, "signin.ok", f"signed in as {username!r}", actor=username, source=ip,
                     details={"remember": remember, "user_agent": user_agent[:200]})
    return sid, session(con, sid)


def session(con: sqlite3.Connection, sid: str | None, touch: bool = False, ip: str | None = None) -> Session | None:
    if not sid or len(sid) > 128:
        return None
    h = sid_hash(sid)
    r = con.execute("SELECT s.*, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash=?",
                    (h,)).fetchone()
    if r is None:
        return None
    now = time.time()
    idle_end = r["last_seen_at"] + (REMEMBER_S if r["remember"] else IDLE_S)
    if now >= r["expires_at"] or now >= idle_end or now >= r["created_at"] + MAX_S:
        con.execute("DELETE FROM sessions WHERE id_hash=?", (h,))
        return None
    if touch and now - r["last_seen_at"] > 30:
        exp = min(r["created_at"] + MAX_S, now + (REMEMBER_S if r["remember"] else IDLE_S))
        con.execute("UPDATE sessions SET last_seen_at=?, expires_at=?, ip=COALESCE(?, ip) WHERE id_hash=?", (now, exp, ip, h))
    return Session(h, r["user_id"], r["username"], r["created_at"], r["last_seen_at"], r["expires_at"], bool(r["remember"]),
                   r["ip"], r["user_agent"], r["reauth_at"])


def reauth(con: sqlite3.Connection, s: Session, password: str, ip: str) -> None:
    with _one_check(ip):
        wait = lockout_wait(con, ip)
        if wait > 0:
            raise AuthError(429, "too many failed attempts; try again later", retry_after=int(wait) + 1)
        row = con.execute("SELECT * FROM users WHERE id=?", (s.user_id,)).fetchone()
        ok = row is not None and passwords.verify_password(row["pw_hash"], password or "")
        _record_reauth(con, s, ip, ok)                    # raises AuthError(401) for a wrong password


def _record_reauth(con: sqlite3.Connection, s: Session, ip: str, ok: bool) -> None:
    with db.tx(con):
        record_attempt(con, ip, s.username, ok)
        if ok:
            con.execute("UPDATE sessions SET reauth_at=? WHERE id_hash=?", (time.time(), s.id_hash))
        else:
            db.add_event(con, "signin.fail", "wrong password when confirming an action", actor=s.username, source=ip,
                         level="warn")
    if not ok:
        raise AuthError(401, "wrong password")


def logout(con: sqlite3.Connection, s: Session, ip: str = "") -> None:
    with db.tx(con):
        con.execute("DELETE FROM sessions WHERE id_hash=?", (s.id_hash,))
        db.add_event(con, "signin.out", "signed out", actor=s.username, source=ip)


def sessions_of(con: sqlite3.Connection, user_id: int) -> list[dict]:
    return [dict(r) for r in con.execute("SELECT id_hash, created_at, last_seen_at, expires_at, remember, ip, user_agent "
                                         "FROM sessions WHERE user_id=? ORDER BY last_seen_at DESC", (user_id,))]


def end_sessions(con: sqlite3.Connection, user_id: int, keep: str | None, actor: str, ip: str = "") -> int:
    with db.tx(con):
        cur = con.execute("DELETE FROM sessions WHERE user_id=? AND id_hash != ?", (user_id, keep or ""))
        db.add_event(con, "signin.out", f"signed out everywhere else ({cur.rowcount} session(s))", actor=actor, source=ip)
    return cur.rowcount


# -------------------------------------------------------------------------------------------------------- CSRF, origin

def own_origin_ok(origin: str | None, host: str | None, names: set[str], dev_origins: set[str]) -> bool:
    """The request's Origin must be this console's own: same scheme-less host as the request, and one of our names."""
    if not origin:
        return False
    o = origin.rstrip("/")
    if o in dev_origins:
        return True
    try:
        u = urlsplit(o)
    except ValueError:
        return False
    if not u.hostname or not host:
        return False
    if u.netloc.lower() != host.strip().lower():
        return False
    return u.hostname.lower() in names
