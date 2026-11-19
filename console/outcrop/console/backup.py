"""Backups of the console's state: a .tar.gz with a consistent copy of the database and, when asked, the secrets.

Without secrets (the default) the database copy has no token secrets (HMACs), no sessions and no login attempts, and none of
the files in $OUTCROP_HOME/state that hold keys.  Restored, it brings back settings, token names and rules, the audit log, the
request history, metrics, switches and bench runs; the tokens themselves must then be rotated (new values).

With secrets it also holds the pepper, the token HMACs, the internal key, the local-tools and console tokens, the TLS keys
and the Telegram bot token, so a restore on a new disk brings everything back as it was.  Keep such a file like a password.
"""
from __future__ import annotations

import io
import json
import os
import sqlite3
import tarfile
import tempfile
import time
from pathlib import Path

from ..common import config, db

SECRET_FILES = ["pepper", "upstream_key", "local_token", "console_token", "telegram.json", "default_preset",
                "tls/ca.key", "tls/ca.crt", "tls/server.key", "tls/server.crt", "tls/server-chain.pem", "tls/meta.json"]
PLAIN_FILES = ["default_preset", "tls/ca.crt"]


def make(dest: Path | None = None, secrets: bool = False, chats: bool = True) -> tuple[bytes, dict]:
    """The backup as bytes (and a summary).  `dest`: also write it there (0600).  `chats`: the saved chats too
    (chats.db, the console's chat; on by default)."""
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / "outcrop.db"
        src = sqlite3.connect(str(config.DB_PATH))
        dst = sqlite3.connect(str(copy))
        src.backup(dst)                                    # consistent, while the gateway and console keep writing
        src.close()
        if not secrets:
            dst.execute("DELETE FROM token_secrets")
            dst.execute("DELETE FROM sessions")
            dst.execute("DELETE FROM login_attempts")
            dst.execute("DELETE FROM request_bodies")
            dst.commit()
            dst.execute("VACUUM")
        counts = {t: dst.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
                  for t in ("tokens", "token_secrets", "requests", "events", "settings", "switches", "bench_runs")}
        dst.close()
        chats_src = config.STATE / "chats.db"
        chats_copy = Path(tmp) / "chats.db"
        if chats and chats_src.exists():
            src = sqlite3.connect(str(chats_src))
            dst = sqlite3.connect(str(chats_copy))
            src.backup(dst)
            src.close()
            counts["chats"] = dst.execute("SELECT count(*) FROM chats").fetchone()[0]
            counts["chat_messages"] = dst.execute("SELECT count(*) FROM messages").fetchone()[0]
            dst.close()
        meta = {"made_at": time.time(), "host": os.uname().nodename, "version": config.VERSION, "secrets": secrets,
                "chats": chats_copy.exists(),
                "schema": db.connect(copy).execute("PRAGMA user_version").fetchone()[0], "counts": counts}
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            info = tarfile.TarInfo("outcrop-backup/meta.json")
            data = json.dumps(meta, indent=1).encode()
            info.size, info.mtime, info.mode = len(data), int(time.time()), 0o600
            tar.addfile(info, io.BytesIO(data))
            tar.add(str(copy), arcname="outcrop-backup/state/outcrop.db")
            if chats_copy.exists():
                tar.add(str(chats_copy), arcname="outcrop-backup/state/chats.db")
            for rel in (SECRET_FILES if secrets else PLAIN_FILES):
                f = config.STATE / rel
                if f.is_file():
                    tar.add(str(f), arcname=f"outcrop-backup/state/{rel}")
        out = buf.getvalue()
    if dest is not None:
        fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(out)
    return out, meta


def restore(archive: Path, *, force: bool = False) -> dict:
    """Put a backup back.  The gateway and the console must be stopped (outcrop console restore does that)."""
    with tarfile.open(str(archive), "r:gz") as tar:
        names = tar.getnames()
        if "outcrop-backup/meta.json" not in names or "outcrop-backup/state/outcrop.db" not in names:
            raise ValueError("not an Outcrop backup")
        meta = json.loads(tar.extractfile("outcrop-backup/meta.json").read())
        for m in tar.getmembers():
            if not m.name.startswith("outcrop-backup/") or ".." in m.name or m.issym() or m.islnk():
                raise ValueError(f"unexpected entry in the backup: {m.name}")
        config.ensure_state_dir()
        if config.DB_PATH.exists() and not force:
            keep = config.STATE / f"outcrop.db.before-restore-{time.strftime('%Y%m%d-%H%M%S')}"
            os.replace(config.DB_PATH, keep)
            for ext in ("-wal", "-shm"):
                with __import__("contextlib").suppress(FileNotFoundError):
                    os.remove(str(config.DB_PATH) + ext)
            meta["previous_db"] = keep.name
        chats_db = config.STATE / "chats.db"
        if "outcrop-backup/state/chats.db" in names and chats_db.exists() and not force:
            keep = config.STATE / f"chats.db.before-restore-{time.strftime('%Y%m%d-%H%M%S')}"
            os.replace(chats_db, keep)
            meta["previous_chats_db"] = keep.name
        if "outcrop-backup/state/chats.db" in names:
            for ext in ("-wal", "-shm"):
                with __import__("contextlib").suppress(FileNotFoundError):
                    os.remove(str(chats_db) + ext)
        for m in tar.getmembers():
            if not m.isfile() or not m.name.startswith("outcrop-backup/state/"):
                continue
            rel = m.name[len("outcrop-backup/state/"):]
            dest = config.STATE / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            os.chmod(dest.parent, 0o700)
            data = tar.extractfile(m).read()
            mode = 0o644 if rel.endswith((".crt", ".pem", "meta.json")) else 0o600
            fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
            with os.fdopen(fd, "wb") as f:
                f.write(data)
    con = db.connect()                                     # migrations, if the backup is older
    db.add_event(con, "backup.restore", f"state restored from a backup made {time.strftime('%Y-%m-%d %H:%M', time.localtime(meta['made_at']))}"
                 + ("" if meta.get("secrets") else " (without secrets: rotate the tokens)"), actor="cli", level="warn",
                 details={"counts": meta.get("counts"), "secrets": meta.get("secrets")})
    con.close()
    return meta
