#!/bin/bash
# fetch-sources.sh DIR  - put the engine's sources in DIR: Strata at its pin with Outcrop's Maxwell patches (DIR/Strata), and
# llama.cpp at Strata's pin with the dp4a patch (DIR/llama.cpp).  The pins are in setup/pins.env.
#
#   setup/install.sh runs it into $OUTCROP_HOME/src; the StartOS image's Dockerfile runs it in its build stage.
#   Each source is prepared in a .tmp directory and moved into place only when complete (patches applied), so a run that
#   stopped halfway is redone, not skipped.
set -euo pipefail
PROJECT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=pins.env
. "$PROJECT/setup/pins.env"
mkdir -p "${1:?usage: setup/fetch-sources.sh DIR}"
cd "$1"
if [ ! -d Strata ]; then
  rm -rf Strata.tmp "Strata-$STRATA_COMMIT" strata.tar.gz
  curl -fL -o strata.tar.gz "https://github.com/Niko1221/Strata/archive/$STRATA_COMMIT.tar.gz"
  tar xzf strata.tar.gz && mv "Strata-$STRATA_COMMIT" Strata.tmp && rm strata.tar.gz
  G="git -C Strata.tmp -c user.name=outcrop -c user.email=outcrop@localhost"
  $G init -q -b v0.2.11 && $G add -A && $G commit -q -m "Strata $STRATA_COMMIT (v0.2.11)"
  $G checkout -q -b m6000 && $G am -q "$PROJECT"/patches/*.patch
  mv Strata.tmp Strata
fi
# An install made before Outcrop's patches changed has the old series applied: apply today's again, in place on the same
# base, so the build directory, the Python environment and the llama.cpp copy stay and the rebuild is incremental.  The
# series are compared by patch id (their diffs), so applying the same patches again counts as no change.
ids() { git patch-id --stable | cut -d' ' -f1; }
have=$(git -C Strata log --reverse -p --format='commit %H' v0.2.11..m6000 | ids)
want=$(for p in "$PROJECT"/patches/*.patch; do ids < "$p"; done)
if [ "$have" != "$want" ]; then
  echo "== Outcrop's engine patches changed: applying them again to Strata $STRATA_COMMIT"
  G="git -C Strata -c user.name=outcrop -c user.email=outcrop@localhost"
  before=$(git -C Strata rev-parse m6000)
  if ! { $G checkout -q -B m6000 v0.2.11 && $G am -q "$PROJECT"/patches/*.patch; }; then
    # the sources go back to the series the engine was built from, so the two still match
    $G am --abort 2> /dev/null || true
    $G checkout -q -B m6000 "$before"
    echo "Outcrop's patches did not apply to $PWD/Strata (it is left as it was)"
    exit 1
  fi
fi
if [ ! -d llama.cpp ]; then
  # A shallow fetch of the one commit: GitHub's archive download stalled on this network.
  rm -rf llama.cpp.tmp
  mkdir llama.cpp.tmp && git -C llama.cpp.tmp init -q && git -C llama.cpp.tmp remote add origin https://github.com/ggml-org/llama.cpp.git
  git -C llama.cpp.tmp fetch -q --depth 1 origin "$LLAMA_COMMIT" && git -C llama.cpp.tmp checkout -q FETCH_HEAD
  python3 "$PROJECT/setup/patch_llama_dp4a.py" llama.cpp.tmp/ggml/src/ggml-cuda/common.cuh
  mv llama.cpp.tmp llama.cpp
fi
