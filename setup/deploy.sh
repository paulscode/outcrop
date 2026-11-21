#!/bin/bash
# deploy.sh [--force]  - on the server: bring this clone up to origin/main and apply what changed.
#
# - What changed is measured from the last deploy that finished ($OUTCROP_HOME/state/deployed), so a deploy that failed
#   halfway is completed by the next run, even when there is nothing new to pull.  --force applies everything.
# - When this script itself changes, the new copy runs (bash would otherwise go on reading the old one).
# - Local changes to tracked files: it refuses (commit them first). presets.json is not in the repo: it lives in
#   $OUTCROP_HOME and a deploy never touches it; when profiles/ changes, `outcrop profile diff NAME` shows what is new.
# - The gateway is restarted only when no request or switch is running (at most 15 minutes, then it says so); the
#   console only when no chat answer is being written (at most 5 minutes).  Strata is never restarted by a deploy.
set -euo pipefail
PROJECT=$(cd "$(dirname "$0")/.." && pwd)
OUTCROP_HOME=${OUTCROP_HOME:-$HOME/.outcrop}
STATE=$OUTCROP_HOME/state
MARK=$STATE/deployed
cd "$PROJECT"
say() { printf '\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!! %s\033[0m\n' "$*" >&2; }
FORCE=""
[ "${1:-}" = "--force" ] && FORCE=1

if [ -z "${DEPLOY_REEXEC:-}" ]; then
  # ------------------------------------------------------------------------------------------------------ pull
  git fetch --quiet origin
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "local changes in $PROJECT; commit or remove them first:" >&2
    git status --short --untracked-files=no >&2
    exit 1
  fi
  old=$(git rev-parse HEAD)
  git merge --ff-only --quiet origin/main
  new=$(git rev-parse HEAD)
  if [ "$old" != "$new" ] && git diff --name-only "$old" "$new" | grep -qx 'setup/deploy.sh'; then
    say "deploy.sh changed: running the new copy"
    DEPLOY_REEXEC=1 exec "$PROJECT/setup/deploy.sh" "$@"
  fi
fi

# ------------------------------------------------------------------------------------------------- what changed
new=$(git rev-parse HEAD)
base=""
[ -s "$MARK" ] && base=$(cat "$MARK")
if [ -n "$base" ] && ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  base=""
fi
if [ -z "$base" ] && [ -z "$FORCE" ]; then
  warn "no record of the last deploy ($MARK): applying everything"
  FORCE=1
fi
if [ "$base" = "$new" ] && [ -z "$FORCE" ]; then
  echo "already up to date ($(git log --oneline -1))"
  exit 0
fi
changed=""
if [ -n "$base" ] && [ "$base" != "$new" ]; then
  changed=$(git diff --name-only "$base" "$new")
  say "$(git log --oneline "$base..$new" | wc -l) new commit(s) since the last deploy: $(git log --oneline -1)"
fi
has() { [ -n "$FORCE" ] || echo "$changed" | grep -qE "$1"; }

# ------------------------------------------------------------------------------------------------- install, build
if has '^console/(pyproject.toml|uv.lock)$|^setup/install-console.sh$|^systemd/|^setup/polkit/|^setup/outcrop-boot$|^setup/logrotate'; then
  say "installing (environment, units, polkit)"
  SKIP_UI_BUILD=1 "$PROJECT/setup/install-console.sh"
  INSTALLED=1
fi
if has '^console/outcrop/fetcher/|^console/outcrop/__init__.py$|^console/(pyproject.toml|uv.lock)$|^setup/install-web.sh$|^setup/searxng/|^systemd/outcrop-(fetch|searxng)\.service$'; then
  say "installing the chat's web access (page fetcher, search)"
  if [ -f "$STATE/no_web" ]; then
    echo "   (skipped: web search was left out at setup, ./setup.sh --no-web; ./setup/install-web.sh adds it)"
  else
    "$PROJECT/setup/install-web.sh"
  fi
fi
if has '^web/' || [ -n "${INSTALLED:-}" ]; then
  say "building the web UI"
  "$PROJECT/setup/build-ui.sh"
fi

# ---------------------------------------------------------------------------------------------- migrate, restart
restart() {  # unit
  systemctl --no-ask-password restart "$1" || sudo -n systemctl restart "$1"
}
migrate() {
  PYTHONPATH="$PROJECT/console" "$OUTCROP_HOME/venv/outcrop/bin/python" -c "from outcrop.common import db; db.connect()"
}
pending=""
GW='^console/outcrop/(common|gateway)/|^console/outcrop/__init__.py$|^console/outcrop/console/(webtools|chatrun|chatdb)\.py$|^console/(pyproject.toml|uv.lock)$|^lib/|^bin/outcrop-gateway$|^systemd/outcrop-gateway.service$'
if has "$GW" && systemctl is-enabled -q outcrop-gateway.service 2>/dev/null; then
  # wait first, then migrate and restart at once: old code runs on a new schema for a moment at most
  say "restarting the gateway when idle"
  if outcrop gateway wait-idle --timeout 900; then
    migrate
    outcrop gateway restart
  else
    warn "the gateway was busy for 15 minutes and was not restarted: run ./setup/deploy.sh again later"
    pending=1
  fi
else
  migrate
fi
if has '^console/outcrop/|^web/|^console/(pyproject.toml|uv.lock)$|^lib/|^bin/outcrop-console$|^systemd/outcrop-console.service$' \
   && systemctl is-enabled -q outcrop-console.service 2>/dev/null; then
  say "restarting the console when no chat answer is being written"
  outcrop gateway wait-idle --console --timeout 300 \
    || warn "a chat answer was still running after 5 minutes: restarting anyway (it stops where it was)"
  restart outcrop-console.service
fi
if has '^bin/outcrop-ollama-bridge$|^lib/|^systemd/outcrop-ollama-bridge.service$'; then
  say "restarting the Ollama bridge"
  restart outcrop-ollama-bridge.service
fi
if has '^lib/strata_presets.py$|^bin/outcrop-serve$'; then
  echo "the engine launcher changed: \`outcrop restart\` applies it to the running preset"
fi
if has '^patches/|^setup/(install|build-engine|build-vision|fetch-sources|download-models|prep-packs)\.sh$|^setup/pins\.env$'; then
  echo "the engine's build or model steps changed: ./setup.sh applies them (finished steps are skipped)"
fi
if has '^profiles/'; then
  prof=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["profile"]["name"])' "$OUTCROP_HOME/presets.json" 2>/dev/null || echo NAME)
  echo "the hardware profiles changed: \`outcrop profile diff $prof\` shows what is new, \`outcrop profile apply $prof\` takes it"
fi
if [ -n "$pending" ]; then
  warn "not finished: the next ./setup/deploy.sh completes it"
  exit 1
fi
echo "$new" > "$MARK"
say "deployed $(git log --oneline -1)"
