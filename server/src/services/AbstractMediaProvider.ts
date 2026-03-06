import type Database from 'better-sqlite3';
import type { MediaItem, ServerConfig } from '../types/index.js';
import type { MediaProvider, PlaybackInfoResult, StreamInfo, MediaProviderCapabilities } from './MediaProvider.js';
import * as queries from '../db/queries.js';

/**
 * Base class providing shared in-memory library access logic for all media providers.
 * Provider-specific API calls (auth, fetch, streaming) are implemented in concrete subclasses.
 */
export abstract class AbstractMediaProvider implements MediaProvider {
  abstract readonly providerType: 'jellyfin' | 'plex';
  abstract readonly capabilities: MediaProviderCapabilities;

  protected db: Database.Database;
  protected libraryItems: Map<string, MediaItem> = new Map();

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ─── Server Management ────────────────────────────────

  abstract getActiveServer(): ServerConfig | undefined;
  abstract testConnection(serverUrl?: string): Promise<boolean>;
  abstract resetApi(): void;

  clearLibrary(): void {
    this.libraryItems.clear();
  }

  // ─── Library ──────────────────────────────────────────

  abstract syncLibrary(onProgress?: (message: string) => void): Promise<MediaItem[]>;
  abstract getItemDetails(itemId: string): Promise<{ overview: string | null; genres?: string[]; communityRating?: number; audienceRating?: number; ratingImage?: string; audienceRatingImage?: string; studios?: string[]; cast?: string[] }>;
  abstract getItemDurationMs(item: MediaItem): number;

  getLibraryItems(): MediaItem[] {
    if (this.libraryItems.size === 0) {
      const server = this.getActiveServer();
      if (server) {
        const cached = queries.getCachedLibrary(this.db, server.id) as MediaItem[];
        for (const item of cached) {
          this.libraryItems.set(item.Id, item);
        }
      }
    }
    return Array.from(this.libraryItems.values());
  }

  getItem(id: string): MediaItem | undefined {
    return this.libraryItems.get(id);
  }

  getItemsByGenre(genre: string): MediaItem[] {
    return this.getLibraryItems().filter(
      item => item.Genres?.some(g => g.toLowerCase() === genre.toLowerCase())
    );
  }

  getItemsWithGenre(canonicalGenre: string, alternateNames: string[] = []): MediaItem[] {
    const matchNames = [canonicalGenre, ...alternateNames].map(n => n.toLowerCase());
    return this.getLibraryItems().filter(item =>
      (item.Genres || []).some(g => matchNames.includes(g.toLowerCase()))
    );
  }

  getItemsWithLeadGenre(canonicalGenre: string, alternateNames: string[] = []): MediaItem[] {
    const matchNames = [canonicalGenre, ...alternateNames].map(n => n.toLowerCase());
    return this.getLibraryItems().filter(item => {
      const lead = (item.Genres || [])[0];
      return lead != null && matchNames.includes(lead.toLowerCase());
    });
  }

  getGenres(): Map<string, MediaItem[]> {
    const genres = new Map<string, MediaItem[]>();
    for (const item of this.getLibraryItems()) {
      const leadGenre = (item.Genres || [])[0];
      if (!leadGenre) continue;
      const existing = genres.get(leadGenre) || [];
      existing.push(item);
      genres.set(leadGenre, existing);
    }
    return genres;
  }

  // ─── Collections & Playlists ──────────────────────────

  abstract getCollections(): Promise<{ id: string; name: string; items: MediaItem[] }[]>;
  abstract getPlaylists(): Promise<{ id: string; name: string; items: MediaItem[] }[]>;

  // ─── Playback ─────────────────────────────────────────

  abstract getPlaybackInfo(itemId: string): Promise<PlaybackInfoResult>;
  abstract getHlsStreamUrl(itemId: string, startPositionTicks?: number, options?: { bitrate?: number; maxWidth?: number; subtitleStreamIndex?: number; audioStreamIndex?: number }): Promise<StreamInfo>;
  abstract getMediaSegments(itemId: string): Promise<{ outroStartMs: number | null; outroEndMs: number | null }>;

  // ─── Session Management ───────────────────────────────

  abstract stopPlaybackSession(playSessionId: string): Promise<void>;
  abstract deleteTranscodingJob(playSessionId: string): Promise<void>;

  // ─── Progress Reporting ───────────────────────────────

  abstract reportPlaybackStart(itemId: string, playSessionId: string, mediaSourceId: string, positionMs: number): Promise<void>;
  abstract reportPlaybackProgress(itemId: string, playSessionId: string, mediaSourceId: string, positionMs: number, isPaused?: boolean): Promise<void>;
  abstract reportPlaybackStopped(itemId: string, playSessionId: string, mediaSourceId: string, positionMs: number): Promise<void>;

  // ─── Image / Proxy Helpers ────────────────────────────

  abstract getImageUrl(itemId: string, imageType?: string, maxWidth?: number): string;
  abstract getBaseUrl(): string;
  abstract getDeviceId(): string;
  abstract getProxyHeaders(): Record<string, string>;
}
