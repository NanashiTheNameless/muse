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
- SoundCloud tracks, share links, and playlists
- Seeking within playable tracks
- Local media URL resolution through yt-dlp
- Optional SponsorBlock integration
- Favorite query support
- Multi-guild support from one bot instance
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

For testing you can use my hosted instance however I ask that you self-host long term...  
<https://discord.com/oauth2/authorize?client_id=1506123145571078185>

The bot requires the following OAuth2 scopes and permissions:

**Scopes:** `bot`, `applications.commands`

**Permissions:**

| Permission | Reason |
| --- | --- |
| View Channels | Receive slash command interactions |
| Send Messages | Respond to commands |
| Send Messages in Threads | Respond to commands in threads |
| Embed Links | Now-playing and queue embeds |
| Read Message History | Read playback control reactions |
| Add Reactions | Add playback controls |
| Manage Messages | Clear control reactions so they can be clicked again |
| Connect | Join voice channels |
| Speak | Play audio in voice channels |
| Use Voice Activity | Required for voice channel operation |

Use this URL, replacing `YOUR_CLIENT_ID` with your bot's application ID from the [Discord Developer Portal](https://discord.com/developers/applications):

```text
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=274914700352&scope=bot%20applications.commands
```

The permission integer `274914700352` encodes exactly the ten permissions above - no administrator or unrelated permissions are requested.

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
      # Optional: mount YouTube-only cookies for age-restricted videos.
      # - ./youtube-cookies.txt:/run/secrets/youtube-cookies.txt:ro
    environment:
      - DISCORD_TOKEN=
      - YOUTUBE_API_KEY=
      # - YT_DLP_COOKIES_PATH=/run/secrets/youtube-cookies.txt
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

### Local validation

Run the behavior suite locally with:

```bash
yarn test
```

### Playback display and controls

The `/play` message shows the current song, progress bar, and upcoming songs
with nearly real-time updates (configurable). The timer updates every five
seconds by default. To change this, set `PLAYING_MESSAGE_UPDATE_INTERVAL_SECONDS`
in your `.env` file to a whole number of seconds greater than zero, then restart
Muse.

When the queue finishes, Muse removes the card and controls and keeps the
original queue acknowledgment. Stopping playback shows "Playback stopped."
Volume and loop changes update the card immediately, including while paused.
Long titles, source labels, and stream URLs are shortened for display when needed
to fit Discord messages; playback uses the full URL.

To use the emoji controls, you must be in the same voice channel as Muse and
be allowed to use the matching command in the text channel containing the
message. Being a listener does not grant extra permissions. You can change who
can use commands and where under **Server Settings > Integrations > Muse**.
Muse checks permissions each time you click a control. If it cannot check them,
it ignores the click. Next-track reactions follow the same requester privileges
and majority vote rules as `/next`; repeat reactions do not add duplicate votes.

| Control | Command you need permission to use |
| --- | --- |
| Previous Track | `/unskip` |
| Next Track | `/next` |
| Rewind | `/seek` |
| Fast-forward | `/fseek` |
| Pause / Resume | `/pause` while playing; `/resume` while paused |
| Stop | `/stop` |
| Shuffle | `/shuffle` |

Rewind and fast-forward move ten seconds within a song and do not work on
livestreams. Playback responses are public so other listeners can use the controls.

Shuffling removes repeated songs from the upcoming queue, including songs
that are playing now or have already played. When you add a playlist with
shuffle enabled, Muse removes repeats within that playlist. Different chapters
of the same track stay separate.

YouTube playlist imports stop once they have enough playable tracks for
`/config set-playlist-limit`. Private and deleted entries do not count toward
that limit; each split chapter counts as one track. Video-detail requests are
limited to three at a time across imports and lookups. This reduces request
bursts, but your YouTube API project's daily quota still applies.

### Favorites

