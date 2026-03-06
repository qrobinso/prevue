import type Database from 'better-sqlite3';
import type { MediaItem, ServerConfig } from '../types/index.js';
import type { PlaybackInfoResult, StreamInfo } from './MediaProvider.js';
import { AbstractMediaProvider } from './AbstractMediaProvider.js';
import * as queries from '../db/queries.js';
import { randomUUID } from 'crypto';

// ─── Plex API response shapes (subset) ─────────────────

interface PlexMediaContainer<T> {
  MediaContainer: {
    size?: number;
    totalSize?: number;
    Metadata?: T[];
    Directory?: T[];
  };
}

interface PlexMetadata {
  ratingKey: string;
  key?: string;
  type: string; // 'movie' | 'episode' | 'show' | 'season'
  title: string;
  grandparentTitle?: string;   // Series name (for episodes)
  parentTitle?: string;        // Season name (for episodes)
  grandparentRatingKey?: string; // SeriesId (for episodes)
  index?: number;              // Episode number
  parentIndex?: number;        // Season number
  duration?: number;           // ms
  summary?: string;
  year?: number;
  contentRating?: string;      // e.g. "PG-13", "TV-MA"
  rating?: number;             // critic/community rating 0-10
  audienceRating?: number;     // audience rating 0-10
  ratingImage?: string;        // e.g. "rottentomatoes://image.rating.ripe"
  audienceRatingImage?: string; // e.g. "rottentomatoes://image.rating.upright"
  studio?: string;
  Genre?: { tag: string }[];
  Role?: { tag: string; role?: string }[];
  Director?: { tag: string }[];
  thumb?: string;
  art?: string;
  parentThumb?: string;
  grandparentThumb?: string;
  grandparentArt?: string;
  Media?: PlexMedia[];
  viewCount?: number;
  lastViewedAt?: number;
  addedAt?: number;
}

interface PlexMedia {
  id: number;
  duration?: number;
  videoResolution?: string;
  Part?: PlexPart[];
  videoProfile?: string;
}

interface PlexPart {
  id: number;
  key: string;
  duration?: number;
  Stream?: PlexStream[];
}

interface PlexStream {
  id: number;
  streamType: number; // 1=video, 2=audio, 3=subtitle
  codec?: string;
  displayTitle?: string;
  language?: string;
  languageCode?: string;
  width?: number;
  height?: number;
  bitDepth?: number;
  colorPrimaries?: string;
  colorTrc?: string;
  DOVIPresent?: boolean;
  // Subtitle-specific
  forced?: boolean;   // true = forced subtitle track
  key?: string;       // path to external/sidecar subtitle file (e.g. /library/streams/12345)
  selected?: boolean; // Plex-default selected track
}

interface PlexLibrarySection {
  key: string;
  title: string;
  type: string; // 'movie' | 'show'
}

const PLEX_PRODUCT = 'Prevue';
const PLEX_VERSION = '1.0.0';

export class PlexClient extends AbstractMediaProvider {
  readonly providerType = 'plex' as const;
  readonly capabilities = { supportsMediaSegments: false, supportsServerDiscovery: false, supportsReAuth: false };
  private deviceId: string;

  constructor(db: Database.Database) {
    super(db);
    this.deviceId = randomUUID();
  }

  // ─── Plex request helpers ──────────────────────────────

  private getActiveServerOrThrow(): ServerConfig {
    const server = this.getActiveServer();
    if (!server) throw new Error('No active Plex server configured');
    return server;
  }

  private getServerUrl(): string {
    return this.getActiveServerOrThrow().url.replace(/\/$/, '');
  }

