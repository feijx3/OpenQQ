# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake \
    g++ \
    make \
    ninja-build \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY native/ native/
COPY scripts/ scripts/
COPY src/ src/
COPY ui/ ui/
COPY web/index.html web/setup.html web/logo.svg web/
COPY config/openqq.example.json config/openqq.example.json

RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

ARG TARGETARCH
ARG INSTALL_QQ=1
ARG QQ_DEB_URL=""

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    dbus \
    ffmpeg \
    fluxbox \
    fonts-wqy-zenhei \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libegl1 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgdk-pixbuf-2.0-0 \
    libgl1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnotify4 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libsecret-1-0 \
    libuuid1 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    novnc \
    procps \
    tini \
    websockify \
    x11vnc \
    xauth \
    xdg-utils \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

COPY docker/install-qq.mjs /tmp/install-qq.mjs
RUN if [ "$INSTALL_QQ" = "1" ]; then \
      TARGETARCH="$TARGETARCH" QQ_DEB_URL="$QQ_DEB_URL" node /tmp/install-qq.mjs /tmp/linuxqq.deb && \
      (dpkg -i /tmp/linuxqq.deb || (apt-get update && apt-get install -f -y --no-install-recommends && rm -rf /var/lib/apt/lists/*)) && \
      rm -f /tmp/linuxqq.deb; \
    fi && rm -f /tmp/install-qq.mjs

WORKDIR /app
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/native ./native
COPY --from=builder /app/web ./web
COPY --from=builder /app/config/openqq.example.json ./config/openqq.example.json
COPY LICENSE ./LICENSE
COPY docker/entrypoint.sh /usr/local/bin/openqq-entrypoint.sh
RUN chmod +x /usr/local/bin/openqq-entrypoint.sh && mkdir -p /app/config /app/.runtime

ENV NODE_ENV=production \
    DISPLAY=:99 \
    OPENQQ_CONFIG=/app/config/openqq.json \
    OPENQQ_QQ_ROOT=/opt/QQ \
    OPENQQ_WEB_PORT=17860 \
    OPENQQ_WEB_HOST=0.0.0.0 \n    OPENQQ_WS_HOST=0.0.0.0 \
    OPENQQ_QQ_NO_SANDBOX=1 \
    OPENQQ_QQ_DISABLE_GPU=1

EXPOSE 17860 3001 6080

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/openqq-entrypoint.sh"]
CMD ["start"]
