import type { JellyfinItem, ServerConfig } from '../types/index.js';

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
export interface MediaProvider {
  readonly providerType: 'jellyfin' | 'plex';

  // ─── Server Management ────────────────────────────────
  getActiveServer(): ServerConfig | undefined;
  testConnection(serverUrl?: string): Promise<boolean>;
  resetApi(): void;
  clearLibrary(): void;

  // ─── Authentication ───────────────────────────────────
  authenticate(serverUrl: string, username: string, password: string): Promise<{ accessToken: string; userId: string }>;

  // ─── Library ──────────────────────────────────────────
  syncLibrary(onProgress?: (message: string) => void): Promise<JellyfinItem[]>;
  getLibraryItems(): JellyfinItem[];
  getItem(id: string): JellyfinItem | undefined;
  getItemDetails(itemId: string): Promise<{ overview: string | null; genres?: string[]; communityRating?: number; studios?: string[]; cast?: string[] }>;
  getItemDurationMs(item: JellyfinItem): number;
  getItemsByGenre(genre: string): JellyfinItem[];
  getItemsWithGenre(canonicalGenre: string, alternateNames?: string[]): JellyfinItem[];
  getItemsWithLeadGenre(canonicalGenre: string, alternateNames?: string[]): JellyfinItem[];
  getGenres(): Map<string, JellyfinItem[]>;
  getCollections(): Promise<{ id: string; name: string; items: JellyfinItem[] }[]>;
  getPlaylists(): Promise<{ id: string; name: string; items: JellyfinItem[] }[]>;

  // ─── Playback ─────────────────────────────────────────
  getPlaybackInfo(itemId: string): Promise<PlaybackInfoResult>;
  getHlsStreamUrl(itemId: string, startPositionTicks?: number): Promise<StreamInfo>;
  getMediaSegments(itemId: string): Promise<{ outroStartMs: number | null; outroEndMs: number | null }>;

  // ─── Session Management ───────────────────────────────
  stopPlaybackSession(playSessionId: string): Promise<void>;
  deleteTranscodingJob(playSessionId: string): Promise<void>;

  // ─── Progress Reporting ───────────────────────────────
  reportPlaybackStart(itemId: string, playSessionId: string, mediaSourceId: string, positionMs: number): Promise<void>;
  reportPlaybackProgress(itemId: string, playSessionId: string, mediaSourceId: string, positionMs: number, isPaused?: boolean): Promise<void>;
  reportPlaybackStopped(itemId: string, playSessionId: string, mediaSourceId: string, positionMs: number): Promise<void>;

  // ─── Image / Proxy Helpers ────────────────────────────
  getImageUrl(itemId: string, imageType?: string, maxWidth?: number): string;
  getBaseUrl(): string;
  getDeviceId(): string;
  getProxyHeaders(): Record<string, string>;
}
