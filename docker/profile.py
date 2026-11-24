#!/usr/bin/env python3
"""profile.py [check | apply | follow]  - (StartOS) presets.json and this machine's hardware profile, for the package's
"Update hardware settings" action and for every start.

presets.json is made from the profile once, at the first start, so neither an update that improves a profile nor a change
of hardware (more RAM, another GPU) changes it by itself (on Ubuntu: `outcrop profile apply NAME`).  The one exception is
less RAM, which `follow` handles at every start.  Applying keeps the network sections and the settings (Configure, the
console's Settings page), and keeps a copy of the old file next to it.

  check   prints {"profile": NAME, "target": NAME, "changes": true|false, "diff": "...", "hardware": {...}}: target is the
          profile that fits this machine now when the hardware changed (lib/profiles.py hardware()), else the same one
  apply   the same, after writing presets.json from target when there are changes
  follow  run before Outcrop starts, as root (prepare.sh hands the files to the service user next): the first time,
          presets.json from the profile that fits, and only the boot preset's pack when the disk is too small for every
          pack; after that, the move to a smaller profile when the RAM went down (lib/profiles.py follow()).  Prints
          {"first": bool, "packs_message": "...", "hardware": {...}} for main.ts's task and notifications.  Never fails
          the start: an error is printed as {"error": "..."}
Exits 1 with the reason on stderr, one line, when check or apply cannot be done (no presets.json, an unknown profile)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import profiles as PF  # noqa: E402

cmd = sys.argv[1] if len(sys.argv) > 1 else "check"

if cmd == "follow":
    out = {"first": False, "packs_message": None, "hardware": None}
    try:
        f = PF.facts()
        if PF.current() is None:
            name, _, why = PF.suggest(f)
            if name:                        # else prepare.sh says why no profile fits, and the engine does not start
                PF.apply(name)
                out["first"] = True
                out["packs_message"] = PF.first_packs(PF.current() or {})
        else:
            out["hardware"] = PF.follow(f)
    except Exception as e:                  # noqa: BLE001  (the start goes on; the error is shown in the log)
        out["error"] = f"{type(e).__name__}: {e}"
    print(json.dumps(out))
    sys.exit(0)

cur = PF.current()
name = ((cur or {}).get("profile") or {}).get("name")
if not name:
    print("presets.json has no hardware profile yet: start Outcrop once first", file=sys.stderr)
    sys.exit(1)
hw = PF.hardware(cur)
target = hw["fits"] if hw["change"] in ("more", "less", "other") else name
try:
    diff = PF.diff(target)
except (KeyError, ValueError) as e:
    print(f"profile {target}: {e.args[0] if e.args else e}", file=sys.stderr)
    sys.exit(1)
out = {"profile": name, "target": target, "changes": bool(diff) or target != name, "diff": diff, "hardware": hw}
if cmd == "apply" and out["changes"]:
    moved = PF.change_to(target) if target != name else None
    if not moved:
        _, backup = PF.apply(name)
    out["moved"] = moved
print(json.dumps(out))
