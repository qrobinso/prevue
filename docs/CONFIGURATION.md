# Configuration

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 3080 | Server port |
| `PREVUE_API_KEY` | No | | Protects all `/api/*` and `/ws` routes with an API key |
| `DATA_ENCRYPTION_KEY` | Recommended | auto | 32+ char key for encrypting stored server tokens |
| `OPENROUTER_API_KEY` | No | | Enables AI channel creation via OpenRouter |
| `ALLOWED_ORIGINS` | No | allow all | Comma-separated CORS allowlist |
| `TRUST_PROXY` | No | false | Set `true` when behind a reverse proxy (nginx, Caddy, Traefik) |
| `PREVUE_ALLOW_PRIVATE_URLS` | No | 1 | Allow local/private server URLs (LAN mode) |
| `SCHEDULE_BLOCK_HOURS` | No | 8 | Schedule block duration in hours |

Media server credentials are configured from the app UI in **Settings > Servers**.

## Production Hardening

- Set `PREVUE_API_KEY` to protect your instance
- Set a strong `DATA_ENCRYPTION_KEY` (32+ characters)
- Set `ALLOWED_ORIGINS` to your app domain(s)
- Set `TRUST_PROXY=true` when behind a reverse proxy
- Use HTTPS at the proxy layer and firewall the app port

## Connecting a Media Server

Prevue connects to your media server through the app UI. No environment variables needed for the connection itself.

### Jellyfin

1. Open **Settings > Servers**
2. Select **Jellyfin** as the server type
3. Enter your Jellyfin server URL, username, and password
4. Prevue syncs your full movie and episode library (with genres, directors, actors, ratings, artwork)
5. Channels are auto-generated from your library content
6. Watch progress can optionally be shared back to Jellyfin (configurable in Settings)

Supports local LAN URLs, remote URLs, and manual or discovered server entry.

### Plex

1. Open **Settings > Servers**
2. Select **Plex** as the server type
3. Sign in with your Plex account via PIN-based authentication (opens plex.tv)
4. Select a server from your available Plex servers
5. Prevue syncs your movie and TV library and auto-generates channels

Plex uses OAuth-style PIN authentication. Your Plex password is never entered into Prevue.

## AI Disclaimer

Prevue's AI features are optional and disabled by default. If you enable them by providing an OpenRouter API key, Prevue sends metadata to the AI service you select via [OpenRouter](https://openrouter.ai). This may include:

- Movie titles, production years, genres, and runtimes (channel creation, iconic scenes, program facts, catch-up summaries)
- TV series names, season counts, episode counts, genres, and years (channel creation, program facts)

No file paths, file names, server URLs, credentials, or personally identifiable information are sent.

You can review the exact prompt and data format in [`server/src/services/AIService.ts`](../server/src/services/AIService.ts).

By using this feature, you acknowledge that library metadata is transmitted to a third-party AI provider subject to their own privacy policies. If you prefer not to share this data, simply don't configure an OpenRouter API key. Everything else works without it.
