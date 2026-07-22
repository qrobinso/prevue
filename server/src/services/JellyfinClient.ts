import type Database from 'better-sqlite3';
import { Jellyfin } from '@jellyfin/sdk';
import { getItemsApi, getMediaInfoApi, getSystemApi, getDynamicHlsApi, getImageApi, getUserApi, getPlaystateApi } from '@jellyfin/sdk/lib/utils/api/index.js';
import type { Api } from '@jellyfin/sdk';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/index.js';
import type { MediaItem, MediaLibrary, ServerConfig } from '../types/index.js';
import type { PlaybackInfoResult } from './MediaProvider.js';
import { AbstractMediaProvider } from './AbstractMediaProvider.js';
import * as queries from '../db/queries.js';
import { ticksToMs, msToTicks } from '../utils/time.js';
import { isHdrMediaSource } from '../utils/hdr.js';
import { randomUUID } from 'crypto';

export class JellyfinClient extends AbstractMediaProvider {
  readonly providerType = 'jellyfin' as const;
  readonly capabilities = { supportsMediaSegments: true, supportsServerDiscovery: true, supportsReAuth: true };
  private jellyfin: Jellyfin;
  private api: Api | null = null;
  private deviceId: string;
  private userId: string | null = null;
  private currentToken: string | null = null;
  private syncInFlight: Promise<MediaItem[]> | null = null;
  private syncAbort: AbortController | null = null;

  constructor(db: Database.Database) {
    super(db);
    this.deviceId = randomUUID();
    this.jellyfin = new Jellyfin({
      clientInfo: {
        name: 'Prevue',
        version: '1.0.0',
      },
      deviceInfo: {
        name: 'Prevue Server',
        id: this.deviceId,
      },
    });
  }

  // ─── Server Management ────────────────────────────────

  getActiveServer(): ServerConfig | undefined {
    return queries.getActiveServer(this.db);
  }

  private getServerUrl(): string {
    const server = this.getActiveServer();
    if (!server) throw new Error('No active Jellyfin server configured');
    return server.url.replace(/\/$/, '');
  }

  private getAccessToken(): string {
    const server = this.getActiveServer();
    if (!server?.access_token) throw new Error('No access token available - please re-authenticate');
    return server.access_token;
  }

  private getApi(): Api {
    const server = this.getActiveServer();
    if (!server) throw new Error('No active Jellyfin server configured');
    
    if (!server.access_token) {
      throw new Error('No access token - server needs re-authentication');
    }

    // Always recreate API if token changed (handles token refresh scenarios)
    if (!this.api || this.currentToken !== server.access_token) {
      console.log(`[Jellyfin] Creating API connection`);
      this.api = this.jellyfin.createApi(server.url, server.access_token);
      this.userId = server.user_id;
      this.currentToken = server.access_token;
    }
    return this.api;
  }

  // Reset API when server changes — also stops any in-flight sync, since its
  // requests belong to the old connection.
  resetApi(): void {
    this.cancelSync();
    this.api = null;
    this.userId = null;
    this.currentToken = null;
  }

  // Abort an in-flight library sync (server disconnected/switched). The cancelled
  // sync resolves promptly with [] and does not touch the library caches.
  cancelSync(): void {
    if (this.syncAbort && !this.syncAbort.signal.aborted) {
      console.log('[Jellyfin] Cancelling in-flight library sync');
      this.syncAbort.abort();
    }
  }

  // Authenticate with username/password and get access token
  async authenticate(serverUrl: string, username: string, password: string): Promise<{ accessToken: string; userId: string }> {
    // Create API without token first
    const api = this.jellyfin.createApi(serverUrl);
    const userApi = getUserApi(api);

    try {
      const response = await userApi.authenticateUserByName({
        authenticateUserByName: {
          Username: username,
          Pw: password,
        },
      });

      const authResult = response.data;
      if (!authResult.AccessToken || !authResult.User?.Id) {
        throw new Error('Authentication failed - no token received');
      }

      const accessToken = authResult.AccessToken;
      const userId = authResult.User.Id;

      console.log(`[Jellyfin] Authenticated as ${authResult.User.Name} (${userId})`);
      return { accessToken, userId };
    } catch (err) {
      console.error('[Jellyfin] Authentication failed:', err);
      throw new Error('Authentication failed - check username and password');
    }
  }

