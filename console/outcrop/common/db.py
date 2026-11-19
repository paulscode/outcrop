"""SQLite store (WAL) shared by the gateway, the console and the CLI.  Standard library only.

Migrations are numbered SQL files in migrations/; PRAGMA user_version records the last one applied.
"""
from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import time
from pathlib import Path

from . import config

MIGRATIONS = Path(__file__).resolve().parent / "migrations"


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    """Open (and create, 0600) the database, apply pending migrations and return an autocommit connection."""
    path = Path(path or config.DB_PATH)
    if path.parent == config.STATE:
        config.ensure_state_dir()
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        fd = os.open(path, os.O_WRONLY | os.O_CREAT, 0o600)
        os.close(fd)
    con = sqlite3.connect(str(path), timeout=15, isolation_level=None, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=15000")
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA foreign_keys=ON")
    migrate(con)
    return con


def migrate(con: sqlite3.Connection) -> int:
    have = con.execute("PRAGMA user_version").fetchone()[0]
    files = sorted(MIGRATIONS.glob("[0-9][0-9][0-9][0-9]_*.sql"))
    for f in files:
        n = int(f.name[:4])
        if n <= have:
            continue
        with tx(con):
            # re-check inside the write lock: another process may have migrated meanwhile
            if con.execute("PRAGMA user_version").fetchone()[0] >= n:
                continue
            for stmt in _statements(f.read_text(encoding="utf-8")):
                con.execute(stmt)
            con.execute(f"PRAGMA user_version={n}")
        have = n
    return have


def _statements(sql: str) -> list[str]:
    lines = [ln for ln in sql.splitlines() if not ln.strip().startswith("--")]
    out, cur = [], []
    for ln in lines:
        cur.append(ln)
        if sqlite3.complete_statement("\n".join(cur)):
            s = "\n".join(cur).strip()
            if s and s != ";":
                out.append(s)
            cur = []
    if "\n".join(cur).strip():
        out.append("\n".join(cur).strip())
    return out


@contextlib.contextmanager
def tx(con: sqlite3.Connection):
    """A write transaction (BEGIN IMMEDIATE), committed on success and rolled back on error."""
    con.execute("BEGIN IMMEDIATE")
    try:
        yield con
    except BaseException:
        con.execute("ROLLBACK")
        raise
    else:
        con.execute("COMMIT")


# ------------------------------------------------------------------------------------------------------------- settings

DEFAULTS = {
    "auth.mode": {"mode": "enforced"},
    "ollama.tokenless": {"enabled": False, "addresses": []},
    "cors.origins": [],
    "hosts.extra": [],
    "capture": {"enabled": False},
    "retention": {"requests_days": 90, "bodies_days": 7, "metrics_10s_days": 7, "metrics_1m_days": 90,
                  "metrics_1h_days": 730, "events_days": 365, "usage_days": 730},
}


def get_setting(con: sqlite3.Connection, key: str, default=None):
    row = con.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    if row is None:
        d = DEFAULTS.get(key, default)
        return json.loads(json.dumps(d))       # a copy
    return json.loads(row["value"])


def all_settings(con: sqlite3.Connection) -> dict:
    out = {k: json.loads(json.dumps(v)) for k, v in DEFAULTS.items()}
    for row in con.execute("SELECT key, value FROM settings"):
        out[row["key"]] = json.loads(row["value"])
    return out


def set_setting(con: sqlite3.Connection, key: str, value, by: str = "") -> None:
    con.execute("INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?,?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, "
                "updated_by=excluded.updated_by", (key, json.dumps(value), time.time(), by))


# --------------------------------------------------------------------------------------------------------------- events

def add_event(con: sqlite3.Connection, kind: str, summary: str, *, actor: str = "", source: str = "",
              level: str = "info", details: dict | None = None, at: float | None = None) -> int:
    cur = con.execute("INSERT INTO events(at, kind, level, actor, source, summary, details) VALUES(?,?,?,?,?,?,?)",
                      (at or time.time(), kind, level, actor, source, summary, json.dumps(details or {})))
    return int(cur.lastrowid)


def events(con: sqlite3.Connection, limit: int = 50, kinds: list[str] | None = None, before: float | None = None):
    q = "SELECT * FROM events"
    args: list = []
    where = []
    if kinds:
        where.append("(" + " OR ".join("kind LIKE ?" for _ in kinds) + ")")
        args += [k.replace("*", "%") for k in kinds]
    if before:
        where.append("at < ?")
        args.append(before)
    if where:
        q += " WHERE " + " AND ".join(where)
    q += " ORDER BY at DESC, id DESC LIMIT ?"
    args.append(limit)
    return [dict(r) | {"details": json.loads(r["details"] or "{}")} for r in con.execute(q, args)]
