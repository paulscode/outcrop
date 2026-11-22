#!/bin/bash
# ./setup.sh  - set up Outcrop on this computer: check it, suggest a profile, install, start.
#
#   ./setup.sh                 check this computer, then (after you say yes) install everything and start the server
#   ./setup.sh --check         only check this computer and suggest a profile; changes nothing
#   ./setup.sh update          after `git pull`: apply what changed (setup/deploy.sh)
#   options:  --profile NAME   use this profile instead of the suggested one (./bin/outcrop profile list)
#             --data DIR       keep the models and everything else in DIR (default ~/.outcrop; needs about 210 to 320 GB)
#             --no-web         skip the chat's web search and page reading (needs Docker otherwise)
#             --yes            do not ask; take the suggested profile
#
# Safe to run again: every step skips what is already done, so after an interruption just run it again.
set -uo pipefail
PROJECT=$(cd "$(dirname "$0")" && pwd)
cd "$PROJECT" || exit 1

if [ -t 1 ]; then B=$'\033[1m' D=$'\033[2m' G=$'\033[32m' Y=$'\033[33m' R=$'\033[31m' X=$'\033[0m'; else B="" D="" G="" Y="" R="" X=""; fi
ok()   { printf '  %s✓%s %s\n' "$G" "$X" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$X" "$*"; WARNINGS=$((WARNINGS + 1)); }
bad()  { printf '  %s✗%s %s\n' "$R" "$X" "$*"; PROBLEMS=$((PROBLEMS + 1)); }
hint() { printf '      %s%s%s\n' "$D" "$*" "$X"; }
step() { printf '\n%s== %s%s\n' "$B" "$*" "$X"; }
ask()  {  # question, default (y/n)
  [ -n "$YES" ] && return 0
  local a; read -r -p "$1 [$( [ "$2" = y ] && echo Y/n || echo y/N )] " a
  a=${a:-$2}; [[ "$a" =~ ^[Yy] ]]
}
WARNINGS=0 PROBLEMS=0
CHECK="" YES="" PROFILE="" DATA="" WEB=1
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --yes|-y) YES=1 ;;
    --profile) PROFILE=${2:?--profile needs a name}; shift ;;
    --data) DATA=${2:?--data needs a folder}; shift ;;
    --no-web) WEB="" ;;
    update) exec "$PROJECT/setup/deploy.sh" ;;
    -h|--help|help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1 (./setup.sh --help)"; exit 2 ;;
  esac
  shift
done

printf '%sOutcrop%s: a simple framework for running a capable LLM (Qwen3.8-Flash-Next on Strata) on budget, upgradable hardware.\n' "$B" "$X"
printf 'This checks your computer first and changes nothing until you say yes.\n'

# --------------------------------------------------------------------------------------------- where the data goes
if [ -n "$DATA" ]; then
  DATA=$(realpath -m "$DATA")
  if [ -e "$HOME/.outcrop" ] && [ "$(realpath "$HOME/.outcrop")" != "$DATA" ]; then
    echo "$HOME/.outcrop already exists and is not $DATA; move it or drop --data"; exit 2
  fi
fi
export OUTCROP_HOME=$HOME/.outcrop          # with --data, a link to DATA (made once you say yes)
if [ -n "$DATA" ]; then
  d=$DATA; while [ ! -e "$d" ]; do d=$(dirname "$d"); done
  [ -w "$d" ] || { echo "$DATA cannot be written by $(id -un). If the disk belongs to root:"; \
                   echo "  sudo mkdir -p $DATA && sudo chown $(id -un): $DATA    then run ./setup.sh again"; exit 2; }
fi

# ------------------------------------------------------------------------------------------------------ checks
step "Checking this computer"
[ "$(id -u)" != 0 ] && ok "running as $(id -un), not root" || { bad "do not run this as root (sudo): run it as your own user"; }
if sudo -n true 2> /dev/null; then
  ok "this account can use sudo"
elif id -nG | tr ' ' '\n' | grep -qxE 'sudo|admin|wheel'; then
  ok "this account can use sudo (it will ask for your password)"
else
  bad "this account cannot use sudo, which setup needs to install system packages and services"
  hint "Run it from an administrator account, or ask an administrator to add yours: sudo usermod -aG sudo $(id -un)"
fi

. /etc/os-release 2>/dev/null || true
if [[ "${ID:-} ${ID_LIKE:-}" == *ubuntu* ]]; then
  if [ "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}" = noble ]; then
    ok "${PRETTY_NAME:-Linux} (Ubuntu 24.04 based)"
  else
    warn "${PRETTY_NAME:-Linux}: Outcrop is tested on Ubuntu 24.04 and systems built on it (Zorin OS 18, Linux Mint 22)"
  fi