  // Get cached user ID (from stored token auth)
  private getUserId(): string {
    if (this.userId) return this.userId;
    
    const server = this.getActiveServer();
    if (server?.user_id) {
      this.userId = server.user_id;
      return this.userId;
    }
    
    throw new Error('No user ID available - please re-authenticate');
  }

  // ─── Connection ───────────────────────────────────────

  async testConnection(serverUrl?: string): Promise<boolean> {
    try {
      if (serverUrl) {
        // Test with provided URL (no auth needed for public info)
        const testApi = this.jellyfin.createApi(serverUrl);
        const systemApi = getSystemApi(testApi);
        const response = await systemApi.getPublicSystemInfo();
        return !!response.data;
      } else {
        // Test with active server
        const api = this.getApi();
        const systemApi = getSystemApi(api);
        const response = await systemApi.getPublicSystemInfo();
        return !!response.data;
      }
    } catch {
      return false;
    }
  }

  // ─── Library ──────────────────────────────────────────

  async syncLibrary(onProgress?: (message: string) => void): Promise<MediaItem[]> {
    // Dedupe concurrent syncs: boot, routes, and retries can all trigger a sync;
    // stacking whole-library fetches multiplies load on Jellyfin and looks like a stall.
    // A cancelled sync is never reused — a fresh one starts even if it hasn't settled yet.
    if (this.syncInFlight && this.syncAbort && !this.syncAbort.signal.aborted) {
      console.log('[Jellyfin] Sync already in progress — reusing in-flight sync');
      return this.syncInFlight;
    }
    const controller = new AbortController();
    this.syncAbort = controller;
    const sync = this.performSync(controller.signal, onProgress).finally(() => {
      if (this.syncInFlight === sync) this.syncInFlight = null;
    });
    this.syncInFlight = sync;
    return sync;
  }

  private async performSync(signal: AbortSignal, onProgress?: (message: string) => void): Promise<MediaItem[]> {
    const server = this.getActiveServer();
    if (!server) {
      console.log('[Jellyfin] No active server to sync');
      return [];
    }

    console.log(`[Jellyfin] Syncing library for server ${server.id} (${server.name})...`);

    // Fetch movies and episodes in parallel
    onProgress?.('Fetching movies and episodes...');
    const [movies, episodes] = await Promise.all([
      this.fetchItems('Movie', onProgress, signal),
      this.fetchItems('Episode', onProgress, signal),
    ]);

    // Cancelled mid-sync: return without touching the in-memory or DB caches —
    // partial data must not replace a complete previous sync.
    if (signal.aborted) {
      console.log('[Jellyfin] Library sync cancelled — discarding partial results');
      return [];
    }

    const allItems = [...movies, ...episodes];

    // Cache in memory
    this.libraryItems.clear();
    for (const item of allItems) {
      this.libraryItems.set(item.Id!, item as MediaItem);
    }

    // Cache in database - verify server still exists before inserting
    const serverStillExists = queries.getServerById(this.db, server.id);
    if (!serverStillExists) {
      console.error(`[Jellyfin] Server ${server.id} no longer exists, skipping database cache`);
      return allItems as MediaItem[];
    }

    try {
      const insertAll = this.db.transaction(() => {
        queries.clearLibraryCache(this.db, server.id);
        for (const item of allItems) {
          queries.upsertLibraryItem(this.db, item.Id!, server.id, item);
        }
      });
      insertAll();
    } catch (err) {
      console.error(`[Jellyfin] Failed to cache library in database:`, err);
      // Continue - in-memory cache still works
    }

    console.log(`[Jellyfin] Synced ${movies.length} movies and ${episodes.length} episodes`);
    return allItems as MediaItem[];
  }

