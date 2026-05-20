# Muse (Unofficial Fork)

> [!IMPORTANT]
> This is an independent fork of Muse. It is not affiliated with, endorsed by, or maintained by the upstream Muse project.

Muse is a self-hosted Discord music bot for small to medium communities.

This repository is an unofficial community-maintained fork.

## Attribution

Fork maintained by NanashiTheNameless, based on work by Max Isom and other Muse contributors.

## Features

- YouTube playback with queue controls
- Livestream playback support
- Seeking within playable tracks
- Local media URL resolution through yt-dlp
- Optional SponsorBlock integration
- Favorite query support
- Multi-guild support from one bot instance
- Configurable volume, including optional voice-based ducking
 - Configurable volume, including optional voice-based ducking (triggers on non-bot users speaking)

## Requirements

- A 64-bit OS
- Discord bot token (`DISCORD_TOKEN`)
- YouTube Data API key (`YOUTUBE_API_KEY`)

For local Node.js runs (non-Docker):

- Node.js 24.15.0 or newer
- ffmpeg 4.1+
- yt-dlp on PATH (or set `YT_DLP_PATH`)

## Adding the Bot to a Server

For testing you acan use my hosted instance however I ask that you self-host long term...
<https://discord.com/oauth2/authorize?client_id=1506123145571078185>

The bot requires the following OAuth2 scopes and permissions:

**Scopes:** `bot`, `applications.commands`

**Permissions:**

| Permission | Reason |
|---|---|
| View Channels | Receive slash command interactions |
| Send Messages | Respond to commands |
| Send Messages in Threads | Respond to commands in threads |
| Embed Links | Now-playing and queue embeds |
| Connect | Join voice channels |
| Speak | Play audio in voice channels |
| Use Voice Activity | Required for voice channel operation |

Use this URL, replacing `YOUR_CLIENT_ID` with your bot's application ID from the [Discord Developer Portal](https://discord.com/developers/applications):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=274914626560&scope=bot%20applications.commands
```

The permission integer `274914626560` encodes exactly the seven permissions above — no administrator or unrelated permissions are requested.

## Quick Start (Docker)

Use the published image from this fork:

```bash
docker run -it \
  -v "$(pwd)/data":/data \
  -e DISCORD_TOKEN='' \
  -e YOUTUBE_API_KEY='' \
  ghcr.io/NanashiTheNameless/muse:latest
```

## Docker Compose

```yaml
services:
  muse:
    image: ghcr.io/NanashiTheNameless/muse:latest
    restart: always
    volumes:
      - ./muse:/data
    environment:
      - DISCORD_TOKEN=
      - YOUTUBE_API_KEY=
```

If you keep the same `DISCORD_TOKEN` and reuse the same `/data` volume, bot identity and persisted data remain intact across image updates.

## Local Development

```bash
git clone https://github.com/NanashiTheNameless/muse.git
cd muse
nvm use
corepack enable
cp .env.example .env
# fill in DISCORD_TOKEN and YOUTUBE_API_KEY

yarn install
yarn start
```

This project requires Node.js 24.15.0 or newer.

Notes on voice ducking
---------------------

 - Ducking is triggered on non-bot users emitting speech (based on Discord `speaking` events).


## Environment Variables

Required:

- `DISCORD_TOKEN`
- `YOUTUBE_API_KEY`

Core paths and cache:

- `DATA_DIR` (default: `./data`)
- `CACHE_LIMIT` (default: `2GB`)

Bot behavior:

- `REGISTER_COMMANDS_ON_BOT` (`true`/`false`, default: `false`)

SponsorBlock:

- `ENABLE_SPONSORBLOCK` (`true`/`false`)
- `SPONSORBLOCK_TIMEOUT` (minutes, default: `5`)

yt-dlp:

- `YT_DLP_PATH`
- `YT_DLP_AUTO_UPDATE` (default: `true`, set to `false` to disable)
- `YT_DLP_COOKIES_PATH`

Instance owner:

- `INSTANCE_OWNER_ID` — Discord user ID that bypasses all bot permission checks. This user can use `/config` without Manage Server and run commands without being in a voice channel. Leave unset to disable.

Docker images built from this repo include:

- `ffmpeg` and `ffprobe`
 - `yt-dlp` (master build by default)
- `deno`

## Cookies for YouTube Bot Checks

If YouTube requires sign-in or bot verification:

- Export YouTube cookies in Netscape format
- Mount the cookies file into the container
- Set `YT_DLP_COOKIES_PATH` to that mounted path

Example:

```yaml
services:
  muse:
    image: ghcr.io/NanashiTheNameless/muse:latest
    volumes:
      - ./muse:/data
      - ./cookies.txt:/cookies.txt
    environment:
      - DISCORD_TOKEN=
      - YOUTUBE_API_KEY=
      - YT_DLP_COOKIES_PATH=/cookies.txt
```

The cookies file must be writable because yt-dlp may refresh cookies.

## CI and Publishing

Current GitHub Actions workflows:

- `type-check.yml` runs TypeScript checks on push and pull request
- `image-publish-latest.yml` builds and publishes `ghcr.io/<owner>/<repo>:latest` from `master`

## License

This project is licensed under MIT. Keep the original license notice when redistributing.
