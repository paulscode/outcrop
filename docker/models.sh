#!/bin/bash
# models.sh  - (StartOS, the outcrop-models unit) download and prepare the models of this machine's profile: setup/install.sh's
# steps 6 and 7, with the same scripts.  Hours the first time; after that every finished file is skipped in seconds.
set -euo pipefail
P=$(cd "$(dirname "$0")/.." && pwd)
: "${OUTCROP_HOME:?}"
PACKS=$(python3 -c 'import json, sys; print(" ".join(json.load(open(sys.argv[1]))["profile"]["packs"]))' "$OUTCROP_HOME/presets.json")
echo "== the profile's packs: $PACKS, the n-gram table and the picture encoder"
# shellcheck disable=SC2086
"$P/setup/download-models.sh" $PACKS vision
echo "== preparing the packs: MTP draft layer, native expert index, Q8_0 dense copies"
# shellcheck disable=SC2086
"$P/setup/prep-packs.sh" mtp $PACKS
echo "== models ready"