  private async fetchItems(
    itemType: string,
    onProgress?: (message: string) => void,
    syncSignal?: AbortSignal
  ): Promise<BaseItemDto[]> {
    const PAGE_SIZE = 2500;
    const CONCURRENCY = 4;
    const PAGE_TIMEOUT_MS = 120_000;
    const api = this.getApi();
    const itemsApi = getItemsApi(api);
    const userId = this.getUserId();
    // Every request aborts on its own timeout OR when the whole sync is cancelled.
    const requestSignal = (timeoutMs: number): AbortSignal =>
      syncSignal
        ? AbortSignal.any([syncSignal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);

    console.log(`[Jellyfin] Starting to fetch ${itemType}s...`);

    const fetchPage = async (startIndex: number): Promise<{ items: BaseItemDto[]; total: number }> => {
      const response = await itemsApi.getItems(
        {
          userId,  // Required for user-specific data (favorites, watch status)
          includeItemTypes: [itemType as 'Movie' | 'Episode'],
          recursive: true,
          fields: [
            'Genres',
            'Overview',
            'Studios',           // Studios/Networks
            'DateCreated',       // When added to library
            'Tags',              // Custom tags
            'People',            // Actors, Directors
            'MediaSources',      // Video resolution
          ],
          enableUserData: true,  // Fetch watch status, favorites, etc.
          enableImages: true,
          startIndex,
          limit: PAGE_SIZE,
          sortBy: ['SortName'],
          sortOrder: ['Ascending'],
        },
        { signal: requestSignal(PAGE_TIMEOUT_MS) }
      );
      return { items: response.data.Items ?? [], total: response.data.TotalRecordCount ?? 0 };
    };

    // Each page is retried once — timeouts are transient while Jellyfin is under load.
    // No retry when the sync itself was cancelled.
    const fetchPageWithRetry = async (startIndex: number) => {
      try {
        return await fetchPage(startIndex);
      } catch (err) {
        if (syncSignal?.aborted) throw err;
        console.warn(`[Jellyfin] ${itemType} page at ${startIndex} failed, retrying once:`, (err as Error)?.message);
        return fetchPage(startIndex);
      }
    };

    // Cheap count precheck (limit: 0, no fields) so all pages can be fetched in
    // parallel. Unbounded whole-library requests with heavy fields (People,
    // MediaSources, ...) take Jellyfin minutes to serialize and used to stall the sync.
    let total: number | null = null;
    try {
      const countResponse = await itemsApi.getItems(
        {
          userId,
          includeItemTypes: [itemType as 'Movie' | 'Episode'],
          recursive: true,
          limit: 0,
          enableTotalRecordCount: true,
          enableUserData: false,
          enableImages: false,
        },
        { signal: requestSignal(30_000) }
      );
      total = countResponse.data.TotalRecordCount ?? null;
      console.log(`[Jellyfin] ${itemType} count precheck: ${total ?? 'unknown'}`);
    } catch (err) {
      console.warn(`[Jellyfin] ${itemType} count precheck failed (continuing):`, (err as Error)?.message);
    }

    const pages: BaseItemDto[][] = [];
    let fetchedCount = 0;
    if (syncSignal?.aborted) return [];

    // Count unknown (older server): fetch the first page alone to learn the total.
    if (total == null) {
      try {
        const first = await fetchPageWithRetry(0);
        pages[0] = first.items;
        fetchedCount = first.items.length;
        total = first.total || first.items.length;
      } catch (err) {
        console.error(`[Jellyfin] First ${itemType} page failed:`, (err as Error)?.message);
        return [];
      }
    }

    const pageStarts: number[] = [];
    for (let start = 0; start < total; start += PAGE_SIZE) {
      if (pages[start / PAGE_SIZE] === undefined) pageStarts.push(start);
    }

    // Worker pool: wall-clock time becomes (pages / CONCURRENCY) × page time
    // instead of the sum of all pages. Ordered by slot so sort order is preserved.
    let cursor = 0;
    const worker = async () => {
      while (cursor < pageStarts.length && !syncSignal?.aborted) {
        const start = pageStarts[cursor++];
        try {
          const result = await fetchPageWithRetry(start);
          pages[start / PAGE_SIZE] = result.items;
          fetchedCount += result.items.length;
          console.log(`[Jellyfin] Received ${result.items.length} ${itemType}s (${fetchedCount}/${total})`);
          onProgress?.(`Fetching ${itemType.toLowerCase()}s: ${fetchedCount}/${total}`);
        } catch (err) {
          if (!syncSignal?.aborted) {
            console.error(`[Jellyfin] ${itemType} page at ${start} failed after retry:`, (err as Error)?.message);
          }
          pages[start / PAGE_SIZE] = [];
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pageStarts.length) }, () => worker()));

    const items = pages.flat();
    console.log(`[Jellyfin] Finished fetching ${itemType}s: ${items.length} total`);
    return items;
  }

