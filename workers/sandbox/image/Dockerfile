# syntax=docker/dockerfile:1.7
# The image every sandbox job runs in (docs/design/v6-sandbox.md §6), and the one its egress proxy
# runs in (it needs node). Built on the machine that runs the sandbox service:
# `miyoria sandbox build`. Pin the three bases by digest when this is changed
# (`docker buildx imagetools inspect <image>`), and the Python packages in requirements.txt.
#
# The image contract (label `miyoria.sandbox.contract`): /home/sandbox writable by any uid, /work,
# /workspace, /code, /tools and /ext exist, and bash, cat, sleep, kill and node are on PATH.
ARG PYTHON_IMAGE=python:3.12-slim-bookworm
ARG NODE_IMAGE=node:24-bookworm-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.8

FROM ${NODE_IMAGE} AS node
FROM ${UV_IMAGE} AS uv

FROM ${PYTHON_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl wget git jq less file procps \
      unzip zip xz-utils bzip2 p7zip-full \
      ffmpeg imagemagick poppler-utils ghostscript sqlite3 \
      build-essential pkg-config \
      fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=uv /uv /uvx /usr/local/bin/
COPY requirements.txt /opt/miyoria/requirements.txt
RUN pip install --no-cache-dir -r /opt/miyoria/requirements.txt
RUN mkdir -p /home/sandbox /work /workspace /code /tools /ext && chmod 0777 /home/sandbox
LABEL org.opencontainers.image.title="miyoria-sandbox" miyoria.sandbox.image="default" miyoria.sandbox.contract="1"
WORKDIR /workspace
CMD ["sleep", "infinity"]
