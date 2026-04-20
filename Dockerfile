# syntax=docker/dockerfile:1.7
FROM node:20-bookworm-slim AS deps
WORKDIR /app
ARG INSTALL_BUILD_DEPS=false
COPY package.json package-lock.json* ./
RUN if [ "$INSTALL_BUILD_DEPS" = "true" ]; then apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*; fi
RUN npm config set fund false && npm config set audit false
RUN --mount=type=cache,target=/root/.npm npm ci || npm install

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 DB_PATH=/dev/null
RUN --mount=type=cache,target=/app/.next/cache npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 DB_PATH=/data/app.db
RUN useradd -m -u 1001 nodeusr && mkdir -p /data && chown -R nodeusr:nodeusr /data
COPY --from=builder --chown=nodeusr:nodeusr /app/.next/standalone ./
COPY --from=builder --chown=nodeusr:nodeusr /app/.next/static ./.next/static
# better-sqlite3 原生模块
COPY --from=builder --chown=nodeusr:nodeusr /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
EXPOSE 3000
CMD ["sh", "-c", "mkdir -p /data && chown -R nodeusr:nodeusr /data && exec su -s /bin/sh nodeusr -c 'node server.js'"]