  // ─── Library Access ───────────────────────────────────

  /**
   * Get item details (e.g. Overview) by ID. Uses cache first, then fetches from Jellyfin if needed.
   */
  async getItemDetails(itemId: string): Promise<{ overview: string | null; genres?: string[]; communityRating?: number; audienceRating?: number; ratingImage?: string; audienceRatingImage?: string; studios?: string[]; cast?: string[] }> {
    const cached = this.libraryItems.get(itemId);
    if (cached) {
      return {
        overview: cached.Overview ?? null,
        genres: cached.Genres ?? undefined,
        communityRating: cached.CommunityRating ?? undefined,
        studios: cached.Studios?.map(s => s.Name).slice(0, 2) ?? undefined,
        cast: cached.People?.filter(p => p.Type === 'Actor').slice(0, 3).map(p => p.Name) ?? undefined,
      };
    }
    const api = this.getApi();
    const itemsApi = getItemsApi(api);
    const userId = this.getUserId();
    try {
      const response = await itemsApi.getItems({
        userId,
        ids: [itemId],
        fields: ['Overview', 'Genres', 'People', 'Studios', 'CommunityRating'] as any,
      });
      const item = response.data.Items?.[0] as MediaItem | undefined;
      if (!item) {
        return { overview: null };
      }
      return {
        overview: item.Overview ?? null,
        genres: item.Genres ?? undefined,
        communityRating: item.CommunityRating ?? undefined,
        studios: item.Studios?.map(s => s.Name).slice(0, 2) ?? undefined,
        cast: item.People?.filter(p => p.Type === 'Actor').slice(0, 3).map(p => p.Name) ?? undefined,
      };
    } catch (err) {
      console.error('[Jellyfin] getItemDetails failed:', err);
      return { overview: null };
    }
  }

  getItemDurationMs(item: MediaItem): number {
    return item.RunTimeTicks ? ticksToMs(item.RunTimeTicks) : 0;
  }

  // ─── Remote Trailers (Now Playing channel) ─────────────────

  /**
   * Fetch RemoteTrailers for the given items if missing. Done as a separate
   * pass because including 'RemoteTrailers' in the bulk getItems() request
   * causes some Jellyfin builds to hang or time out.
   *
   * Best-effort: errors are logged and the items just stay without trailers.
   */
  override async ensureRemoteTrailers(itemIds: string[]): Promise<void> {
    const need: string[] = [];
    for (const id of itemIds) {
      const item = this.libraryItems.get(id);
      if (!item) continue;
      if (item.RemoteTrailers !== undefined) continue; // already fetched (may be empty)
      need.push(id);
    }
    if (need.length === 0) return;

    let api;
    let userId: string;
    try {
      api = this.getApi();
      userId = this.getUserId();
    } catch (err) {
      console.warn('[Jellyfin] ensureRemoteTrailers: cannot fetch (no auth)', (err as Error).message);
      return;
    }
    const itemsApi = getItemsApi(api);

    const BATCH = 50;
    let fetched = 0;
    const server = this.getActiveServer();

    for (let i = 0; i < need.length; i += BATCH) {
      const batch = need.slice(i, i + BATCH);
      try {
        const response = await itemsApi.getItems({
          userId,
          ids: batch,
          fields: ['RemoteTrailers'],
        });
        for (const fetchedItem of response.data.Items || []) {
          if (!fetchedItem.Id) continue;
          const target = this.libraryItems.get(fetchedItem.Id);
          if (!target) continue;
          target.RemoteTrailers = (fetchedItem.RemoteTrailers || []) as MediaItem['RemoteTrailers'];
          fetched++;
          if (server) {
            try {
              queries.upsertLibraryItem(this.db, target.Id, server.id, target);
            } catch { /* best-effort */ }
          }
        }
      } catch (err) {
        console.warn(`[Jellyfin] Trailer batch ${i / BATCH + 1} failed:`, (err as Error).message);
      }
    }

    if (fetched > 0) {
      console.log(`[Jellyfin] Fetched RemoteTrailers for ${fetched}/${need.length} items`);
    }
  }

