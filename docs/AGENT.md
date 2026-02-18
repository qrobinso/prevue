# Agent Quick Start Guide

## TL;DR - Start Here

**Prevue** is a cable TV guide for Jellyfin. It has:
- React client (Guide, Player, Settings)
- Express server (API, schedule engine, channel manager)
- SQLite database
- Deterministic scheduling using seedrandom

**Key Files to Know**:
- Client entry: `client/src/App.tsx`
- Server entry: `server/src/index.ts`
- Business logic: `server/src/services/{ScheduleEngine,ChannelManager,JellyfinClient}.ts`
- Database: `server/src/db/queries.ts`
- API types: `server/src/types/index.ts`

**Local Dev**: `npm run dev` (starts Vite @:5173 + Express @:3080)

---

## Before You Start

1. **Read these first** (in order):
   - `README.md` (project overview)
   - This file (AGENT.md - you're reading it!)
   - `CLAUDE.md` (development guidelines)
   - `ARCHITECTURE.md` (system design)

2. **Setup**:
   ```bash
   npm install
   cp .env.example .env
   npm run dev
   ```

3. **Open browser**: http://localhost:5173

---

## Project at a Glance

| Layer | Tech | Entry Point |
|-------|------|-------------|
| **Client** | React 18 + Vite + HLS.js | `client/src/main.tsx` → `App.tsx` |
| **Server** | Express + TypeScript + better-sqlite3 | `server/src/index.ts` |
| **Streams** | HLS proxy + Jellyfin SDK | `server/src/routes/stream.ts` |
| **Tests** | Vitest (server only) | `npm run test` |

---

## Understanding the Code

### How the App Works (User Journey)

```
1. User opens browser → http://localhost:5173
2. App.tsx loads → AuthWrapper → Guide component mounts
3. Guide fetches channels from GET /api/channels
4. User presses Enter on a channel → navigates to /channel/:number
5. Player component mounts → fetches stream from GET /api/playback/:channelId
6. HLS.js plays video stream (proxied from Jellyfin)
7. User presses Escape → back to Guide
```

### How Schedules Are Generated

```
1. Server starts → boot sequence
2. ScheduleEngine.extendSchedules() called
3. For each channel:
   a. Get the next 8-hour block (e.g., 8am-4pm)
   b. Use seedrandom(seed) to pick programs deterministically
   c. Pick candidates by rating/genre/cooldown
   d. Fill gaps with interstitials
   e. Store block in DB
4. When user requests playback, server queries schedule_blocks table
```

### Key Files & What They Do

#### Client (`client/src/`)

| File | Purpose |
|------|---------|
| `App.tsx` | Router + Auth gate + Layout (Guide + Player) |
| `components/Guide/Guide.tsx` | EPG component (channels, schedules, keyboard nav) |
| `components/Player/Player.tsx` | HLS player + controls + next-up card |
| `components/Settings/Settings.tsx` | Server/channel management modal |
| `hooks/useWebSocket.ts` | WebSocket connection (real-time updates) |
| `hooks/useKeyboard.ts` | Keyboard handling (arrow keys, Enter, Escape) |
| `hooks/useSchedule.ts` | Fetch/cache schedule data |
| `services/api.ts` | Fetch functions (getChannels, playback, etc.) |
| `types/index.ts` | TypeScript interfaces (Channel, ScheduleProgram, etc.) |

#### Server (`server/src/`)

| File | Purpose |
|------|---------|
| `index.ts` | Express app setup + boot sequence |
| `services/ScheduleEngine.ts` | Generates deterministic schedules |
| `services/ChannelManager.ts` | Auto-generates channels from library |
| `services/JellyfinClient.ts` | Jellyfin SDK wrapper + caching |
| `services/MetricsService.ts` | Analytics (channel switches) |
| `routes/channels.ts` | GET /api/channels endpoint |
| `routes/playback.ts` | GET /api/playback/:channelId endpoint |
| `routes/schedule.ts` | GET /api/schedule endpoint |
| `routes/settings.ts` | GET/POST /api/settings endpoints |
| `routes/servers.ts` | Server management endpoints |
| `routes/stream.ts` | Proxy HLS streams from Jellyfin |
| `db/index.ts` | Database schema + initialization |
| `db/queries.ts` | All SQL queries (centralized) |
| `types/index.ts` | TypeScript types (Channel, ScheduleProgram, etc.) |
| `middleware/auth.ts` | Optional API key authentication |

---

## Common Tasks

### Task: "Fix a bug in the schedule"

1. **Understand the bug**: Is it in ScheduleEngine or a query?
2. **Reproduce**: Add test in `server/tests/services/ScheduleEngine.test.ts`
3. **Locate code**: Check `server/src/services/ScheduleEngine.ts`
4. **Fix**: Update logic (e.g., cooldown check, conflict detection)
5. **Test**: `npm run test:watch`

### Task: "Add a new API endpoint"

1. **Create route file** or add handler to existing `server/src/routes/{resource}.ts`
2. **Add types** to `server/src/types/index.ts`
3. **Add service method** to appropriate service (or create new one)
4. **Register route** in `server/src/index.ts`: `app.use('/api/{resource}', {resource}Routes)`
5. **Add client function** to `client/src/services/api.ts`
6. **Call from component** (e.g., `Settings.tsx`)
7. **Test**: `npm run test`

### Task: "Add a database column"

1. **Update schema** in `server/src/db/index.ts` (add column to CREATE TABLE)
2. **Add query** to `server/src/db/queries.ts` (if needed for new column)
3. **Update types** in `server/src/types/index.ts`
4. **Delete database** (optional; schema auto-updates on next run)
5. **Test**: Run app and verify data loads

### Task: "Improve the UI"

1. **Find component** in `client/src/components/{Feature}/`
2. **Edit component** (change JSX, state, styling)
3. **Test in browser**: Hot reload should work
4. **No CSS file needed**: Inline styles or use Tailwind (if available)

### Task: "Add a new channel preset"

1. **Edit** `server/src/data/channelPresets.ts`
2. **Add new ChannelPreset** object to `CHANNEL_PRESETS` array
3. **Define filter** (what content goes on this channel)
4. **Restart server**: New preset auto-generates channels on boot
5. **Test**: Check Settings → channels to see new preset

### Task: "Understand why schedules don't extend"

1. Check logs for: `[Prevue] Extending schedules` or `[Prevue] Schedule maintenance`
2. Search `ScheduleEngine.ts` for `extendSchedules()` and `maintainSchedules()`
3. Check if current time < block_end of last schedule
4. If no Jellyfin connection, schedule extension is skipped

---

## Common Gotchas

| Gotcha | Fix |
|--------|-----|
| Schedule doesn't extend | Jellyfin not connected (check Settings > Servers) |
| Player won't play video | Check HLS URL in /api/playback response; may need CORS/proxy |
| Channels not generating | Check Jellyfin has movies/episodes; empty library = no channels |
| Settings not saving | Check Network tab for 400 errors; may be API key issue |
| React component not updating | Check useState vs URL state; Player mounts fresh each channel change |
| `seedrandom` not working | Make sure seed is string; same seed must produce same schedule |
| Database locked | Kill other connections; better-sqlite3 doesn't share connections well |

---

## Testing Quick Reference

### Run Tests
```bash
npm run test           # One-shot
npm run test:watch     # Watch mode
npm run test:coverage  # Coverage report
```

### Write a Test
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ScheduleEngine } from '../src/services/ScheduleEngine';

