#!/bin/bash
# startos-variant.sh NAME PACK [BUDGET_GIB|auto] [CONV_CACHE_MIB|default]  - one measured variant of a preset on a StartOS test
# server, run from another computer: what costs speed on StartOS (its memory line, the RAM copy of the experts, the
# conversation cache) and what the disk does (SATA against NVMe).
#
#   1. adds preset NAME to the service's presets.json (PACK, 262K context; the budget and conversation cache given)
#   2. switches to it through the service's own `outcrop switch` (timed)
#   3. runs bench/quickbench.py over the LAN (chat, code, story, 4K document; 3 runs each)
#   4. records the host's counters before, after the switch, and after the bench: StartOS's memory.high events for its
#      services, memory and IO pressure, and the bytes read from the disk holding the models
#
# Needs: ssh to the server as start9 with sudo (HOST=YOUR-SERVER.local, required), a token in $OUTCROP_TOKEN_FILE (default
# ~/.config/outcrop-test/token).  BASE=PRESET starts from that preset's settings (the GB10's prefill and draft
# options) instead of a bare one, CONTEXT sets the context (default 262144), and ARGS
# adds engine options ("--ple-io ram"), GPUS the cards to run on ("0,1": Strata's layer split across two).  PACK "shipped" measures the service's own preset NAME as it is (step 1 skipped).
# TAG (32g, say) goes in the file name.  Writes bench/results/startos-<host>-[<TAG>-]<NAME>-<date>.json.
set -euo pipefail
NAME=${1:?usage: startos-variant.sh NAME PACK [BUDGET_GIB|auto] [CONV_CACHE_MIB|default]}
PACK=${2:?pack: q2_0, iq3_xxs, iq3_s, or shipped}
BUDGET=${3:-auto}
CONV=${4:-default}
HOST=${HOST:?name the server: HOST=YOUR-SERVER.local}
TOKEN_FILE=${OUTCROP_TOKEN_FILE:-$HOME/.config/outcrop-test/token}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/results/startos-${HOST%%.*}-${TAG:+$TAG-}$NAME-$(date -u +%Y%m%d-%H%M).json
ATTACH="sudo -n start-cli package attach outcrop --name outcrop --user outcrop --"

counters() {  # the host's view, as JSON
  ssh -o BatchMode=yes "start9@$HOST" 'python3 - <<"PY"
import json, os, time
def kv(p):
    return {l.split()[0]: int(l.split()[1]) for l in open(p) if len(l.split()) == 2}
def psi(p):
    out = {}
    for l in open(p):
        f = l.split()
        out[f[0]] = {k: float(v) for k, v in (x.split("=") for x in f[1:])}
    return out
disk = os.path.basename(os.path.realpath("/sys/class/block/" + [d for d in os.listdir("/sys/class/block")
        if os.path.exists(f"/sys/class/block/{d}/device")][0]))
dev = {}
for l in open("/proc/diskstats"):
    f = l.split()
    dev[f[2]] = f
print(json.dumps({"t": time.time(), "disk": disk, "disk_read_bytes": int(dev[disk][5]) * 512,
                  "high_events": kv("/sys/fs/cgroup/services.slice/memory.events")["high"],
                  "slice_bytes": int(open("/sys/fs/cgroup/services.slice/memory.current").read()),
                  "mem_pressure": psi("/sys/fs/cgroup/services.slice/memory.pressure"),
                  "io_pressure": psi("/proc/pressure/io")}))
PY'
}

echo "== $NAME: $PACK, budget $BUDGET, conversation cache $CONV, on $HOST"
[ "$PACK" = shipped ] || ssh -o BatchMode=yes "start9@$HOST" "$ATTACH python3 - '$NAME' '$PACK' '$BUDGET' '$CONV' '${BASE:-}' '${CONTEXT:-262144}' '${ARGS:-}' '${GPUS:-}'" <<'PY'
import json, os, sys
name, pack, budget, conv, base, context, extra, gpus = sys.argv[1:9]
path = os.environ.get("OUTCROP_HOME", "/data") + "/presets.json"
c = json.load(open(path))
p = dict(c["presets"][base]) if base else {}
p.update({"description": f"measurement: {pack}, context {context}, budget {budget}, conversation cache {conv}"
                         + (f", from {base}" if base else ""), "pack": pack, "context": int(context)})
p.pop("tested", None)
if extra:
    p["args"] = p.get("args", []) + [extra]
if budget != "auto":
    p["resident_budget_gib"] = int(budget)
if conv != "default":
    p["args"] = p.get("args", []) + [f"--conversation-cache-mib {int(conv)}"]
if gpus:
    p["gpu"] = [int(x) for x in gpus.split(",")]
c["presets"][name] = p
tmp = path + ".tmp"
json.dump(c, open(tmp, "w"), indent=2)
os.replace(tmp, path)
print(f"preset {name}: {p}")
PY
before=$(counters)
t0=$(date +%s)
ssh -o BatchMode=yes "start9@$HOST" "$ATTACH outcrop switch $NAME" | tail -3
switch_s=$(( $(date +%s) - t0 ))
after_switch=$(counters)
bench=$(mktemp)
OUTCROP_API_KEY=$(cat "$TOKEN_FILE") python3 "$HERE/quickbench.py" --url "http://$HOST:8080" --json "$bench" | tail -4
after_bench=$(counters)
engine=$(ssh -o BatchMode=yes "start9@$HOST" "sudo -n start-cli package logs outcrop --limit 400" | grep "outcrop-engine@$NAME" \
         | grep -E "low-RAM mode|conversation cache|experts into RAM" | tail -3 | cut -d' ' -f3- || true)
python3 - "$OUT" "$NAME" "$PACK" "$BUDGET" "$CONV" "$switch_s" "$before" "$after_switch" "$after_bench" "$bench" "$engine" <<'PY'
import json, sys
out, name, pack, budget, conv, switch_s, b, s, a, bench, engine = sys.argv[1:12]
b, s, a = json.loads(b), json.loads(s), json.loads(a)
def delta(x, y):
    return {"seconds": round(y["t"] - x["t"]), "disk_read_gib": round((y["disk_read_bytes"] - x["disk_read_bytes"]) / 2**30, 2),
            "high_events": y["high_events"] - x["high_events"],
            "mem_full_stall_s": round((y["mem_pressure"]["full"]["total"] - x["mem_pressure"]["full"]["total"]) / 1e6, 1),
            "io_some_stall_s": round((y["io_pressure"]["some"]["total"] - x["io_pressure"]["some"]["total"]) / 1e6, 1),
            "slice_gib_after": round(y["slice_bytes"] / 2**30, 2)}
rec = {"variant": name, "pack": pack, "budget": budget, "conversation_cache_mib": conv, "switch_s": int(switch_s),
       "disk": b["disk"], "switch": delta(b, s), "bench": delta(s, a), "engine_log": engine.splitlines(),
       "quickbench": json.load(open(bench))}
json.dump(rec, open(out, "w"), indent=1)
print(f"switch {switch_s} s: {rec['switch']}")
print(f"bench: {rec['bench']}")
print(f"-> {out}")
PY
rm -f "$bench"
