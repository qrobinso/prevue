# Prevue

A retro cable TV guide for Jellyfin. Transforms your media library into a classic channel-surfing experience with auto-generated genre channels, deterministic program schedules, and a Prevue Channel-inspired electronic program guide.

## Quick Start (Docker)

```bash
# Clone and configure
cp .env.example .env
# Edit .env with security/runtime settings (API key, encryption key, etc.)

# Run with Docker Compose
docker compose up -d
```

Open `http://localhost:3080` in your browser.
Then go to **Settings > Servers** to add your Jellyfin server.

### Jellyfin Discovery in Docker

If **Discover Servers** returns no results, this is usually Docker networking (not a Prevue bug).  
In bridge mode, container LAN discovery can miss Jellyfin broadcasts/subnets.

- Recommended fallback: manually enter your Jellyfin URL (for example `http://<jellyfin-ip>:8096`).
- Optional (Linux): use host networking for better LAN discovery by adding `network_mode: host` to your compose service.

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
| `PREVUE_API_KEY` | No | - | Protects all `/api/*` and `/ws` with an API key |
| `DATA_ENCRYPTION_KEY` | Recommended | auto | 32+ char key for encrypting stored Jellyfin tokens |
| `ALLOWED_ORIGINS` | No | allow all | Comma-separated CORS allowlist |
| `TRUST_PROXY` | No | false | Set true when behind reverse proxy (nginx/Caddy/Traefik) |
| `PREVUE_ALLOW_PRIVATE_URLS` | No | 1 | Allow local/private Jellyfin URLs (LAN mode) |
| `PORT` | No | 3080 | Server port |
| `OPENROUTER_API_KEY` | No | - | Enables AI-powered channel creation |
| `SCHEDULE_BLOCK_HOURS` | No | 8 | Schedule block duration |

Jellyfin server credentials are configured from the app UI in **Settings > Servers**.

## Deployment Hardening Checklist

- Set `PREVUE_API_KEY` in production.
- Set a strong `DATA_ENCRYPTION_KEY` (32+ chars).
- Set `ALLOWED_ORIGINS` to your app domain(s) only.
- Set `TRUST_PROXY=true` when using a reverse proxy.
- Use HTTPS at the proxy layer and firewall app port access.

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
- `GET /api/auth/status` - Whether API key auth is required

## License

MIT
