#!/bin/bash
# download-models.sh [pack ...]  - fetch Qwen3.8-Flash-Next GSQ-RCO packs from ISTA-DASLab at a pinned revision, then check SHA-256.
#
#   Packs: q2_0 iq3_xxs iq3_s iq2_xs vision.  Default: q2_0 iq3_xxs iq3_s vision.
#   The 28.8 GB n-gram shard (file 2 of 2) is identical in every pack, so it is fetched once into models/ngram and linked.
set -u
OUTCROP_HOME=${OUTCROP_HOME:-$HOME/.outcrop}
# the revision and the SHA-256 values: setup/pins.env
# shellcheck source=pins.env
. "$(dirname "$0")/pins.env"
BASE=https://huggingface.co/$HF_REPO/resolve/$HF_REV
NGRAM=Qwen3.8-Flash-Next-GSQ-RCO-Q2_0-00002-of-00002.gguf
declare -A SHA=(
  [ngram]=$SHA256_NGRAM
  [Q2_0]=$SHA256_Q2_0
  [IQ2_XS]=$SHA256_IQ2_XS
  [IQ3_XXS]=$SHA256_IQ3_XXS
  [IQ3_S]=$SHA256_IQ3_S
  [vision]=$SHA256_VISION
)
M=$OUTCROP_HOME/models
mkdir -p "$M/ngram" "$M/vision"

fetch() {  # dir name url sha
  local d=$1 n=$2 u=$3 s=$4
  if [ -f "$d/$n.ok" ]; then echo "== $n already verified"; return 0; fi
  echo "== fetching $n"
  aria2c -x 16 -s 16 -k 64M -c --file-allocation=falloc --console-log-level=warn --summary-interval=60 \
    --max-tries=0 --retry-wait=10 --auto-file-renaming=false -d "$d" -o "$n" "$u" || { echo "FAILED $n"; return 1; }
  echo "== checking $n"
  if [ "$(sha256sum "$d/$n" | cut -d' ' -f1)" = "$s" ]; then touch "$d/$n.ok"; echo "OK $n"; return 0; fi
  # a bad copy would be taken as finished next time (the download resumes from its length): remove it
  rm -f "$d/$n" "$d/$n.aria2"
  echo "SHA MISMATCH $n: the file was damaged in transfer and is deleted; the next run downloads it again"; return 1
}

PACKS=${*:-q2_0 iq3_xxs iq3_s vision}
FAILED=""
fetch "$M/ngram" "$NGRAM" "$BASE/Q2_0/$NGRAM" "${SHA[ngram]}" || exit 1
for p in $PACKS; do
  case $p in
    vision) fetch "$M/vision" mmproj-Qwen3.8-Flash-Next-BF16.gguf "$BASE/mmproj-Qwen3.8-Flash-Next-BF16.gguf" "${SHA[vision]}" || FAILED="$FAILED vision" ;;
    *) Q=$(echo "$p" | tr a-z A-Z); mkdir -p "$M/$Q"
       S1=Qwen3.8-Flash-Next-GSQ-RCO-$Q-00001-of-00002.gguf
       fetch "$M/$Q" "$S1" "$BASE/$Q/$S1" "${SHA[$Q]}" || { FAILED="$FAILED $p"; continue; }
       ln -sf "../ngram/$NGRAM" "$M/$Q/Qwen3.8-Flash-Next-GSQ-RCO-$Q-00002-of-00002.gguf" ;;
  esac
done
if [ -n "$FAILED" ]; then echo "NOT DONE:$FAILED (run it again: finished files are skipped)"; exit 1; fi
echo ALL_DONE