describe('ScheduleEngine', () => {
  it('should generate schedule with deterministic seed', () => {
    // Arrange
    const engine = new ScheduleEngine(db, jellyfin);

    // Act
    const schedule = engine.buildBlock(...);

    // Assert
    expect(schedule.programs).toHaveLength(5);
    expect(schedule.programs[0].title).toBe('Inception');
  });
});
```

---

## Architecture Quick Map

```
CLIENT (React)
├── Guide (EPG) ── fetchChannels() ─┐
├── Player (HLS) ─ getPlayback() ───┤
└── Settings (UI) ─ updateServer() ─┤
                                     │
                                  SERVER (Express)
                                  ├─ GET /api/channels
                                  ├─ GET /api/playback/:id
                                  ├─ GET /api/schedule
                                  ├─ POST /api/servers
                                  └─ ... (other routes)
                                     │
                                  SERVICES
                                  ├─ ScheduleEngine (blocks, programs)
                                  ├─ ChannelManager (channel generation)
                                  ├─ JellyfinClient (library cache)
                                  └─ MetricsService (analytics)
                                     │
                                  DATABASE (SQLite)
                                  ├─ channels
                                  ├─ schedule_blocks
                                  ├─ servers
                                  ├─ settings
                                  └─ metrics
                                     │
                                  JELLYFIN (External)
                                  └─ Media items
