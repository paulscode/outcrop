#!/bin/bash
# install-console.sh  - install the API gateway and the web console (Outcrop) on this machine.  Safe to run again.
#
#   1. the Python environment ($OUTCROP_HOME/venv/outcrop, from console/uv.lock; installs uv if missing)
#   2. the state directory: the database, the token pepper, the internal key, the local-tools token
#   3. the units (outcrop-gateway, outcrop-console, outcrop-boot, the bridge) and the polkit rule for the LLM units
#   4. the boot default: from an enabled outcrop-engine@ instance to $OUTCROP_HOME/state/default_preset
#   5. the console's TLS (a private CA and the server certificate) and the web UI, when those parts are present
#
# The gateway runs when $OUTCROP_HOME/presets.json has "gateway": {"enabled": true}, as every profile does.
set -euo pipefail
PROJECT=$(cd "$(dirname "$0")/.." && pwd)
OUTCROP_HOME=${OUTCROP_HOME:-$HOME/.outcrop}
U=$(id -un)
VENV=$OUTCROP_HOME/venv/outcrop
STATE=$OUTCROP_HOME/state
say() { printf '\033[1m== %s\033[0m\n' "$*"; }

# 1. Python environment
if ! command -v uv >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/uv" ]; then
  say "installing uv (Astral's Python package manager) to ~/.local/bin"
  curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh
fi
UV=$(command -v uv || echo "$HOME/.local/bin/uv")
say "Python environment: $VENV"
mkdir -p "$OUTCROP_HOME/venv"
UV_PROJECT_ENVIRONMENT="$VENV" "$UV" sync --project "$PROJECT/console" --frozen --no-dev --quiet
"$VENV/bin/python" -c "import uvicorn, httpx, fastapi, argon2, zxcvbn, cryptography, pynvml, psutil, zstandard"

# 2. state
say "state: $STATE"
mkdir -p "$STATE" "$OUTCROP_HOME/cfg" "$OUTCROP_HOME/logs"
chmod 700 "$STATE" "$OUTCROP_HOME/cfg"
chmod 600 "$OUTCROP_HOME"/cfg/*.json 2>/dev/null || true        # rendered engine configs hold Strata's internal key
PYTHONPATH="$PROJECT/console" "$VENV/bin/python" - <<'PY'
from outcrop.common import config, db, tokens
pepper = tokens.load_pepper()
config.upstream_key(create=True)
con = db.connect()
tokens.ensure_local_token(con, pepper)
print(f"   database schema v{con.execute('PRAGMA user_version').fetchone()[0]}, "
      f"{con.execute('SELECT count(*) FROM tokens WHERE revoked_at IS NULL').fetchone()[0]} active tokens")
PY
chmod 600 "$STATE"/outcrop.db* "$STATE/pepper" "$STATE/upstream_key" "$STATE/local_token" 2>/dev/null || true

# 3. units and polkit
say "units and the polkit rule"
render() { sed -e "s#@USER@#$U#g" -e "s#@PROJECT@#$PROJECT#g" -e "s#@OUTCROP_HOME@#$OUTCROP_HOME#g" -e "s#@HOME@#$HOME#g" "$1"; }
# (not %h in the units: in a system unit that is root's home, not the service user's)
for unit in outcrop-engine@.service outcrop-ollama-bridge.service outcrop-gateway.service outcrop-boot.service outcrop-console.service \
            outcrop-tls-renew.service outcrop-tls-renew.timer; do
  [ -f "$PROJECT/systemd/$unit" ] || continue
  render "$PROJECT/systemd/$unit" | sudo tee "/etc/systemd/system/$unit" > /dev/null
done
sudo install -D -o root -g root -m 0755 "$PROJECT/setup/outcrop-boot" /usr/local/libexec/outcrop-boot
render "$PROJECT/setup/polkit/50-outcrop.rules" | sudo tee /etc/polkit-1/rules.d/50-outcrop.rules > /dev/null
sudo chmod 644 /etc/polkit-1/rules.d/50-outcrop.rules
sudo ln -sfn "$PROJECT/bin/outcrop" /usr/local/bin/outcrop
sudo ln -sfn "$PROJECT/bin/outcrop" /usr/local/bin/llmctl      # the old name, kept as an alias
sudo systemctl daemon-reload

# 4. the boot default moves to a state file read by outcrop-boot.service
if [ ! -s "$STATE/default_preset" ]; then
  d=""
  for f in /etc/systemd/system/multi-user.target.wants/outcrop-engine@*.service; do
    [ -e "$f" ] || continue
    d=$(basename "$f" .service); d=${d#outcrop-engine@}
  done
  if [ -n "$d" ]; then
    echo "$d" > "$STATE/default_preset"
    echo "   boot default: $d (was the enabled outcrop-engine@$d)"
  fi
fi
for f in /etc/systemd/system/multi-user.target.wants/outcrop-engine@*.service; do
  [ -e "$f" ] || continue
  sudo systemctl disable -q "$(basename "$f")"
done
sudo systemctl enable -q outcrop-boot.service

# 5. the gateway: enabled for boot only when presets.json turns it on
if "$VENV/bin/python" -c 'import json, sys; sys.exit(0 if json.load(open(sys.argv[1])).get("gateway", {}).get("enabled") else 1)' \
     "$OUTCROP_HOME/presets.json"; then
  sudo systemctl enable -q --now outcrop-gateway.service       # --now: started too (nothing happens if it runs already)
  echo "   outcrop-gateway enabled and running (presets.json gateway.enabled)"
else
  sudo systemctl disable -q outcrop-gateway.service 2>/dev/null || true
  echo "   outcrop-gateway installed, not enabled for boot (presets.json gateway.enabled is false)"
fi
sudo systemctl enable -q outcrop-ollama-bridge.service

# logs in $OUTCROP_HOME/logs (the engine's own) rotate weekly, at most 50 MB each
render "$PROJECT/setup/logrotate/outcrop" | sudo tee /etc/logrotate.d/outcrop > /dev/null
sudo chmod 644 /etc/logrotate.d/outcrop

# 6. the console (TLS and the UI), when present
if [ -f "$PROJECT/systemd/outcrop-console.service" ] && [ -d "$PROJECT/console/outcrop/console" ] && \
   [ -f "$PROJECT/console/outcrop/console/__main__.py" ]; then
  say "console: TLS"
  PYTHONPATH="$PROJECT/console" "$VENV/bin/python" -m outcrop.console.admin tls ensure
  if [ -f "$PROJECT/web/package.json" ]; then
    if [ -z "${SKIP_UI_BUILD:-}" ]; then                    # deploy.sh builds it itself
      say "console: building the web UI (in a throwaway node container)"
      "$PROJECT/setup/build-ui.sh"
    fi
  fi
  sudo systemctl enable -q --now outcrop-console.service
  [ -f /etc/systemd/system/outcrop-tls-renew.timer ] && sudo systemctl enable -q --now outcrop-tls-renew.timer
fi
say "done"
echo "   outcrop token create NAME   makes a token for an app;   outcrop auth   shows the access mode"