  private getPlexHeaders(): Record<string, string> {
    const server = this.getActiveServerOrThrow();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Plex-Product': PLEX_PRODUCT,
      'X-Plex-Version': PLEX_VERSION,
      'X-Plex-Client-Identifier': server.plex_client_id || this.deviceId,
    };
    if (server.access_token) {
      headers['X-Plex-Token'] = server.access_token;
    }
    return headers;
  }

  private async plexFetch<T>(path: string, options?: RequestInit): Promise<T> {
    const baseUrl = this.getServerUrl();
    const url = `${baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.getPlexHeaders(),
        ...(options?.headers || {}),
      },
    });
    if (!response.ok) {
      throw new Error(`Plex API error ${response.status}: ${response.statusText} (${path})`);
    }
    return response.json() as Promise<T>;
  }

  // ─── Server Management ────────────────────────────────

  getActiveServer(): ServerConfig | undefined {
    return queries.getActiveServer(this.db);
  }

  async testConnection(serverUrl?: string): Promise<boolean> {
    try {
      const url = (serverUrl || this.getServerUrl()).replace(/\/$/, '');
      const server = this.getActiveServer();
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-Plex-Product': PLEX_PRODUCT,
        'X-Plex-Version': PLEX_VERSION,
        'X-Plex-Client-Identifier': server?.plex_client_id || this.deviceId,
      };
      if (!serverUrl && server?.access_token) {
        headers['X-Plex-Token'] = server.access_token;
      }
      const response = await fetch(`${url}/identity`, { headers });
      return response.ok;
    } catch {
      return false;
    }
  }

  resetApi(): void {
    // No persistent API client to reset for Plex (raw fetch)
  }

  // ─── Library ──────────────────────────────────────────

  async syncLibrary(onProgress?: (message: string) => void): Promise<MediaItem[]> {
    const server = this.getActiveServer();
    if (!server) {
      console.log('[Plex] No active server to sync');
      return [];
    }

    console.log(`[Plex] Syncing library for server ${server.id} (${server.name})...`);

    // Get library sections
    const sectionsData = await this.plexFetch<PlexMediaContainer<PlexLibrarySection>>('/library/sections');
    const sections = sectionsData.MediaContainer.Directory || [];

    const allItems: MediaItem[] = [];

    await Promise.all(sections.map(async (section) => {
      if (section.type === 'movie') {
        onProgress?.(`Fetching movies from "${section.title}"...`);
        const movies = await this.fetchSectionItems(section.key, 1);
        allItems.push(...movies);
        console.log(`[Plex] Section "${section.title}": ${movies.length} movies`);
      } else if (section.type === 'show') {
        onProgress?.(`Fetching episodes from "${section.title}"...`);
        const episodes = await this.fetchSectionEpisodes(section.key);
        allItems.push(...episodes);
        console.log(`[Plex] Section "${section.title}": ${episodes.length} episodes`);
      }
    }));

    // Cache in memory
    this.libraryItems.clear();
    for (const item of allItems) {
      this.libraryItems.set(item.Id, item);
    }

    // Cache in database
    const serverStillExists = queries.getServerById(this.db, server.id);
    if (serverStillExists) {
      try {
        const insertAll = this.db.transaction(() => {
          queries.clearLibraryCache(this.db, server.id);
          for (const item of allItems) {
            queries.upsertLibraryItem(this.db, item.Id, server.id, item);
          }
        });
        insertAll();
      } catch (err) {
        console.error('[Plex] Failed to cache library in database:', err);
      }
    }

    const movies = allItems.filter(i => i.Type === 'Movie');
    const episodes = allItems.filter(i => i.Type === 'Episode');
    console.log(`[Plex] Synced ${movies.length} movies and ${episodes.length} episodes`);
    return allItems;
  }

  private async fetchSectionItems(sectionKey: string, plexType: number): Promise<MediaItem[]> {
    const items: MediaItem[] = [];
    let start = 0;
    const pageSize = 500;

    while (true) {
      const data = await this.plexFetch<PlexMediaContainer<PlexMetadata>>(
        `/library/sections/${sectionKey}/all?type=${plexType}&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${pageSize}`
      );
      const metadata = data.MediaContainer.Metadata || [];
      for (const m of metadata) {
        items.push(this.mapToNormalized(m));
      }
      const totalSize = data.MediaContainer.totalSize ?? metadata.length;
      if (items.length >= totalSize || metadata.length === 0) break;
      start += pageSize;
    }

    return items;
  }

  private async fetchSectionEpisodes(sectionKey: string): Promise<MediaItem[]> {
    // First, fetch all shows (type=2) to get genres, studio, and rating metadata
    // that Plex only stores at the show level, not on individual episodes.
    const showMetaMap = await this.fetchShowMetadata(sectionKey);

    // Plex type 4 = episodes
    const episodes = await this.fetchSectionItems(sectionKey, 4);

    // Enrich episodes with parent show metadata
    for (const ep of episodes) {
      const showMeta = ep.SeriesId ? showMetaMap.get(ep.SeriesId) : undefined;
      if (showMeta) {
        if (!ep.Genres || ep.Genres.length === 0) ep.Genres = showMeta.genres;
        if (!ep.OfficialRating) ep.OfficialRating = showMeta.contentRating;
        if (!ep.Studios || ep.Studios.length === 0) ep.Studios = showMeta.studios;
        if (!ep.CommunityRating) ep.CommunityRating = showMeta.rating;
        if (!ep.AudienceRating) ep.AudienceRating = showMeta.audienceRating;
        if (!ep.RatingImage) ep.RatingImage = showMeta.ratingImage;
        if (!ep.AudienceRatingImage) ep.AudienceRatingImage = showMeta.audienceRatingImage;
      }
    }

    return episodes;
  }

  /**
   * Fetch show-level metadata (genres, studio, content rating) for all shows in a section.
   * Returns a map of show ratingKey → metadata.
   */
  private async fetchShowMetadata(sectionKey: string): Promise<Map<string, {
    genres: string[];
    contentRating?: string;
    studios: { Name: string }[];
    rating?: number;
    audienceRating?: number;
    ratingImage?: string;
    audienceRatingImage?: string;
  }>> {
    const metaMap = new Map<string, {
      genres: string[];
      contentRating?: string;
      studios: { Name: string }[];
      rating?: number;
      audienceRating?: number;
      ratingImage?: string;
      audienceRatingImage?: string;
    }>();

    let start = 0;
    const pageSize = 500;

    while (true) {
      const data = await this.plexFetch<PlexMediaContainer<PlexMetadata>>(
        `/library/sections/${sectionKey}/all?type=2&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${pageSize}`
      );
      const shows = data.MediaContainer.Metadata || [];
      for (const show of shows) {
        metaMap.set(show.ratingKey, {
          genres: show.Genre?.map(g => g.tag) ?? [],
          contentRating: show.contentRating,
          studios: show.studio ? [{ Name: show.studio }] : [],
          rating: show.rating,
          audienceRating: show.audienceRating,
          ratingImage: show.ratingImage,
          audienceRatingImage: show.audienceRatingImage,
        });
      }
      const totalSize = data.MediaContainer.totalSize ?? shows.length;
      if (metaMap.size >= totalSize || shows.length === 0) break;
      start += pageSize;
    }

    console.log(`[Plex] Fetched metadata for ${metaMap.size} shows in section ${sectionKey}`);
    return metaMap;
  }

  private mapToNormalized(m: PlexMetadata): MediaItem {
    const plexType = m.type?.toLowerCase();
    const normalizedType = plexType === 'movie' ? 'Movie' : plexType === 'episode' ? 'Episode' : 'Movie';

    // Map Plex duration (ms) to Jellyfin RunTimeTicks (100ns intervals = ms * 10000)
    const durationMs = m.duration ?? m.Media?.[0]?.duration ?? 0;
    const runTimeTicks = durationMs * 10000;

    // Build image tags from Plex thumb paths
    const imageTags: Record<string, string> = {};
    if (m.thumb) imageTags['Primary'] = m.thumb;

    // Build backdrop tags
    const backdropTags: string[] = [];
    if (m.art) backdropTags.push(m.art);

    // Map people
    const people: { Name: string; Type: string }[] = [];
    if (m.Role) {
      for (const r of m.Role) {
        people.push({ Name: r.tag, Type: 'Actor' });
      }
    }
    if (m.Director) {
      for (const d of m.Director) {
        people.push({ Name: d.tag, Type: 'Director' });
      }
    }

    // Map studios
    const studios: { Name: string }[] = [];
    if (m.studio) {
      studios.push({ Name: m.studio });
    }

    // Map media sources for resolution
    const mediaSources: MediaItem['MediaSources'] = [];
    if (m.Media && m.Media.length > 0) {
      const media = m.Media[0];
      const mediaStreams: { Type?: string; Width?: number; Height?: number; BitDepth?: number; ColorPrimaries?: string; ColorTrc?: string; DOVIPresent?: boolean }[] = [];
      if (media.Part?.[0]?.Stream) {
        for (const s of media.Part[0].Stream) {
          if (s.streamType === 1) { // video
            mediaStreams.push({
              Type: 'Video',
              Width: s.width,
              Height: s.height,
              BitDepth: s.bitDepth,
              ColorPrimaries: s.colorPrimaries,
              ColorTrc: s.colorTrc,
              DOVIPresent: s.DOVIPresent,
            });
          }
        }
      }
      mediaSources.push({ MediaStreams: mediaStreams });
    }

    // Map user data
    const userData: MediaItem['UserData'] = {
      Played: (m.viewCount ?? 0) > 0,
      PlayedPercentage: undefined,
      IsFavorite: false,
      LastPlayedDate: m.lastViewedAt ? new Date(m.lastViewedAt * 1000).toISOString() : undefined,
    };

    return {
      Id: m.ratingKey,
      Name: m.title,
      Type: normalizedType,
      SeriesName: m.grandparentTitle,
      SeasonName: m.parentTitle,
      IndexNumber: m.index,
      ParentIndexNumber: m.parentIndex,
      RunTimeTicks: runTimeTicks,
      Genres: m.Genre?.map(g => g.tag) ?? [],
      ImageTags: imageTags,
      BackdropImageTags: backdropTags.length > 0 ? backdropTags : null,
      ParentBackdropImageTags: m.grandparentArt ? [m.grandparentArt] : null,
      ParentBackdropItemId: m.grandparentRatingKey ?? null,
      Overview: m.summary,
      ProductionYear: m.year,
      SeriesId: m.grandparentRatingKey,
      OfficialRating: m.contentRating,
      Studios: studios,
      DateCreated: m.addedAt ? new Date(m.addedAt * 1000).toISOString() : undefined,
      CommunityRating: m.rating,
      AudienceRating: m.audienceRating,
      RatingImage: m.ratingImage,
      AudienceRatingImage: m.audienceRatingImage,
      People: people,
      MediaSources: mediaSources,
      UserData: userData,
    };
  }

  // ─── Library Access ───────────────────────────────────

  async getItemDetails(itemId: string): Promise<{ overview: string | null; genres?: string[]; communityRating?: number; audienceRating?: number; ratingImage?: string; audienceRatingImage?: string; studios?: string[]; cast?: string[] }> {
    const cached = this.libraryItems.get(itemId);
    if (cached) {
      return {
        overview: cached.Overview ?? null,
        genres: cached.Genres ?? undefined,
        communityRating: cached.CommunityRating ?? undefined,
        audienceRating: cached.AudienceRating ?? undefined,
        ratingImage: cached.RatingImage ?? undefined,
        audienceRatingImage: cached.AudienceRatingImage ?? undefined,
        studios: cached.Studios?.map(s => s.Name).slice(0, 2) ?? undefined,
        cast: cached.People?.filter(p => p.Type === 'Actor').slice(0, 3).map(p => p.Name) ?? undefined,
      };
    }

    try {
      const data = await this.plexFetch<PlexMediaContainer<PlexMetadata>>(`/library/metadata/${itemId}`);
      const m = data.MediaContainer.Metadata?.[0];
      if (!m) return { overview: null };
      return {
        overview: m.summary ?? null,
        genres: m.Genre?.map(g => g.tag),
        communityRating: m.rating,
        audienceRating: m.audienceRating,
        ratingImage: m.ratingImage,
        audienceRatingImage: m.audienceRatingImage,
        studios: m.studio ? [m.studio] : undefined,
        cast: m.Role?.slice(0, 3).map(r => r.tag),
      };
    } catch (err) {
      console.error('[Plex] getItemDetails failed:', err);
      return { overview: null };
    }
  }

  getItemDurationMs(item: MediaItem): number {
    // RunTimeTicks is stored as 100ns intervals (Jellyfin format)
    return item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10000) : 0;
  }

  // ─── Collections & Playlists ──────────────────────────

  async getCollections(): Promise<{ id: string; name: string; items: MediaItem[] }[]> {
    try {
      const sectionsData = await this.plexFetch<PlexMediaContainer<PlexLibrarySection>>('/library/sections');
      const sections = sectionsData.MediaContainer.Directory || [];

      const collections: { id: string; name: string; items: MediaItem[] }[] = [];

      for (const section of sections) {
        try {
          const collectionsData = await this.plexFetch<PlexMediaContainer<PlexMetadata>>(
            `/library/sections/${section.key}/collections`
          );
          const metas = collectionsData.MediaContainer.Metadata || [];

          for (const col of metas) {
            try {
              const childrenData = await this.plexFetch<PlexMediaContainer<PlexMetadata>>(
                `/library/collections/${col.ratingKey}/children`
              );
              const rawChildren = childrenData.MediaContainer.Metadata || [];
              const children: MediaItem[] = [];

              for (const m of rawChildren) {
                if (m.type === 'show') {
                  // Collection contains a show — expand to its episodes from library cache
                  const showEpisodes = this.getLibraryItems().filter(
                    i => i.Type === 'Episode' && i.SeriesId === m.ratingKey
                  );
                  children.push(...showEpisodes);
                } else if (m.duration) {
                  children.push(this.mapToNormalized(m));
                }
              }

              if (children.length > 0) {
                collections.push({ id: col.ratingKey, name: col.title, items: children });
              }
            } catch { /* skip failed collection */ }
          }
        } catch { /* section may not support collections */ }
      }

      console.log(`[Plex] Found ${collections.length} collections with content`);
      return collections;
    } catch (err) {
      console.error('[Plex] Failed to fetch collections:', err);
      return [];
    }
  }

  async getPlaylists(): Promise<{ id: string; name: string; items: MediaItem[] }[]> {
    try {
      const data = await this.plexFetch<PlexMediaContainer<PlexMetadata>>('/playlists?playlistType=video');
      const metas = data.MediaContainer.Metadata || [];
      const playlists: { id: string; name: string; items: MediaItem[] }[] = [];

      for (const pl of metas) {
        try {
          const itemsData = await this.plexFetch<PlexMediaContainer<PlexMetadata>>(
            `/playlists/${pl.ratingKey}/items`
          );
          const items = (itemsData.MediaContainer.Metadata || [])
            .filter(m => m.duration)
            .map(m => this.mapToNormalized(m));

          if (items.length > 0) {
            playlists.push({ id: pl.ratingKey, name: pl.title, items });
          }
        } catch { /* skip failed playlist */ }
      }

      console.log(`[Plex] Found ${playlists.length} playlists with content`);
      return playlists;
    } catch (err) {
      console.error('[Plex] Failed to fetch playlists:', err);
      return [];
    }
  }

  // ─── Playback ─────────────────────────────────────────

  async getPlaybackInfo(itemId: string): Promise<PlaybackInfoResult> {
    // Plex doesn't have an exact equivalent to Jellyfin's PlaybackInfo.
    // We fetch the item metadata to get media source info and generate a session ID.
    const data = await this.plexFetch<PlexMediaContainer<PlexMetadata>>(`/library/metadata/${itemId}`);
    const m = data.MediaContainer.Metadata?.[0];
    const playSessionId = randomUUID();
    const mediaSourceId = m?.Media?.[0]?.id?.toString() || itemId;

    // Collect streams from all parts (some Plex items split media across parts)
    const allStreams: NonNullable<NonNullable<PlaybackInfoResult['MediaSources']>[0]['MediaStreams']> = [];
    const parts = m?.Media?.[0]?.Part ?? [];
    for (const part of parts) {
      if (!part.Stream) continue;
      for (const s of part.Stream) {
        // Plex may return streamType as string in some server versions
        const st = Number(s.streamType);
        allStreams.push({
          Type: st === 1 ? 'Video' : st === 2 ? 'Audio' : st === 3 ? 'Subtitle' : null,
          Index: s.id,
          Language: s.languageCode ?? s.language ?? null,
          DisplayTitle: s.displayTitle ?? null,
          Title: s.displayTitle ?? null,
          Codec: s.codec ?? null,
          IsForced: s.forced ?? false,
          // External subtitles have a key pointing to /library/streams/{id}
          IsExternal: !!s.key,
          Key: s.key ?? null,
        });
      }
    }

    const subtitleCount = allStreams.filter(s => s.Type === 'Subtitle').length;
    const audioCount = allStreams.filter(s => s.Type === 'Audio').length;
    console.log(`[Plex] getPlaybackInfo item=${itemId}: ${allStreams.length} streams (${audioCount} audio, ${subtitleCount} subtitle, ${parts.length} parts)`);

    return {
      PlaySessionId: playSessionId,
      MediaSources: [{ Id: mediaSourceId, MediaStreams: allStreams.length > 0 ? allStreams : [] }],
    };
  }

  async getHlsStreamUrl(itemId: string, startPositionTicks?: number, options?: { bitrate?: number; maxWidth?: number; subtitleStreamIndex?: number; audioStreamIndex?: number }): Promise<StreamInfo> {
    // Fetch fresh metadata — needed for partId (subtitle stream persistence) and HDR detection
    const data = await this.plexFetch<PlexMediaContainer<PlexMetadata>>(`/library/metadata/${itemId}`);
    const m = data.MediaContainer.Metadata?.[0];
    const playSessionId = randomUUID();
    const mediaSourceId = m?.Media?.[0]?.id?.toString() || itemId;

    // Determine HDR from fresh metadata — use actual stream HDR fields
    const videoStream = m?.Media?.[0]?.Part?.[0]?.Stream?.find(s => s.streamType === 1);
    const isHdrSource = !!(
      videoStream?.DOVIPresent ||
      (videoStream?.bitDepth && videoStream.bitDepth >= 10 && (
        videoStream.colorPrimaries === 'bt2020' ||
        videoStream.colorTrc === 'smpte2084' ||
        videoStream.colorTrc === 'arib-std-b67'
      ))
    );

    const baseUrl = this.getServerUrl();
    const server = this.getActiveServerOrThrow();

    // ── Persist subtitle/audio selection via Plex's /library/parts API ──────
    // This is the canonical Plex way (used by Plex Web, Plezy, etc.) — sets the
    // preferred stream server-side so Plex knows which subtitle to include.
    const partId = m?.Media?.[0]?.Part?.[0]?.id;
    if (partId && options?.subtitleStreamIndex != null) {
      const putParams = new URLSearchParams({
        subtitleStreamID: String(options.subtitleStreamIndex),
        allParts: '1',
        'X-Plex-Token': server.access_token || '',
      });
      await fetch(`${baseUrl}/library/parts/${partId}?${putParams}`, {
        method: 'PUT',
        headers: this.getPlexHeaders(),
      }).catch((err) => console.warn('[Plex] selectStreams PUT failed:', err));
      console.log(`[Plex] Persisted subtitle stream ${options.subtitleStreamIndex} on part ${partId}`);
    }
    if (partId && options?.audioStreamIndex != null) {
      const putParams = new URLSearchParams({
        audioStreamID: String(options.audioStreamIndex),
        allParts: '1',
        'X-Plex-Token': server.access_token || '',
      });
      await fetch(`${baseUrl}/library/parts/${partId}?${putParams}`, {
        method: 'PUT',
        headers: this.getPlexHeaders(),
      }).catch((err) => console.warn('[Plex] selectAudioStream PUT failed:', err));
      console.log(`[Plex] Persisted audio stream ${options.audioStreamIndex} on part ${partId}`);
    }

    // Build Plex universal transcode URL
    const metadataKey = `/library/metadata/${itemId}`;
    const clientId = server.plex_client_id || this.deviceId;
    const needsTranscode = !!(options?.bitrate || options?.maxWidth || options?.subtitleStreamIndex != null);
    const params = new URLSearchParams({
      path: metadataKey,
      mediaIndex: '0',
      partIndex: '0',
      protocol: 'hls',
      fastSeek: '1',
      directPlay: '0',
      directStream: needsTranscode ? '0' : '1',
      // Required codec targets when transcoding — Plex returns 400 without these when directStream=0.
      // directStreamAudio must NOT be set when transcoding (directStream=0) — it conflicts with
      // audioCodec and causes Plex to return 400 on session restarts (e.g. subtitle track changes).
      ...(needsTranscode
        ? { videoCodec: 'h264', audioCodec: 'aac,mp3,vorbis,opus' }
        : { directStreamAudio: '1' }),
      videoQuality: '100',
      maxVideoBitrate: options?.bitrate ? String(Math.round(options.bitrate / 1000)) : '20000',
      videoResolution: options?.maxWidth ? `${options.maxWidth}x${Math.round(options.maxWidth * 9 / 16)}` : '1920x1080',
      subtitleSize: '100',
      audioBoost: '100',
      location: 'lan',
      addDebugOverlay: '0',
      autoAdjustQuality: '0',
      session: playSessionId,
      'X-Plex-Session-Identifier': playSessionId,
      'X-Plex-Client-Identifier': clientId,
      'X-Plex-Product': PLEX_PRODUCT,
      'X-Plex-Version': PLEX_VERSION,
      'X-Plex-Platform': 'Chrome',
      'X-Plex-Token': server.access_token || '',
    });

    if (startPositionTicks) {
      // Convert 100ns ticks to seconds for Plex offset
      const offsetSec = Math.floor(startPositionTicks / 10000000);
      params.set('offset', offsetSec.toString());
    }

    // Subtitle and audio stream selection
    if (options?.subtitleStreamIndex != null) {
      params.set('subtitleStreamID', String(options.subtitleStreamIndex));
    }
    if (options?.audioStreamIndex != null) {
      params.set('audioStreamID', String(options.audioStreamIndex));
    }

    const url = `${baseUrl}/video/:/transcode/universal/start.m3u8?${params}`;
    console.log(`[Plex] HLS stream URL for item=${itemId}: ${url.substring(0, 200)}...`);
    return { url, playSessionId, isHdrSource, mediaSourceId };
  }

  async getMediaSegments(_itemId: string): Promise<{ outroStartMs: number | null; outroEndMs: number | null }> {
    // Plex doesn't have a native media segments API like Jellyfin's intro/outro detection
    return { outroStartMs: null, outroEndMs: null };
  }

  // ─── Session Management ───────────────────────────────

  async stopPlaybackSession(playSessionId: string): Promise<void> {
    try {
      const baseUrl = this.getServerUrl();
      const headers = this.getPlexHeaders();
      await fetch(`${baseUrl}/video/:/transcode/universal/stop?session=${playSessionId}`, {
        method: 'DELETE',
        headers,
      });
      console.log(`[Plex] Stopped playback session: ${playSessionId}`);
    } catch (err) {
      console.error(`[Plex] Failed to stop session ${playSessionId}:`, err);
    }
  }

  async deleteTranscodingJob(_playSessionId: string): Promise<void> {
    // Plex uses the same stop endpoint; no separate transcode cleanup needed.
    // stopPlaybackSession already handles this — no-op here to avoid double-stopping.
  }

  // ─── Progress Reporting ───────────────────────────────

  async reportPlaybackStart(itemId: string, _playSessionId: string, _mediaSourceId: string, positionMs: number): Promise<void> {
    try {
      const baseUrl = this.getServerUrl();
      const headers = this.getPlexHeaders();
      const timeMs = Math.round(positionMs);
      await fetch(
        `${baseUrl}/:/timeline?ratingKey=${itemId}&state=playing&time=${timeMs}&duration=0&key=/library/metadata/${itemId}`,
        { method: 'GET', headers }
      );
      console.log(`[Plex] Reported playback start: item=${itemId}, position=${Math.round(positionMs / 1000)}s`);
    } catch (err) {
      console.error('[Plex] Failed to report playback start:', err);
    }
  }

  async reportPlaybackProgress(itemId: string, _playSessionId: string, _mediaSourceId: string, positionMs: number, isPaused?: boolean): Promise<void> {
    try {
      const baseUrl = this.getServerUrl();
      const headers = this.getPlexHeaders();
      const state = isPaused ? 'paused' : 'playing';
      const timeMs = Math.round(positionMs);
      await fetch(
        `${baseUrl}/:/timeline?ratingKey=${itemId}&state=${state}&time=${timeMs}&key=/library/metadata/${itemId}`,
        { method: 'GET', headers }
      );
    } catch (err) {
      console.error('[Plex] Failed to report playback progress:', err);
    }
  }

  async reportPlaybackStopped(itemId: string, _playSessionId: string, _mediaSourceId: string, positionMs: number): Promise<void> {
    try {
      const baseUrl = this.getServerUrl();
      const headers = this.getPlexHeaders();
      const timeMs = Math.round(positionMs);
      await fetch(
        `${baseUrl}/:/timeline?ratingKey=${itemId}&state=stopped&time=${timeMs}&key=/library/metadata/${itemId}`,
        { method: 'GET', headers }
      );
      console.log(`[Plex] Reported playback stopped: item=${itemId}, position=${Math.round(positionMs / 1000)}s`);
    } catch (err) {
      console.error('[Plex] Failed to report playback stopped:', err);
    }
  }

  // ─── Image / Proxy Helpers ────────────────────────────

  getImageUrl(itemId: string, imageType: string = 'Primary', maxWidth: number = 400): string {
    const server = this.getActiveServer();
    if (!server) return '';
    const baseUrl = server.url.replace(/\/$/, '');
    const token = server.access_token || '';

    // Ensure library cache is populated (may be empty after server restart)
    if (this.libraryItems.size === 0) {
      const cached = queries.getCachedLibrary(this.db, server.id) as MediaItem[];
      for (const item of cached) {
        this.libraryItems.set(item.Id, item);
      }
    }

    const item = this.libraryItems.get(itemId);
    let thumbPath: string | undefined;

    // Map all image type aliases to Plex thumb/art paths
    if (imageType === 'Primary' || imageType === 'Thumb' || imageType === 'Guide') {
      thumbPath = item?.ImageTags?.['Primary'];
    } else if (imageType === 'Backdrop' || imageType === 'Art' || imageType === 'Banner') {
      thumbPath = item?.BackdropImageTags?.[0] ?? undefined;
    }

    if (thumbPath) {
      return `${baseUrl}/photo/:/transcode?width=${maxWidth}&height=${Math.round(maxWidth * 1.5)}&minSize=1&upscale=1&url=${encodeURIComponent(thumbPath)}&X-Plex-Token=${token}`;
    }

    // Fallback: direct metadata thumb (works without library cache)
    return `${baseUrl}/library/metadata/${itemId}/thumb?X-Plex-Token=${token}`;
  }

  getBaseUrl(): string {
    return this.getServerUrl();
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  getProxyHeaders(): Record<string, string> {
    // Return only auth/identity headers for proxy requests (no Accept: application/json
    // which would interfere with HLS playlist and segment requests)
    const server = this.getActiveServerOrThrow();
    const headers: Record<string, string> = {
      'X-Plex-Product': PLEX_PRODUCT,
      'X-Plex-Version': PLEX_VERSION,
      'X-Plex-Platform': 'Chrome',
      'X-Plex-Client-Identifier': server.plex_client_id || this.deviceId,
    };
    if (server.access_token) {
      headers['X-Plex-Token'] = server.access_token;
    }
    return headers;
  }
}
