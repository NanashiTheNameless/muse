# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base

ARG YT_DLP_CHANNEL=master
ARG YT_DLP_VERSION=
ARG DENO_VERSION=
ENV MUSE_BUNDLED_YT_DLP_PATH=/opt/yt-dlp/bin/yt-dlp

# openssl will be a required package if base is updated to 18.16+ due to node:*-slim base distro change
# https://github.com/prisma/prisma/issues/19729#issuecomment-1591270599
# Install ffmpeg/ffprobe, yt-dlp, yt-dlp-ejs, and deno runtime dependencies
RUN --mount=type=cache,target=/root/.cache/pip \
    apt-get update \
    && apt-get install --no-install-recommends -y \
    ffmpeg \
    tini \
    openssl \
    ca-certificates \
    curl \
    unzip \
    python3 \
    python3-venv \
    && python3 -m venv /opt/yt-dlp \
    && if [ "${YT_DLP_CHANNEL}" = "master" ]; then \
        if [ -n "${YT_DLP_VERSION}" ]; then \
          yt_dlp_url="https://github.com/yt-dlp/yt-dlp-master-builds/releases/download/${YT_DLP_VERSION}/yt-dlp"; \
        else \
          yt_dlp_url="https://github.com/yt-dlp/yt-dlp-master-builds/releases/latest/download/yt-dlp"; \
        fi; \
        curl -fsSL "${yt_dlp_url}" -o /opt/yt-dlp/bin/yt-dlp; \
        chmod +x /opt/yt-dlp/bin/yt-dlp; \
      elif [ -n "${YT_DLP_VERSION}" ]; then \
        /opt/yt-dlp/bin/pip install "yt-dlp==${YT_DLP_VERSION}"; \
    else \
        /opt/yt-dlp/bin/pip install yt-dlp; \
    fi \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && npm install -g --omit=dev yt-dlp-ejs \
    && export DENO_INSTALL=/opt/deno \
    && if [ -n "${DENO_VERSION}" ]; then \
        deno_version="${DENO_VERSION#v}"; \
        curl -fsSL https://deno.land/install.sh | sh -s "v${deno_version}"; \
      else \
        curl -fsSL https://deno.land/install.sh | sh; \
      fi \
    && ln -s /opt/deno/bin/deno /usr/local/bin/deno \
    && command -v ffmpeg \
    && command -v ffprobe \
    && command -v yt-dlp \
    && command -v deno \
    && apt-get autoclean \
    && apt-get autoremove \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies
FROM base AS dependencies

WORKDIR /usr/app

# Add Python and build tools to compile native modules
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
    python-is-python3 \
    build-essential \
    && apt-get autoclean \
    && apt-get autoremove \
    && rm -rf /var/lib/apt/lists/*

COPY package.json .
COPY yarn.lock .

RUN --mount=type=cache,target=/usr/local/share/.cache/yarn/v6 \
    yarn install --prod --frozen-lockfile
RUN cp -R node_modules /usr/app/prod_node_modules

RUN --mount=type=cache,target=/usr/local/share/.cache/yarn/v6 \
    yarn install --frozen-lockfile

FROM dependencies AS builder

COPY . .

# Run tsc build
RUN yarn prisma generate
RUN yarn build

# Only keep what's necessary to run
FROM base AS runner

WORKDIR /usr/app

COPY --from=builder /usr/app/dist ./dist
COPY --from=dependencies /usr/app/prod_node_modules node_modules
COPY --from=builder /usr/app/node_modules/.prisma/client ./node_modules/.prisma/client

COPY . .

ARG COMMIT_HASH=unknown
ARG BUILD_DATE=unknown

ENV DATA_DIR=/data
ENV NODE_ENV=production
ENV COMMIT_HASH=$COMMIT_HASH
ENV BUILD_DATE=$BUILD_DATE
ENV ENV_FILE=/config

CMD ["tini", "--", "node", "--enable-source-maps", "dist/scripts/migrate-and-start.js"]
