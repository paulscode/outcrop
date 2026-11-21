#!/bin/bash
# build-engine.sh SRC_DIR NAME  - build Strata for the Quadro M6000 (Maxwell, sm_52) with CUDA 12.9, and install the binary as
# $OUTCROP_HOME/bin/strata-NAME.  Each source tree gets its own llama.cpp copy, because configure writes an overlay into it.
set -euo pipefail
SRC=$(cd "$1" && pwd); NAME=$2
OUTCROP_HOME=${OUTCROP_HOME:-$HOME/.outcrop}
CUDA=/usr/local/cuda-12.9
# shellcheck source=pins.env
. "$(dirname "$0")/pins.env"
LLAMA_PIN=$LLAMA_COMMIT
[ -d "$SRC/.llama.cpp" ] || cp -a "$OUTCROP_HOME/src/llama.cpp" "$SRC/.llama.cpp"
[ "$(git -C "$SRC/.llama.cpp" rev-parse HEAD)" = "$LLAMA_PIN" ] || { echo "llama.cpp is not at $LLAMA_PIN"; exit 1; }
export PATH=$CUDA/bin:$PATH
cmake -S "$SRC" -B "$SRC/build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DSTRATA_ENABLE_CUDA=ON -DSTRATA_EXPERIMENTAL_SM60=ON \
  -DSTRATA_BUILD_TESTS=OFF -DCMAKE_CUDA_ARCHITECTURES=52 -DCMAKE_CUDA_COMPILER=$CUDA/bin/nvcc \
  -DFETCHCONTENT_SOURCE_DIR_STRATA_LLAMACPP="$SRC/.llama.cpp" > "$OUTCROP_HOME/logs/build-$NAME.log" 2>&1
cmake --build "$SRC/build" --target strata -j"$(nproc)" >> "$OUTCROP_HOME/logs/build-$NAME.log" 2>&1
install -m 755 "$SRC/build/strata" "$OUTCROP_HOME/bin/strata-$NAME"
echo "built $OUTCROP_HOME/bin/strata-$NAME from $(git -C "$SRC" log --oneline -1)"
