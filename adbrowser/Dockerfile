# Chaos ADBrowser — single-image, no build step, no compile, no bundler.
#
#   docker build -t chaos-adbrowser .
#   docker run --rm -p 6001:6001 -e CHAOS_ACCESS_CODE=supersecret chaos-adbrowser
#
# The ad-block payload (data/adblock.json.gz, ~930 KB) is committed, so the image builds without
# network access. To rebuild the lists inside a container: docker compose run --rm adbrowser npm run build:filters

FROM node:22-alpine

# --- runtime only: undici (HTTP client) + ws (demo/echo + upgrade plumbing) -------------------
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
COPY data/seed.txt ./data/
COPY data/adblock.json.gz ./data/

# unprivileged, read-only filesystem (a writable volume is mounted at /data)
RUN addgroup -g 10001 -S chaos && adduser -u 10001 -S chaos -G chaos \
 && mkdir -p /data && chown -R chaos:chaos /data /app

ENV NODE_ENV=production \
    PORT=6001 \
    CHAOS_HOST=0.0.0.0 \
    CHAOS_DATA_DIR=/data \
    TZ=Etc/UTC

USER chaos
EXPOSE 6001

HEALTHCHECK --interval=30s --timeout=4s --start-period=6s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||6001)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

LABEL org.opencontainers.image.title="Chaos ADBrowser" \
      org.opencontainers.image.description="Self-hosted proxy browser with a built-in ad blocker" \
      org.opencontainers.image.source="https://github.com/chaostobimc/ChaosSites" \
      org.opencontainers.image.licenses="MIT"

# --max-old-space-size caps the heap so a long-lived container cannot grow unbounded under a
# burst of large documents; the caches are byte-budgeted, this is the safety net.
CMD ["node", "--max-old-space-size=1024", "src/server.js"]
