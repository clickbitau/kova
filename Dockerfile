FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY hub/package.json hub/
RUN npm ci --omit=dev -w hub --include-workspace-root
COPY hub hub
COPY web web
ENV KOVA_DATA=/data NODE_ENV=production
VOLUME /data
EXPOSE 8140
WORKDIR /app/hub
CMD ["npx", "tsx", "src/main.ts"]
