#!/usr/bin/env python3
"""set-password.py  - (StartOS) set the console password read from stdin, ending every session.  Run as the service user,
with the console's Python, by the package's init (the random password made at install) and its Configure action.

It applies the console's own password policy (outcrop.console.passwords): a refused password exits 1 with the reasons on
stderr, one line, for the action to show.  Prints {"ok": true} on success.  The password never appears in an argument
or the environment."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "console"))
from outcrop.common import db  # noqa: E402
from outcrop.console import auth, passwords  # noqa: E402

pw = sys.stdin.readline().rstrip("\n")
con = db.connect()
u = auth.get_user(con)
user = u["username"] if u else "admin"
verdict = passwords.check(pw, user)
if not verdict.ok:
    print("; ".join(verdict.reasons), file=sys.stderr)
    sys.exit(1)
auth.set_password(con, user, pw, actor="startos", source="StartOS")
print(json.dumps({"ok": True}))