else
  bad "${PRETTY_NAME:-this system} is not Ubuntu based; Outcrop needs Ubuntu 24.04 or a system built on it"
fi

if grep -qw avx2 /proc/cpuinfo; then
  ok "CPU: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/^ *//') ($(nproc) threads, AVX2)"
else
  bad "the CPU has no AVX2, which the engine needs (Intel Haswell / AMD Zen or newer)"
fi

if ! command -v nvidia-smi > /dev/null 2>&1 || ! nvidia-smi > /dev/null 2>&1; then
  bad "no NVIDIA driver is working (nvidia-smi)"
  hint "Install driver 580: open Driver Manager / Additional Drivers and pick nvidia-driver-580,"
  hint "or run: sudo apt install nvidia-driver-580   then restart the computer and run ./setup.sh again."
else
  drv=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)
  major=${drv%%.*}
  if [ "$major" -ge 575 ] && [ "$major" -le 580 ]; then
    ok "NVIDIA driver $drv"
  elif [ "$major" -gt 580 ]; then
    bad "NVIDIA driver $drv: drivers after 580 dropped Maxwell cards like the M6000; install nvidia-driver-580"
  else
    bad "NVIDIA driver $drv is too old for CUDA 12.9: install nvidia-driver-580 (Driver Manager, or sudo apt install nvidia-driver-580)"
  fi
fi

# the profile: from the GPU and the RAM (lib/profiles.py)
pf() { PYTHONPATH="$PROJECT/lib" python3 -c "import profiles as P, sys, json; $1" "${@:2}"; }
read -r -d '' FACTS < <(pf 'f = P.facts(); n, kind, why = P.suggest(f); print(json.dumps({"f": f, "name": n, "kind": kind, "why": why}))'; printf '\0')
gpu=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(", ".join(f"{g["name"]} ({g["vram_mib"]//1024} GB)" for g in d["f"]["gpus"]) or "-")' "$FACTS")
ram=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["f"]["ram_gib"])' "$FACTS")
[ "$gpu" != "-" ] && ok "GPU: $gpu"
ok "RAM: $ram GB"
if [ -z "$PROFILE" ]; then
  PROFILE=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["name"] or "")' "$FACTS")
  kind=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["kind"])' "$FACTS")
  if [ -z "$PROFILE" ]; then
    bad "no profile fits this computer yet"
    python3 -c 'import json,sys; [print("      - " + w) for w in json.loads(sys.argv[1])["why"][:4]]' "$FACTS"
    hint "Profiles are in profiles/ (./bin/outcrop profile list). If your hardware is close to one, --profile NAME"
    hint "uses it anyway; a new profile for your machine is welcome (CONTRIBUTING.md)."
  elif [ "$kind" = similar ]; then
    warn "profile $PROFILE: your GPU is in the same family as the one it was made for, but it has not been tested"
  else
    ok "profile: $PROFILE"
  fi
else
  pf 'P.usable(sys.argv[1])' "$PROFILE" 2> /dev/null && ok "profile: $PROFILE (your choice)" \
    || bad "$PROFILE is not a profile setup can use: $(pf 'P.usable(sys.argv[1])' "$PROFILE" 2>&1 | tail -1) (./bin/outcrop profile list)"
fi

NOW=$(pf 'print((P.current() or {}).get("profile", {}).get("name", ""))' 2> /dev/null)
if [ -n "$NOW" ] && [ -n "$PROFILE" ] && [ "$NOW" != "$PROFILE" ]; then
  warn "Outcrop is installed with profile $NOW; this setup switches it to $PROFILE (the old presets.json is kept as a copy)"
  hint "./bin/outcrop profile diff $PROFILE shows what changes"
fi

need=0
if [ -n "$PROFILE" ] && pf 'P.usable(sys.argv[1])' "$PROFILE" 2> /dev/null; then
  need=$(pf 'print(P.disk_gb(P.compose(sys.argv[1])))' "$PROFILE")
  if [ -e "$OUTCROP_HOME" ]; then target=$(realpath "$OUTCROP_HOME"); else target=${DATA:-$HOME}; fi
  while [ ! -d "$target" ]; do target=$(dirname "$target"); done
  free=$(df -BG --output=avail "$target" | tail -1 | tr -dc 0-9)
  have=0; [ -e "$OUTCROP_HOME" ] && have=$(du -sLBG "$OUTCROP_HOME" 2> /dev/null | cut -f1 | tr -dc 0-9)
  if [ $((free + have)) -ge "$need" ]; then
    ok "disk: $free GB free at $target, about $need GB needed"
  else
    bad "disk: about $need GB needed, only $free GB free at $target"
    best=$(df -BG --output=avail,target -x tmpfs -x devtmpfs -x squashfs -x overlay 2> /dev/null | tail -n +2 | sort -rn \
           | awk -v n="$need" '$1+0 >= n {print $2; exit}')
    if [ -n "$best" ]; then hint "$best has room: ./setup.sh --data $best/outcrop"; else hint "free some space, or add a disk"; fi
  fi
