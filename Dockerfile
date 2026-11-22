# syntax=docker/dockerfile:1
# Outcrop's StartOS image: the Strata engine, the gateway, the console and its web UI.  The models are not in it: the service
# downloads them into its volume on first start.  startos/manifest builds it (start-cli runs `docker buildx build`).
#
#   amd64: CUDA 12.9, the last toolkit that compiles for the Quadro M6000 / Tesla M40 (Maxwell, sm_52).
#   arm64: CUDA 13.0, for the NVIDIA GB10 (sm_121).  [not built yet: the GB10 stage comes with the GB10 profile]
#
# Every base image is pinned by digest, every source by commit (setup/pins.env), every dependency by lock file.
ARG TARGETARCH

# ------------------------------------------------------------------------------------------------------------ the engine
FROM nvidia/cuda:12.9.1-devel-ubuntu24.04@sha256:020bc241a628776338f4d4053fed4c38f6f7f3d7eb5919fecb8de313bb8ba47c AS engine-amd64
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build git python3 python3-venv python3-dev pkg-config \
      libnuma-dev libcurl4-openssl-dev libssl-dev curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# the same steps as setup/install.sh (3 to 5), with the same scripts; only the CPU side is portable (any AVX2 CPU), since
# the image is built on one machine and runs on another
ENV OUTCROP_HOME=/build OUTCROP_CUDA=/usr/local/cuda STRATA_PORTABLE=ON
COPY setup/pins.env setup/fetch-sources.sh setup/build-engine.sh setup/build-vision.sh setup/patch_llama_dp4a.py /outcrop/setup/
COPY patches/ /outcrop/patches/
# /opt/strata: the path it keeps at run time (its Python environment is not relocatable)
RUN /outcrop/setup/fetch-sources.sh /build/src && mv /build/src/Strata /opt/strata && ln -s /opt/strata /build/src/Strata
RUN /outcrop/setup/build-engine.sh /opt/strata 0211 && /outcrop/setup/build-vision.sh /opt/strata
RUN python3 -m venv /opt/strata/.venv && /opt/strata/.venv/bin/pip install --no-cache-dir -q -r /opt/strata/requirements.txt

FROM engine-${TARGETARCH} AS engine
# Strata at run time: its sources, data and Python environment, not its build trees
RUN rm -rf /opt/strata/build /opt/strata/build-vision /opt/strata/.llama.cpp \
    && mkdir -p /opt/outcrop-engine/bin /opt/llama.cpp \
    && cp /build/bin/strata-0211 /build/bin/strata-vision /opt/outcrop-engine/bin/ \
    && cp -a /build/src/llama.cpp/gguf-py /opt/llama.cpp/gguf-py

# ------------------------------------------------------------------------------------------------- the console's web UI
# (the same build as setup/build-ui.sh; the output is the same on every architecture, so it is built once, natively)
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS ui
ENV COREPACK_HOME=/tmp/corepack CI=1
RUN corepack enable
WORKDIR /web
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --silent
COPY web/ ./
RUN pnpm build

# ------------------------------------------------------------------------------------------------------------ run time
FROM nvidia/cuda:12.9.1-base-ubuntu24.04@sha256:29e5e3425e2e0f5a4e97c9fb4695ba4887cd78210a43cf94c3bcafc6ab01c5e6 AS base-amd64
# the engine's RUNPATH is the toolkit's library directory: cuBLAS goes there, beside the base image's CUDA runtime
COPY --from=engine-amd64 /usr/local/cuda-12.9/targets/x86_64-linux/lib/libcublas.so.12* \
                         /usr/local/cuda-12.9/targets/x86_64-linux/lib/libcublasLt.so.12* \
                         /usr/local/cuda-12.9/targets/x86_64-linux/lib/
ENV OUTCROP_CUDA_LIB=/usr/local/cuda-12.9/targets/x86_64-linux/lib

