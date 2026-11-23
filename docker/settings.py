#!/usr/bin/env python3
"""settings.py [get | set]  - (StartOS) the settings for every preset (lib/strata_presets.py SETTINGS), for the package's
Configure action.  Run as the service user.

  get   prints {"exact_answers": "off", "context": "profile"}: this machine's settings, defaults filled in
  set   reads the same shape on stdin and writes each one that changed to presets.json (as `outcrop setting` does);
        prints {"changed": [...]} or exits 1 with the reason on stderr, one line, for the action to show

The console's Settings page and `outcrop setting` change the same presets.json section, so Configure shows what any of
them chose last."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import strata_presets as SP  # noqa: E402

cmd = sys.argv[1] if len(sys.argv) > 1 else "get"
try:
    cur = SP.settings(SP.load())
except SystemExit:                 # no presets.json yet (the first start makes it): the defaults
    cur = {k: d["default"] for k, d in SP.SETTINGS.items()}
if cmd == "get":
    print(json.dumps(cur))
    sys.exit(0)
if cmd != "set":
    sys.exit("usage: settings.py get | set")
want = json.loads(sys.stdin.read() or "{}")
changed = []
try:
    for k, v in want.items():
        if k in SP.SETTINGS and str(v) != cur.get(k):
            SP.set_setting(k, str(v))
            changed.append(k)
except (KeyError, ValueError, SystemExit) as e:
    print(e.args[0] if e.args else str(e), file=sys.stderr)
    sys.exit(1)
print(json.dumps({"changed": changed}))
