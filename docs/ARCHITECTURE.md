# Prevue Architecture

## System Overview

Prevue is a full-stack application that emulates the cable TV experience using a Jellyfin media server as the content source.

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT (Browser)                     │
│  React 18 (Vite) + HLS.js + WebSocket Client              │
│  - Guide Component (EPG scrolling grid)                     │
│  - Player Component (HLS video playback)                    │
│  - Settings Component (Server/channel management)           │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP + WebSocket
                         │
┌────────────────────────────────────────────────────────────┐
│                     SERVER (Express/Node)                  │
│  TypeScript, ES2022 modules, better-sqlite3              │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                   Services Layer                    │  │
│  │ - JellyfinClient: Jellyfin SDK integration         │  │
│  │ - ChannelManager: Channel generation & presets     │  │
│  │ - ScheduleEngine: Deterministic schedule building  │  │
│  │ - MetricsService: Analytics tracking               │  │
│  └─────────────────────────────────────────────────────┘  │
│                         ▲                                  │
│                         │                                  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │            HTTP Routes (/api/*)                    │  │
│  │ - /channels: List channels with current programs   │  │
│  │ - /schedule: Full EPG data                         │  │
│  │ - /playback/:channelId: Stream URL + seek offset   │  │
│  │ - /settings: User preferences (display, filters)   │  │
│  │ - /servers: Jellyfin connection management         │  │
│  │ - /stream: Proxy HLS streams from Jellyfin         │  │
│  │ - /metrics: Analytics (channel switches)           │  │
│  └─────────────────────────────────────────────────────┘  │
│                         ▲                                  │
│                         │                                  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │            SQLite Database (better-sqlite3)        │  │
│  │ - servers: Jellyfin connection configs             │  │
│  │ - channels: Channel definitions                    │  │
│  │ - schedule_blocks: Pre-generated 8hr schedules    │  │
│  │ - settings: User preferences                       │  │
│  │ - metrics: Analytics/usage logs                    │  │
│  │ - library_cache: Jellyfin item metadata            │  │
│  └─────────────────────────────────────────────────────┘  │
│                         │                                  │
│                         ▼                                  │
│            (Jellyfin API - external)                       │
└────────────────────────────────────────────────────────────┘
                         │
                         ▼
                  ┌──────────────────┐
                  │  Jellyfin Server │
                  │  (Media Library)  │
                  └──────────────────┘
```

## Core Components

### 1. **Client (React SPA)**

**Entry**: `client/src/main.tsx` → `client/src/App.tsx`

**Main Components**:
- **Guide** (`Guide.tsx`): EPG grid showing channels and schedules
  - Displays 8-hour schedule blocks
  - Keyboard navigation (arrow keys, Enter)
  - Real-time streaming of schedule data
  - Focus management for resume-on-return

- **Player** (`Player.tsx`): HLS video player overlay
  - HLS.js for streaming
  - Playback controls (play, pause, seek)
  - Next-up card for upcoming programs
  - Info overlay with program details, audio track selection
  - Fullscreen support (requestFullscreen API)

- **Settings** (`Settings.tsx`): Configuration modal
  - Server management: Add/test/remove Jellyfin servers
  - Channel management: Enable/disable channels, reorder
  - Display settings: Preview background, theme
  - Filter settings: Unwatched-only toggle
  - Advanced: metrics, server reset

**State Management**:
- React Router for navigation (`/`, `/channel/:number`)
- URL-driven state (e.g., `/channel/5` to watch channel 5)
- Session storage for API key (`prevue_api_key`)
- localStorage for display preferences

**Key Hooks**:
- `useWebSocket()`: Connect to server WS for live updates
- `useKeyboard()`: Handle arrow keys, Enter, Escape
- `useSchedule()`: Fetch and cache schedule data
- `useSwipe()`: Mobile swipe navigation
- `useVolume()`: Volume control state
- `useAudioTrack()`: Select audio tracks from HLS manifest

**Services**:
- `services/api.ts`: Fetch functions for all endpoints
- `services/websocket.ts`: WebSocket connection & messaging
- `services/clientIdentity.ts`: Persistent device ID (localStorage)
- `services/playbackHandoff.ts`: Resume playback on reconnect

### 2. **Server (Express/TypeScript)**

**Entry**: `server/src/index.ts`

**Startup Sequence**:
1. Load environment config
2. Initialize security middleware (Helmet, CORS, rate limits, auth)
3. Initialize database (create tables if needed)
4. Initialize services (JellyfinClient, ScheduleEngine, etc.)
5. Initialize WebSocket server
6. Register API routes
7. Boot sequence (connect Jellyfin, sync library, generate channels, extend schedules)

**Security Layers**:
- **Helmet**: Security headers (CSP disabled for HLS, COEP disabled)
- **CORS**: Configurable origins or allow all
- **Rate Limiting**: 600 req/15min global, 90 req/15min on admin endpoints
- **Auth**: Optional API key protection (X-API-Key header or ?api_key=)
- **URL Validation**: Prevent private URLs unless explicitly allowed

#### Services

**JellyfinClient** (`services/JellyfinClient.ts`):
- Wraps Jellyfin SDK (@jellyfin/sdk)
- Stores/retrieves server configs from DB (with encrypted tokens)
- Syncs library: fetches all movies/episodes into memory cache
- Provides helper methods: get items by genre, filter by year, etc.
- Handles authentication & token refresh

**ChannelManager** (`services/ChannelManager.ts`):
- Auto-generates channels from library content
- Priority-based: genres first, then cast/crew, then thematic
- Each channel has a filter (ChannelFilter) applied at schedule-build time
- Supports dynamic presets (e.g., "one director channel per director")
- Validates channels have minimum content duration before creation

**ScheduleEngine** (`services/ScheduleEngine.ts`):
- Builds deterministic schedules using seedrandom
- Generates blocks (8 hours by default)
- Per-block algorithm:
  1. Build GlobalScheduleTracker (prevent same item on 2+ channels simultaneously)
  2. For each channel, pick programs deterministically:
     - Sort candidates by priority (genre match, last-play date, etc.)
     - Pick from top N (MOVIE_POOL_SIZE = 20) for variety
     - Check cooldown: don't repeat same item for 24h (8h for movies)
     - Check global conflicts: not playing elsewhere at same time
     - Check rating bucket: kids content separate from adult
  3. Fill gaps with interstitials (5-30 min padding)
- Extends schedules to ensure 24h of future content available
- Maintains schedules: removes old blocks, generates new ones

**MetricsService** (`services/MetricsService.ts`):
- Tracks channel switches (from_channel → to_channel)
- Records client ID, timestamp, user agent
- Used for analytics (most popular channels, watch patterns)

#### Routes

All routes in `routes/` follow REST conventions:

- **`/api/channels`**: GET - List all channels with current program
- **`/api/schedule?from=&to=`**: GET - Schedule for time range
- **`/api/playback/:channelId`**: GET - Stream URL, seek position, next program
- **`/api/settings`**: GET - User preferences; POST - Update preference
- **`/api/servers`**: GET - List servers; POST - Add server; DELETE - Remove
- **`/api/metrics`**: POST - Log event
- **`/api/stream/*`** and **`/api/images/*`**: Proxy to Jellyfin
- **`/api/health`**: GET - Health check (public)
- **`/api/auth/status`**: GET - Whether API key is required (public)

#### Database (SQLite)

Schema (created in `db/index.ts`):

```sql
servers(
  id PRIMARY KEY,
  name TEXT,
  url TEXT,
  username TEXT,
  access_token TEXT (encrypted),
  user_id TEXT,
  is_active BOOLEAN,
  created_at TEXT
)

channels(
  id PRIMARY KEY,
  number INTEGER UNIQUE,
  name TEXT,
  type ('auto'|'custom'|'preset'),
  genre TEXT,
  preset_id TEXT,
  filter TEXT (JSON),
  item_ids TEXT (JSON list),
  ai_prompt TEXT,
  sort_order INTEGER,
  created_at TEXT
)

schedule_blocks(
  id PRIMARY KEY,
  channel_id INTEGER,
  block_start TEXT (ISO),
  block_end TEXT (ISO),
  programs TEXT (JSON list),
  seed TEXT (for reproducibility),
  created_at TEXT
)

settings(
  key TEXT PRIMARY KEY,
  value TEXT (JSON)
)

metrics(
  id PRIMARY KEY,
  event_type TEXT ('channel_switch'|...),
  client_id TEXT,
  from_channel_id INTEGER,
  from_channel_name TEXT,
  to_channel_id INTEGER,
  to_channel_name TEXT,
  timestamp TEXT,
  user_agent TEXT
)

library_cache(
  jellyfin_item_id TEXT PRIMARY KEY,
  data TEXT (JSON JellyfinItem)
)
```

### 3. **Data Flow**

#### Initial Load (Cold Start)
1. **Client**: `App.tsx` calls `getChannels()` and `getSettings()`
2. **Server**: Boot sequence runs (Jellyfin sync, channel generation)
3. **Server**: `GET /api/channels` returns list of channels with current programs
4. **Client**: Guide mounts with channel list; Player awaits channel selection

#### Channel Surfing (Tuning)
1. **Client**: User navigates to `/channel/:number`
2. **Client**: URL changes → Player mounts with channel number
3. **Client**: `GET /api/playback/:channelId` → stream URL, seek position
4. **Client**: HLS.js loads manifest and starts playback
5. **Server**: `POST /api/metrics` logs channel switch

#### Schedule Maintenance (Background)
1. **Server**: Every 15 minutes, ScheduleEngine.maintainSchedules() runs
2. Checks if schedules extend 24h into future
3. If not, calls extendSchedules() to generate new blocks
4. **WebSocket**: Broadcasts update to all clients (optional notification)

#### Library Sync (On-Demand)
1. **Client**: Settings → Sync Library button
2. **Server**: JellyfinClient.syncLibrary() fetches all items from Jellyfin
3. Caches items in memory (not DB) for fast filtering
4. Updates library_cache table for persistence

## Key Design Decisions

### Why Deterministic Schedules?
- Same seed always produces same schedule
- Users can close the app and reopen; same programs will play at same times
- Seed is stored with each block for reproducibility
- Feels like a "real" TV guide (not truly random)

### Why Blocks Instead of Full 24/7 Schedule?
- Reduces upfront computation (8-hour blocks scale better)
- Allows lazy generation (only generate what's needed)
- Easy to maintain (delete old blocks, generate new ones)

### Why Kids/Adult Separation?
- Parental control: don't accidentally play R-rated content on kids channel
- Prevents mixing (e.g., "Kids" channel won't have adult movies)
- Rating-agnostic fallback: unrated content defaults to adult

### Why No ORM?
- better-sqlite3 is synchronous; an ORM adds overhead
- Queries are straightforward; manual SQL is clear
- Prepared statements prevent SQL injection

### Why WebSocket?
- Real-time schedule updates (no polling)
- Server can notify clients of maintenance/errors
- Optional; client gracefully degrades if WS unavailable

### Why HLS Proxy?
- Client can't talk to Jellyfin directly (same-origin policy, potential firewall)
- Server proxies HLS manifests and segments
- Server can cache transcode requests (reduce Jellyfin load)

## Data Models

### ChannelFilter
Flexible filtering for content:
```typescript
includeMovies?: boolean;
includeEpisodes?: boolean;
genres?: string[];
minYear?: number;
maxYear?: number;
unwatchedOnly?: boolean;
favoritesOnly?: boolean;
directors?: string[];
actors?: string[];
// ... (many more options)
```

### Channel
Stored in DB:
```typescript
{
  id: number;
  number: number;              // Display channel number (e.g., 101)
  name: string;
  type: 'auto' | 'custom' | 'preset';
  genre: string | null;        // For auto channels
  preset_id: string | null;    // References ChannelPreset
  filter: string;              // JSON-stringified ChannelFilter
  item_ids: string;            // JSON-stringified string[]
  sort_order: number;
  created_at: string;
}
```

### ScheduleProgram
A single program (movie, episode, or interstitial):
```typescript
{
  jellyfin_item_id: string;
  title: string;
  subtitle: string | null;     // Season/episode info
  start_time: string;          // ISO string
  end_time: string;
  duration_ms: number;
  type: 'program' | 'interstitial';
  backdrop_url?: string;       // Jellyfin image
  guide_url?: string;
  thumbnail_url: string | null;
  year: number | null;
  rating: string | null;       // e.g., 'PG-13'
  description: string | null;
}
```

### ScheduleBlock
A pre-generated 8-hour chunk:
```typescript
{
  id: number;
  channel_id: number;
  block_start: string;         // ISO string
  block_end: string;
  programs: string;            // JSON-stringified ScheduleProgram[]
  seed: string;                // seedrandom seed (for reproducibility)
  created_at: string;
}
```

## Performance Profile

### Metrics (Rough Estimates)
- **Channel Generation**: ~100-500ms per channel (depends on library size)
- **Schedule Block Generation**: ~50-200ms per block (depends on library size)
- **Jellyfin Sync**: ~5-60s (depends on library size)
- **API Response Time**: <50ms (cached data)
- **HLS Stream Start**: ~2-5s (HLS manifest fetching + segment buffering)

### Scaling Limits
- **Max Channels**: No hard limit, but UI lists channels (performance TBD at 200+)
- **Max Library Size**: Tested with ~10k items; no known limits
- **Max Concurrent Players**: Not measured, but server uses WebSocket (scales well)

## Testing Strategy

### Server Tests (Vitest)
- `tests/db/queries.test.ts`: Database query correctness
- `tests/services/ScheduleEngine.test.ts`: Deterministic scheduling
- `tests/services/ChannelManager.test.ts`: Channel generation
- `tests/utils/`: Utility functions (crypto, time)
- `tests/routes/api.test.ts`: Endpoint behavior

### No Client Tests
- Complex UI interactions; manual testing via browser preferred
- Consider adding Playwright/Cypress if UI complexity grows

## Future Improvements

1. **Playlist Support**: Allow users to create custom playlists as channels
2. **AI Channel Creation**: Describe a channel in natural language (via OpenRouter)
3. **Mobile UI**: Responsive design for tablet/phone (partially done)
4. **Watch History**: Track what user has watched across sessions
5. **Resume Playback**: Remember seek position per item
6. **Recording Simulation**: "Record" programs to custom playlist
7. **Search**: Find channels/programs by title
8. **Themes**: Light/dark mode, custom colors
