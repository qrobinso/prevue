import type { MediaItem, ServerConfig } from '../types/index.js';

/**
 * Normalized playback info returned by getPlaybackInfo().
 * Matches the shape of Jellyfin's PlaybackInfoResponse so existing consumers work unchanged.
 */
export interface PlaybackInfoResult {
  PlaySessionId?: string | null;
  MediaSources?: Array<{
    Id?: string | null;
    MediaStreams?: Array<{
      Type?: string | null;
      Index?: number | null;
      Language?: string | null;
      DisplayTitle?: string | null;
      Title?: string | null;
      Codec?: string | null;
      IsForced?: boolean;
      IsExternal?: boolean;
      Key?: string | null;
    }> | null;
  }> | null;
}

export interface StreamInfo {
  url: string;
  playSessionId: string;
  isHdrSource: boolean;
  mediaSourceId: string;
}

/**
 * Provider-agnostic interface for media server backends (Jellyfin, Plex, etc.).
 * All routes and services reference this interface instead of a concrete client.
 */
export interface MediaProviderCapabilities {
  supportsMediaSegments: boolean;
  supportsServerDiscovery: boolean;
  supportsReAuth: boolean;
}

export interface MediaProvider {
  readonly providerType: 'jellyfin' | 'plex';
  readonly capabilities: MediaProviderCapabilities;

  // ─── Server Management ────────────────────────────────
  getActiveServer(): ServerConfig | undefined;
  testConnection(serverUrl?: string): Promise<boolean>;
  resetApi(): void;
  clearLibrary(): void;

  // ─── Library ──────────────────────────────────────────
  syncLibrary(onProgress?: (message: string) => void): Promise<MediaItem[]>;
  getLibraryItems(): MediaItem[];
  getItem(id: string): MediaItem | undefined;
  getItemDetails(itemId: string): Promise<{ overview: string | null; genres?: string[]; communityRating?: number; studios?: string[]; cast?: string[] }>;
  getItemDurationMs(item: MediaItem): number;
  getItemsByGenre(genre: string): MediaItem[];
  getItemsWithGenre(canonicalGenre: string, alternateNames?: string[]): MediaItem[];
  getItemsWithLeadGenre(canonicalGenre: string, alternateNames?: string[]): MediaItem[];
  getGenres(): Map<string, MediaItem[]>;
  getCollections(): Promise<{ id: string; name: string; items: MediaItem[] }[]>;
  getPlaylists(): Promise<{ id: string; name: string; items: MediaItem[] }[]>;
  /**
   * Populate `RemoteTrailers` on the given items if missing. Used by the
   * Now Playing channel on demand instead of fetching for every library item
   * during the main sync (which is slow and brittle for some Jellyfin setups).
   * Best-effort: failures should be logged, not thrown.
   */
  ensureRemoteTrailers(itemIds: string[]): Promise<void>;

  // ─── Playback ─────────────────────────────────────────
  getPlaybackInfo(itemId: string): Promise<PlaybackInfoResult>;
  getHlsStreamUrl(itemId: string, startPositionTicks?: number, options?: { bitrate?: number; maxWidth?: number; subtitleStreamIndex?: number; audioStreamIndex?: number }): Promise<StreamInfo>;
  getMediaSegments(itemId: string): Promise<{ outroStartMs: number | null; outroEndMs: number | null }>;

  // ─── Session Management ───────────────────────────────
  stopPlaybackSession(playSessionId: string): Promise<void>;
  deleteTranscodingJob(playSessionId: string): Promise<void>;

  // ─── Progress Reporting ───────────────────────────────
  reportPlaybackStart(itemId: string, playSessionId: string, mediaSourceId: string, positionMs: number): Promise<void>;
  reportPlaybackProgress(itemId: string, playSessionId: string, mediaSourceId: string, positionMs: number, isPaused?: boolean): Promise<void>;
  reportPlaybackStopped(itemId: string, playSessionId: string, mediaSourceId: string, positionMs: number): Promise<void>;
  /**
   * Explicitly mark an item as fully watched on the media server. Updates the
   * server's watch state so subsequent library syncs reflect `Played: true`.
   * Used when a video reaches its natural end — neither Plex's /timeline nor
   * Jellyfin's /Stopped reliably mark items watched on their own.
   */
  markPlayed(itemId: string): Promise<void>;

  // ─── Image / Proxy Helpers ────────────────────────────
  getImageUrl(itemId: string, imageType?: string, maxWidth?: number): string;
  getBaseUrl(): string;
  getDeviceId(): string;
  getProxyHeaders(): Record<string, string>;
}
