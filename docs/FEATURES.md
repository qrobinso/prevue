# Features

## Channels

### Auto-Generated Channels

On first sync, Prevue creates channels based on your library metadata:

- **Genre** - Action, Comedy, Drama, Horror, Sci-Fi, etc.
- **Era** - 80s, 90s, 2000s
- **Director** - Spielberg, Nolan, Fincher, etc.
- **Actor** - Hanks, DiCaprio, Streep, etc.
- **Collection** - box sets and collections from your media server
- **Composer** - Williams, Zimmer, Shore, etc.

### Preset Channels

Additional presets available in Settings:

- **Time & Mood** - Late Night, Saturday Morning, Feel Good
- **Audience** - Kids, Family, Adults Only
- **Smart** - Unwatched, Favorites, Continue Watching
- **Thematic** - Holiday, Cult Classics, Award Winners

### AI Channel Creation

With an OpenRouter API key, you can create channels by describing them:

> "80s action movies", "Studio Ghibli marathon", "movies about space exploration"

Prevue sends a compact summary of your library to the model, which picks matching content and builds the channel. Configure your API key in `.env` or **Settings > General > AI**.

Default model: `google/gemini-3-flash-preview` (configurable in Settings).

### Program Facts ("Did You Know")

When enabled in **Settings > General > AI**, Prevue generates trivia facts about currently airing programs.

## Iconic Scene Detection

AI identifies famous movie moments and surfaces them across the UI as they happen. Enable in **Settings > General > AI** with an OpenRouter API key.

### How It Works

When a schedule is generated, Prevue sends movie titles and runtimes to the configured LLM (default: Gemini 3 Flash). The model returns up to 2 iconic scenes per movie with timestamp ranges and explanations. Results are cached in SQLite so each movie is only analyzed once.

### Where Iconic Scenes Appear

- **Guide grid** - a purple pulsing dot appears next to the title when an iconic scene is playing
- **Guide filter** - "Iconic Scene Now" narrows the guide to channels with an active iconic scene
- **Program info modal** - shows all detected scenes with time ranges and explanations
- **Player notification** - bottom-of-screen alert when a scene is approaching or active
- **Settings** - toggle on/off, manually refresh, see last generation time

### Example

A movie like *The Empire Strikes Back* might have:

| Scene | Time | Why |
|-------|------|-----|
| "I am your father" | 1:28-1:33 | One of the most quoted and parodied reveals in cinema history |
| "Imperial March / AT-AT assault" | 0:12-0:18 | The Battle of Hoth is one of the most iconic sci-fi battle sequences ever filmed |

When one of these scenes is playing live, the guide shows a purple dot and the player shows a brief overlay.

## "What Did I Miss" (Catch-Up Summaries)

Land on a movie already in progress and get a quick spoiler-free summary. Enable in **Settings > General > AI** with an OpenRouter API key.

### How It Works

1. You land on a movie that's at least 5 minutes in
2. After 15 seconds (to avoid calls while channel surfing), Prevue sends the movie title, runtime, and elapsed time to the LLM
3. A notification appears with a catch-up: what's happened and what's on screen now
4. Results are cached in 10-minute buckets, so revisiting the same point reuses the summary

### Manual Trigger

Press `M` to request a catch-up on demand. `M` toggles the notification if it's already visible. Fresh LLM calls have a 1-minute cooldown; pressing `M` within the cooldown re-shows the last result. Works in fullscreen and the guide preview panel.

### Style

Short sentences, plain words, Hemingway-ish. Never says "you missed." Three to four sentences covering the plot so far and the current scene.

## Electronic Program Guide

- Retro Prevue Channel-inspired scrolling grid
- Configurable time window (1-4 hours) and visible channels (3-15)
- Program preview panel with artwork, title, description, and duration
- Color-coded entries (movies vs. episodes, customizable)
- Per-channel color coding with preset color palette
- Guide dividers for organizing your channel lineup
- Guide filters (Movies, TV Shows, Recently Started, Starting Soon, HD & 4K, Kids & Family, genre). Multiple filters stack. Filters apply to both guide and player navigation. Channels appear/disappear dynamically as programs change.
- Live ticker marquee with primetime picks, recently added titles, library stats, and trivia
- Auto-scroll with adjustable speed (slow, normal, fast)
- Classic or modern preview style
- Keyboard navigation (arrow keys, Enter to tune, Escape for settings)
- Touch and swipe support on mobile

## Built-in Player

- HLS adaptive bitrate streaming via hls.js
- Quality selection: Auto, 4K, 1080p, 720p, 480p
- Subtitle and audio track selection overlay
- Fullscreen, picture-in-picture, and video fit (contain/cover) modes
- Info overlay with channel name, program title, time remaining, and next up
- Promo overlay - periodic broadcast-style popups showing what's on, what's next, and what's starting soon on other channels. "Starting Soon" promos are clickable.
- Iconic scene notifications
- "What Did I Miss" catch-up summaries
- Sleep timer - press `T` or use player controls. Volume fades over the last 5 minutes, screen dims in the final 60 seconds, then a goodnight screen. Tap during wind-down to snooze.
- Nerd stats panel: resolution, bitrate, codec, FPS, buffer health
- Channel up/down while watching
- Progress reporting back to Jellyfin/Plex
- Auto-advances to next program when current one ends

## Just Watch Mode

Enable in **Settings > General > Just Watch** to skip the guide on launch. Prevue picks a channel automatically:

- **Time-of-day awareness** - morning favors kids/comedy, evening favors drama/action, late night favors thriller/comedy
- **Program freshness** - prefers channels where the program just started
- **Watch history** - avoids channels you've recently watched
- **Channel persistence** - remembers your last channel across refreshes

When Just Watch is enabled, the guide becomes an overlay you can pull up with `G` or `Escape`.

## Interstitial Screen

- Cinematic "coming soon" screen between programs with countdown, channel ident, lineup carousel, and program spotlight
- Ambient video texture overlay for visual depth
- Background music with audio-reactive animations
- CRT scanline overlay and floating particles

## Hardware Transcoding

Prevue proxies HLS streams through your media server's transcoding pipeline. If your server has hardware transcoding configured (VAAPI, NVENC, QSV, etc.), Prevue benefits automatically.

- Quality presets with configurable bitrate and resolution caps
- HEVC support (when your server is configured for it)
- Request deduplication to prevent duplicate transcoding jobs
- Idle session cleanup after 5 minutes of inactivity

## Subtitle Support

- Displays all available subtitle tracks (embedded and external)
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

The IPTV stream uses a sliding-window live mode so external players see a continuous live stream. EPG data covers 24-48 hours.

## API Resilience

- **Request deduplication** - concurrent identical GETs share a single in-flight fetch
- **Retry with backoff** - 429s are retried up to 3 times (1s/2s/4s), respects `Retry-After`
- **Debounced schedule reloads** - rapid WebSocket events collapse into a single reload (2s window)
- **Server-side caching** - item details (5-min TTL) and playback sessions (60s TTL) reduce API calls during navigation
