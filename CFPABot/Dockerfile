FROM oven/bun:1.4 AS build
WORKDIR /app
COPY CFPABot/package.json CFPABot/bun.lock ./
COPY CFPABot/web/package.json web/package.json
COPY CFPABot/packages/contracts/package.json packages/contracts/package.json
COPY CFPABot/packages/review-core/package.json packages/review-core/package.json
RUN bun install --frozen-lockfile
COPY CFPABot/ .
RUN bun run build

FROM oven/bun:1.4
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep util-linux python3 \
 && rm -rf /var/lib/apt/lists/*
# 术语 MCP 服务：.mcp.json 按 PATH 拉起 packtrans-glossary
ARG GLOSSARY_VERSION=v0.0.14
RUN curl -fsSL "https://github.com/packtrans/glossary/releases/download/${GLOSSARY_VERSION}/packtrans-glossary-${GLOSSARY_VERSION}-x86_64-unknown-linux-gnu.tar.gz" \
 && tar -xzf - -C /tmp \
 && mv "/tmp/packtrans-glossary-${GLOSSARY_VERSION}-x86_64-unknown-linux-gnu/packtrans-glossary" /usr/local/bin/packtrans-glossary \
 && chmod +x /usr/local/bin/packtrans-glossary \
 && rm -rf "/tmp/packtrans-glossary-${GLOSSARY_VERSION}-x86_64-unknown-linux-gnu"
WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=8080
# 本地 .mcp.json 是生成物（含平台路径）；镜像内二进制在 PATH 上，直接写命令名
RUN printf '{"mcpServers":{"glossary":{"command":"packtrans-glossary","args":["mcp"]}}}\n' > .mcp.json
COPY --from=build /app/package.json ./package.json
# dist/main.js 已内联全部依赖，运行阶段不需要 node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/native ./native
COPY --from=build /app/skills ./skills
COPY --from=build /app/config ./config
COPY --from=build /app/.env.example ./.env.example
EXPOSE 8080
VOLUME ["/app/runtime"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
CMD ["bun", "dist/main.js"]
