#!/usr/bin/env python3
"""set-password.py  - (StartOS, the Set console password action) set a generated console password, ending every session,
and print {"username", "password"} as JSON for the action's result.  Run as the service user, with the console's Python."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "console"))
from outcrop.common import db  # noqa: E402
from outcrop.console import auth, passwords  # noqa: E402

con = db.connect()
u = auth.get_user(con)
user = u["username"] if u else "admin"
pw = passwords.generate(username=user)
auth.set_password(con, user, pw, actor="startos", source="StartOS action")
print(json.dumps({"username": user, "password": pw}))
