"""docker/set-password.py: the StartOS action's console password: generated, set, and given back as JSON."""
import json
import os
import subprocess
import sys
from pathlib import Path

from outcrop.common import db
from outcrop.console import auth

ROOT = Path(__file__).resolve().parents[2]


def test_set_password_prints_json_and_the_password_signs_in(tmp_path):
    env = {**os.environ, "OUTCROP_HOME": str(tmp_path), "OUTCROP_STATE": str(tmp_path / "state")}
    r = subprocess.run([sys.executable, str(ROOT / "docker" / "set-password.py")], env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    got = json.loads(r.stdout)
    assert got["username"] == "admin" and len(got["password"].split()) == 6
    con = db.connect(tmp_path / "state" / "outcrop.db")
    sid, s = auth.login(con, "admin", got["password"], ip="192.0.2.1")
    assert sid and s.username == "admin"
    again = json.loads(subprocess.run([sys.executable, str(ROOT / "docker" / "set-password.py")], env=env,
                                      capture_output=True, text=True, check=True).stdout)
    assert again["password"] != got["password"]                       # a reset: a new one, for the same user
