#!/bin/bash
# fetch.sh  - (StartOS, the outcrop-fetch unit, as root) the chat's page fetcher, in the outcrop-web network namespace
# (docker/webnet.sh) as its own user, without privileges: what outcrop-fetch.service runs on Ubuntu, minus systemd's
# sandbox, plus the namespace.  It checks its own isolation at start and refuses every page while that check fails.
#   It probes StartOS's host (the container's gateway, which answers HTTP from the container): that must be unreachable.
set -euo pipefail
probe=$(ip -4 route show default | awk '{print $3; exit}')
exec ip netns exec outcrop-web \
  setpriv --reuid=outcrop-fetch --regid=outcrop-fetch --init-groups --no-new-privs --inh-caps=-all --bounding-set=-all \
  env -i PATH=/usr/bin:/bin HOME=/nonexistent PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
      OUTCROP_FETCH_PROBE="$probe" OUTCROP_FETCH_WAN_ECHO=https://api.ipify.org \
  /opt/outcrop-fetch/venv/bin/python -I -m outcrop.fetcher --socket /run/outcrop-fetch/fetch.sock
