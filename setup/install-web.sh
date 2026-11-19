#!/bin/bash
# install-web.sh  - the chat's web access (docs/SECURITY.md, "Web access for the chat"): the page fetcher (outcrop-fetch) and the search
# (SearXNG in a container).  Safe to run again; deploy.sh runs it when these parts change.
#
#   1. the outcrop-fetch system user (no login, no home), and the console's user in its group (for the socket)
#   2. /opt/outcrop-fetch: root-owned code and its own Python environment (only the "fetch" dependency group, with hashes)
#   3. SearXNG: the pinned image, /etc/outcrop-searxng/settings.yml with a secret made here
#   4. the units, started; then a check that the fetcher is isolated and search answers
set -euo pipefail
PROJECT=$(cd "$(dirname "$0")/.." && pwd)
U=$(id -un)
UV=$(command -v uv || echo "$HOME/.local/bin/uv")
IMAGE="searxng/searxng@sha256:aecad882e86eeb022b76351c8dce4eb48d0cbb16a5f1691f77ea32c96d317502"   # 2026.10.23-629368e40
say() { printf '\033[1m== %s\033[0m\n' "$*"; }

say "the outcrop-fetch user"
if ! id outcrop-fetch >/dev/null 2>&1; then
  sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin outcrop-fetch
fi
if ! id -nG "$U" | tr ' ' '\n' | grep -qx outcrop-fetch; then
  sudo usermod -aG outcrop-fetch "$U"
fi

say "/opt/outcrop-fetch (code and its own Python environment)"
tmp=$(mktemp -d)
trap 'sudo rm -rf "$tmp"' EXIT                 # the download cache below is made by root
"$UV" export --project "$PROJECT/console" --frozen --only-group fetch --no-emit-project --quiet -o "$tmp/req.txt"
sudo install -d -o root -g root -m 0755 /opt/outcrop-fetch /opt/outcrop-fetch/app/outcrop/fetcher
if [ ! -x /opt/outcrop-fetch/venv/bin/python ]; then
  sudo "$UV" venv --quiet --python /usr/bin/python3 /opt/outcrop-fetch/venv
