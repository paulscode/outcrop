#!/bin/bash
# prep-packs.sh [mtp] [q2_0] [iq3_xxs] [iq3_s] ...  - turn downloaded GGUFs into what the tuned engine runs:
#   mtp      the model's MTP draft layer, fetched from Qwen's checkpoint (pinned, SHA-256 checked) and packed with Q2_0 experts
#   <pack>   the native expert index (iq_pack.py) and a copy of shard 1 whose dense projections and head are Q8_0 (q8_dense_gguf.py),
#            which the Maxwell GEMV path (STRATA_Q8_SM60) runs fastest.  Each step is skipped when its output exists.
set -euo pipefail
OUTCROP_HOME=${OUTCROP_HOME:-$HOME/.outcrop}
# the engine's sources and gguf-py: under $OUTCROP_HOME as setup/install.sh puts them, unless the environment says otherwise
# (the StartOS image keeps them under /opt)
S=${OUTCROP_STRATA:-$OUTCROP_HOME/src/Strata}
PY=$S/.venv/bin/python
export STRATA_GGUF_PY=${STRATA_GGUF_PY:-$OUTCROP_HOME/src/llama.cpp/gguf-py}
cd "$S"
for p in "$@"; do
  case $p in
    mtp)
      D=$OUTCROP_HOME/data/mtp
      [ -f "$D/mtp-q2_0.gguf" ] || { $PY tools/mtp_fetch.py fetch --out "$D" && $PY tools/mtp_pack.py --src "$D" --experts q2_0 --out "$D/mtp-q2_0.gguf"; }
      [ -d "$D/rt" ] || $PY tools/mtp_rt.py --gguf "$D/mtp-q2_0.gguf" --out "$D/rt"
      echo "PREP_DONE mtp" ;;
    *)
      Q=$(echo "$p" | tr a-z A-Z)
      G=$OUTCROP_HOME/models/$Q/Qwen3.8-Flash-Next-GSQ-RCO-$Q-00001-of-00002.gguf
      [ -f "$G.ok" ] || { echo "PREP_FAILED $p: $G is not downloaded and verified yet"; exit 1; }
      [ -f "$OUTCROP_HOME/data/packs/$p/native_experts.txt" ] || $PY tools/iq_pack.py --gguf "$G" --out "$OUTCROP_HOME/data/packs/$p"
      if [ ! -d "$OUTCROP_HOME/models/$Q-q8dense" ]; then
        rm -rf "$OUTCROP_HOME/models/$Q-q8dense.tmp"       # a conversion that stopped halfway starts over
        $PY tools/q8_dense_gguf.py "$G" "$OUTCROP_HOME/models/$Q-q8dense.tmp"
        mv "$OUTCROP_HOME/models/$Q-q8dense.tmp" "$OUTCROP_HOME/models/$Q-q8dense"
      fi
      echo "PREP_DONE $p" ;;
  esac
done