  // ─── Collections ───────────────────────────────────────

  /**
   * Fetch all collections (BoxSets) from the library with their items
   */
  async getCollections(): Promise<{ id: string; name: string; items: MediaItem[] }[]> {
    const api = this.getApi();
    const itemsApi = getItemsApi(api);
    const userId = this.getUserId();

    try {
      // Fetch all BoxSet items (collections)
      const response = await itemsApi.getItems({
        userId,
        includeItemTypes: ['BoxSet'],
        recursive: true,
        fields: ['Overview'],
        enableUserData: true,
        sortBy: ['SortName'],
        sortOrder: ['Ascending'],
      });

      const boxSets = response.data.Items || [];
      console.log(`[Jellyfin] Found ${boxSets.length} BoxSets`);
      
      if (boxSets.length === 0) return [];

      // Fetch items for all collections in parallel (much faster)
      const collectionPromises = boxSets
        .filter(boxSet => boxSet.Id && boxSet.Name)
        .map(async (boxSet) => {
          try {
            const itemsResponse = await itemsApi.getItems({
              userId,
              parentId: boxSet.Id!,
              recursive: true,
              includeItemTypes: ['Movie', 'Episode'],
              fields: ['Genres', 'Overview', 'Studios', 'DateCreated', 'Tags', 'People'],
              enableUserData: true,
              sortBy: ['SortName'],
              sortOrder: ['Ascending'],
            });

            const items = (itemsResponse.data.Items || [])
              .filter(item => item.Id && item.RunTimeTicks)
              .map(item => item as MediaItem);

            console.log(`[Jellyfin] Collection "${boxSet.Name}": ${items.length} items`);

            if (items.length > 0) {
              return {
                id: boxSet.Id!,
                name: boxSet.Name!,
                items,
              };
            }
            return null;
          } catch (err) {
            console.error(`[Jellyfin] Failed to fetch items for collection ${boxSet.Name}:`, err);
            return null;
          }
        });

      const results = await Promise.all(collectionPromises);
      const collections = results.filter((c): c is NonNullable<typeof c> => c !== null);

      console.log(`[Jellyfin] Found ${collections.length} collections with content`);
      return collections;
    } catch (err) {
      console.error('[Jellyfin] Failed to fetch collections:', err);
      return [];
    }
  }

