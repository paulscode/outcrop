#!/bin/bash
# prepare.sh  - (StartOS) run as root before the supervisor on every start: the data volume's layout and ownership,
# presets.json from this machine's profile (the first time), the console's state, and the StartOS settings: the gateway
# and the console behind StartOS's proxy, and the names this server answers to.
#   OUTCROP_HOSTS  the server's addresses from StartOS (comma-separated: its .local name, LAN addresses, onion ...)
set -euo pipefail
P=$(cd "$(dirname "$0")/.." && pwd)
: "${OUTCROP_HOME:?}"
U=outcrop
mkdir -p "$OUTCROP_HOME"/{state,cfg,logs/units,models,data/packs,data/mtp}
# the volumes are mounted root-owned: hand over whatever is not the service user's yet (seconds, even with the models)
# (searxng/ stays root:977: SearXNG's settings, below)
find "$OUTCROP_HOME" -xdev -path "$OUTCROP_HOME/searxng" -prune -o \( ! -user "$U" -o ! -group "$U" \) -exec chown -h "$U:$U" {} +
find "$OUTCROP_HOME/models" "$OUTCROP_HOME/data" -mindepth 0 -maxdepth 0 \( ! -user "$U" \) -exec chown "$U:$U" {} +
chmod 700 "$OUTCROP_HOME/state" "$OUTCROP_HOME/cfg"
# the data volume is the service user's alone: the page fetcher's user (outcrop-fetch) and SearXNG's (977) cannot read it
chmod 750 "$OUTCROP_HOME"
as() { setpriv --reuid="$U" --regid="$U" --clear-groups -- "$@"; }

if [ ! -s "$OUTCROP_HOME/presets.json" ]; then
  # lib/profiles.py, as setup.sh: the suggested profile's name, or the reasons none fits
  pick=$(as env PYTHONPATH="$P/lib" python3 -c 'import profiles as P
n, kind, why = P.suggest(P.facts())
print(n or "") if n else print("\n".join(["", *why[:6]]))')
  name=$(printf '%s\n' "$pick" | head -n1)
  if [ -n "$name" ]; then
    as python3 "$P/bin/outcrop" profile apply "$name" --yes > /dev/null
    echo "presets.json from profile $name"
  else
    echo "no hardware profile fits this server, so the engine will not start:" >&2
    printf '%s\n' "$pick" | tail -n +2 | sed 's/^/  - /' >&2
  fi
fi

if [ -s "$OUTCROP_HOME/presets.json" ]; then
  # behind StartOS: the API's raw ports 8080 and 11434 (LAN clients' real addresses), 8443 and the console's 8800 for
  # StartOS's proxy, which is the container's default gateway and the only address whose X-Forwarded-For counts
  proxy=$(ip -4 route show default | awk '{print $3; exit}')
  as python3 - "$OUTCROP_HOME/presets.json" "$proxy" "${OUTCROP_HOSTS:-}" <<'PY'
import json, os, sys
path, proxy, hosts = sys.argv[1], sys.argv[2], [h for h in sys.argv[3].split(",") if h]
c = json.load(open(path))
g = c.setdefault("gateway", {})
g.update({"enabled": True, "listen": "::", "port": 8080, "ollama_port": 11434, "https_port": 0, "proxied_port": 8443,
          "trusted_proxies": [proxy] if proxy else [], "hosts": hosts})
c.setdefault("console", {}).update({"proxied_port": 8800, "http_port": 0})
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(c, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY
  # the boot default: the profile's, until the user chooses another
  if [ ! -s "$OUTCROP_HOME/state/default_preset" ]; then
    as python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["profile"]["default_preset"])' \
      "$OUTCROP_HOME/presets.json" > "$OUTCROP_HOME/state/default_preset" || rm -f "$OUTCROP_HOME/state/default_preset"
  fi
fi

# the console's state: the database, the token pepper, Strata's internal key and the local tools' token (as
# setup/install-console.sh's step 2)
as env PYTHONPATH="$P/console" "$OUTCROP_VENV/bin/python" - <<'PY'
from outcrop.common import config, db, tokens
pepper = tokens.load_pepper()
config.upstream_key(create=True)
tokens.ensure_local_token(db.connect(), pepper)
PY
chmod 600 "$OUTCROP_HOME"/state/outcrop.db* "$OUTCROP_HOME/state/pepper" "$OUTCROP_HOME/state/upstream_key" \
  "$OUTCROP_HOME/state/local_token" 2>/dev/null || true
mkdir -p /run/outcrop && chown "$U:$U" /run/outcrop

# SearXNG's settings (setup/searxng/settings.yml with a secret made here, as setup/install-web.sh does): kept while the
# template is unchanged, readable by SearXNG's user (977) and root only
install -d -o root -g 977 -m 0750 "$OUTCROP_HOME/searxng"
cfg=$OUTCROP_HOME/searxng/settings.yml
if [ ! -s "$cfg" ] || ! grep -q '^# SearXNG for the console' "$cfg" \
   || ! cmp -s <(sed '/secret_key/d' "$P/setup/searxng/settings.yml") <(sed '/secret_key/d' "$cfg"); then
  secret=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')
  sed "s/@SECRET@/$secret/" "$P/setup/searxng/settings.yml" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"
fi
chown root:977 "$cfg" && chmod 0640 "$cfg"
