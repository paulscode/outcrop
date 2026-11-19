#!/bin/bash
# validate.sh [PRESET ...]  - switch the real service to each preset and check it: answers (qualgate), every API (apitest),
# and speed (quickbench: greedy, thinking off, median of 3).  Ends on the boot default.  Output: results/validate-<date>.log
#   Default presets: speed balanced quality.  Run it with nobody on the remote desktop for clean numbers.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LOG=$HERE/results/validate-$(date +%Y%m%d-%H%M).log
PRESETS=${*:-speed balanced quality}
HOSTIP=$(hostname -I | awk '{print $1}')
{
  echo "validate $(date -Is) presets: $PRESETS  host $HOSTIP"
  # columns: gpu pid type sm mem ... command; the daemon idles at "-" when nobody is connected
  nvidia-smi pmon -c 3 | awk '/remote-de/ && $4 != "-" && $4 + 0 > 0 {f = 1} END {exit !f}' &&
    echo "WARNING: a remote desktop session is using the GPU; numbers will be low"
  for p in $PRESETS; do
    echo "=================== $p"
    t0=$(date +%s)
    outcrop switch "$p" | tr '\r' '\n' | grep -v '^loading' | tail -2
    echo "switch took $(( $(date +%s) - t0 )) s"
    grep -oE "expert cache [0-9]+ slots, [0-9.]+ GiB|[0-9]+ MiB of VRAM free with everything loaded" ~/.outcrop/logs/engine-$p.log | tail -2
    python3 "$HERE/qualgate.py" --url http://127.0.0.1:8080
    python3 "$HERE/apitest.py" --host "$HOSTIP" --fast
    python3 "$HERE/quickbench.py" --url http://127.0.0.1:8080 --repeat 3 --cases chat,code,story,doc4k --json "$HERE/results/validate-$p.json"
  done
  d=$(outcrop default)
  [ -n "$d" ] && [ "$d" != none ] && outcrop switch "$d" | tail -1
  echo "VALIDATE_DONE"
} 2>&1 | tee "$LOG"
