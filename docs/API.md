# Prevue API Reference

> **Interactive docs:** When the server is running, visit [`/api/docs`](http://localhost:3080/api/docs) for the Swagger UI — browse endpoints, view schemas, and try requests directly from the browser.

## Overview

| Property | Value |
|----------|-------|
| **Default Port** | `3080` (configurable via `PORT` env var) |
| **Base Path** | `/api` |
| **Interactive Docs** | `/api/docs` (Swagger UI, no auth required) |
| **Content Type** | `application/json` (unless noted otherwise) |
| **Request Body Limit** | 1 MB |

---

## Authentication

Authentication is **optional** and controlled by the `PREVUE_API_KEY` environment variable.

When set, all `/api/*` routes require one of:

| Method | Example |
|--------|---------|
| `X-API-Key` header | `X-API-Key: your-key-here` |
| `api_key` query param | `?api_key=your-key-here` |
| `token` query param | `?token=your-key-here` |

### Public Endpoints (never require auth)

| Path | Notes |
|------|-------|
| `GET /api/health` | Health check |
| `GET /api/auth/status` | Check if auth is enabled |
| `/api/iptv/*` | Token-based auth handled internally |
| `/api/assets/*` | Static files (background music) |

### WebSocket Auth

When auth is enabled, include the API key as a query parameter:

```
ws://host:3080/ws?api_key=YOUR_KEY
```

---

## Rate Limiting

| Scope | Limit | Applies To |
|-------|-------|-----------|
| Global | 600 req / 15 min per IP | All `/api/*` routes |
| Strict | 90 req / 15 min per IP | `/api/servers`, `/api/settings/factory-reset` |

**Exempt paths:** `/stream`, `/images`, `/iptv/channel/*`

When rate limited, the server returns `429 Too Many Requests`.

---

## Error Handling

All errors return JSON:

```json
{
  "error": "Human-readable error message"
}
```

### Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Created |
| `400` | Bad request (invalid parameters) |
| `401` | Unauthorized (missing or invalid API key) |
| `403` | Forbidden (feature disabled, SSRF blocked) |
| `404` | Not found |
| `429` | Rate limited |
| `500` | Internal server error |
| `502` | Jellyfin server unavailable |
| `503` | Service temporarily unavailable (includes `Retry-After` header) |

---

## WebSocket

**Endpoint:** `ws://host:3080/ws`

The server sends JSON messages with the following structure:

```json
{
  "type": "event_type",
  "payload": { ... }
}
```

### Connection Events

| Type | Payload | Description |
|------|---------|-------------|
| `connected` | `{ timestamp }` | Sent on successful connection |
| `heartbeat` | — | Sent every 30 seconds |

### Broadcast Events

These are sent to all connected clients when server-side state changes:

| Type | Payload | Trigger |
|------|---------|---------|
| `channel:added` | `Channel` | New channel created |
| `channel:removed` | `{ id: number }` | Channel deleted |
| `channels:regenerated` | `{ count: number }` | Bulk channel regeneration complete |
| `schedule:updated` | `{ channel_id, block }` | Schedule block changed |
| `library:synced` | `{ item_count: number }` | Jellyfin library sync complete |
| `generation:progress` | `{ step, message, current?, total? }` | Progress during sync/generation |

---

## Auth & Health

### `GET /api/auth/status`

Check whether API key authentication is required.

**Auth:** No

**Response:**

```json
{ "required": true }
```

### `GET /api/health`

Health check.

**Auth:** No

**Response:**

```json
{ "status": "ok", "timestamp": "2026-02-23T12:00:00.000Z" }
```

---

## Channels

### `GET /api/channels`

List all channels with currently airing and next program info.

**Response:** Array of `ChannelWithProgram` objects:

```json
[
  {
    "id": 1,
    "number": 1,
    "name": "Movies",
    "type": "preset",
    "genre": "Action",
    "preset_id": "genre-action",
    "item_ids": ["abc123", "def456"],
    "ai_prompt": null,
    "sort_order": 1,
    "created_at": "2026-02-23T00:00:00.000Z",
    "current_program": { ScheduleProgram },
    "next_program": { ScheduleProgram },
    "schedule_generated_at": "2026-02-23T00:00:00.000Z",
    "schedule_updated_at": "2026-02-23T00:00:00.000Z"
  }
]
```

### `POST /api/channels`

Create a custom channel from a list of Jellyfin item IDs.

**Body:**

```json
{
  "name": "My Channel",
  "item_ids": ["jellyfin-item-id-1", "jellyfin-item-id-2"]
}
```

**Response:** Created `Channel` object.

**WebSocket:** Broadcasts `channel:added`.

### `POST /api/channels/ai`

Create a channel from a natural language prompt using AI.

**Body:**

```json
{ "prompt": "90s action movies with Arnold Schwarzenegger" }
```

**Response:**

```json
{
  "channel": { Channel },
  "ai_description": "Action-packed 90s films starring Arnold..."
}
```

**Requires:** OpenRouter API key configured in settings.

### `PUT /api/channels/:id`

Update a channel's name, items, or sort order.

**Path Params:** `id` — channel ID

**Body:**

```json
{
  "name": "Renamed Channel",
  "item_ids": ["id1", "id2"],
  "sort_order": 5
}
```

**Response:** Updated `Channel` object.

**Side Effects:** Regenerates schedule if `item_ids` changed.

### `PUT /api/channels/:id/ai-refresh`

Re-run the AI prompt on an AI-generated channel to pick up new library items.

**Path Params:** `id` — channel ID (must have `ai_prompt` set)

**Response:**

```json
{
  "channel": { Channel },
  "ai_description": "Updated selection..."
}
```

### `DELETE /api/channels/:id`

Delete a channel.

**Path Params:** `id` — channel ID

**Response:** `{ "success": true }`

**WebSocket:** Broadcasts `channel:removed`.

### `GET /api/channels/ai/status`

Check if AI channel generation is available.

**Response:** `{ "available": true }`

### `GET /api/channels/ai/config`

Get AI configuration (keys are masked).

**Response:**

```json
{
  "hasKey": true,
  "hasUserKey": true,
  "hasEnvKey": false,
  "model": "openai/gpt-4o",
  "defaultModel": "openai/gpt-4o-mini",
  "available": true
}
```

### `PUT /api/channels/ai/config`

Update the OpenRouter API key and/or model.

**Body:**

```json
{
  "apiKey": "sk-or-...",
  "model": "openai/gpt-4o"
}
```

Set `apiKey` to `null` to clear it.

**Response:** Same format as `GET /api/channels/ai/config`.

### `GET /api/channels/ai/suggestions`

Generate sample AI prompt suggestions based on library metadata.

**Response:**

```json
{ "suggestions": ["80s horror classics", "Comedy movies under 2 hours", ...] }
```

### `POST /api/channels/regenerate`

Regenerate all channels from saved presets (or auto-generate by genre if no presets).

**Response:** `{ "channels_created": 8 }`

**WebSocket:** Broadcasts `generation:progress` (multiple), then `channels:regenerated`.

### `GET /api/channels/genres`

List all genres present in the Jellyfin library.

**Response:** `{ "genres": ["Action", "Comedy", "Drama", ...] }`

### `GET /api/channels/ratings`

List all content ratings in the library.

**Response:** `{ "ratings": ["PG", "PG-13", "R", ...] }`

### `GET /api/channels/search`

Search library items by title.

**Query Params:** `q` — search query

**Response:** Array of matching library items.

### `GET /api/channels/presets`

List all available channel preset templates.

**Response:** Array of preset objects with `id`, `name`, `description`, `category`, `icon`, `filter`.

### `GET /api/channels/presets/:id/preview`

Preview what items would be included in a preset channel.

**Path Params:** `id` — preset ID

**Response:** Preview object with sample items and count.

### `POST /api/channels/presets/:id`

Create a channel from a preset template.

**Path Params:** `id` — preset ID

**Response:** Created `Channel` object.

### `GET /api/channels/selected-presets`

Get the list of preset IDs currently selected for generation.

**Response:** `["genre-action", "genre-comedy", ...]`

### `POST /api/channels/generate`

Generate channels from a list of preset IDs.

**Body:**

```json
{
  "preset_ids": ["genre-action", "genre-comedy"],
  "force_sync": false
}
```

**Response:**

```json
{
  "channels_created": 4,
  "channels": [ Channel, ... ]
}
```

**WebSocket:** Broadcasts `generation:progress` through steps: syncing → generating → scheduling → complete.

**Side Effects:** Syncs library first if empty or `force_sync` is true. Saves preset selection.

### `GET /api/channels/settings`

Get channel generation settings.

**Response:**

```json
{
  "max_channels": 20,
  "selected_presets": ["genre-action", ...]
}
```

### `PUT /api/channels/settings`

Update channel generation settings.

**Body:**

```json
{
  "max_channels": 15,
  "selected_presets": ["genre-action"]
}
```

**Response:** `{ "success": true }`

---

## Schedule

### `GET /api/schedule`

Get the full schedule for all channels.

**Response:** Keyed by channel ID:

```json
{
  "1": {
    "channel": { Channel },
    "blocks": [
      {
        "id": 1,
        "channel_id": 1,
        "block_start": "2026-02-23T00:00:00.000Z",
        "block_end": "2026-02-24T00:00:00.000Z",
        "programs": [ ScheduleProgram, ... ],
        "seed": "abc123",
        "created_at": "2026-02-23T00:00:00.000Z"
      }
    ]
  }
}
```

### `GET /api/schedule/:channelId`

Get schedule blocks for a specific channel.

**Path Params:** `channelId` — channel ID

**Response:** Array of `ScheduleBlock` objects.

### `GET /api/schedule/:channelId/now`

Get the currently airing program on a channel.

**Path Params:** `channelId` — channel ID

**Response:**

```json
{
  "program": { ScheduleProgram },
  "next": { ScheduleProgram },
  "seekMs": 123456
}
```

**Error:** `404` if no program is currently airing.

### `GET /api/schedule/item/:itemId`

Get detailed program info (overview, genres) for the guide modal.

**Path Params:** `itemId` — Jellyfin item ID

**Response:** Jellyfin item details object (overview, genres, people, etc.).

### `POST /api/schedule/regenerate`

Force full schedule regeneration for all channels.

**Response:** `{ "success": true }`

---

## Playback

### `GET /api/playback/:channelId`

Get streaming info for the current program on a channel. This is the primary endpoint used by the player to start watching.

**Path Params:** `channelId` — channel ID

**Query Params:**

| Param | Type | Description |
|-------|------|-------------|
| `bitrate` | number | Target video bitrate (bps) |
| `maxWidth` | number | Max video width (px) |
| `audioStreamIndex` | number | Specific audio track index |
| `hevc` | `"1"` | Enable HEVC codec support |

**Response:**

```json
{
  "stream_url": "/api/stream/ITEM_ID?playSessionId=...&mediaSourceId=...",
  "seek_position_ms": 54321,
  "seek_position_seconds": 54.321,
  "program": { ScheduleProgram },
  "next_program": { ScheduleProgram },
  "channel": { Channel },
  "is_interstitial": false,
  "audio_tracks": [
    { "index": 0, "language": "eng", "name": "English - AAC Stereo" }
  ],
  "audio_stream_index": 0,
  "subtitle_tracks": [
    { "index": 3, "language": "eng", "name": "English (SRT)" }
  ],
  "subtitle_index": null,
  "outro_start_ms": 5520000
}
```

**Notes:**
- For interstitials, `stream_url` is `null` and `is_interstitial` is `true`.
- `outro_start_ms` is the media position (ms) where ending credits begin, from the Jellyfin MediaSegments API. `null` if the server doesn't support it.
- `seek_position_ms` is calculated from the schedule — how far into the media file the current wall-clock time maps to.
- Applies preferred audio language and subtitle settings from the database if the client doesn't specify them.

---

## Stream

### `GET /api/stream/:itemId`

Get the HLS master playlist for a Jellyfin item. All URLs in the playlist are rewritten to proxy through this server.

**Path Params:** `itemId` — Jellyfin item ID

**Query Params:**

| Param | Type | Description |
|-------|------|-------------|
| `bitrate` | number | Max streaming bitrate (default: 120 Mbps) |
| `maxWidth` | number | Max video width for transcoding |
| `audioStreamIndex` | number | Audio track index |
| `subtitleStreamIndex` | number | Subtitle track index |
| `hevc` | `"1"` | Enable HEVC direct stream |
| `playSessionId` | string | Pre-fetched session ID (avoids extra round-trip) |
| `mediaSourceId` | string | Pre-fetched media source ID |

**Response:** `Content-Type: application/vnd.apple.mpegurl` — HLS master playlist.

**Side Effects:** Creates a playback session in Jellyfin, tracks session in memory.

### `GET /api/stream/proxy/*`

Proxy HLS child playlists and media segments through Jellyfin with authentication.

**Query Params:** `PlaySessionId`, `DeviceId` (required)

**Response:** HLS playlist or binary segment data.

**Security:** Only allows paths starting with `/Videos/` or `/video/`.

**Features:**
- Request deduplication (prevents concurrent FFmpeg spawns for the same URL)
- IPTV live-window filtering (when `iptv=1`)
- Automatic URL rewriting for nested playlists

### `POST /api/stream/stop`

Stop a playback session and release server resources.

**Body:**

```json
{
  "itemId": "jellyfin-item-id",
  "playSessionId": "session-id",
  "positionMs": 1234567
}
```

All fields are optional. If `itemId` is provided, stops that specific session.

**Response:** `{ "success": true, "stopped": "item-id" }`

**Side Effects:** Reports final playback position to Jellyfin (if progress sharing is enabled), stops the transcoding job.

### `POST /api/stream/progress`

Report periodic playback progress to Jellyfin.

**Body:**

```json
{
  "itemId": "jellyfin-item-id",
  "positionMs": 1234567
}
```

**Response:**

```json
{ "success": true, "reported": true }
```

**Requires:** `share_playback_progress` setting must be enabled. Returns `{ "reported": false, "reason": "disabled" }` otherwise.

### `GET /api/stream/sessions`

List all active playback sessions (debug endpoint).

**Response:**

```json
{
  "count": 2,
  "sessions": [
    { "itemId": "abc", "playSessionId": "xyz" }
  ]
}
```

### `DELETE /api/stream/sessions`

Stop all active playback sessions (debug endpoint).

**Response:** `{ "cleared": 2, "stopped": ["item1", "item2"] }`

### `GET /api/images/:itemId/:imageType`

Proxy a Jellyfin image with optional resizing and caching.

**Path Params:**
- `itemId` — Jellyfin item ID
- `imageType` — Image type: `Primary`, `Backdrop`, `Banner`, `Guide`, `Thumb`, etc.

**Query Params:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `maxWidth` | number | `400` | Max image width in pixels |

**Response:** Image binary (`image/jpeg` or `image/png`).

**Caching:** `Cache-Control: public, max-age=86400` (24 hours) unless Jellyfin provides its own header.

---

## Settings

### `GET /api/settings`

Get all settings.

**Response:** Object with all setting key/value pairs.

### `PUT /api/settings`

Update one or more settings.

**Body:** Object with setting keys and values:

```json
{
  "preferred_audio_language": "eng",
  "share_playback_progress": true,
  "metrics_enabled": true
}
```

**Response:** All settings (same as GET).

**Validation:** Rejects keys not in the allowed list (see below).

### `GET /api/settings/:key`

Get a single setting.

**Path Params:** `key` — setting key

**Response:** `{ "key": "preferred_audio_language", "value": "eng" }`

**Error:** `404` if the key doesn't exist.

### `POST /api/settings/factory-reset`

Delete all data: settings, channels, schedules, servers.

**Response:** `{ "success": true }`

**Rate Limited:** Strict (90 req / 15 min).

### Allowed Setting Keys

| Key | Type | Description |
|-----|------|-------------|
| `selected_presets` | string[] | Preset IDs for channel generation |
| `max_channels` | number | Maximum channels to generate |
| `preferred_audio_language` | string | ISO 639 language code (e.g. `"eng"`) |
| `preferred_subtitle_index` | number | Default subtitle track index (`null` = off) |
| `share_playback_progress` | boolean | Sync watch progress to Jellyfin |
| `metrics_enabled` | boolean | Enable watch analytics |
| `preview_bg` | string | Guide preview background preference |
| `genre_filter` | string[] | Filter channels by genre |
| `content_types` | string[] | Filter by content type |
| `rating_filter` | string[] | Filter by content rating |
| `separate_content_types` | boolean | Separate movies and TV into distinct channels |
| `schedule_auto_update_enabled` | boolean | Enable automatic schedule extension |
| `schedule_auto_update_hours` | number | Hours between auto-updates (1–168) |
| `channel_count` | number | Target number of channels |
| `visible_channels` | number[] | Channel IDs visible in the guide |
| `openrouter_api_key` | string | OpenRouter API key (encrypted at rest) |
| `openrouter_model` | string | AI model identifier |
| `unwatched_only` | boolean | Only schedule unwatched content |
| `iptv_enabled` | boolean | Enable IPTV endpoints |
| `iptv_base_url` | string | External base URL for IPTV playlist URLs |
| `iptv_timezone` | string | Timezone for XMLTV EPG times |
| `schedule_alignment` | string | Schedule alignment preference |

---

## Servers

### `GET /api/servers/discover`

Auto-discover Jellyfin servers on the local network via UDP broadcast (port 7359) and HTTP probes.

**Response:**

```json
[
  { "id": "server-guid", "name": "My Jellyfin", "address": "http://192.168.1.50:8096" }
]
```

**Timeout:** ~3 seconds.

### `GET /api/servers`

List all configured servers (sensitive tokens are excluded).

**Response:**

```json
[
  {
    "id": 1,
    "name": "My Jellyfin",
    "url": "http://192.168.1.50:8096",
    "username": "admin",
    "is_active": true,
    "is_authenticated": true,
    "created_at": "2026-02-23T00:00:00.000Z"
  }
]
```

### `POST /api/servers`

Add and authenticate a new Jellyfin server.

**Body:**

```json
{
  "name": "My Jellyfin",
  "url": "http://192.168.1.50:8096",
  "username": "admin",
  "password": "password123"
}
```

**Response:** Server object (same as GET).

**Security:** SSRF protection — private IP ranges are blocked for the URL.

**Side Effects:** If this becomes the active server, triggers a background library sync and channel generation.

### `PUT /api/servers/:id`

Update server details. Include `password` to re-authenticate.

**Path Params:** `id` — server ID

**Body:**

```json
{
  "name": "Renamed Server",
  "url": "http://new-ip:8096",
  "username": "admin",
  "password": "new-password"
}
```

### `DELETE /api/servers/:id`

Delete a server and all related data (channels, schedules, library cache).

**Path Params:** `id` — server ID

**Response:** `{ "success": true }`

### `POST /api/servers/:id/test`

Test connectivity and authentication to a server.

**Path Params:** `id` — server ID

**Response:**

```json
{ "connected": true, "authenticated": true }
```

### `POST /api/servers/:id/reauthenticate`

Re-authenticate with a new password (e.g., after token expiry).

**Path Params:** `id` — server ID

**Body:** `{ "password": "new-password" }`

**Response:** `{ "success": true, "authenticated": true }`

### `POST /api/servers/:id/activate`

Set a server as the active server (triggers full library reload).

**Path Params:** `id` — server ID

**Response:** `{ "success": true }`

**Side Effects:** Syncs library, auto-generates channels, rebuilds schedules.

### `POST /api/servers/:id/resync`

Manually re-sync the Jellyfin library and refresh schedules.

**Path Params:** `id` — server ID

**Response:** `{ "success": true, "item_count": 1523 }`

**WebSocket:** Broadcasts `generation:progress` through sync → scheduling → complete.

---

## Metrics

All metrics endpoints require the `metrics_enabled` setting to be `true`. When disabled, they return immediately with `{ "success": true, "enabled": false }`.

### `POST /api/metrics/start`

Record the start of a watch session.

**Body:**

```json
{
  "client_id": "browser-uuid",
  "channel_id": 1,
  "channel_name": "Movies",
  "item_id": "jellyfin-item-id",
  "title": "The Matrix",
  "series_name": null,
  "content_type": "movie"
}
```

`client_id` is required. All other fields are optional.

**Response:** `{ "success": true, "session_id": "uuid" }`

### `POST /api/metrics/stop`

End a watch session.

**Body:** `{ "client_id": "browser-uuid" }`

**Response:** `{ "success": true }`

### `POST /api/metrics/channel-switch`

Record a channel switch event.

**Body:**

```json
{
  "client_id": "browser-uuid",
  "from_channel_id": 1,
  "from_channel_name": "Movies",
  "to_channel_id": 3,
  "to_channel_name": "Sci-Fi"
}
```

**Response:** `{ "success": true }`

### `GET /api/metrics/dashboard`

Get aggregated watch statistics.

**Query Params:** `range` — `24h`, `7d` (default), `30d`, or `all`

**Response:** Dashboard object with total watch time, popular channels, popular items, session counts, etc.

### `DELETE /api/metrics/data`

Clear all recorded metrics data.

**Response:** `{ "success": true }`

---

## IPTV

IPTV endpoints use token-based auth via the `token` query parameter (separate from header-based API key auth). When `PREVUE_API_KEY` is not set, no token is needed.

### `GET /api/iptv/playlist.m3u`

Get an M3U playlist compatible with IPTV players (VLC, Kodi, etc.).

**Query Params:** `token` — API key (if auth enabled)

**Response:** `Content-Type: audio/x-mpegurl`

```
#EXTM3U url-tvg="http://host:3080/api/iptv/epg.xml?token=KEY"
#EXTINF:-1 tvg-id="ch-1" tvg-name="Movies" tvg-chno="1" tvg-logo="http://host:3080/api/images/abc/Primary?maxWidth=200" group-title="Action",Movies
http://host:3080/api/iptv/channel/1?token=KEY
```

**Features:** Channel logos, genre grouping, EPG URL header.

### `GET /api/iptv/epg.xml`

Get an XMLTV electronic program guide.

**Query Params:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `token` | string | — | API key (if auth enabled) |
| `hours` | number | `24` | Hours of guide data (max 48) |

**Response:** `Content-Type: application/xml` — XMLTV format.

**Caching:** 5-minute server-side cache. Invalidated when channel count or params change.

**Features:** Episode numbers, MPAA/VCHIP ratings, program icons, descriptions, 12-hour lookback.

### `GET /api/iptv/channel/:channelNumber`

Get a live HLS stream for a channel. VOD content is presented as live TV with a sliding window — external players see a live stream and cannot scrub.

**Path Params:** `channelNumber` — channel number (not ID)

**Query Params:** `token` — API key (if auth enabled)

**Response:** `Content-Type: application/vnd.apple.mpegurl` — HLS master playlist.

**Codecs:** h264 + AAC (maximum compatibility).

**Errors:**
- `404` — Channel not found
- `503` + `Retry-After: 5` — No program currently airing

### `GET /api/iptv/status`

Get IPTV configuration status for the settings UI.

**Query Params:** `token` — API key (if auth enabled)

**Response:**

```json
{
  "enabled": true,
  "playlistUrl": "http://host:3080/api/iptv/playlist.m3u?token=KEY",
  "epgUrl": "http://host:3080/api/iptv/epg.xml?token=KEY",
  "channelCount": 12
}
```

---

## Assets

### `GET /api/assets/music/:filename`

Serve a background music file (static).

**Auth:** No

**Response:** Audio file (MP3, OGG, WAV, M4A, AAC).

### `GET /api/assets/music-list`

List all available background music tracks.

**Auth:** No

**Response:**

```json
[
  "/api/assets/music/bg1.mp3",
  "/api/assets/music/bg2.mp3"
]
```

---

## Type Definitions

### Channel

```typescript
{
  id: number;
  number: number;
  name: string;
  type: "auto" | "custom" | "preset";
  genre: string | null;
  preset_id: string | null;
  item_ids: string[];
  ai_prompt: string | null;
  sort_order: number;
  created_at: string;          // ISO 8601
}
```

### ScheduleProgram

```typescript
{
  media_item_id: string;
  title: string;
  subtitle: string | null;     // e.g. "S01E05 - Pilot"
  start_time: string;          // ISO 8601
  end_time: string;            // ISO 8601
  duration_ms: number;
  type: "program" | "interstitial";
  content_type: "movie" | "episode" | null;
  backdrop_url: string | null; // /api/images/{id}/Backdrop
  guide_url: string | null;    // /api/images/{id}/Guide
  thumbnail_url: string | null;// /api/images/{id}/Primary
  banner_url: string | null;   // /api/images/{id}/Banner
  year: number | null;
  rating: string | null;       // e.g. "PG-13"
  resolution: string | null;   // e.g. "4K", "1080p"
  description: string | null;
}
```

### ScheduleBlock

```typescript
{
  id: number;
  channel_id: number;
  block_start: string;         // ISO 8601
  block_end: string;           // ISO 8601
  programs: ScheduleProgram[];
  seed: string;
  created_at: string;          // ISO 8601
}
```

### PlaybackInfo

```typescript
{
  stream_url: string;          // HLS master playlist URL (null for interstitials)
  seek_position_ms: number;    // Position in media file (ms)
  seek_position_seconds: number;
  program: ScheduleProgram;
  next_program: ScheduleProgram | null;
  channel: Channel;
  is_interstitial: boolean;
  audio_tracks: AudioTrackInfo[];
  audio_stream_index: number | null;
  subtitle_tracks: SubtitleTrackInfo[];
  subtitle_index: number | null;
  outro_start_ms: number | null; // Credits start position (ms), from MediaSegments
}
```

### AudioTrackInfo

```typescript
{
  index: number;
  language: string;            // ISO 639 (e.g. "eng")
  name: string;                // e.g. "English - AAC Stereo"
}
```

### SubtitleTrackInfo

```typescript
{
  index: number;
  language: string;
  name: string;
}
```

### WSEvent

```typescript
type WSEvent =
  | { type: "schedule:updated"; payload: { channel_id: number; block: ScheduleBlock } }
  | { type: "channel:added"; payload: Channel }
  | { type: "channel:removed"; payload: { id: number } }
  | { type: "channels:regenerated"; payload: { count: number } }
  | { type: "library:synced"; payload: { item_count: number } }
  | { type: "generation:progress"; payload: { step: string; message: string; current?: number; total?: number } };
```
