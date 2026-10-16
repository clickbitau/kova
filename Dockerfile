# Kova hub. Node is pinned; bump NODE_VERSION deliberately (it must be >= 22.13 for node:sqlite).
ARG NODE_VERSION=22.22.2

# aircast (AirConnect): shows Cast speakers to Apple devices as AirPlay ones. Pinned and checked; to bump it,
# change both lines (sha256 of the release zip).
FROM debian:bookworm-slim AS airconnect
ARG AIRCONNECT_VERSION=1.12.4
ARG AIRCONNECT_SHA256=ae59d595be80db7f4e93c94c9029baff59dc7515ec03e44505ab2792bbcd1903
ARG TARGETARCH
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates curl unzip >/dev/null \
 && curl -fsSL -o /ac.zip "https://github.com/philippe44/AirConnect/releases/download/${AIRCONNECT_VERSION}/AirConnect-${AIRCONNECT_VERSION}.zip" \
 && echo "${AIRCONNECT_SHA256}  /ac.zip" | sha256sum -c - \
 && case "${TARGETARCH:-amd64}" in amd64) cpu=x86_64 ;; arm64) cpu=aarch64 ;; arm) cpu=arm ;; 386) cpu=x86 ;; *) echo "no aircast for ${TARGETARCH}"; exit 1 ;; esac \
 && mkdir -p /opt/airconnect && unzip -q -o /ac.zip "aircast-linux-${cpu}-static" -d /opt/airconnect \
 && chmod 0755 /opt/airconnect/*

# Dependencies, built where compilers are: some (Bluetooth via hap-controller, usb, serialport) are native and
# build from source when npm finds no prebuilt binary. Only node_modules goes on to the image.
FROM node:${NODE_VERSION}-bookworm-slim AS deps
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends python3 make g++ >/dev/null && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY hub/package.json hub/
RUN npm ci --omit=dev -w hub --include-workspace-root && npm cache clean --force

FROM node:${NODE_VERSION}-bookworm-slim

ENV NODE_ENV=production \
    KOVA_DATA=/data \
    KOVA_PORT=8140

# ffmpeg: seamless loops of sounds that repeat (hub/src/services/loops.ts).
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY hub/package.json hub/
COPY --from=deps /app/node_modules node_modules
COPY hub hub
COPY web web
COPY ota ota
# The same path a native install uses (deploy/install.sh), so integrations.json's aircast setting carries over.
COPY --from=airconnect /opt/airconnect /opt/airconnect

# Run as the image's unprivileged "node" user (uid 1000). The code stays root-owned
# and read-only to it; only /data is writable. A bind-mounted ./data must belong to uid 1000.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME /data

# 8140 web + API · 51826 Apple Home bridge · 5540/udp Matter. Use host networking anyway:
# mDNS (5353/udp) and SSDP (1900/udp) discovery don't work through Docker's NAT.
EXPOSE 8140/tcp 51826/tcp 5540/udp

WORKDIR /app/hub
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.KOVA_PORT||8140)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Node runs directly (not through npm/npx) so it gets SIGTERM and shuts down cleanly.
STOPSIGNAL SIGTERM
CMD ["node", "--import", "tsx", "src/main.ts"]
