# syntax=docker/dockerfile:1.7
# The image of browser jobs (docs/design/v6-agent-split.md P6): Playwright's official image, whose
# Chromium and the system libraries it needs are the ones the playwright-core of package.json
# drives, plus the driver Core talks to (driver.mjs). Built with the default image by
# `miyoria sandbox build` on the machine that runs the sandbox service.
#
# When playwright-core changes in package.json, change this tag to the same version and pin its
# digest again (`docker buildx imagetools inspect mcr.microsoft.com/playwright:v<version>-noble`),
# then `npm install --package-lock-only` for package-lock.json.
#
# The image contract (label `miyoria.sandbox.contract`, as the default image's): /home/sandbox
# writable by any uid, /work, /workspace, /code, /tools and /ext exist, and bash, cat, sleep, kill
# and node are on PATH. Jobs run it read-only as a uid that is not root, with /tmp and /dev/shm as
# tmpfs and the network only through the job's egress proxy.
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579

FROM ${PLAYWRIGHT_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production npm_config_update_notifier=false
# procps for kill; CJK fonts so Chinese and Japanese pages are not boxes in a screenshot.
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/miyoria/browser
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY driver.mjs ./
RUN chmod -R a+rX /opt/miyoria /ms-playwright \
 && mkdir -p /home/sandbox /work /workspace /code /tools /ext && chmod 0777 /home/sandbox
LABEL org.opencontainers.image.title="miyoria-sandbox-browser" miyoria.sandbox.image="browser" miyoria.sandbox.contract="1"
WORKDIR /workspace
CMD ["sleep", "infinity"]
