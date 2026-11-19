#!/bin/bash
# install-service.sh [DEFAULT_PRESET]  - install the systemd units and the outcrop command, and set the boot default.
#   outcrop-engine@.service      one preset at a time (outcrop switch / default)
#   outcrop-ollama-bridge.service  Ollama's API on port 11434, answered by the Strata server
set -euo pipefail
PROJECT=$(cd "$(dirname "$0")/.." && pwd)
OUTCROP_HOME=${OUTCROP_HOME:-$HOME/.outcrop}
U=$(id -un)
for unit in outcrop-engine@.service outcrop-ollama-bridge.service; do
  [ -f "$PROJECT/systemd/$unit" ] || continue
  sed -e "s#@USER@#$U#g" -e "s#@PROJECT@#$PROJECT#g" -e "s#@OUTCROP_HOME@#$OUTCROP_HOME#g" -e "s#@HOME@#$HOME#g" "$PROJECT/systemd/$unit" | sudo tee /etc/systemd/system/$unit > /dev/null
done
sudo ln -sfn "$PROJECT/bin/outcrop" /usr/local/bin/outcrop
sudo ln -sfn "$PROJECT/bin/outcrop" /usr/local/bin/llmctl      # the old name, kept as an alias
sudo systemctl daemon-reload
[ -f /etc/systemd/system/outcrop-ollama-bridge.service ] && sudo systemctl enable --now outcrop-ollama-bridge.service
if [ -n "${1:-}" ]; then "$PROJECT/bin/outcrop" default "$1"; fi
echo "installed: outcrop, outcrop-engine@.service$( [ -f /etc/systemd/system/outcrop-ollama-bridge.service ] && echo ', outcrop-ollama-bridge.service')"
