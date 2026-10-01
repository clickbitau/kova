# Kova hub. Node is pinned; bump NODE_VERSION deliberately (it must be >= 22.13 for node:sqlite).
ARG NODE_VERSION=22.22.2
FROM node:${NODE_VERSION}-bookworm-slim

ENV NODE_ENV=production \
    KOVA_DATA=/data \
    KOVA_PORT=8140

WORKDIR /app
COPY package.json package-lock.json ./
COPY hub/package.json hub/
RUN npm ci --omit=dev -w hub --include-workspace-root && npm cache clean --force
COPY hub hub
COPY web web
COPY ota ota

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
