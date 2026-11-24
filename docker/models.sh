#!/bin/bash
# models.sh  - (StartOS, the outcrop-models unit) download and prepare the models of this machine's profile: setup/install.sh's
# steps 6 and 7, with the same scripts.  Hours the first time; after that every finished file is skipped in seconds.
set -euo pipefail
P=$(cd "$(dirname "$0")/.." && pwd)
: "${OUTCROP_HOME:?}"
# the packs this machine keeps (lib/profiles.py): every pack of the profile presets.json was made from, or with "Models to
# keep" at the boot preset's only, that one; then the files of the packs no longer kept go first, to make room
read -r Q8 PACKS < <(PYTHONPATH="$P/lib" python3 -c 'import profiles as P
c = P.current() or {}
q8 = P.compose(c["profile"]["name"]).get("common", {}).get("q8_dense", True)
for gone in P.remove_unwanted(c):
    print(f"== removed the {gone} pack (Models to keep: only the boot preset'"'"'s)", file=__import__("sys").stderr)
print(int(bool(q8)), " ".join(P.wanted_packs(c)))')
echo "== the packs kept: $PACKS, the n-gram table and the picture encoder"
# shellcheck disable=SC2086
"$P/setup/download-models.sh" $PACKS vision
echo "== preparing the packs: MTP draft layer, native expert index$([ "$Q8" = 1 ] && echo ", Q8_0 dense copies")"
# shellcheck disable=SC2086
OUTCROP_Q8_DENSE=$Q8 "$P/setup/prep-packs.sh" mtp $PACKS
echo "== models ready"
