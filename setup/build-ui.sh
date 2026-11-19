#!/bin/bash
# build-ui.sh  - build the console's web UI (web/ -> web/dist) in a throwaway node container, so the server needs no Node.
# On a machine with Node and pnpm, `cd web && pnpm install && pnpm build` does the same.
set -euo pipefail
PROJECT=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$PROJECT/web/package.json" ] || { echo "no web/package.json"; exit 1; }
if command -v pnpm > /dev/null 2>&1 && [ "${OUTCROP_BUILD_IN_DOCKER:-}" != 1 ]; then
  (cd "$PROJECT/web" && pnpm install --frozen-lockfile --silent && pnpm build)
  exit 0
fi
# through sudo unless this user can reach Docker already (being in the docker group amounts to root, so setup does not
# add anyone to it)
DOCKER=docker
docker info > /dev/null 2>&1 || DOCKER="sudo docker"
$DOCKER run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e COREPACK_HOME=/tmp/corepack -e CI=1 \
  -v "$PROJECT/web:/app" -w /app node:22-bookworm-slim \
  sh -c "mkdir -p /tmp/bin && corepack enable --install-directory /tmp/bin && export PATH=/tmp/bin:\$PATH && pnpm install --frozen-lockfile --silent && pnpm build"
echo "built: $PROJECT/web/dist ($(du -sh "$PROJECT/web/dist" | cut -f1))"
