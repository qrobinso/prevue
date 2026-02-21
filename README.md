# Prevue

A self-hosted, retro cable TV guide for Jellyfin. Prevue transforms your personal media library into a classic channel-surfing experience — complete with auto-generated channels, a full electronic program guide, a built-in video player, and IPTV output for external apps. It's a fun way to rediscover your media library.

Open source under CC BY-NC-SA 4.0. Free for personal and non-commercial use.

## Key Features

- **Self-hosted** — Run on your own server, your own network, your own terms. Docker or bare metal.
- **Jellyfin integration** — Connects to your Jellyfin media server and syncs your full movie and TV library.
- **AI-powered channel creation** — Generate channels from natural language prompts using an AI agent via OpenRouter (e.g. "90s nostalgia" or "Christopher Nolan marathon").
- **Preset and custom channels** — Auto-generates channels by genre, era, director, actor, collection, and more. Create your own with manual item lists or AI prompts.
- **Hardware transcoding** — Leverages Jellyfin's transcoding pipeline with selectable quality presets (Auto, 4K, 1080p, 720p, 480p) and HEVC support.
- **Subtitle and audio track support** — Full multi-track subtitle and audio selection, with per-language preferences and persistence.
- **Full-featured guide and player** — Retro Prevue Channel-inspired EPG grid with a built-in HLS video player, overlay controls, nerd stats, and picture-in-picture.
- **IPTV server with EPG** — Exposes an M3U playlist and XMLTV EPG feed so you can watch your channels in Kodi, VLC, Jellyfin, or any IPTV client.
- **Open source** — Inspect, modify, and contribute. Licensed for non-commercial use.

## Quick Start (Docker)

```bash
# Clone and configure
cp .env.example .env
# Edit .env with your settings (API key, encryption key, OpenRouter key, etc.)

# Run with Docker Compose
docker compose up -d
```

Open `http://localhost:3080` in your browser.
Go to **Settings > Servers** to connect your Jellyfin server. Your library will sync automatically and channels will be generated on first run.

### Jellyfin Discovery in Docker

If **Discover Servers** returns no results, this is usually Docker networking (not a Prevue bug).
In bridge mode, container LAN discovery can miss Jellyfin broadcasts/subnets.

- Recommended fallback: manually enter your Jellyfin URL (e.g. `http://<jellyfin-ip>:8096`).
- Optional (Linux): use host networking by adding `network_mode: host` to your compose service.

## Quick Start (Development)

```bash
npm install
cp .env.example .env
npm run dev
```

- Client: http://localhost:5173 (Vite dev server, proxies API to :3080)
- Server: http://localhost:3080

## Connecting to Jellyfin

Prevue connects to Jellyfin entirely through the app UI — no environment variables needed for the connection itself.

1. Open **Settings > Servers**
2. Enter your Jellyfin server URL, username, and password
3. Prevue syncs your full movie and episode library (with genres, directors, actors, ratings, artwork)
4. Channels are auto-generated from your library content
5. Watch progress can optionally be shared back to Jellyfin (configurable in Settings)

Supports local LAN URLs, remote URLs, and manual or discovered server entry.

## Channels

### Auto-Generated Channels

On first sync, Prevue creates channels based on your library metadata:

- **Genre** — Action, Comedy, Drama, Horror, Sci-Fi, etc.
- **Era** — 80s, 90s, 2000s, etc.
- **Director** — Spielberg, Nolan, Fincher, and more
- **Actor** — Hanks, DiCaprio, Streep, and more
- **Collection** — Box sets and Jellyfin collections
- **Composer** — Williams, Zimmer, Shore, and more

### Preset Channels

Additional curated presets available in Settings:

- **Time & Mood** — Late Night, Saturday Morning, Feel Good
- **Audience** — Kids, Family, Adults Only
- **Smart** — Unwatched, Favorites, Continue Watching
- **Thematic** — Holiday, Cult Classics, Award Winners

### AI Channel Creation

With an OpenRouter API key configured, you can create channels by describing them in plain English:

> "80s action movies", "Studio Ghibli marathon", "movies about space exploration"

Prevue sends a compact summary of your library to an AI model, which selects matching content and builds the channel automatically. Configure your API key in `.env` or in **Settings > Channels**.

Default model: `google/gemini-3-flash-preview` (configurable in Settings).

## Guide and Player

### Electronic Program Guide

- Retro Prevue Channel-inspired scrolling grid
- Configurable time window (1-4 hours) and visible channels (3-15)
- Program preview panel with artwork, title, description, and duration
- Color-coded entries (movies vs. episodes, customizable)
- Auto-scroll with adjustable speed (slow, normal, fast)
- Classic or modern preview style
- Keyboard navigation (arrow keys, Enter to tune, Escape for settings)
- Touch and swipe support on mobile

### Built-in Player

- HLS adaptive bitrate streaming via hls.js
- Quality selection: Auto, 4K, 1080p, 720p, 480p
- Subtitle and audio track selection overlay
- Fullscreen, picture-in-picture, and video fit (contain/cover) modes
- Info overlay with channel name, program title, time remaining, and next up
- Nerd stats panel: resolution, bitrate, codec, FPS, buffer health
- Channel up/down while watching
- Progress reporting back to Jellyfin
- Auto-advances to next program when current one ends

