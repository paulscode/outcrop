#!/bin/sh
# Inside the container: 127.0.0.1:8080 -> /gw/gw.sock (the host forwards that to the gateway), then one headless dsh run.
# The task comes on stdin; the NDJSON event stream goes to stdout.
set -eu
socat TCP-LISTEN:8080,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/gw/gw.sock &
cd "${WORKDIR:-/work}"
exec dsh --profile headless --json "$@"
