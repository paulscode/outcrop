#!/bin/bash
# run-one.sh PROMPT_FILE RUN_NAME  - one headless dsh run against a copy of $REPO, in a container with no network.
#
# Settings (environment):
#   REPO        the repository to review (required): a git checkout on this machine
#   WORKDIR     where the model sees it (default /home/dev/<the repo's folder name>, like a developer's own clone)
#   RUNS        where runs go (default ~/bug-hunt/runs)
#   TOKEN_FILE  an Outcrop token for the runs (default ~/.config/outcrop/bug-hunt-token; README.md says how to make one)
#   GATEWAY     Outcrop's OpenAI port, host:port (default 127.0.0.1:8080: run this on the Outcrop installation)
#   IMAGE       the dsh image (default outcrop-bug-hunt:dsh-0.2.1-rc.3; build it from this folder's Dockerfile)
#   LIMIT       how long a run may take (default 4h)
#
# Each run gets $RUNS/RUN_NAME:
#   work/          the repository as the run sees it: an overlay mount (needs sudo for `mount`), the repository read-only
#                  underneath and anything the run writes kept in upper/, so the repository itself is never changed
#   home/          dsh's home: the settings (dsh.patch.yml) and the full session logs (sessions/)
#   events.jsonl   dsh's --json event stream; the last "final" event is the answer
#   stderr.log, meta.json, exit (0 finished, 124 out of time), finished
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
PROMPT=$(readlink -f "${1:?usage: run-one.sh PROMPT_FILE RUN_NAME}"); NAME=${2:?usage: run-one.sh PROMPT_FILE RUN_NAME}
REPO=$(readlink -f "${REPO:?set REPO to the repository to review}")
WORKDIR=${WORKDIR:-/home/dev/$(basename "$REPO")}
RUNS=${RUNS:-$HOME/bug-hunt/runs}
TOKEN_FILE=${TOKEN_FILE:-$HOME/.config/outcrop/bug-hunt-token}
GATEWAY=${GATEWAY:-127.0.0.1:8080}
IMAGE=${IMAGE:-outcrop-bug-hunt:dsh-0.2.1-rc.3}
LIMIT=${LIMIT:-4h}
[ -r "$TOKEN_FILE" ] || { echo "no token in $TOKEN_FILE (README.md, \"A token for the runs\")" >&2; exit 2; }
D=$RUNS/$NAME
[ -e "$D" ] && { echo "$D exists" >&2; exit 2; }
sudo -n true 2> /dev/null || sudo -n mount --version > /dev/null 2>&1 \
  || { echo "run-one.sh mounts a copy of the repository and needs sudo without a password prompt (README.md, \"What you need\")" >&2; exit 2; }
# Docker through sudo unless this user can reach it already
DOCKER=docker
docker info > /dev/null 2>&1 || DOCKER="sudo -n docker"
$DOCKER info > /dev/null 2>&1 || { echo "cannot reach Docker as $(id -un) or through sudo without a password (README.md, \"What you need\")" >&2; exit 2; }
mkdir -p "$D/gw" "$D/home/profiles/headless" "$D/work" "$D/upper" "$D/.ovl"

SOCAT=""
# set before the mount: whatever fails from here, the copy is unmounted and the token file removed
trap '[ -n "$SOCAT" ] && kill "$SOCAT" 2>/dev/null; rm -f "$D/env"; sudo -n umount "$D/work" 2>/dev/null; true' EXIT
sudo -n mount -t overlay overlay -o "lowerdir=$REPO,upperdir=$D/upper,workdir=$D/.ovl" "$D/work"
cp "$HERE/dsh.patch.yml" "$D/home/profiles/headless/cordis.patch.yml"
cp "$PROMPT" "$D/prompt.txt"

umask 077
printf 'GATEWAY_API_KEY=%s\n' "$(cat "$TOKEN_FILE")" > "$D/env"
socat "UNIX-LISTEN:$D/gw/gw.sock,fork,mode=600" "TCP:$GATEWAY" &
SOCAT=$!
for _ in $(seq 50); do [ -S "$D/gw/gw.sock" ] && break; sleep 0.1; done

DOCKER=$DOCKER REPO=$REPO WORKDIR=$WORKDIR LIMIT=$LIMIT python3 - "$D" "$IMAGE" "$PROMPT" <<'PY'
import json, os, subprocess, sys, time
d, image, prompt = sys.argv[1:]
def sh(*a):
    try:
        return subprocess.run(a, capture_output=True, text=True).stdout.strip()
    except OSError:
        return ""
json.dump({
    "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "prompt_file": prompt,
    "repo": os.environ["REPO"],
    "repo_commit": sh("git", "-C", d + "/work", "rev-parse", "HEAD"),
    "workdir": os.environ["WORKDIR"],
    "limit": os.environ["LIMIT"],
    "image": image,
    "image_id": sh(*os.environ["DOCKER"].split(), "image", "inspect", "--format", "{{.Id}}", image),
    "settings_sha256": sh("sha256sum", d + "/home/profiles/headless/cordis.patch.yml").split()[0],
    "outcrop_status": sh("outcrop", "status").splitlines()[:3],
}, open(d + "/meta.json", "w"), indent=1)
PY

set +e
# as this user's own ids, so the run can use the gateway socket (0600, this user's) and write its copy of the repository
U=$(id -u) G=$(id -g)
timeout "$LIMIT" $DOCKER run --rm -i --network none \
  --read-only --tmpfs /tmp:size=2g,exec --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 512 --memory 8g --cpus 8 --user "$U:$G" \
  -e HOME=/home/dev -e DSH_HOME=/dsh-home -e WORKDIR="$WORKDIR" --tmpfs "/home/dev:size=1g,uid=$U,gid=$G" \
  -e DSH_TELEMETRY_DISABLED=1 -e DSH_PERMISSION_MODE=danger-full-access \
  --env-file "$D/env" \
  -v "$D/gw:/gw" -v "$D/work:$WORKDIR" -v "$D/home:/dsh-home" \
  "$IMAGE" < "$PROMPT" > "$D/events.jsonl" 2> "$D/stderr.log"
rc=$?
set -e
echo "$rc" > "$D/exit"
date +%Y-%m-%dT%H:%M:%S%z > "$D/finished"
echo "$NAME: exit $rc ($D)"