fi

if [ -z "$CHECK" ] || [ "$PROBLEMS" = 0 ]; then
  # the files setup actually fetches (a site's front page may refuse a HEAD request)
  # shellcheck source=setup/pins.env
  . "$PROJECT/setup/pins.env"
  for u in "https://huggingface.co/api/models/$HF_REPO" https://github.com/Niko1221/Strata "$CUDA_URL"; do
    python3 -c 'import sys, urllib.request; urllib.request.urlopen(urllib.request.Request(sys.argv[1], method="HEAD"), timeout=20)' "$u" \
      2> /dev/null || { bad "cannot reach $(echo "$u" | cut -d/ -f3) (the downloads come from there)"; continue; }
  done
  [ "$PROBLEMS" = 0 ] && ok "internet: Hugging Face, GitHub and NVIDIA answer"
fi
if grep -qs '^ENABLED=yes' /etc/ufw/ufw.conf; then        # readable without sudo
  warn "the ufw firewall is on: other devices cannot reach the console and the API until it allows them"
  hint "after setup: ./setup/harden.sh firewall opens Outcrop's ports to your home network only"
fi
if ! systemctl is-active -q avahi-daemon 2> /dev/null; then
  warn "mDNS (avahi-daemon) is not running, so $(hostname).local will not work from other devices; use the address instead"
fi
if command -v docker > /dev/null 2>&1; then
  ok "Docker is installed (it builds the console's page, and runs web search)"
else
  warn "Docker is not installed: setup installs it (Ubuntu's docker.io) to build the console's page and run web search"
fi

# ------------------------------------------------------------------------------------------------- the plan
if [ "$PROBLEMS" -gt 0 ]; then
  printf '\n%s%d problem(s) above need fixing first.%s Run ./setup.sh again afterwards.\n' "$R" "$PROBLEMS" "$X"
  exit 1
fi
step "The plan"
python3 "$PROJECT/bin/outcrop" profile show "$PROFILE" | sed 's/^/  /'
dl=$(pf 'p = P.compose(sys.argv[1]); print(27 + 6 + sum({"q2_0": 36, "iq3_xxs": 44, "iq3_s": 52, "iq2_xs": 38}.get(q, 50) for q in p["profile"]["packs"]))' "$PROFILE")
cat <<EOF

  It will:
    1. install system packages, CUDA 12.9 (beside anything already there) and Docker if missing   (sudo asks for your password)
    2. build the engine (about 10 minutes)
    3. download about $dl GB of model files from Hugging Face, check them, and prepare them (hours, depending on your internet)
    4. install the services: the engine, the API gateway (OpenAI, Anthropic and Ollama APIs) and the web console
    5. ask you to choose a password for the console, start the server and check that it answers
  Everything goes in ${DATA:-$HOME/.outcrop}${DATA:+ (linked from ~/.outcrop)}. The code stays here, in $PROJECT.
EOF
[ -n "$CHECK" ] && { printf '\nThis was only a check (--check). Run ./setup.sh to install.\n'; exit 0; }
echo
ask "Install now?" n || { echo "Nothing was changed."; exit 0; }

# ------------------------------------------------------------------------------------------------- install
if [ -n "$DATA" ] && [ ! -e "$HOME/.outcrop" ]; then
  { mkdir -p "$DATA" && ln -s "$DATA" "$HOME/.outcrop"; } \
    || { echo "cannot use $DATA. If the disk belongs to root: sudo mkdir -p $DATA && sudo chown $(id -un): $DATA"; exit 1; }
fi
mkdir -p "$OUTCROP_HOME/logs"
LOG=$OUTCROP_HOME/logs/setup-$(date +%Y%m%d-%H%M%S).log
exec > >(tee -a "$LOG") 2>&1
echo "(a copy of everything below is in $LOG)"
sudo -n true 2> /dev/null || sudo -v || { echo "sudo is needed to install system packages and services"; exit 1; }
# keep sudo's permission alive through the long download, so it does not ask again hours later
( while sleep 60; do kill -0 $$ 2> /dev/null && sudo -n -v 2> /dev/null || exit; done ) > /dev/null 2>&1 &
KEEPALIVE=$!
trap 'kill $KEEPALIVE 2> /dev/null' EXIT
fail() { printf '\n%s✗ %s%s\nThe log is %s. Fix the cause and run ./setup.sh again: finished steps are skipped.\n' "$R" "$*" "$X" "$LOG"; exit 1; }