  /**
   * Fetch all playlists from the library with their items
   */
  async getPlaylists(): Promise<{ id: string; name: string; items: MediaItem[] }[]> {
    const api = this.getApi();
    const itemsApi = getItemsApi(api);
    const userId = this.getUserId();

    try {
      const response = await itemsApi.getItems({
        userId,
        includeItemTypes: ['Playlist'],
        recursive: true,
        fields: ['Overview'],
        enableUserData: true,
        sortBy: ['SortName'],
        sortOrder: ['Ascending'],
      });

      const playlists = response.data.Items || [];
      console.log(`[Jellyfin] Found ${playlists.length} playlists`);
      if (playlists.length === 0) return [];

      const playlistPromises = playlists
        .filter(playlist => playlist.Id && playlist.Name)
        .map(async (playlist) => {
          try {
            const itemsResponse = await itemsApi.getItems({
              userId,
              parentId: playlist.Id!,
              recursive: true,
              includeItemTypes: ['Movie', 'Episode'],
              fields: ['Genres', 'Overview', 'Studios', 'DateCreated', 'Tags', 'People'],
              enableUserData: true,
              sortBy: ['SortName'],
              sortOrder: ['Ascending'],
            });

            const items = (itemsResponse.data.Items || [])
              .filter(item => item.Id && item.RunTimeTicks)
              .map(item => item as MediaItem);

            console.log(`[Jellyfin] Playlist "${playlist.Name}": ${items.length} items`);

            if (items.length > 0) {
              return {
                id: playlist.Id!,
                name: playlist.Name!,
                items,
              };
            }
            return null;
          } catch (err) {
            console.error(`[Jellyfin] Failed to fetch items for playlist ${playlist.Name}:`, err);
            return null;
          }
        });

      const results = await Promise.all(playlistPromises);
      const resolvedPlaylists = results.filter((p): p is NonNullable<typeof p> => p !== null);
      console.log(`[Jellyfin] Found ${resolvedPlaylists.length} playlists with content`);
      return resolvedPlaylists;
    } catch (err) {
      console.error('[Jellyfin] Failed to fetch playlists:', err);
      return [];
    }
  }

  // ─── Playback Session ──────────────────────────────────

  /**
   * Get playback info including a PlaySessionId for streaming.
   * Uses a device profile that prefers direct play / direct stream (no transcoding) when possible.
   */
  async getPlaybackInfo(itemId: string): Promise<PlaybackInfoResult> {
    const api = this.getApi();
    const mediaInfoApi = getMediaInfoApi(api);
    const userId = this.getUserId();

    try {
      const response = await mediaInfoApi.getPostedPlaybackInfo({
        itemId,
        userId,
        playbackInfoDto: {
          EnableDirectPlay: true,
          EnableDirectStream: true,
          EnableTranscoding: true,
          AllowVideoStreamCopy: true,
          AllowAudioStreamCopy: true,
          DeviceProfile: {
            MaxStreamingBitrate: 120000000,
            TranscodingProfiles: [
              {
                Container: 'mp4',
                Type: 'Video',
                AudioCodec: 'aac',
                VideoCodec: 'hevc',
                Context: 'Streaming',
                Protocol: 'hls',
                MaxAudioChannels: '2',
                BreakOnNonKeyFrames: true,
              },
              {
                Container: 'ts',
                Type: 'Video',
                AudioCodec: 'aac',
                VideoCodec: 'h264',
                Context: 'Streaming',
                Protocol: 'hls',
                MaxAudioChannels: '2',
                BreakOnNonKeyFrames: true,
              },
            ],
            DirectPlayProfiles: [
              {
                Container: 'mp4,mkv,webm,m4v',
                Type: 'Video',
                VideoCodec: 'h264,hevc,vp9,av1',
                AudioCodec: 'aac,mp3,opus,ac3,eac3',
              },
            ],
          },
        },
      });

      return response.data;
    } catch (err: unknown) {
      // Check for 401 Unauthorized - token may have expired
      const axiosError = err as { response?: { status?: number } };
      if (axiosError.response?.status === 401) {
        // Reset the cached API so next request will get fresh credentials
        this.resetApi();
        throw new Error('Authentication expired - please re-authenticate the server');
      }
      throw err;
    }
  }

