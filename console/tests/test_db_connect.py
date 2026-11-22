"""db.connect: files are made 0600; sqlite's in-memory database makes no file at all."""
import os

from outcrop.common import db


def test_memory_database_makes_no_file(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    con = db.connect(":memory:")
    assert con.execute("PRAGMA user_version").fetchone()[0] > 0      # migrated
    assert not (tmp_path / ":memory:").exists()


def test_file_database_is_private(tmp_path):
    db.connect(tmp_path / "x" / "c.db").close()
    assert os.stat(tmp_path / "x" / "c.db").st_mode & 0o777 == 0o600
