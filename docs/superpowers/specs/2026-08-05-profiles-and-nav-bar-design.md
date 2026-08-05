# Profiles & Top Navigation Bar — Design

**Date:** 2026-08-05
**Status:** Approved

## Summary

Prevue gains multi-user **profiles**. Each profile carries its own preferences, channel
lineup, and watch history. A new **top navigation bar** above the guide's preview video
exposes three destinations: the active profile, the guide, and settings. Settings moves
from a modal to a full-screen page, and a new profile page handles switching and
management.

Core configuration — media servers, channel definitions, schedule generation, API keys,
IPTV output — remains global and is shared by every profile.

## Motivation

Today every user preference lives in `localStorage`, so preferences are device-scoped and
anonymous. A household sharing one Prevue instance shares one set of guide colors, one
channel count, one sleep timer, and one watch history. Profiles make the guide personal
across devices: Joey's guide looks like Joey's guide on both the living room TV and the
iPad.

## Scope

### Per-profile

- All display preferences: theme, guide colors, ratings/year/resolution/HDR/artwork
  toggles, channel count, guide hours, visible channels, preview style, clock format,
  video quality, video fit
- Guide filters and guide customization (dividers, custom colors)
- Sleep timer settings
- AI feature toggles: Program Facts, Iconic Scenes, Hidden Gems, Catch-Up
- Last-watched channel / auto-tune state
- Subtitle and audio track preferences
- Channel lineup overrides (hide and reorder)
- Watch history and metrics attribution

### Global

- Media servers (Jellyfin/Plex) and library sync
- Channel definitions, presets, and generated schedule
- OpenRouter API key and AI service configuration
- IPTV (M3U/XMLTV) output configuration
- Aggregate metrics and connected-device tracking

## Data Model

```sql
CREATE TABLE profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  avatar_glyph TEXT NOT NULL DEFAULT '',   -- preset glyph id; '' renders a monogram
  avatar_color TEXT NOT NULL DEFAULT '#7c5cff',
  is_kids INTEGER NOT NULL DEFAULT 0,
  max_rating TEXT,                          -- NULL = unrestricted
  prefs TEXT NOT NULL DEFAULT '{}',         -- JSON blob of per-profile preferences
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE profile_channels (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  hidden INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER,
  PRIMARY KEY (profile_id, channel_id)
);
```

`watch_sessions` gains a nullable `profile_id INTEGER REFERENCES profiles(id)` column.
Nullable so pre-existing rows remain valid; aggregation treats `NULL` as unattributed.

Schema is added to `initDatabase()` in `server/src/db/index.ts`, following the project's
no-separate-migrations convention. `profile_channels` uses `ON DELETE CASCADE` for both
foreign keys so deleting a profile or a channel cannot orphan overrides.

### Why `prefs` is a JSON blob

The client reads preferences as a flat bag of roughly forty keys, always fetched and saved
wholesale. A blob is one row read and one row write with no join. A key/value table would
buy per-key querying that nothing needs.

## Migration

On boot, if `profiles` is empty, the server creates a single profile named **"Default"**
(`sort_order` 0, no kids flag, unrestricted rating). Boot is idempotent: a non-empty
`profiles` table is left untouched.

On the client, the first load after upgrade copies existing `localStorage` preference keys
into the active profile's `prefs` via a single `PUT`, guarded by a
`prevue_prefs_migrated` flag in `localStorage`. The first device to upgrade seeds Default
with its settings; subsequent devices no-op. Existing devices adopt Default through the
no-active-profile fallback, so nobody is confronted with a picker on first launch.

## Active Profile Resolution

The active profile is **device-local**: `prevue_active_profile_id` in `localStorage`,
alongside the existing `prevue_client_id`. The TV can stay on "Family" while a phone stays
on "Joey".

The client sends it as an `X-Profile-Id` header, set centrally in
`client/src/services/api.ts`, mirroring the existing `X-API-Key` pattern.

Resolution is defensive — a missing, malformed, or deleted profile id resolves to the
first profile by `sort_order` rather than erroring. The app must never block on profile
resolution, because it auto-tunes straight into video on launch.

There is no launch-blocking profile picker and no PIN. Without real authentication a PIN
is decorative — the API is reachable directly — and it is hostile to remote-control input.

## Server API

```
GET    /api/profiles                 list profiles
POST   /api/profiles                 create
PUT    /api/profiles/:id             update name / avatar / kids flag / max_rating
DELETE /api/profiles/:id             delete; 400 if it is the last profile
GET    /api/profiles/:id/prefs       preferences blob
PUT    /api/profiles/:id/prefs       merge-patch the blob
GET    /api/profiles/:id/lineup      hidden/order overrides
PUT    /api/profiles/:id/lineup      replace overrides
```

Routes follow the project's `{ success, data, error }` response pattern, live in
`server/src/routes/profiles.ts`, and are registered in `server/src/index.ts`. Queries go in
`server/src/db/queries.ts` with parameter binding. Types are added to
`server/src/types/index.ts` as the single source of truth, mirrored in
`client/src/types/index.ts`.

`PUT /prefs` is a **merge-patch**: supplied keys overwrite, omitted keys are preserved,
and unknown keys pass through unvalidated so client-side preferences can be added without
a server change. A malformed stored blob is treated as `{}` rather than throwing.