missing=""
for c in curl:curl git:git docker:docker.io; do command -v "${c%%:*}" > /dev/null 2>&1 || missing="$missing ${c#*:}"; done
if [ -n "$missing" ]; then
  step "Installing what setup needs first:$missing"
  # shellcheck disable=SC2086
  sudo apt-get update -y && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y $missing || fail "installing$missing failed"
fi
if [ -n "$NOW" ] && [ "$NOW" != "$PROFILE" ]; then
  step "Switching presets.json from profile $NOW to $PROFILE"
  python3 "$PROJECT/bin/outcrop" profile apply "$PROFILE" --yes || fail "applying profile $PROFILE failed"
fi
step "The engine, the models and their services (the long part)"
"$PROJECT/setup/install.sh" "$PROFILE" || fail "the engine install stopped"
step "The API gateway and the web console"
"$PROJECT/setup/install-console.sh" || fail "the console install stopped"
if [ -n "$WEB" ]; then
  step "Web search and page reading for the chat"
  "$PROJECT/setup/install-web.sh" || warn "web search did not install; the chat works without it (./setup/install-web.sh to retry)"
fi

step "Your console password"
if PYTHONPATH="$PROJECT/console" "$OUTCROP_HOME/venv/outcrop/bin/python" -c \
     'import sys; from outcrop.common import db; from outcrop.console import auth; sys.exit(0 if auth.get_user(db.connect()) else 1)'; then
  ok "a console password is set already (outcrop console passwd changes it)"
elif [ -n "$YES" ]; then
  ( umask 077; PYTHONUNBUFFERED=1 outcrop console passwd --generate > "$OUTCROP_HOME/state/console-password.txt" 2>&1 ) \
    && ok "a password was generated for you: it is in $OUTCROP_HOME/state/console-password.txt (readable by you only)" \
    || warn "no password set yet: run  outcrop console passwd  before signing in"
else
  echo "  The console asks for this password. Pick a long one; a few random words work well."
  # unbuffered: setup's output goes through a pipe, and "not accepted: why" must show before the next prompt
  PYTHONUNBUFFERED=1 outcrop console passwd || warn "no password set yet: run  outcrop console passwd  before signing in"
fi

step "Starting the server"
DEFAULT=$(pf 'print(P.compose(sys.argv[1])["profile"]["default_preset"])' "$PROFILE")
outcrop switch "$DEFAULT" || fail "the server did not start (outcrop logs shows why)"
TESTED=""
outcrop test && TESTED=1 || warn "the first answer check failed"

# what ./setup.sh update starts from: this version, and whether web search was left out
git -C "$PROJECT" rev-parse HEAD > "$OUTCROP_HOME/state/deployed" 2> /dev/null || true
if [ -n "$WEB" ]; then rm -f "$OUTCROP_HOME/state/no_web"; else touch "$OUTCROP_HOME/state/no_web"; fi

host=$(hostname).local
ip=$(ip -4 route get 1.1.1.1 2> /dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") {print $(i + 1); exit}}')
if [ -n "$TESTED" ]; then
  printf '\n%s%sOutcrop is running.%s\n' "$G" "$B" "$X"
else
  printf '\n%s%sOutcrop is installed, but its first answer check failed.%s See what happened with:  outcrop status  and  outcrop logs\n' "$Y" "$B" "$X"
  printf 'Then  outcrop test  checks again. Once it passes, everything below works.\n'
fi
cat <<EOF

  The console     https://$host   (or https://$ip)
                  First, on each device: open http://$host/ca (or http://$ip/ca) and install the certificate
                  it offers, so the browser trusts the console. Sign in with your password.
  Apps            OpenAI API  http://$host:8080/v1    Ollama API  http://$host:11434
                  Each app needs a token: outcrop token create NAME   (outcrop connect explains more)
  Day to day      outcrop             what runs now
                  outcrop list        the presets;  outcrop switch NAME  changes it
                  ./setup.sh update   after git pull, to apply an update
  Keep it on      Turn off automatic sleep (Settings, Power), and give this computer a fixed address in your
                  router (a "DHCP reservation"), so devices and apps keep finding it.
EOF