A favorite is a named search or track/playlist URL saved for this server. It
stores the input you would give `/play`, not audio or a copy of the current
queue. Anyone in the server who can use `/favorites use` can queue that saved
input again.

For example, create one with `/favorites create name:lofi query:lofi hip hop`,
then use `/favorites use name:lofi` to play it. Use `/favorites list` to see the
server's favorites and `/favorites remove name:lofi` to remove one you created.
The server owner can also remove other users' favorites.

Favorite names must contain 1–100 characters. `/favorites list` may shorten long
names and queries for display; the saved query is still used in full. Existing
names longer than 100 characters can still be entered manually with
`/favorites use` or `/favorites remove`.

### Leaving voice when the queue ends

`/config set-wait-after-queue-empties` takes a whole number of **seconds**.
For example, `delay:60` makes Muse wait 60 seconds after the queue ends before
leaving voice. Set `delay:0` to never leave because the queue is empty.
The separate `/config set-leave-if-no-listeners` setting can still make Muse
leave when everyone else leaves the channel.

Use `/help` in Discord for the command list and these usage examples. Its reply
is visible only to you.

Notes on voice ducking

---------------------

- Ducking is triggered on non-bot users emitting speech (based on Discord `speaking` events) and uses a short, smooth ramp to reduce/increase playback volume.

Interaction responses

---------------------

- Only error or permission messages are sent ephemerally to the command invoker. Informational, progress, and successful action messages (for example: add-to-queue confirmations, skip vote updates, and config results) are public by default so other users can see bot activity.
- Examples: permission-denied errors and caught command exceptions remain ephemeral; queue additions, playback start/resume messages, and vote registrations are public.

## Environment Variables

Required:

- `DISCORD_TOKEN`
- `YOUTUBE_API_KEY`

Core paths and cache:

- `DATA_DIR` (default: `./data`)
- `CACHE_LIMIT` (default: `2GB`)

Bot behavior:

- `PLAYING_MESSAGE_UPDATE_INTERVAL_SECONDS` (positive whole seconds, default: `5`)
- `REGISTER_COMMANDS_ON_BOT` (`true`/`false`, default: `false`)

SponsorBlock:

- `ENABLE_SPONSORBLOCK` (`true`/`false`)
- `SPONSORBLOCK_TIMEOUT` (minutes, default: `5`)

yt-dlp:

- `YT_DLP_PATH`
- `YT_DLP_AUTO_UPDATE` (default: `true`, set to `false` to disable)
- `YT_DLP_COOKIES_PATH`

Instance owner:

- `INSTANCE_OWNER_ID` - Discord user ID that bypasses all bot permission checks. This user can use `/config` without Manage Server and run commands without being in a voice channel. Leave unset to disable.

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

The mounted cookies file may be read-only; Muse copies it to a private per-extraction temporary file because yt-dlp refreshes the cookie jar while it runs.

## Troubleshooting voice connection timeouts

Muse retries a stalled initial voice handshake up to three times, waiting up to 20 seconds per attempt. Requests are added to the queue only after the connection is ready; a failed join leaves the existing queue intact. A later successful request can still resume songs that were already queued intentionally.

The failure message includes the last voice and network states. `OpeningWs` means the secure connection to the voice server did not open; check outbound TCP access to the **port supplied by Discord**, which is not necessarily 443. `UdpHandshaking` means the voice server was reached but UDP discovery did not finish; check outbound UDP and return traffic through the firewall/NAT. Discord describes both steps in its [voice connection documentation](https://docs.discord.com/developers/topics/voice-connections).

Keep voice tokens, session IDs, encryption keys, and full protocol/debug payloads out of logs and bug reports. The network-state diagnostic reports only a state name.

## CI and Publishing

Current GitHub Actions workflows:

- `type-check.yml` runs TypeScript checks on push and pull request
- `image-publish-latest.yml` builds and publishes `ghcr.io/<owner>/<repo>:latest` from `master`

## License

This project is licensed under MIT. Keep the original license notice when redistributing.