## Hardware Transcoding

Prevue proxies HLS streams through Jellyfin's transcoding pipeline. If your Jellyfin server has hardware transcoding configured (VAAPI, NVENC, QSV, etc.), Prevue benefits automatically.

- Quality presets with configurable bitrate and resolution caps
- HEVC support (when Jellyfin is configured for it)
- Smart request deduplication to prevent duplicate FFmpeg jobs
- Idle session cleanup after 5 minutes of inactivity

## Subtitle Support

- Displays all available subtitle tracks from Jellyfin (embedded and external)
- In-player track selection with language and display name
- Subtitle preference persisted across sessions
- Server-side preferred subtitle index configurable in Settings
- WebVTT delivery via HLS

## IPTV Server

Prevue includes a built-in IPTV server that exposes your channels to external players and apps.

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `/api/iptv/playlist.m3u` | M3U playlist with all channels |
| `/api/iptv/epg.xml` | XMLTV electronic program guide |
| `/api/iptv/channel/:number` | Live HLS stream for a channel |

### Usage

1. Enable IPTV in **Settings > IPTV**
2. Set your base URL if needed (auto-detected on LAN)
3. Add the M3U URL to your IPTV client (Kodi, VLC, Jellyfin Live TV, TiviMate, etc.)
4. The EPG URL is embedded in the playlist and loaded automatically by most clients

The IPTV stream uses a sliding-window live mode — external players see a continuous live stream, just like real cable TV. EPG data covers 24-48 hours of programming.

## Mobile App (PWA)

Prevue can be installed as a Progressive Web App on iOS, Android, and desktop — no app store required.

### iOS (Safari)

1. Open your Prevue instance in Safari
2. Tap the **Share** button (box with arrow)
3. Tap **Add to Home Screen**
4. Name it "Prevue" and tap **Add**

### Android (Chrome)

1. Open your Prevue instance in Chrome
2. Tap the **three-dot menu**
3. Tap **Install app** or **Add to Home Screen**

The PWA runs in standalone mode (no browser chrome), supports offline caching of app assets, and handles deep links to channels. Video playback, fullscreen, and all player controls work as expected.

## Raspberry Pi Cable Box

Transform a Raspberry Pi into a dedicated cable box connected to your TV via HDMI.

```bash
# One-command installation (on fresh Raspberry Pi OS)
curl -fsSL https://raw.githubusercontent.com/user/prevue/master/deploy/raspberry-pi/install.sh | sudo bash
```

- Boots directly to fullscreen Prevue guide (X11 + Chromium kiosk)
- TV remote control via HDMI-CEC
- Keyboard/mouse fallback support
- Auto-recovery from crashes
- One-click updates
- Works with local or remote Jellyfin

See [Raspberry Pi Deployment Guide](deploy/raspberry-pi/README-PI.md) for detailed setup.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 3080 | Server port |
| `PREVUE_API_KEY` | No | — | Protects all `/api/*` and `/ws` routes with an API key |
| `DATA_ENCRYPTION_KEY` | Recommended | auto | 32+ char key for encrypting stored Jellyfin tokens |
| `OPENROUTER_API_KEY` | No | — | Enables AI-powered channel creation via OpenRouter |
| `ALLOWED_ORIGINS` | No | allow all | Comma-separated CORS allowlist |
| `TRUST_PROXY` | No | false | Set `true` when behind a reverse proxy (nginx, Caddy, Traefik) |
| `PREVUE_ALLOW_PRIVATE_URLS` | No | 1 | Allow local/private Jellyfin URLs (LAN mode) |
| `SCHEDULE_BLOCK_HOURS` | No | 8 | Schedule block duration in hours |

Jellyfin server credentials are configured from the app UI in **Settings > Servers**.

### Production Hardening

- Set `PREVUE_API_KEY` to protect your instance
- Set a strong `DATA_ENCRYPTION_KEY` (32+ characters)
- Set `ALLOWED_ORIGINS` to your app domain(s)
- Set `TRUST_PROXY=true` when behind a reverse proxy
- Use HTTPS at the proxy layer and firewall the app port

## Architecture

| Layer | Stack |
|-------|-------|
| Client | React 18, Vite, HLS.js, TypeScript |
| Server | Express, TypeScript, WebSocket |
| Database | SQLite (better-sqlite3) |
| Streaming | Proxied HLS from Jellyfin |
| Container | Docker (node:20-alpine, multi-stage build) |

## API

All endpoints prefixed with `/api`:

| Endpoint | Description |
|----------|-------------|
| `GET /api/channels` | List channels with current programs |
| `GET /api/schedule` | Full schedule for all channels |
| `GET /api/playback/:channelId` | Stream URL + seek offset |
| `GET /api/settings` | App settings |
| `GET /api/servers` | Configured Jellyfin servers |
| `GET /api/iptv/playlist.m3u` | IPTV M3U playlist |
| `GET /api/iptv/epg.xml` | IPTV XMLTV guide |
| `GET /api/health` | Health check |
| `GET /api/auth/status` | Whether API key auth is required |

## License

This project is licensed under the [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License](https://creativecommons.org/licenses/by-nc-sa/4.0/).

**You are free to use, share, and modify this software for non-commercial purposes.** Commercial use requires explicit permission from the copyright holder.
