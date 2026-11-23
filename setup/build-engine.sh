#!/bin/bash
# build-engine.sh SRC_DIR NAME  - build Strata for the Quadro M6000 (Maxwell, sm_52) with CUDA 12.9, and install the binary as
# $OUTCROP_HOME/bin/strata-NAME.  Each source tree gets its own llama.cpp copy, because configure writes an overlay into it.
#
#   STRATA_PORTABLE=ON  builds the CPU side for any AVX2 CPU instead of this one (the StartOS image sets it).
#   OUTCROP_CUDA=DIR    the CUDA 12.9 toolkit, if it is not at /usr/local/cuda-12.9 (the image's is at /usr/local/cuda).
set -euo pipefail
SRC=$(cd "$1" && pwd); NAME=$2
OUTCROP_HOME=${OUTCROP_HOME:-$HOME/.outcrop}
CUDA=${OUTCROP_CUDA:-/usr/local/cuda-12.9}
# shellcheck source=pins.env
. "$(dirname "$0")/pins.env"
LLAMA_PIN=$LLAMA_COMMIT
[ -d "$SRC/.llama.cpp" ] || cp -a "$OUTCROP_HOME/src/llama.cpp" "$SRC/.llama.cpp"
[ "$(git -C "$SRC/.llama.cpp" rev-parse HEAD)" = "$LLAMA_PIN" ] || { echo "llama.cpp is not at $LLAMA_PIN"; exit 1; }
export PATH=$CUDA/bin:$PATH
LOG=$OUTCROP_HOME/logs/build-$NAME.log
mkdir -p "$OUTCROP_HOME/logs" "$OUTCROP_HOME/bin"
fail() { echo "building strata-$NAME failed; the end of $LOG:"; tail -n 40 "$LOG"; exit 1; }
# (STRATA_PORTABLE unset adds no option at all, so the Ubuntu build's configure line is what it always was)
cmake -S "$SRC" -B "$SRC/build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DSTRATA_ENABLE_CUDA=ON -DSTRATA_EXPERIMENTAL_SM60=ON \
  -DSTRATA_BUILD_TESTS=OFF -DCMAKE_CUDA_ARCHITECTURES=52 -DCMAKE_CUDA_COMPILER=$CUDA/bin/nvcc \
  ${STRATA_PORTABLE:+-DSTRATA_PORTABLE=$STRATA_PORTABLE} \
  -DFETCHCONTENT_SOURCE_DIR_STRATA_LLAMACPP="$SRC/.llama.cpp" > "$LOG" 2>&1 || fail
cmake --build "$SRC/build" --target strata -j"$(nproc)" >> "$LOG" 2>&1 || fail
install -m 755 "$SRC/build/strata" "$OUTCROP_HOME/bin/strata-$NAME"
# what it was built from: setup/install.sh builds it again when the sources' tree is no longer this one
git -C "$SRC" rev-parse 'HEAD^{tree}' > "$OUTCROP_HOME/bin/strata-$NAME.tree" 2> /dev/null || true
echo "built $OUTCROP_HOME/bin/strata-$NAME from $(git -C "$SRC" log --oneline -1)"
