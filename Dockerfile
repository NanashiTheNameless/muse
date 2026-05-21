# syntax=docker/dockerfile:1.7

FROM node:lts-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /usr/app

# Copy package metadata and lockfiles first for cached installs
COPY package.json yarn.lock .yarnrc.yml tsconfig.json prisma.config.cjs prisma.config.mjs ./
COPY schema.prisma ./
COPY migrations ./migrations

# Copy source
COPY src ./src

# Prepare Yarn v4 and install node_modules (force classic layout for Docker)
RUN corepack enable && corepack prepare yarn@4 --activate
ENV YARN_ENABLE_INLINE_BUILDS=1

# Install build tools required for native modules (node-gyp, better-sqlite3, opus, Prisma)
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 \
  python3-venv \
  python-is-python3 \
  build-essential \
  g++ \
  make \
  libssl-dev \
  zlib1g-dev \
  pkg-config \
  libopus-dev \
  libtool \
  autoconf \
  automake \
  libsqlite3-dev \
  ca-certificates \
  curl \
  && rm -rf /var/lib/apt/lists/*

# Use cache mount for yarn and force node_modules layout
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
  YARN_NODE_LINKER=node-modules \
  yarn install --immutable

# Generate Prisma client and build TypeScript
RUN yarn prisma generate
RUN yarn build

# Create production-only node_modules to copy into the runtime image
RUN yarn workspaces focus --production --all && \
  mkdir -p /usr/app/prod_node_modules && cp -a /usr/app/node_modules/. /usr/app/prod_node_modules/ && rm -rf /usr/app/node_modules


FROM node:lts-slim AS runner

ENV DEBIAN_FRONTEND=noninteractive
ENV MUSE_BUNDLED_YT_DLP_PATH=/opt/yt-dlp/bin/yt-dlp
WORKDIR /usr/app

# Install runtime system tools and grab yt-dlp; also install Deno
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    tini \
    openssl \
    ca-certificates \
    curl \
    unzip \
    python3 \
    python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /opt/yt-dlp/bin \
  && curl -fsSL "https://github.com/yt-dlp/yt-dlp-master-builds/releases/latest/download/yt-dlp" -o /opt/yt-dlp/bin/yt-dlp \
  && chmod +x /opt/yt-dlp/bin/yt-dlp \
  && ln -sf /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
  && set -eux; \
     arch="$(uname -m)"; \
     case "${arch}" in \
       x86_64) deno_target='x86_64-unknown-linux-gnu' ;; \
       aarch64) deno_target='aarch64-unknown-linux-gnu' ;; \
       *) echo "Unsupported architecture for Deno: ${arch}" >&2; exit 1 ;; \
     esac; \
     deno_version="$(curl -fsSL https://dl.deno.land/release-latest.txt)"; \
     mkdir -p /opt/deno/bin; \
     curl -fsSL "https://dl.deno.land/release/${deno_version}/deno-${deno_target}.zip" -o /tmp/deno.zip; \
     unzip -q /tmp/deno.zip -d /opt/deno/bin; \
     chmod +x /opt/deno/bin/deno; \
     ln -sf /opt/deno/bin/deno /usr/local/bin/deno; \
     rm -f /tmp/deno.zip

# Copy runtime artifacts from builder
COPY --from=builder /usr/app/dist ./dist
COPY --from=builder /usr/app/prod_node_modules ./node_modules
COPY --from=builder /usr/app/schema.prisma ./schema.prisma
COPY --from=builder /usr/app/migrations ./migrations
COPY --from=builder /usr/app/prisma.config.cjs ./prisma.config.cjs
COPY --from=builder /usr/app/prisma.config.mjs ./prisma.config.mjs

# Copy repo-level yt-dlp config and expose it via env
COPY yt-dlp.conf /etc/yt-dlp.conf
ENV MUSE_YT_DLP_CONFIG_PATH=/etc/yt-dlp.conf

# Ensure local CLIs from node_modules are on PATH (prisma, etc.)
ENV PATH=/usr/app/node_modules/.bin:$PATH

ENV DATA_DIR=/data
ENV NODE_ENV=production
ENV ENV_FILE=/config

CMD ["tini", "--", "node", "--enable-source-maps", "dist/scripts/migrate-and-start.js"]
