# ---- Build stage ----
FROM oven/bun:1 AS build

WORKDIR /app

COPY package.json bun.lock ./
COPY web/package.json ./web/

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

COPY . .

RUN bun run build

# ---- Runtime stage ----
FROM oven/bun:1 AS runtime

ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    PORT=8080 \
    PI_CODING_AGENT_DIR=/app/config/pi-agent \
    CFPABOT_GLOSSARY_DIR=/app/bin

# packtrans/glossary release tag for the bundled MCP server binary.
# Note: glibc build (no musl asset upstream) — runtime must be glibc-based (oven/bun:1), not -alpine.
ARG GLOSSARY_VERSION=v0.0.13

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone && \
    apt-get update -qq && apt-get install -y -qq --no-install-recommends git curl ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /app/bin && \
    curl -fsSL "https://github.com/packtrans/glossary/releases/download/${GLOSSARY_VERSION}/packtrans-glossary-${GLOSSARY_VERSION}-x86_64-unknown-linux-gnu.tar.gz" | tar xz --strip-components=1 -C /app/bin && \
    /app/bin/packtrans-glossary mcp --help >/dev/null

WORKDIR /app

# Install production deps (needed for thread-stream worker file, etc.)
COPY package.json bun.lock ./
COPY web/package.json ./web/
RUN bun install --frozen-lockfile --production

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/config/pi-agent ./config/pi-agent
COPY --from=build /app/config/vanilla-terms.json ./config/vanilla-terms.json

RUN mkdir -p runtime logs temp

EXPOSE 8080

VOLUME ["/app/config", "/app/runtime", "/app/logs"]

HEALTHCHECK --interval=5s --timeout=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8080/healthcheck').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "dist/index.js"]
