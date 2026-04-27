# Prevue - Development Guidelines

## Project Overview

**Prevue** is a retro cable TV guide for Jellyfin **and Plex**. It turns a media library into a channel-surfing experience with auto-generated channels, deterministic schedules, a Prevue Channel-inspired EPG, an HLS player, IPTV (M3U/XMLTV) output, and optional AI features (channel creation, guide filter, Hidden Gems, iconic-scene detection).

- **Stack**: React 18 + Vite + react-router v7 (client, PWA), Express + TypeScript (server), SQLite via better-sqlite3
- **Type Safety**: Strict TypeScript enabled in both client and server
- **Testing**: Vitest for server unit tests (client has no tests)
- **Database**: better-sqlite3 for fast, synchronous queries

## Repository Structure

```
prevue/
├── client/                 # React Vite SPA
│   ├── src/components/    # Guide, Player, Settings, common, AuthGate
│   ├── src/hooks/         # Custom React hooks
│   ├── src/navigation/    # Centralized focus/remote-control nav (zones, layers, focus groups)
│   ├── src/notifications/ # Unified toast / overlay / confirm system
│   ├── src/services/      # API client, WebSocket, identity
│   ├── src/types/         # TypeScript interfaces (mirror server)
│   ├── src/utils/         # Utilities (platform detection, sanitization, etc.)
│   ├── vite.config.ts     # PWA via vite-plugin-pwa
│   └── tsconfig.json
├── server/                # Express backend
│   ├── src/
│   │   ├── index.ts              # Express app setup & boot sequence
│   │   ├── routes/               # /api/channels, /api/playback, /api/schedule, /api/servers,
│   │   │                         # /api/settings, /api/stream, /api/iptv, /api/metrics,
│   │   │                         # /api/plex-auth, /api/ticker
│   │   ├── services/             # ChannelManager, ScheduleEngine, AIService,
│   │   │                         # HiddenGemsService, IconicSceneService, MetricsService,
│   │   │                         # AbstractMediaProvider + JellyfinClient/PlexClient via providerFactory
│   │   ├── middleware/           # Express middleware (auth, rate limiting)
│   │   ├── db/                   # Database initialization & queries
│   │   ├── websocket/            # WebSocket event handling
│   │   ├── types/index.ts        # Shared TypeScript types
│   │   ├── data/                 # Channel presets & rating systems
│   │   ├── utils/                # crypto, time, urlValidation, hdr, serverSetup
│   │   └── openapi.ts            # Swagger/OpenAPI spec served at /api-docs
│   ├── tests/
│   ├── vitest.config.ts
│   └── tsconfig.json
├── data/                  # SQLite database & migrations (gitignored)
├── scripts/               # Development scripts (dev.js, kill-dev-ports.js)
├── package.json          # Monorepo config with workspaces
├── README.md
└── CLAUDE.md             # This file
```

## Code Organization Principles

### 1. **Service Layer Pattern**
- Core business logic lives in `services/` (ChannelManager, ScheduleEngine, JellyfinClient)
- Services are instantiated in `server/src/index.ts` and passed to routes via `app.locals`
- Each service has a clear responsibility: channel generation, schedule building, Jellyfin API interaction

### 2. **Database Abstraction**
- All database access goes through `server/src/db/queries.ts`
- Prepared statements prevent SQL injection; use parameter binding
- Database schema is defined in `server/src/db/index.ts` (no separate migrations)
- **Important**: better-sqlite3 is synchronous—use it for fast, blocking operations only

### 3. **Type-First Development**
- Define interfaces first in `server/src/types/index.ts` before implementing
- Client-side types in `client/src/types/index.ts` mirror server types (no codegen)
- Use **strict TypeScript**: no `any`, no `as` casts except where absolutely necessary
- Parsed types separate DB/JSON strings from deserialized objects (e.g., `Channel` vs `ChannelParsed`)

### 4. **API Consistency**
- All API routes follow REST conventions: `/api/{resource}` with GET/POST/PUT/DELETE
- Responses use `{ success, data, error }` pattern (or just `{ error }` on failure)
- Rate limiting: 600 req/15min global, 90 req/15min on sensitive endpoints (`/api/servers`, `/api/settings/factory-reset`)
- Auth: Optional API key via `X-API-Key` header or `?api_key=` query param