`/api/channels` and `/api/schedule` (the endpoint the guide actually renders from) apply the
calling profile's lineup overrides and rating ceiling **server-side**. `/api/playback/:channelId`
and `/api/stream/:itemId` re-check the ceiling too, so a deep link straight to playback can't
bypass what the guide already hides.

## Kids Profiles

A profile with `is_kids = 1` and a `max_rating` is restricted to content at or below that
rating, compared using the existing ordering in `server/src/data/ratingSystems.ts`.

Filtering is enforced on the server, in the channel, schedule, ticker, auto-tune, and
playback/stream paths. Client-side filtering alone would be decoration — a direct link or API
call would bypass it. Content with an unknown or missing rating is **blocked** for kids
profiles: failing closed is the correct default for a content ceiling.

**Known limitation:** IPTV output (M3U/XMLTV) is not filtered by any profile's ceiling — those
feeds are fetched by URL with no profile context attached, so there is nothing to enforce a
ceiling against. See [FEATURES.md](../../FEATURES.md#profiles).

Unrestricted profiles (`max_rating IS NULL`) are unaffected by every part of this path.

## Client Architecture

### `ProfileContext` (`client/src/contexts/ProfileContext.tsx`)

Holds the active profile and its preferences. Exposes the profile list, `setActiveProfile`,
and `setPref(key, value)`. Writes are applied optimistically to local state and flushed to
`PUT /prefs` on a debounce, so preference changes stay as immediate as `localStorage` was.
A failed write logs and retains the local value rather than reverting under the user.

### `usePref(key, default)` (`client/src/hooks/usePref.ts`)

Replaces the roughly forty `localStorage.getItem`/`setItem` pairs across
`DisplaySettings`, `GeneralSettings`, `ChannelSettings`, `guideFilterUtils`,
`guideCustomization`, `useSleepTimer`, `Player`, and `PreviewPanel`. The signature matches
`useState`, keeping each call site a mechanical edit. It returns the supplied default
before the fetch resolves, which is what makes the synchronous-to-async move safe.

### `NavBar` (`client/src/components/NavBar/`)

A floating pill row centered above the preview video: **Profile · Guide · Settings**. The
active destination is highlighted. It renders on `/`, `/settings`, and `/profile`, and is
**absent** on `/channel/:n` — nothing overlays fullscreen video. The guide header's gear
button is removed; the Settings pill replaces it.

The bar registers a new zone in `client/src/navigation/` so remote-control focus reaches it
from the top row of the guide grid.

### Routes

```
/              guide
/channel/:n    player
/settings      settings (full page)
/profile       profile switching and management
```

`Settings.tsx` becomes a routed full-screen page. Its section components
(`DisplaySettings`, `GeneralSettings`, and the rest) are unchanged; only the shell moves
from modal to page.

### Profile page (`/profile`)

- A grid of profile cards. Selecting one switches the active profile and returns to the
  guide.
- A **Manage** section: add a profile; edit name, avatar color and glyph, kids flag and max
  rating; delete a profile. The last remaining profile cannot be deleted.
- Preferences themselves are not duplicated here — they live on the Settings page and apply
  to whoever is active.

### Avatars

Preset only: a monogram derived from the name, rendered on a chosen accent color, with an
optional preset glyph. No uploads, no file storage, no serving path, consistent rendering
offline.

## Implementation Sequencing

Two phases, each independently shippable.

**Phase 1 — profiles exist.** Schema, boot migration, profiles API, `ProfileContext`,
`NavBar`, routed Settings and Profile pages, per-profile lineup, kids filtering, watch
history attribution. Preferences still read from `localStorage`.

**Phase 2 — preferences move.** Introduce `usePref`, convert call sites, run the one-time
`localStorage` migration.

The split isolates the main regression risk. Moving preferences from synchronous
`localStorage` to async server state touches many files, and anything reading a preference
during first render needs a sensible default before the fetch lands. `usePref` absorbs
that, but the conversion deserves its own reviewable change.

## Testing

The client currently has no tests. Because the riskiest code in this feature is
client-side, this design **adds Vitest, Testing Library, and jsdom to `client/`** — a
deliberate departure from the current convention.

### Server (Vitest, existing setup)

- Profile CRUD: create, rename, delete; last-profile-delete guard; cascade delete of
  `profile_channels`
- Prefs: merge-patch semantics; unknown-key passthrough; malformed stored JSON tolerated
- Lineup: hidden and reordered channels applied to `/api/channels`; a profile with no
  overrides receives the global lineup unchanged
- Kids: rating ceiling filters channels, schedule programs, and the playback/stream paths
  (IPTV output is a known, documented exception); unrestricted profiles unaffected; unknown
  or missing rating blocked for kids
- Migration: empty database seeds exactly one "Default"; repeated boots are idempotent
- `X-Profile-Id`: missing, invalid, and deleted ids fall back to the first profile and
  never return 500
- Regression guard: `watch_sessions` rows with `profile_id NULL` still aggregate correctly

### Client (new)

- `usePref`: returns the default before the fetch resolves; applies optimistically;
  debounces writes; retains the local value when a `PUT` fails
- `ProfileContext`: switching profile swaps prefs and re-renders consumers
- One-time migration: runs once, sets the guard flag, no-ops on a second mount
- `NavBar`: present on `/`, `/settings`, `/profile`; absent on `/channel/:n`

## Explicitly Out of Scope

- PIN or password protection on profiles
- Launch-blocking profile picker
- Avatar image upload
- Per-profile media server configuration
- Cross-device active-profile synchronization