  /**
   * Get HLS master playlist URL with proper session ID
   */
  async getHlsStreamUrl(itemId: string, startPositionTicks?: number, options?: { bitrate?: number; maxWidth?: number; subtitleStreamIndex?: number; audioStreamIndex?: number }): Promise<{ url: string; playSessionId: string; isHdrSource: boolean; mediaSourceId: string }> {
    const playbackInfo = await this.getPlaybackInfo(itemId);
    const playSessionId = playbackInfo.PlaySessionId || randomUUID();
    const mediaSource = playbackInfo.MediaSources?.[0];
    const mediaSourceId = mediaSource?.Id || itemId;
    const isHdrSource = this.isHdrMediaSource(mediaSource);

    const baseUrl = this.getServerUrl();
    const accessToken = this.getAccessToken();
    const bitrate = options?.bitrate || 120000000;

    const params = new URLSearchParams({
      api_key: accessToken,
      DeviceId: this.deviceId,
      MediaSourceId: mediaSourceId,
      PlaySessionId: playSessionId,
      VideoCodec: 'h264',
      AudioCodec: 'aac',
      MaxStreamingBitrate: String(bitrate),
      VideoBitrate: String(bitrate),
      TranscodingMaxAudioChannels: '2',
      SegmentContainer: 'ts',
      MinSegments: '2',
      BreakOnNonKeyFrames: 'true',
      AllowVideoStreamCopy: 'true',
      AllowAudioStreamCopy: 'true',
      EnableAutoStreamCopy: 'true',
      MaxWidth: options?.maxWidth ? String(options.maxWidth) : '3840',
      MaxHeight: '2160',
    });

    if (startPositionTicks) {
      params.set('StartTimeTicks', startPositionTicks.toString());
    }

    const url = `${baseUrl}/Videos/${itemId}/master.m3u8?${params}`;
    return { url, playSessionId, isHdrSource, mediaSourceId };
  }

  private isHdrMediaSource = isHdrMediaSource;

  // ─── Playback Session Management ─────────────────────────

