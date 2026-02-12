# Prevue

A retro cable TV guide for Jellyfin. Transforms your media library into a classic channel-surfing experience with auto-generated genre channels, deterministic program schedules, and a Prevue Channel-inspired electronic program guide.

## Quick Start (Docker)

```bash
# Clone and configure
cp .env.example .env
# Edit .env with your Jellyfin URL and API key

# Run with Docker Compose
docker compose up -d
```

Open `http://localhost:3080` in your browser.

## Quick Start (Development)

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env

# Start dev servers (client + server with hot reload)
npm run dev
```

- Client: http://localhost:5173 (Vite dev server, proxies API to :3080)
- Server: http://localhost:3080

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JELLYFIN_URL` | Yes | - | Your Jellyfin server URL |
| `JELLYFIN_API_KEY` | Yes | - | Jellyfin API key (Admin > API Keys) |
| `PORT` | No | 3080 | Server port |
| `OPENROUTER_API_KEY` | No | - | Enables AI-powered channel creation |
| `DATA_ENCRYPTION_KEY` | No | auto | 32+ char key for encrypting stored API keys |
| `SCHEDULE_BLOCK_HOURS` | No | 8 | Schedule block duration |

## Features

- **Auto-generated channels** from your Jellyfin library genres
- **Retro Prevue Channel UI** with scrolling EPG grid
- **Live TV experience** - join programs in progress, channel surf
- **Deterministic schedules** - same schedule regenerates after restart
- **AI channel creation** - describe a channel in natural language (requires OpenRouter)
- **Multi-device** - responsive design for desktop, tablet, and phone
- **Keyboard navigation** - arrow keys, Enter to tune, Escape for settings

## Architecture

- **Client**: React + Vite + HLS.js
- **Server**: Express + TypeScript
- **Database**: SQLite (via better-sqlite3)
- **Streaming**: Proxied HLS from Jellyfin

## API

All endpoints prefixed with `/api`:

- `GET /api/channels` - List channels with current programs
- `GET /api/schedule` - Full schedule for all channels
- `GET /api/playback/:channelId` - Stream URL + seek offset
- `GET /api/settings` - App settings
- `GET /api/servers` - Configured Jellyfin servers
- `GET /api/health` - Health check

## License

MIT