### 5. **React Component Structure**
- Functional components with hooks only (no class components)
- Custom hooks in `client/src/hooks/` for complex state logic
- Components are grouped by feature: Guide, Player, Settings
- Styles are inline CSS or via CSS modules (no component-specific CSS in this project)
- **No external UI libraries**—keep it lightweight

### 6. **Media Provider Abstraction**
- `AbstractMediaProvider` defines the common contract (library sync, item fetch, stream URLs)
- `JellyfinClient` and `PlexClient` are concrete implementations
- `providerFactory.ts` selects the right client per configured server
- When adding a feature that touches a media server, prefer extending the abstract base over branching on provider type in callers

## Development Workflows

### Local Development
```bash
npm install              # Install dependencies
cp .env.example .env     # Create environment config
npm run dev              # Start both client (Vite, :5173) and server (:3080)
npm run dev:fresh        # Kill anything on dev ports, then start dev
npm run dev:server       # Server only
npm run dev:client       # Client only
npm run kill-dev-ports   # Free :5173 / :3080 if a previous run is stuck
```
- Client proxies API requests to server
- Hot reload on both client and server (via tsx watch)

### Building
```bash
npm run build        # Build both client and server
npm run start        # Run production server (serves client dist)
npm run clean        # rimraf client/dist server/dist
```

### Testing
```bash
npm run test         # Run server unit tests (one-shot)
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Generate coverage report
```

## Key Patterns & Conventions

### Schedule Generation
1. **ScheduleEngine** generates "blocks" (8-hour chunks by default)
2. For each block:
   - Builds a **GlobalScheduleTracker** to prevent same item on multiple channels
   - Populates each channel with programs using deterministic seeding (seedrandom)
   - Handles kids vs. adult content separation (by rating)
   - Fills gaps with interstitials (5-30 min padding)
   - Respects cooldown: don't repeat same item for 24h (8h on movie channels)

### Channel Generation
- **CHANNEL_PRESETS** in `server/src/data/channelPresets.ts` define preset categories
- **Priority lists** (PRIORITY_GENRES, PRIORITY_DIRECTORS, PRIORITY_ACTORS) control ordering
- ChannelManager generates preset channels if none exist (on boot)
- Each channel tracks: preset_id, filter (JSON), item_ids (JSON), sort_order

### WebSocket Messaging
- `server/src/websocket/index.ts` handles client connections
- Message format: `{ type: string, payload: unknown }`
- Used for real-time updates (e.g., schedule maintenance notifications)
- Client hook: `client/src/hooks/useWebSocket.ts`

### Database Queries
- All queries are in `server/src/db/queries.ts` (centralized)
- Use prepared statements with parameter binding
- Return single row, multiple rows, or count as appropriate
- Never construct SQL strings; always use parameters

## Performance Considerations

1. **Schedule Caching**: Schedules are pre-generated in blocks; generate ahead of current time
2. **Jellyfin Sync**: Library syncing is async but non-blocking; happens at boot
3. **Rate Limiting**: Protects `/api` routes (except `/stream` for video playback)
4. **Video Streaming**: HLS streams are proxied from Jellyfin; transcode requests are cached server-side
5. **React Re-renders**: Guide uses `key` prop to control component mounting; Player mounts fresh on channel change

## Security Best Practices

1. **API Key Auth**: Optional via `PREVUE_API_KEY` env var (requires `X-API-Key` header)
2. **Encryption**: Jellyfin tokens encrypted with `DATA_ENCRYPTION_KEY` (32+ chars recommended)
3. **CORS**: Configurable via `ALLOWED_ORIGINS` env var; defaults to allow all (suitable for LAN)
4. **Helmet**: Relaxed CSP (not strictly enforced) and disabled COEP (needed for HLS)
5. **Rate Limiting**: Protects against brute force on auth/server endpoints
6. **URL Validation**: Private URLs allowed by default; disable via `PREVUE_ALLOW_PRIVATE_URLS=0`