```

---

## Debugging Checklist

- [ ] **Server logs**: Check console for `[Prevue]` prefixed messages
- [ ] **Network tab**: Are API requests succeeding (200 OK)?
- [ ] **Browser console**: Any JavaScript errors?
- [ ] **Jellyfin connection**: Settings > Servers, test connection?
- [ ] **Schedule exists**: Check DB (via tests or direct query)?
- [ ] **Rate limit**: Too many requests in short time (429 response)?
- [ ] **API key**: Is X-API-Key header being sent if PREVUE_API_KEY is set?
- [ ] **WebSocket**: Browser DevTools > Network, filter by "WS"?

---

## Type System Cheat Sheet

### Common Types

```typescript
// Channel (from DB)
interface Channel {
  id: number;
  number: number;        // Display channel number (e.g., 101)
  name: string;
  type: 'auto' | 'custom' | 'preset';
  preset_id?: string;
  filter?: string;       // JSON-stringified ChannelFilter
  item_ids: string;      // JSON-stringified string[]
  sort_order: number;
}

// Parsed version (deserialized)
interface ChannelParsed extends Omit<Channel, 'item_ids' | 'filter'> {
  item_ids: string[];
  filter: ChannelFilter | null;
}

// Program in schedule
interface ScheduleProgram {
  jellyfin_item_id: string;
  title: string;
  start_time: string;    // ISO string
  end_time: string;
  duration_ms: number;
  type: 'program' | 'interstitial';
  rating?: string;       // e.g., 'PG-13'
}

// 8-hour block
interface ScheduleBlock {
  channel_id: number;
  block_start: string;   // ISO string
  block_end: string;
  programs: string;      // JSON array in DB
}
```

---

## Performance Tips

1. **Schedule Generation**: Already deterministic; don't optimize prematurely
2. **Library Sync**: Async, non-blocking; happens once at boot
3. **Caching**: Library items cached in memory; 24h+ cooldown for schedule de-duplication
4. **Streaming**: HLS segments cached on server (reduce Jellyfin load)
5. **React**: Guide mounts fresh on settings close; Player mounts fresh on channel change

---

## Next Steps

1. **Run the app locally**: `npm install && npm run dev`
2. **Add a Jellyfin server**: Settings > Add Server
3. **Review a schedule**: Guide shows channels; press Enter to play
4. **Read CLAUDE.md**: Project conventions & best practices
5. **Read ARCHITECTURE.md**: Deep dive into design decisions
6. **Pick a task**: Bug fix, feature, or refactoring

---

## Getting Help

- Check `CLAUDE.md` for development guidelines
- Check `ARCHITECTURE.md` for system design
- Check `README.md` for deployment & configuration
- Check server logs (`console.log` in `index.ts`)
- Check browser Network tab for API response details
- Run tests: `npm run test:watch` to debug failures
- Use browser debugger (F12) for JavaScript issues
