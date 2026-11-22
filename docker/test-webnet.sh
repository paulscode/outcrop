#!/bin/bash
# test-webnet.sh  - check the chat's web isolation (docker/webnet.sh) from inside it.  Run as root in the service's container
# once outcrop-webnet, outcrop-fetch and outcrop-searxng run:
#   sudo start-cli package attach outcrop --name outcrop --user root -- /opt/outcrop/docker/test-webnet.sh
# Every private destination must be unreachable from the outcrop-web namespace, the public internet reachable, SearXNG
# answering, and the page fetcher must report itself isolated.  Exit 0 only when all of that holds.
set -uo pipefail
fail=0
# enter the namespace the page fetcher actually runs in (through its process: a `start-cli package attach` session does not
# see the supervisor's /run/netns mount)
fpid=$(pgrep -f "outcrop.fetcher" | head -1)
[ -n "$fpid" ] || { echo "FAIL the page fetcher is not running"; exit 1; }
inns() { nsenter --net="/proc/$fpid/ns/net" "$@"; }
ok() { printf 'PASS %s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; fail=1; }

# a TCP connection from inside the namespace: "open" (it connected), "closed" (refused), or "blocked" (no answer)
probe() {  # host port
  inns python3 -c '
import socket, sys
h, p = sys.argv[1], int(sys.argv[2])
s = socket.socket(socket.AF_INET6 if ":" in h else socket.AF_INET)
s.settimeout(2.5)
try:
    s.connect((h, p)); print("open")
except TimeoutError: print("blocked")
except ConnectionRefusedError: print("closed")
except OSError as e: print("blocked" if e.errno in (101, 113, 97, 99) else "error %s" % e.errno)
' "$1" "$2" 2>/dev/null
}

must_block() {  # what host port
  r=$(probe "$2" "$3")
  [ "$r" = blocked ] && ok "$1 ($2:$3) is unreachable" || bad "$1 ($2:$3): $r"
}

gw=$(ip -4 route show default | awk '{print $3; exit}')
me=$(ip -4 -o addr show scope global | awk '$2 != "owh" {sub("/.*", "", $4); print $4; exit}')
must_block "loopback, SSH" 127.0.0.1 22
must_block "loopback, a web port" 127.0.0.1 8080
must_block "IPv6 loopback" ::1 443
must_block "the container's own gateway port, through the veth" 10.255.53.1 8080
must_block "the container's console, through the veth" 10.255.53.1 8800
must_block "the container's own address, the gateway port" "$me" 8080
must_block "the container's own address, Strata" "$me" 18080
must_block "the host (the container's gateway), HTTP" "$gw" 80
must_block "the host (the container's gateway), SSH" "$gw" 22
must_block "a home router" 192.168.1.1 80
must_block "a home router" 192.168.4.1 80
must_block "10/8" 10.0.0.1 80
must_block "172.16/12" 172.17.0.1 80
must_block "CGNAT" 100.64.0.1 80
must_block "cloud metadata" 169.254.169.254 80
must_block "IPv6 ULA" fd00::1 80
must_block "IPv6 public" 2606:4700:4700::1111 443

r=$(probe 1.1.1.1 443); [ "$r" = open ] && ok "the public internet (1.1.1.1:443) is reachable" || bad "the public internet: $r"
if inns python3 -c 'import socket; socket.getaddrinfo("example.com", 443)' 2>/dev/null; then
  ok "DNS answers inside the namespace"
else
  bad "DNS does not answer inside the namespace"
fi

if curl -s -m 10 http://10.255.53.2:8080/healthz | grep -q OK; then ok "SearXNG answers"; else bad "SearXNG does not answer"; fi
n=$(curl -s -m 30 "http://10.255.53.2:8080/search?q=ubuntu&format=json" | python3 -c 'import json, sys; print(len(json.load(sys.stdin)["results"]))' 2>/dev/null || echo 0)
[ "${n:-0}" -gt 0 ] && ok "SearXNG finds results ($n)" || bad "SearXNG found nothing for a test query"
h=$(curl -s -m 30 --unix-socket /run/outcrop-fetch/fetch.sock http://fetch/health)
if python3 -c 'import json, sys; sys.exit(0 if json.loads(sys.argv[1]).get("isolated") else 1)' "$h" 2>/dev/null; then
  ok "the page fetcher reports itself isolated: $(python3 -c 'import json, sys; print(", ".join(c["target"] + " " + c["why"] for c in json.loads(sys.argv[1])["checked"]))' "$h")"
else
  bad "the page fetcher is not isolated: $h"
fi
exit $fail