## Debugging Tips

1. **Server Logs**: Look for `[Prevue]` prefixed logs in console
2. **Boot Sequence**: Check logs during startup (Jellyfin connection, library sync, channel generation)
3. **Schedule Maintenance**: Runs every 15 minutes; monitor for gaps in schedules
4. **WebSocket**: Browser DevTools > Network tab, filter by "WS"
5. **Client Errors**: Check browser console; uses `console.error` with context labels

## Common Tasks

### Adding a New API Endpoint
1. Create a route handler in `server/src/routes/{resource}.ts`
2. Import services from `app.locals` (db, jellyfinClient, etc.)
3. Add TypeScript types to `server/src/types/index.ts`
4. Register route in `server/src/index.ts`: `app.use('/api/{resource}', {resource}Routes)`
5. Update client API service: `client/src/services/api.ts`
6. Add tests: `server/tests/routes/api.test.ts`

### Adding a New Database Table
1. Add schema in `initDatabase()` in `server/src/db/index.ts`
2. Add query functions in `server/src/db/queries.ts`
3. Use in services/routes via `db.prepare()` and parameter binding
4. Test via `server/tests/db/queries.test.ts`

### Adding a New React Component
1. Create file in appropriate `client/src/components/{Feature}/`
2. Use functional component + hooks
3. Import types from `client/src/types/index.ts`
4. Consume API data via `client/src/services/api.ts`
5. Add error handling (catch blocks, null checks)

## Environment Variables

See `.env.example` for full list:
- `PORT`: Server port (default 3080)
- `PREVUE_API_KEY`: Optional API key for route protection
- `DATA_ENCRYPTION_KEY`: Token encryption (32+ chars)
- `ALLOWED_ORIGINS`: CORS allowlist (comma-separated)
- `TRUST_PROXY`: Set true behind reverse proxy
- `PREVUE_ALLOW_PRIVATE_URLS`: Allow private Jellyfin URLs (default true)
- `SCHEDULE_BLOCK_HOURS`: Block duration in hours (default 8)
- `OPENROUTER_API_KEY`: Optional for AI channel creation

## Testing Strategy

### Server Tests
- Unit tests in `server/tests/` using Vitest
- Mock database and services as needed
- Test critical paths: channel generation, schedule building, schedule queries
- No integration tests (avoid hitting real Jellyfin)

### Client Tests
- None currently (consider adding if feature complexity grows)
- Manual testing via browser during development

## Common Gotchas

1. **JSON in Database**: Channel filters and program lists are stored as JSON strings; always parse/stringify carefully
2. **Time Zones**: All times are UTC ISO strings (`toISOString()`); local conversion happens in the browser
3. **seedrandom Determinism**: Same seed always produces same schedule; used for reproducibility
4. **Jellyfin Item Types**: Only 'Movie' and 'Episode' are supported; others are skipped
5. **Kids Rating Separation**: Don't mix kids and adult content on same channel (enforced in ScheduleEngine)

## AI Features (Optional, OpenRouter)

All AI features are **opt-in** and require `OPENROUTER_API_KEY` (configured via Settings → AI, persisted in DB):
- **AIService** — shared client for OpenRouter requests, model selection, prompt templates
- **HiddenGemsService** — analyzes watch history + library, flags underwatched quality titles (gold badge in guide, ticker rotation)
- **IconicSceneService** — flags famous scenes timed to live playback
- **AI channel creation / guide filter / Program Facts / What Did I Miss** — implemented via `AIService` + routes

When adding AI work: never make it the default path; always gate on a settings toggle and degrade gracefully if the key is missing or the call fails.

## For Future Contributors

- See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design
- See [docs/AGENT.md](docs/AGENT.md) for the quick-start guide
- See [docs/API.md](docs/API.md) for the full REST API reference
- See [docs/FEATURES.md](docs/FEATURES.md), [docs/CONFIGURATION.md](docs/CONFIGURATION.md), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- Run tests before committing: `npm run test`
- Keep `src/types/index.ts` as the single source of truth for interfaces
- Profile before optimizing; schedule generation is already deterministic