fi
sudo env UV_CACHE_DIR="$tmp/cache" "$UV" pip install --quiet --python /opt/outcrop-fetch/venv/bin/python --require-hashes -r "$tmp/req.txt"
sudo install -o root -g root -m 0644 "$PROJECT/console/outcrop/__init__.py" /opt/outcrop-fetch/app/outcrop/__init__.py
for f in "$PROJECT"/console/outcrop/fetcher/*.py; do
  sudo install -o root -g root -m 0644 "$f" /opt/outcrop-fetch/app/outcrop/fetcher/
done
# the code's directory on the path (the unit runs python -I, which leaves the working directory off it)
site=$(/opt/outcrop-fetch/venv/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')
echo /opt/outcrop-fetch/app | sudo tee "$site/outcrop-fetch-app.pth" >/dev/null
sudo chmod -R go-w /opt/outcrop-fetch

say "SearXNG"
sudo docker image inspect "$IMAGE" >/dev/null 2>&1 || sudo docker pull -q "$IMAGE"
# the container's user is 977: reserve that group on the host, so no other group can get it and read the secret
if ! getent group 977 >/dev/null; then
  sudo groupadd -r -g 977 outcrop-searxng
elif [ "$(getent group 977 | cut -d: -f1)" != "outcrop-searxng" ]; then
  printf '\033[33m!! group 977 is %s on this host: its members can read SearXNG settings\033[0m\n' "$(getent group 977 | cut -d: -f1)" >&2
fi
sudo install -d -o root -g root -m 0755 /etc/outcrop-searxng
if ! sudo test -s /etc/outcrop-searxng/settings.yml || ! sudo grep -q '^# SearXNG for the console' /etc/outcrop-searxng/settings.yml \
   || ! sudo cmp -s <(sed '/secret_key/d' "$PROJECT/setup/searxng/settings.yml") <(sudo sed '/secret_key/d' /etc/outcrop-searxng/settings.yml); then
  secret=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')
  sed "s/@SECRET@/$secret/" "$PROJECT/setup/searxng/settings.yml" | sudo tee /etc/outcrop-searxng/settings.yml >/dev/null
fi
sudo chown root:977 /etc/outcrop-searxng/settings.yml          # 977: the searxng user inside the container
sudo chmod 0640 /etc/outcrop-searxng/settings.yml

sudo install -D -o root -g root -m 0755 "$PROJECT/setup/searxng/net.sh" /usr/local/libexec/outcrop-searxng-net

say "units"
LAN_GATEWAY=$(ip -4 route show default | awk '{print $3; exit}' || true)
render() { sed -e "s#@USER@#$U#g" -e "s#@PROJECT@#$PROJECT#g" -e "s#@SEARXNG_IMAGE@#$IMAGE#g" -e "s#@LAN_GATEWAY@#$LAN_GATEWAY#g" "$1"; }
for unit in outcrop-fetch.service outcrop-searxng.service; do
  render "$PROJECT/systemd/$unit" | { if [ -z "$LAN_GATEWAY" ]; then grep -v '^Environment=OUTCROP_FETCH_PROBE='; else cat; fi; } \
    | sudo tee "/etc/systemd/system/$unit" > /dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --quiet outcrop-fetch.service outcrop-searxng.service
sudo systemctl restart outcrop-fetch.service outcrop-searxng.service
# the console and the gateway reach the fetcher's socket through the outcrop-fetch group: a service started before the
# user joined it does not have it yet, so restart it (the gateway when idle)
gid=$(getent group outcrop-fetch | cut -d: -f3)
has_group() {  # unit
  local pid
  pid=$(systemctl show -p MainPID --value "$1" 2>/dev/null || echo 0)
  [ "${pid:-0}" = 0 ] && return 0                           # not running: it gets the group when it starts
  grep -qE "^Groups:.*\b$gid\b" "/proc/$pid/status" 2>/dev/null
}
if ! has_group outcrop-console.service; then
  say "restarting the console when no chat answer runs (it joins the outcrop-fetch group)"
  outcrop gateway wait-idle --console --timeout 300 || true
  sudo systemctl restart outcrop-console.service
fi
if ! has_group outcrop-gateway.service; then
  say "restarting the gateway when idle (it joins the outcrop-fetch group)"
  outcrop gateway restart --when-idle --timeout 900 || echo "   the gateway was busy: restart it later (outcrop gateway restart --when-idle)" >&2
fi

# checks: a problem is reported loudly but does not stop a deploy (the fetcher refuses every page when it is not
# isolated, so that failure is safe)
say "checks"
for _ in $(seq 30); do
  [ -S /run/outcrop-fetch/fetch.sock ] && break
  sleep 1
done
if ! sudo curl -s -m 10 --unix-socket /run/outcrop-fetch/fetch.sock http://fetch/health | python3 -c '
import json, sys
h = json.load(sys.stdin)
print("   fetcher isolated from the network:", h["isolated"], "(" + ", ".join(c["target"] + " " + c["why"] for c in h["checked"]) + ")")
sys.exit(0 if h["isolated"] else 1)'; then
  printf '\033[33m!! the page fetcher is not answering or not isolated: the chat cannot open pages (journalctl -u outcrop-fetch)\033[0m\n' >&2
fi
for _ in $(seq 40); do
  curl -sf -m 5 -o /dev/null http://127.0.0.1:8888/healthz && break
  sleep 1
done
n=$(curl -s -m 20 "http://127.0.0.1:8888/search?q=ubuntu&format=json" \
    | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["results"]))' 2>/dev/null || echo "no")
if [ "$n" = "no" ] || [ "$n" = 0 ]; then
  printf '\033[33m!! search gave no results for a test query (SearXNG: docker logs outcrop-searxng); the chat answers without the web\033[0m\n' >&2
else
  echo "   search answers: $n results for a test query"
fi
