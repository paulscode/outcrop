"""The console password: argon2id hashing, the strength policy and a passphrase generator.

Policy (NIST SP 800-63B, with stricter length and strength limits):
  - 16 to 256 characters; any characters, spaces and Unicode included; no composition rules, no expiry
  - not one of the 100,000 most common breached passwords (offline list), nor a famous example password
  - zxcvbn score 4 of 4 ("very unguessable")
  - no username, "computer", "outcrop", "strata" or "qwen" in it
"""
from __future__ import annotations

import gzip
import re
import secrets
import socket
import unicodedata
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

DATA = Path(__file__).resolve().parent / "data"
MIN_LEN, MAX_LEN = 16, 256
BANNED_WORDS = ["computer", "outcrop", "strata", "qwen"]
FAMOUS = ["correcthorsebatterystaple", "tr0ub4dor&3", "troubadour", "passwordpassword", "letmeinletmein",
          "iloveyouiloveyou", "qwertyuiopasdfgh", "1234567890123456", "abcdefghijklmnop", "thequickbrownfoxjumpsoverthelazydog",
          "password123456789", "administrator", "changemechangeme"]

HASHER = PasswordHasher(time_cost=3, memory_cost=64 * 1024, parallelism=4, hash_len=32, salt_len=16)


def hash_password(pw: str) -> str:
    return HASHER.hash(pw)


def verify_password(stored: str, pw: str) -> bool:
    try:
        return HASHER.verify(stored, pw)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(stored: str) -> bool:
    try:
        return HASHER.check_needs_rehash(stored)
    except InvalidHashError:
        return True


_DUMMY = None


def burn_time(pw: str) -> None:
    """Spend the same time as a real check, so an unknown username is not faster to refuse."""
    global _DUMMY
    if _DUMMY is None:
        _DUMMY = HASHER.hash(secrets.token_urlsafe(16))
    verify_password(_DUMMY, pw)


@lru_cache(maxsize=1)
def _common() -> frozenset:
    with gzip.open(DATA / "common-passwords.txt.gz", "rt", encoding="utf-8", errors="replace") as f:
        return frozenset(ln.strip().lower() for ln in f if ln.strip())


@lru_cache(maxsize=1)
def _words() -> list[str]:
    return [w.strip() for w in (DATA / "eff_large_wordlist.txt").read_text().splitlines() if w.strip()]


def _repeat_unit(s: str) -> str | None:
    """The shortest string that repeated makes up all of `s` (two times or more), if there is one."""
    n = len(s)
    for k in range(1, n // 2 + 1):
        if n % k == 0 and s[:k] * (n // k) == s:
            return s[:k]
    return None


def _squash(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).lower()
    return re.sub(r"[\s\-_.,;:!]+", "", s)


@dataclass
class Verdict:
    ok: bool
    score: int = 0                       # zxcvbn 0..4
    reasons: list[str] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)
    crack_time: str = ""                 # zxcvbn's offline slow-hash estimate, in words
    length: int = 0

    def public(self) -> dict:
        return {"ok": self.ok, "score": self.score, "reasons": self.reasons, "suggestions": self.suggestions,
                "crack_time": self.crack_time, "length": self.length, "min_length": MIN_LEN}


def check(pw: str, username: str = "") -> Verdict:
    pw = pw or ""
    n = len(pw)
    v = Verdict(ok=False, length=n)
    if n < MIN_LEN:
        v.reasons.append(f"at least {MIN_LEN} characters ({n} so far); a few unrelated words make it easy")
    if n > MAX_LEN:
        v.reasons.append(f"at most {MAX_LEN} characters")
    low = pw.lower()
    sq = _squash(pw)
    banned = [w for w in BANNED_WORDS + ([username.lower()] if username else []) + [socket.gethostname().lower()]
              if w and len(w) >= 3]
    hit = sorted({w for w in banned if w in low or w in sq})
    if hit:
        v.reasons.append("contains " + ", ".join(f"“{w}”" for w in hit) + ", which an attacker would try first")
    unit = _repeat_unit(sq)
    if low in _common() or sq in _common() or (unit and unit in _common()):
        v.reasons.append("it is on the list of the 100,000 most common breached passwords"
                         + (" (repeated)" if unit and unit in _common() else ""))
    if sq in FAMOUS or (unit and unit in FAMOUS) or any(len(f) >= 8 and f in sq and len(f) * 2 >= len(sq) for f in FAMOUS):
        v.reasons.append("it is a well-known example password")
    elif unit and len(unit) < MIN_LEN:
        v.reasons.append(f"it repeats “{unit[:3]}…” ({len(unit)} characters); repeating does not make it stronger")
    if n <= MAX_LEN:
        try:
            from zxcvbn import zxcvbn
            r = zxcvbn(pw[:100], user_inputs=banned)
            v.score = int(r["score"])
            v.crack_time = str(r["crack_times_display"]["offline_slow_hashing_1e4_per_second"])
            fb = r.get("feedback") or {}
            if v.score < 4:
                warn = fb.get("warning") or "it is easier to guess than it looks"
                v.reasons.append(f"not strong enough ({v.score} of 4): {warn[0].lower() + warn[1:] if warn else ''}".rstrip(": "))
            v.suggestions = [s for s in fb.get("suggestions") or [] if s]
        except ImportError:                       # pragma: no cover
            v.score = 4 if n >= 20 else 0
    if v.score < 4 and not v.suggestions:
        v.suggestions.append("Use the generator: six random words are easy to type and very hard to guess.")
    v.ok = not v.reasons
    return v


def generate(words: int = 6, sep: str = " ", username: str | None = None) -> str:
    """A passphrase from the EFF long wordlist: 6 words is about 77.5 bits. With `username`, one the policy accepts for
    that user (a word can contain a short user name, such as "dev" in "device"): drawn again until it does."""
    w = _words()
    while True:
        pw = sep.join(secrets.choice(w) for _ in range(words))
        if username is None or check(pw, username).ok:
            return pw
