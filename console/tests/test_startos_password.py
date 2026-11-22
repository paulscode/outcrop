"""docker/set-password.py: the console password StartOS keeps (made at install, changed with Configure), set from stdin."""
import os
import subprocess
import sys
from pathlib import Path

from outcrop.common import db
from outcrop.console import auth

ROOT = Path(__file__).resolve().parents[2]
GOOD = "q7Lm2Rx9Vt4Kw8Np3Hs6Jd5F"          # the shape StartOS makes: 24 random letters and digits


def run(tmp_path, pw):
    env = {**os.environ, "OUTCROP_HOME": str(tmp_path), "OUTCROP_STATE": str(tmp_path / "state")}
    return subprocess.run([sys.executable, str(ROOT / "docker" / "set-password.py")], input=pw + "\n", env=env,
                          capture_output=True, text=True)


def test_sets_the_password_from_stdin(tmp_path):
    r = run(tmp_path, GOOD)
    assert r.returncode == 0, r.stderr
    con = db.connect(tmp_path / "state" / "outcrop.db")
    sid, s = auth.login(con, "", GOOD, ip="192.0.2.1", single_user=True)
    assert sid and s.username == "admin"


def test_a_weak_password_is_refused_with_the_reason(tmp_path):
    r = run(tmp_path, "password123")
    assert r.returncode == 1 and r.stderr.strip()
    assert not (tmp_path / "state" / "outcrop.db").exists() or db.connect(tmp_path / "state" / "outcrop.db").execute(
        "SELECT count(*) FROM users").fetchone()[0] == 0
