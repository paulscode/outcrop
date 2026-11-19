#!/bin/bash
# run-strategy.sh TAG  - "map, then review each part" on $REPO, with the preset Outcrop runs now.
#
#   ABOUT="the firmware for the COLDCARD hardware wallet" REPO=~/src/firmware ./run-strategy.sh coldcard-quality
#
#   1. TAG-M-1: the model maps the repository's security-critical subsystems (prompts/map.txt) and ends with a
#      "## Subsystems" list, one "- <name>: <description>" line each.
#   2. TAG-S-<n>: one review per line, in the map's own words (prompts/review.txt). No person picks or edits the parts;
#      the prompts are kept as RUNS/TAG-S-<n>.prompt.txt.
#
# ABOUT completes "This repository is ...". The other settings are run-one.sh's (REPO, RUNS, TOKEN_FILE, GATEWAY ...).
# Finished runs are skipped, so it can be started again. LIMIT_M and LIMIT_S are the time limits (default 4h each).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
PROMPTS=$(cd "$HERE/../prompts" && pwd)
TAG=${1:?usage: ABOUT="..." REPO=DIR run-strategy.sh TAG}
: "${ABOUT:?set ABOUT, e.g. ABOUT=\"the firmware for the COLDCARD hardware wallet\"}"
: "${REPO:?set REPO to the repository to review}"
export REPO
RUNS=${RUNS:-$HOME/bug-hunt/runs}
export RUNS
mkdir -p "$RUNS"
say() { echo "$(date +%H:%M:%S) $*"; }
run() {  # prompt-file name limit
  [ -e "$RUNS/$2/exit" ] && { say "$2 done before: skipped"; return; }
  mountpoint -q "$RUNS/$2/work" 2>/dev/null && sudo -n umount "$RUNS/$2/work"
  rm -rf "${RUNS:?}/${2:?}"
  say "start $2 (limit $3)"
  LIMIT=$3 "$HERE/run-one.sh" "$1" "$2" || true
  say "end $2: exit $(cat "$RUNS/$2/exit" 2>/dev/null || echo '?')"
}

python3 -c 'import sys; open(sys.argv[3], "w").write(open(sys.argv[1]).read().replace("{ABOUT}", sys.argv[2]))' \
  "$PROMPTS/map.txt" "$ABOUT" "$RUNS/$TAG-M-1.prompt.txt"
run "$RUNS/$TAG-M-1.prompt.txt" "$TAG-M-1" "${LIMIT_M:-4h}"
python3 - "$RUNS/$TAG-M-1/events.jsonl" "$PROMPTS/review.txt" "$ABOUT" "$RUNS/$TAG-S" <<'PY' || { say "no subsystem list in the map: stopping"; exit 1; }
import json, re, sys
events, template, about, out = sys.argv[1:]
final = ""
for line in open(events):
    try: e = json.loads(line)
    except ValueError: continue
    if e.get("type") == "final": final = e.get("text", "")
m = re.search(r"^##\s*Subsystems\s*$(.*)", final, re.M | re.S)
items = [l.strip()[2:].strip() for l in (m.group(1) if m else "").splitlines() if l.strip().startswith("- ")]
if not items: sys.exit(1)
t = open(template).read().replace("{ABOUT}", about)
for i, item in enumerate(items, 1):
    open(f"{out}-{i}.prompt.txt", "w").write(t.replace("{SUBSYSTEM}", item))
print(f"{len(items)} subsystems")
PY
for f in $(ls "$RUNS"/"$TAG"-S-*.prompt.txt | sort -V); do     # in the map's order: S-1, S-2 ... S-10
  n=${f%.prompt.txt}; n=${n##*-S-}
  run "$f" "$TAG-S-$n" "${LIMIT_S:-4h}"
done
say "strategy $TAG finished"
