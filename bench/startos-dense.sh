#!/bin/bash
# startos-dense.sh server NAME MODEL [llama-server options ...]   a dense model through llama.cpp on a StartOS test
# startos-dense.sh bench  NAME MODEL [llama-bench options ...]    server, for comparison with Outcrop's own engine
#
# Runs llama.cpp inside Outcrop's container (its CUDA runtime and cuBLAS are there), with Outcrop's engine stopped so
# llama.cpp has the cards to itself; `outcrop start` brings the boot preset back afterwards (DONE=1, or by hand).
#   server: starts llama-server on 127.0.0.1:18090 in the container, waits until it answers, records each card's memory
#           and the server's own memory lines, runs bench/quickbench.py (chat, code, story, 4K document, 3 runs each;
#           CASES and REPEAT change that), bench/concurrent.py with STREAMS="1,2,4" (for -np 4), and bench/qualgate.py
#           against it, then stops it
#   bench:  runs llama-bench with the options given (-p / -n / -d / -sm ...), JSON out
# MODEL is a file in DENSE_DIR (default /mnt/models/dense, on the models volume), and llama.cpp's binaries are in
# $DENSE_DIR/bin (built for sm_52 elsewhere: they need nothing but the container's CUDA libraries).
# ENVS adds environment settings ("NCCL_P2P_DISABLE=1 GGML_CUDA_...=..."), space-separated.
# Needs: ssh to the server as start9 with sudo (HOST=YOUR-SERVER.local, required).
# Writes bench/results/startos-<host>-dense-<NAME>-<date>.json.
set -euo pipefail
MODE=${1:?usage: startos-dense.sh server|bench NAME MODEL [options]}
NAME=${2:?name}
MODEL=${3:?model file}
shift 3
HOST=${HOST:?name the server: HOST=YOUR-SERVER.local}
D=${DENSE_DIR:-/mnt/models/dense}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/results/startos-${HOST%%.*}-dense-$NAME-$(date -u +%Y%m%d-%H%M).json
A="sudo -n start-cli package attach outcrop --name outcrop --user outcrop --"
LIB="LD_LIBRARY_PATH=$D/bin:"'$OUTCROP_CUDA_LIB'" ${ENVS:-}"    # the container expands $OUTCROP_CUDA_LIB
OPTS=$(printf ' %q' "$@")
on() { ssh -o BatchMode=yes "start9@$HOST" "$@"; }

on "$A outcrop stop" | tail -1
if [ "$MODE" = bench ]; then
  on "$A sh -c 'cd $D && env $LIB timeout 3600 $D/bin/llama-bench -m $D/$MODEL $OPTS -o json 2>$D/bench-$NAME.err'" > "$OUT.tmp" \
    || { echo "llama-bench failed:"; on "$A tail -15 $D/bench-$NAME.err"; rm -f "$OUT.tmp"; exit 1; }
  python3 - "$OUT.tmp" "$OUT" "$NAME" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))
json.dump({"name": sys.argv[3], "llama_bench": rows}, open(sys.argv[2], "w"), indent=1)
for r in rows:
    kind = f"pp{r['n_prompt']}" if r.get("n_prompt") else f"tg{r['n_gen']}"
    print(f"  {kind:7s} depth {r.get('n_depth', 0):6d}  sm {r.get('split_mode', '?'):6s}  ngl {r.get('n_gpu_layers')}  "
          f"fa {int(bool(r.get('flash_attn')))}  kv {r.get('type_k', '?')}  {r['avg_ts']:.1f} +- {r['stddev_ts']:.1f} tok/s")
PY
  rm -f "$OUT.tmp"
  [ -n "${DONE:-}" ] && on "$A outcrop start" | tail -1
  echo "-> $OUT"
  exit 0
fi

on "$A sh -c 'cd $D && rm -f server.pid && (nohup env $LIB $D/bin/llama-server -m $D/$MODEL --host 127.0.0.1 --port 18090 $OPTS > $D/server-$NAME.log 2>&1 & echo \$! > $D/server.pid)'"
stop_server() { on "$A sh -c 'kill \$(cat $D/server.pid) 2>/dev/null; sleep 3; kill -9 \$(cat $D/server.pid) 2>/dev/null; true'" || true; }
trap stop_server EXIT
t0=$(date +%s)
until on "$A python3 -c 'import urllib.request, sys; sys.exit(0 if urllib.request.urlopen(\"http://127.0.0.1:18090/health\", timeout=5).status == 200 else 1)'" 2>/dev/null; do
  if ! on "$A sh -c 'kill -0 \$(cat $D/server.pid)'" 2>/dev/null; then
    echo "llama-server stopped while loading:"; on "$A tail -20 $D/server-$NAME.log"; exit 1
  fi
  [ $(( $(date +%s) - t0 )) -gt 1200 ] && { echo "not ready after 20 min"; on "$A tail -20 $D/server-$NAME.log"; exit 1; }
  sleep 5
done
load_s=$(( $(date +%s) - t0 ))
vram=$(on "nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader,nounits" | tr '\n' ';')
mem=$(on "$A sh -c 'grep -E \"model buffer size|KV buffer size|compute buffer size|n_ctx|offloaded|llama_kv_cache|split_mode|draft\" $D/server-$NAME.log | head -40'" || true)
on "$A python3 - --url http://127.0.0.1:18090 --cases ${CASES:-chat,code,story,doc4k} --repeat ${REPEAT:-3} --json /tmp/dense-qb.json" \
  < "$HERE/quickbench.py" | grep -vE '^\s*$' | tail -8
qb=$(on "$A cat /tmp/dense-qb.json")
if [ -n "${STREAMS:-}" ]; then          # several conversations at once (llama-server -np N): bench/concurrent.py
  on "$A python3 - --url http://127.0.0.1:18090 --streams $STREAMS --rounds 3 --json /tmp/dense-cc.json" \
    < "$HERE/concurrent.py" | grep stream
fi
qual=$(on "$A python3 - --url http://127.0.0.1:18090" < "$HERE/qualgate.py" 2>&1 | tail -1 || true)
echo "$qual"
python3 - "$OUT" "$NAME" "$MODEL" "$OPTS" "$load_s" "$vram" "$mem" "$qb" "$qual" <<'PY'
import json, sys
out, name, model, opts, load_s, vram, mem, qb, qual = sys.argv[1:10]
rec = {"name": name, "model": model, "options": opts.strip(), "load_s": int(load_s),
       "vram_mib": [dict(zip(("card", "used", "total"), map(int, x.split(", ")))) for x in vram.split(";") if x.strip()],
       "server_log": mem.splitlines(), "quickbench": json.loads(qb), "qualgate": qual}
json.dump(rec, open(out, "w"), indent=1)
print(f"loaded in {load_s} s; VRAM used per card (MiB): {[v['used'] for v in rec['vram_mib']]}")
print(f"-> {out}")
PY
stop_server
trap - EXIT
[ -n "${DONE:-}" ] && on "$A outcrop start" | tail -1
exit 0
