# Prevue
A self-hosted retro cable TV guide for Jellyfin and Plex. It turns your media library into a channel-surfing experience with auto-generated channels, a program guide, a built-in video player, and IPTV output for external apps.

Open source under CC BY-NC-SA 4.0. Free for personal and non-commercial use.

![Prevue](server/src/assets/img/title1.png)

## Why Prevue?

**No more decision fatigue.** You shouldn't have to choose what to watch every time you sit down. Just turn it on and something good is already playing.

**AI that stays out of the way.** Create channels with one-liners like "80s action movies", get notified when iconic scenes are playing live, catch up on movies already in progress. All optional, all powered by OpenRouter.

**Works on everything.** The guide is a PWA, so it runs great on iOS and Android without needing a native app. Fully customizable time windows, channel counts, colors, and layout.

**Completely free.** There are plenty of services now charging for cable TV-like experiences. It's your content, your servers, your home.

## Key Features

- **Self-hosted** - runs on your own server, Docker or bare metal
- **Jellyfin & Plex** - syncs your full movie and TV library
- **AI channel creation** - describe a channel in plain English ("90s nostalgia", "Christopher Nolan marathon") and it builds itself via OpenRouter
- **Preset and custom channels** - auto-generates by genre, era, director, actor, collection, and more. Or build your own manually.
- **Content filters** - filter by type, rating, genre, unwatched status
- **Hardware transcoding** - uses your media server's transcoding pipeline. Quality presets from 480p to 4K, HEVC supported.
- **Subtitles and audio tracks** - multi-track selection with per-language preferences
- **Guide and player** - retro Prevue Channel-style EPG grid, built-in HLS player, overlay controls, nerd stats, PiP
- **Iconic scene detection** - AI flags famous movie moments across the guide, player, and filters as they happen
- **"What Did I Miss"** - land on a movie already in progress and get a quick spoiler-free catch-up. Triggers after 15 seconds or press `M`.
- **Live ticker** - scrolling marquee with primetime picks, recently added titles, library stats, and trivia
- **Just Watch mode** - skip the guide, go straight to a channel picked by time of day and watch history
- **Sleep timer** - 15 to 120 minutes. Volume fades, screen dims, then a goodnight screen. Tap to snooze.
- **IPTV server** - M3U playlist and XMLTV EPG for Kodi, VLC, Jellyfin, TiviMate, etc.
- **Open source** - CC BY-NC-SA 4.0, non-commercial use

| EPG | Full Screen | Settings |
|:---:|:---:|:---:|
| ![EPG](server/src/assets/img/mobile1.PNG) | ![Full Screen](server/src/assets/img/mobile2.PNG) | ![Settings](server/src/assets/img/mobile3.PNG) |

## Quick Start (Docker)

```bash
cp .env.example .env
# Edit .env with your settings

docker compose up -d
```

Open `http://localhost:3080` and go to **Settings > Servers** to connect Jellyfin or Plex. Your library syncs automatically and channels are generated on first run.

## Quick Start (Development)

```bash
npm install
cp .env.example .env
npm run dev
```

- Client: http://localhost:5173 (Vite dev server, proxies API to :3080)
- Server: http://localhost:3080

## Documentation

| Doc | What's in it |
|-----|-------------|
| [Features](docs/FEATURES.md) | Channels, guide, player, AI features, IPTV, transcoding |
| [Configuration](docs/CONFIGURATION.md) | Environment variables, media server setup, production hardening, AI disclaimer |
| [Deployment](docs/DEPLOYMENT.md) | Docker, PWA install, Raspberry Pi cable box |
| [API Reference](docs/API.md) | All REST endpoints, Swagger/OpenAPI |
| [Architecture](docs/ARCHITECTURE.md) | System design, streaming pipeline, schedule engine, database schema |

## License

[Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-nc-sa/4.0/)

Free to use, share, and modify for non-commercial purposes. Commercial use requires explicit permission from the copyright holder.
