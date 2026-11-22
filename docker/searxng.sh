#!/bin/bash
# searxng.sh  - (StartOS, the outcrop-searxng unit, as root) the chat's web search: the same SearXNG image Ubuntu runs
# (setup/install-web.sh's digest; the Dockerfile copies its files to /opt/searxng-root), in the outcrop-web network
# namespace (docker/webnet.sh), chrooted, with its root read-only, as its own user (977), its settings from the data volume.
# The image's environment and working directory are set here, as Docker would from the image's config.
set -euo pipefail
R=/opt/searxng-root
S=${OUTCROP_HOME:?}/searxng          # settings.yml with its secret, made by docker/prepare.sh (root:977, 0640)
[ -s "$S/settings.yml" ] || { echo "no $S/settings.yml (docker/prepare.sh makes it)" >&2; exit 1; }
exec ip netns exec outcrop-web sh -c '
  set -eu
  R=$1 S=$2
  # (ip netns exec runs this in a mount namespace of its own: nothing below is seen outside)
  mount --bind "$R" "$R" && mount -o remount,bind,ro "$R"
  mount -t tmpfs -o mode=0700,uid=977,gid=977,size=256m tmpfs "$R/var/cache/searxng"
  mount -t tmpfs -o mode=1777,size=64m tmpfs "$R/tmp"
  mount --bind "$S" "$R/etc/searxng" && mount -o remount,bind,ro "$R/etc/searxng"
  mount --bind /etc/netns/outcrop-web/resolv.conf "$R/etc/resolv.conf"
  exec chroot --userspec=977:977 "$R" env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/tmp HISTFILE=/dev/null \
    SSL_CERT_DIR=/etc/ssl/certs SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    __SEARXNG_CONFIG_PATH=/etc/searxng __SEARXNG_DATA_PATH=/var/cache/searxng \
    __SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml __SEARXNG_VERSION=2026.10.23-629368e40 \
    GRANIAN_PROCESS_NAME=searxng GRANIAN_INTERFACE=wsgi GRANIAN_HOST=0.0.0.0 GRANIAN_PORT=8080 \
    GRANIAN_WEBSOCKETS=false GRANIAN_BLOCKING_THREADS=4 GRANIAN_WORKERS_KILL_TIMEOUT=30s \
    GRANIAN_BLOCKING_THREADS_IDLE_TIMEOUT=5m FORCE_OWNERSHIP=false \
    /bin/sh -c "cd /usr/local/searxng && exec ./entrypoint.sh"
' sh "$R" "$S"
