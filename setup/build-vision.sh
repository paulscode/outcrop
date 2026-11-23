#!/bin/bash
# build-vision.sh SRC_DIR  - build Strata's CPU picture encoder (strata-vision) from SRC_DIR and install it as
# $OUTCROP_HOME/bin/strata-vision.  Run setup/build-engine.sh on SRC_DIR first: it puts the pinned llama.cpp in SRC_DIR/.llama.cpp.
#
#   STRATA_PORTABLE=ON  builds for any AVX2 CPU instead of this one (the StartOS image sets it; setup/install.sh does not).
set -euo pipefail
SRC=$(cd "$1" && pwd)
OUTCROP_HOME=${OUTCROP_HOME:-$HOME/.outcrop}
LOG=$OUTCROP_HOME/logs/build-vision.log
mkdir -p "$OUTCROP_HOME/logs" "$OUTCROP_HOME/bin"
[ -d "$SRC/.llama.cpp" ] || { echo "no $SRC/.llama.cpp: run setup/build-engine.sh first"; exit 1; }
fail() { echo "building strata-vision failed; the end of $LOG:"; tail -n 40 "$LOG"; exit 1; }
# a build folder made where the sources used to be (the install was moved): CMake refuses to use it, so it is made again
if [ -f "$SRC/build-vision/CMakeCache.txt" ] && ! grep -qxF -e "CMAKE_HOME_DIRECTORY:INTERNAL=$SRC/tools/vision" \
  -e "CMAKE_HOME_DIRECTORY:INTERNAL=$(cd "$SRC" && pwd -P)/tools/vision" "$SRC/build-vision/CMakeCache.txt"; then
  rm -rf "$SRC/build-vision"
fi
cmake -S "$SRC/tools/vision" -B "$SRC/build-vision" -G Ninja -DCMAKE_BUILD_TYPE=Release -DLLAMA_DIR="$SRC/.llama.cpp" \
  -DSTRATA_PORTABLE="${STRATA_PORTABLE:-OFF}" > "$LOG" 2>&1 || fail
cmake --build "$SRC/build-vision" --target strata-vision -j"$(nproc)" >> "$LOG" 2>&1 || fail
install -m 755 "$SRC/build-vision/bin/strata-vision" "$OUTCROP_HOME/bin/strata-vision"