FROM base-${TARGETARCH} AS base
# StartOS mounts the host driver's libraries (libcuda, NVML, nvidia-smi) over the image (nvidiaContainer): no other
# libcuda may sit on the library path, so the CUDA forward-compatibility copy goes.
RUN rm -rf /usr/local/cuda/compat /usr/local/cuda-*/compat \
    && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
         python3 aria2 curl ca-certificates jq numactl tini iproute2 nftables procps \
    && rm -rf /var/lib/apt/lists/* \
    && { userdel --remove ubuntu 2>/dev/null || true; } && useradd --uid 1000 --user-group --no-create-home --home-dir /data --shell /usr/sbin/nologin outcrop \
    && useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin outcrop-fetch \
    && usermod -aG outcrop-fetch outcrop

# the console's Python environment, from console/uv.lock, built where it runs (its interpreter is this image's python3)
FROM base AS console-env
COPY --from=ghcr.io/astral-sh/uv:0.9.30@sha256:538e0b39736e7feae937a65983e49d2ab75e1559d35041f9878b7b7e51de91e4 /uv /usr/local/bin/uv
COPY console/pyproject.toml console/uv.lock /opt/outcrop/console/
RUN UV_PROJECT_ENVIRONMENT=/opt/outcrop/venv UV_PYTHON_DOWNLOADS=never UV_NO_CACHE=1 \
      uv sync --project /opt/outcrop/console --frozen --no-dev --python /usr/bin/python3 --quiet \
    && /opt/outcrop/venv/bin/python -c "import uvicorn, httpx, fastapi, argon2, zxcvbn, cryptography, pynvml, psutil, zstandard"

# the page fetcher's own environment: only the "fetch" dependency group, every package hash-checked, the code root-owned
# (as setup/install-web.sh installs it in /opt/outcrop-fetch on Ubuntu)
FROM console-env AS fetch-env
COPY console/outcrop/__init__.py /opt/outcrop-fetch/app/outcrop/__init__.py
COPY console/outcrop/fetcher/ /opt/outcrop-fetch/app/outcrop/fetcher/
RUN uv export --project /opt/outcrop/console --frozen --only-group fetch --no-emit-project --quiet -o /tmp/fetch-req.txt \
    && uv venv --quiet --python /usr/bin/python3 /opt/outcrop-fetch/venv \
    && UV_NO_CACHE=1 uv pip install --quiet --python /opt/outcrop-fetch/venv/bin/python --require-hashes -r /tmp/fetch-req.txt \
    && echo /opt/outcrop-fetch/app > "$(/opt/outcrop-fetch/venv/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')/outcrop-fetch-app.pth" \
    && find /opt/outcrop-fetch/app -name __pycache__ -prune -exec rm -rf {} + \
    && /opt/outcrop-fetch/venv/bin/python -I -c "import trafilatura, pypdf, outcrop.fetcher.__main__"

FROM base AS runtime
# the chat's web search: the files of the SearXNG image setup/install-web.sh runs on Ubuntu (the same digest; test_web_pins
# checks they agree), run chrooted in its own network namespace by docker/searxng.sh
COPY --from=searxng/searxng@sha256:aecad882e86eeb022b76351c8dce4eb48d0cbb16a5f1691f77ea32c96d317502 / /opt/searxng-root/
# (Docker gives a container its own /etc/resolv.conf; the chroot gets the namespace's, bound over this empty file)
RUN touch /opt/searxng-root/etc/resolv.conf
COPY --from=fetch-env /opt/outcrop-fetch /opt/outcrop-fetch
COPY --from=engine /opt/strata /opt/strata
COPY --from=engine /opt/llama.cpp /opt/llama.cpp
COPY --from=engine /opt/outcrop-engine /opt/outcrop-engine
COPY --from=console-env /opt/outcrop/venv /opt/outcrop/venv
COPY bin/ /opt/outcrop/bin/
COPY lib/ /opt/outcrop/lib/
COPY profiles/ /opt/outcrop/profiles/
COPY setup/ /opt/outcrop/setup/
COPY docker/ /opt/outcrop/docker/
COPY console/outcrop/ /opt/outcrop/console/outcrop/
COPY console/pyproject.toml console/uv.lock /opt/outcrop/console/
COPY LICENSE README.md /opt/outcrop/
COPY --from=ui /web/dist /opt/outcrop/web/dist
ENV OUTCROP_PLATFORM=startos \
    OUTCROP_HOME=/data \
    OUTCROP_VENV=/opt/outcrop/venv \
    OUTCROP_STRATA=/opt/strata \
    OUTCROP_ENGINE_DIR=/opt/outcrop-engine/bin \
    STRATA_GGUF_PY=/opt/llama.cpp/gguf-py \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/outcrop/bin:$PATH
ENTRYPOINT ["/usr/bin/tini", "--"]

# ------------------------------------------------------------------------------------------- tests, in the run-time image
# `docker buildx build --target test .` runs the console's whole test suite (fake engine, no GPU) with the image's
# Python and libraries.  start-cli builds the default (last) target, so this stage never ships.
FROM runtime AS test
COPY --from=ghcr.io/astral-sh/uv:0.9.30@sha256:538e0b39736e7feae937a65983e49d2ab75e1559d35041f9878b7b7e51de91e4 /uv /usr/local/bin/uv
COPY console/ /opt/outcrop-test/console/
COPY lib/ /opt/outcrop-test/lib/
COPY bin/ /opt/outcrop-test/bin/
COPY profiles/ /opt/outcrop-test/profiles/
COPY setup/ /opt/outcrop-test/setup/
COPY docker/ /opt/outcrop-test/docker/
RUN cd /opt/outcrop-test && UV_PROJECT_ENVIRONMENT=/opt/outcrop-test/venv UV_PYTHON_DOWNLOADS=never UV_NO_CACHE=1 \
      uv sync --project console --frozen --python /usr/bin/python3 --quiet \
    && env -u OUTCROP_PLATFORM -u OUTCROP_HOME HOME=/tmp /opt/outcrop-test/venv/bin/python -m pytest console/tests -q -p no:cacheprovider --ignore=console/tests/test_pins.py

FROM runtime
