#!/usr/bin/env python3
"""profile.py [check | apply]  - (StartOS) bring presets.json up to this machine's hardware profile as this version of
Outcrop has it, for the package's "Update hardware settings" action.  Run as the service user.

presets.json is made from the profile once, at the first start, so an update that improves a profile does not change
it by itself (on Ubuntu: `outcrop profile apply NAME`).  Applying keeps the network sections and the settings (Configure,
the console's Settings page), and keeps a copy of the old file next to it.

  check  prints {"profile": NAME, "changes": true|false, "diff": "..."}
  apply  the same, after writing presets.json when there are changes
Exits 1 with the reason on stderr, one line, when there is no presets.json or its profile is unknown."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import profiles as PF  # noqa: E402

cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
cur = PF.current()
name = ((cur or {}).get("profile") or {}).get("name")
if not name:
    print("presets.json has no hardware profile yet: start Outcrop once first", file=sys.stderr)
    sys.exit(1)
try:
    diff = PF.diff(name)
except (KeyError, ValueError) as e:
    print(f"profile {name}: {e.args[0] if e.args else e}", file=sys.stderr)
    sys.exit(1)
out = {"profile": name, "changes": bool(diff), "diff": diff}
if cmd == "apply" and diff:
    _, backup = PF.apply(name)
    out["backup"] = backup.name if backup else None
print(json.dumps(out))
