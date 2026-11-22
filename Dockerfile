ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

# 国内网络环境可覆盖为镜像源，默认官方源
ARG NPM_REGISTRY=https://registry.npmjs.org

# better-sqlite3 优先用预编译包，保留编译工具链作为兜底
RUN if command -v apt-get >/dev/null 2>&1; then \
      apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates tzdata \
      && rm -rf /var/lib/apt/lists/*; \
    fi

ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=8080

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" \
    && (npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund) \
    && npm cache clean --force \
    && npm config delete registry

COPY VERSION ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
