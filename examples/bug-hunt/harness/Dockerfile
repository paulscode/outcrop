# DeepSeek Harness (dsh) in a container that run-one.sh starts with --network none.
# The only way out is /gw/gw.sock, a Unix socket the host forwards to Outcrop's gateway (see run-one.sh).
# Build: docker build -t outcrop-bug-hunt:dsh-0.2.1-rc.3 examples/bug-hunt/harness
#
# Pins: the base image by digest; dsh by version; every npm dependency no newer than --before (the two-week rule).
FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4

# Tools a developer reading this code would have at hand.
RUN apt-get update \
 && apt-get install -y --no-install-recommends socat git ripgrep python3 file ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG DSH_VERSION=0.2.1-rc.3
ARG NPM_BEFORE=2026-10-24T00:00:00Z
RUN npm install -g --before="$NPM_BEFORE" "@deepseek-ai/dsh@$DSH_VERSION" \
 && npm cache clean --force

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
# uid 1000 is named "dev", not the base image's "node": `ls -l` in the checkout shows the owner
RUN groupmod -n dev node && usermod -l dev -d /home/dev node
USER dev
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