  /**
   * Stop a playback session and terminate any associated transcoding
   * This frees up server resources when the user leaves the video
   */
  async stopPlaybackSession(playSessionId: string): Promise<void> {
    try {
      const baseUrl = this.getServerUrl();
      const headers = this.getProxyHeaders();
      
      // Tell Jellyfin to stop the playback session
      // This will terminate any active transcoding for this session
      const url = `${baseUrl}/Sessions/Playing/Stopped`;
      
      await fetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          PlaySessionId: playSessionId,
        }),
      });
      
      console.log(`[Jellyfin] Stopped playback session: ${playSessionId}`);
    } catch (err) {
      // Don't throw - this is a best-effort cleanup
      console.error(`[Jellyfin] Failed to stop session ${playSessionId}:`, err);
    }
  }

  /**
   * Delete active transcoding job to free up server resources
   */
  async deleteTranscodingJob(playSessionId: string): Promise<void> {
    try {
      const baseUrl = this.getServerUrl();
      const headers = this.getProxyHeaders();
      
      const url = `${baseUrl}/Videos/ActiveEncodings?deviceId=${this.deviceId}&playSessionId=${playSessionId}`;
      
      await fetch(url, {
        method: 'DELETE',
        headers,
      });
      
      console.log(`[Jellyfin] Deleted transcoding job for session: ${playSessionId}`);
    } catch (err) {
      // Don't throw - this is a best-effort cleanup
      console.error(`[Jellyfin] Failed to delete transcoding job:`, err);
    }
  }

  // ─── Playback Progress Reporting ─────────────────────────

  /**
   * Report to Jellyfin that playback has started.
   */
  async reportPlaybackStart(itemId: string, playSessionId: string, mediaSourceId: string, positionMs: number): Promise<void> {
    try {
      const api = this.getApi();
      const playstateApi = getPlaystateApi(api);
      await playstateApi.reportPlaybackStart({
        playbackStartInfo: {
          ItemId: itemId,
          PlaySessionId: playSessionId,
          MediaSourceId: mediaSourceId,
          PositionTicks: msToTicks(positionMs),
          CanSeek: true,
          PlayMethod: 'Transcode',
        },
      });
      console.log(`[Jellyfin] Reported playback start: item=${itemId}, position=${Math.round(positionMs / 1000)}s`);
    } catch (err) {
      console.error(`[Jellyfin] Failed to report playback start:`, err);
    }
  }

  /**
   * Report playback progress (position update) to Jellyfin.
   */
  async reportPlaybackProgress(itemId: string, playSessionId: string, mediaSourceId: string, positionMs: number, isPaused?: boolean): Promise<void> {
    try {
      const api = this.getApi();
      const playstateApi = getPlaystateApi(api);
      await playstateApi.reportPlaybackProgress({
        playbackProgressInfo: {
          ItemId: itemId,
          PlaySessionId: playSessionId,
          MediaSourceId: mediaSourceId,
          PositionTicks: msToTicks(positionMs),
          IsPaused: isPaused ?? false,
          CanSeek: true,
          PlayMethod: 'Transcode',
        },
      });
    } catch (err) {
      console.error(`[Jellyfin] Failed to report playback progress:`, err);
    }
  }

  /**
   * Report to Jellyfin that playback has stopped, including final position.
   */
  async reportPlaybackStopped(itemId: string, playSessionId: string, mediaSourceId: string, positionMs: number): Promise<void> {
    try {
      const api = this.getApi();
      const playstateApi = getPlaystateApi(api);
      await playstateApi.reportPlaybackStopped({
        playbackStopInfo: {
          ItemId: itemId,
          PlaySessionId: playSessionId,
          MediaSourceId: mediaSourceId,
          PositionTicks: msToTicks(positionMs),
        },
      });
      console.log(`[Jellyfin] Reported playback stopped: item=${itemId}, position=${Math.round(positionMs / 1000)}s`);
    } catch (err) {
      console.error(`[Jellyfin] Failed to report playback stopped:`, err);
    }
  }

  /**
   * Explicitly mark an item as played on Jellyfin. reportPlaybackStopped only
   * marks items watched when the final position is close to the end; this is
   * the unconditional equivalent of Jellyfin Web's ✓.
   */
  async markPlayed(itemId: string): Promise<void> {
    try {
      const api = this.getApi();
      const playstateApi = getPlaystateApi(api);
      const userId = this.getUserId();
      await playstateApi.markPlayedItem({
        userId,
        itemId,
        datePlayed: new Date().toISOString(),
      });
      const cached = this.libraryItems.get(itemId);
      if (cached) {
        cached.UserData = {
          ...(cached.UserData ?? {}),
          Played: true,
          LastPlayedDate: new Date().toISOString(),
        };
      }
      console.log(`[Jellyfin] Marked item ${itemId} as played`);
    } catch (err) {
      console.error('[Jellyfin] Failed to mark item played:', err);
    }
  }

  // ─── Media Segments (outro/credits detection) ────────────

  async getMediaSegments(itemId: string): Promise<{ outroStartMs: number | null; outroEndMs: number | null }> {
    try {
      const baseUrl = this.getServerUrl();
      const headers = this.getProxyHeaders();
      const resp = await fetch(`${baseUrl}/MediaSegments/${itemId}`, { method: 'GET', headers });
      if (!resp.ok) {
        return { outroStartMs: null, outroEndMs: null };
      }

      const data = await resp.json() as { Items?: Array<{ Type?: string; StartTicks?: number; EndTicks?: number }> };
      const outro = (data.Items ?? []).find(s => s.Type === 'Outro');
      if (!outro || outro.StartTicks == null) {
        return { outroStartMs: null, outroEndMs: null };
      }

      return {
        outroStartMs: Math.round(outro.StartTicks / 10000),
        outroEndMs: outro.EndTicks != null ? Math.round(outro.EndTicks / 10000) : null,
      };
    } catch {
      return { outroStartMs: null, outroEndMs: null };
    }
  }

  // ─── Image URL ─────────────────────────────────────────

  getImageUrl(itemId: string, imageType: string = 'Primary', maxWidth: number = 400): string {
    const baseUrl = this.getServerUrl();
    return `${baseUrl}/Items/${itemId}/Images/${imageType}?maxWidth=${maxWidth}&quality=90`;
  }

  // ─── Proxy helpers ────────────────────────────────────

  getProxyHeaders(): Record<string, string> {
    return {
      'X-Emby-Token': this.getAccessToken(),
    };
  }

  getBaseUrl(): string {
    return this.getServerUrl();
  }

  getDeviceId(): string {
    return this.deviceId;
  }
}
