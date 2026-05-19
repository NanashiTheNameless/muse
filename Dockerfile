# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base

ARG YT_DLP_CHANNEL=master
ARG YT_DLP_VERSION=
ARG DENO_VERSION=
ENV MUSE_BUNDLED_YT_DLP_PATH=/opt/yt-dlp/bin/yt-dlp

# openssl will be a required package if base is updated to 18.16+ due to node:*-slim base distro change
# https://github.com/prisma/prisma/issues/19729#issuecomment-1591270599
# Install ffmpeg/ffprobe and yt-dlp runtime dependencies
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
    && apt-get autoclean \
    && apt-get autoremove \
    && rm -rf /var/lib/apt/lists/*

# Note: yt-dlp is installed via the Python wheel above; no npm wrapper required.

# Install Deno from official release artifacts (more reliable than install.sh in CI/buildx).
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) deno_target='x86_64-unknown-linux-gnu' ;; \
      arm64) deno_target='aarch64-unknown-linux-gnu' ;; \
      *) echo "Unsupported architecture for Deno: ${arch}" >&2; exit 1 ;; \
    esac; \
    if [ -n "${DENO_VERSION}" ]; then \
      deno_version="${DENO_VERSION#v}"; \
    else \
      deno_version="$(curl -fsSL https://dl.deno.land/release-latest.txt)"; \
    fi; \
    # normalize: strip leading 'v' if present (release-latest may include a 'v')
    deno_version="${deno_version#v}"; \
    mkdir -p /opt/deno/bin; \
    curl -fsSL "https://dl.deno.land/release/v${deno_version}/deno-${deno_target}.zip" -o /tmp/deno.zip; \
    unzip -q /tmp/deno.zip -d /opt/deno/bin; \
    chmod +x /opt/deno/bin/deno; \
    ln -sf /opt/deno/bin/deno /usr/local/bin/deno; \
    rm -f /tmp/deno.zip

# Verify required runtime tools are available in the final image.
RUN command -v ffmpeg \
    && command -v ffprobe \
    && command -v yt-dlp \
    && command -v deno

# Install dependencies
FROM base AS dependencies

WORKDIR /usr/app

# Add Python and build tools to compile native modules
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
  python-is-python3 \
  build-essential \
  libssl-dev \
  zlib1g-dev \
  pkg-config \
    && apt-get autoclean \
    && apt-get autoremove \
    && rm -rf /var/lib/apt/lists/*

COPY package.json .
COPY yarn.lock .
COPY .yarnrc.yml .

# Ensure Corepack is enabled and Yarn v4 is prepared/activated for this build
RUN corepack enable && corepack prepare yarn@4 --activate

RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
  yarn install --immutable
RUN cp -R node_modules /usr/app/prod_node_modules

RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
  yarn install --immutable

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
