#!/bin/bash
# install.sh PROFILE  - set up the engine (Strata serving Qwen3.8-Flash-Next) on this machine, from nothing.
#
#   ./setup.sh runs this for you, after checking the machine and suggesting a profile. To run it by hand:
#   `outcrop profile detect` (or bin/outcrop profile detect) names the profile, then ./setup/install.sh NAME.
#   For: Ubuntu 24.04 or a derivative (Zorin OS 18, Linux Mint 22), NVIDIA driver 580 already installed, a GPU a profile
#   in profiles/ is made for.  Needs: the disk space `outcrop profile show NAME` gives, under $OUTCROP_HOME (default
#   ~/.outcrop), sudo, and the network (GitHub, Hugging Face, NVIDIA).
#   Every source and model is pinned; models are SHA-256 checked.  Each step is skipped when its output is already there,
#   so the script can be run again after an interruption.
set -euo pipefail
PROJECT=$(cd "$(dirname "$0")/.." && pwd)
export OUTCROP_HOME=${OUTCROP_HOME:-$HOME/.outcrop}
# STRATA_COMMIT, LLAMA_COMMIT, CUDA_RUN and CUDA_URL: setup/pins.env
# shellcheck source=pins.env
. "$PROJECT/setup/pins.env"
mkdir -p "$OUTCROP_HOME"/{src,models,data/packs,data/mtp,cfg,logs,bin,pkgs,state}

# The profile: presets.json from it (once; later `outcrop profile apply` changes it), and the packs it needs.
PROFILE=${1:-}
if [ -z "$PROFILE" ] && [ -f "$OUTCROP_HOME/presets.json" ]; then
  PROFILE=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("profile", {}).get("name", ""))' "$OUTCROP_HOME/presets.json")
fi
[ -n "$PROFILE" ] || { echo "usage: setup/install.sh PROFILE   (bin/outcrop profile detect suggests one)"; exit 2; }
prof() { PYTHONPATH="$PROJECT/lib" python3 -c "import profiles, sys; p = profiles.compose(sys.argv[1]); print($1)" "$PROFILE"; }
PACKS=$(prof '" ".join(p["profile"]["packs"])')
DEFAULT=$(prof 'p["profile"]["default_preset"]')
if [ ! -f "$OUTCROP_HOME/presets.json" ]; then
  OUTCROP_HOME=$OUTCROP_HOME python3 "$PROJECT/bin/outcrop" profile apply "$PROFILE" --yes > /dev/null
  echo "== presets.json from profile $PROFILE: $OUTCROP_HOME/presets.json"
fi

echo "== 1/8 system packages"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential cmake ninja-build git python3-venv python3-dev pkg-config \
  libnuma-dev libcurl4-openssl-dev libssl-dev aria2 unzip jq numactl curl ca-certificates socat

echo "== 2/8 CUDA 12.9.1 toolkit at /usr/local/cuda-12.9, beside anything already installed"
if [ ! -x /usr/local/cuda-12.9/bin/nvcc ]; then
  aria2c -x 8 -s 8 -c -d "$OUTCROP_HOME/pkgs" -o "$CUDA_RUN" "$CUDA_URL"
  before=$(readlink /usr/local/cuda || true)
  # --nox11: without it the runfile tries to open an xterm when a desktop session's DISPLAY is set and no terminal is attached
  sudo env -u DISPLAY -u WAYLAND_DISPLAY sh "$OUTCROP_HOME/pkgs/$CUDA_RUN" --nox11 --silent --toolkit --toolkitpath=/usr/local/cuda-12.9 \
    --no-man-page --no-drm --no-opengl-libs
  # The runfile repoints /usr/local/cuda and adds itself to the loader path; give both back (the engine finds 12.9 by RUNPATH).
  [ -n "$before" ] && sudo ln -sfn "$before" /usr/local/cuda
  [ -n "$before" ] && sudo rm -f /etc/ld.so.conf.d/cuda-12-9.conf && sudo ldconfig
fi

echo "== 3/8 sources: Strata v0.2.11 with the Maxwell patches, llama.cpp at Strata's pin"
ENGINE=$OUTCROP_HOME/bin/strata-0211
src_tree() { git -C "$OUTCROP_HOME/src/Strata" rev-parse 'HEAD^{tree}' 2> /dev/null || true; }
# an engine built before Outcrop recorded its sources was built from them as they stand now, before any new patch
[ -x "$ENGINE" ] && [ ! -s "$ENGINE.tree" ] && src_tree > "$ENGINE.tree"
"$PROJECT/setup/fetch-sources.sh" "$OUTCROP_HOME/src"
cd "$OUTCROP_HOME/src"

echo "== 4/8 Python environment for the server and the pack tools"
[ -x Strata/.venv/bin/python ] || python3 -m venv Strata/.venv
Strata/.venv/bin/pip -q install -r Strata/requirements.txt

echo "== 5/8 engine (about 5 minutes) and the CPU picture encoder"
if [ ! -x "$ENGINE" ] || [ "$(cat "$ENGINE.tree" 2> /dev/null)" != "$(src_tree)" ]; then
  if [ -x "$ENGINE" ]; then
    echo "   its sources changed (Outcrop's patches): building it again"
    # the build takes several GB of RAM, which a running engine on a 32 GB machine leaves no room for
    if command -v outcrop > /dev/null && outcrop stop > /dev/null 2>&1; then
      echo "   the engine is stopped while it builds (./setup.sh starts it again; by hand: outcrop switch PRESET)"
    fi
  fi
  "$PROJECT/setup/build-engine.sh" "$OUTCROP_HOME/src/Strata" 0211
fi
[ -x "$OUTCROP_HOME/bin/strata-vision" ] || "$PROJECT/setup/build-vision.sh" "$OUTCROP_HOME/src/Strata"

echo "== 6/8 models for profile $PROFILE: packs $PACKS, the shared n-gram table and the picture encoder's weights"
# shellcheck disable=SC2086
"$PROJECT/setup/download-models.sh" $PACKS vision

echo "== 7/8 packs: MTP draft layer, native expert index and Q8_0 dense copies (written at disk speed)"
# shellcheck disable=SC2086
"$PROJECT/setup/prep-packs.sh" mtp $PACKS

echo "== 8/8 services: outcrop-engine@<preset> and the Ollama API bridge, outcrop on the PATH"
"$PROJECT/setup/install-service.sh" "$DEFAULT"
echo "== done.  Start it now with: outcrop switch $DEFAULT    (outcrop status shows what runs)"
