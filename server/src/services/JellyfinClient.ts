import type Database from 'better-sqlite3';
import { Jellyfin } from '@jellyfin/sdk';
import { getItemsApi, getMediaInfoApi, getSystemApi, getDynamicHlsApi, getImageApi, getUserApi, getPlaystateApi } from '@jellyfin/sdk/lib/utils/api/index.js';
import type { Api } from '@jellyfin/sdk';
import type { BaseItemDto, PlaybackInfoResponse } from '@jellyfin/sdk/lib/generated-client/models/index.js';
import type { JellyfinItem, JellyfinLibrary, ServerConfig } from '../types/index.js';
import * as queries from '../db/queries.js';
import { ticksToMs, msToTicks } from '../utils/time.js';
import { randomUUID } from 'crypto';

export class JellyfinClient {
  private db: Database.Database;
  private libraryItems: Map<string, JellyfinItem> = new Map();
  private jellyfin: Jellyfin;
  private api: Api | null = null;
  private deviceId: string;
  private userId: string | null = null;
  private currentToken: string | null = null;

  constructor(db: Database.Database) {
    this.db = db;
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

  // Reset API when server changes
  resetApi(): void {
    this.api = null;
    this.userId = null;
    this.currentToken = null;
  }

  /** Clear in-memory library cache (e.g. when active server is deleted) */
  clearLibrary(): void {
    this.libraryItems.clear();
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

  async syncLibrary(onProgress?: (message: string) => void): Promise<JellyfinItem[]> {
    const server = this.getActiveServer();
    if (!server) {
      console.log('[Jellyfin] No active server to sync');
      return [];
    }

    console.log(`[Jellyfin] Syncing library for server ${server.id} (${server.name})...`);

    // Fetch movies
    onProgress?.('Fetching movies...');
    const movies = await this.fetchItems('Movie', onProgress);
    
    // Fetch episodes
    onProgress?.(`Found ${movies.length} movies. Fetching episodes...`);
    const episodes = await this.fetchItems('Episode', onProgress);

    const allItems = [...movies, ...episodes];

    // Cache in memory
    this.libraryItems.clear();
    for (const item of allItems) {
      this.libraryItems.set(item.Id!, item as JellyfinItem);
    }

    // Cache in database - verify server still exists before inserting
    const serverStillExists = queries.getServerById(this.db, server.id);
    if (!serverStillExists) {
      console.error(`[Jellyfin] Server ${server.id} no longer exists, skipping database cache`);
      return allItems as JellyfinItem[];
    }

    try {
      queries.clearLibraryCache(this.db, server.id);
      for (const item of allItems) {
        queries.upsertLibraryItem(this.db, item.Id!, server.id, item);
      }
    } catch (err) {
      console.error(`[Jellyfin] Failed to cache library in database:`, err);
      // Continue - in-memory cache still works
    }

    console.log(`[Jellyfin] Synced ${movies.length} movies and ${episodes.length} episodes`);
    return allItems as JellyfinItem[];
  }

  private async fetchItems(itemType: string, onProgress?: (message: string) => void): Promise<BaseItemDto[]> {
    const items: BaseItemDto[] = [];
    let startIndex = 0;
    const limit = 1000;
    const api = this.getApi();
    const itemsApi = getItemsApi(api);
    const userId = this.getUserId();
    let totalCount = 0;
    let pageCount = 0;

    console.log(`[Jellyfin] Starting to fetch ${itemType}s...`);

    while (true) {
      try {
        pageCount++;
        console.log(`[Jellyfin] Fetching ${itemType}s page ${pageCount} (starting at ${startIndex})...`);
        const response = await itemsApi.getItems({
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
          ],
          enableUserData: true,  // Fetch watch status, favorites, etc.
          enableImages: true,
          startIndex,
          limit,
          sortBy: ['SortName'],
          sortOrder: ['Ascending'],
        });

        const data = response.data;
        if (data.Items) {
          items.push(...data.Items);
          console.log(`[Jellyfin] Received ${data.Items.length} ${itemType}s, total now: ${items.length}`);
        }
        
        totalCount = data.TotalRecordCount || 0;
        
        // Report progress
        if (totalCount > 0) {
          onProgress?.(`Fetching ${itemType.toLowerCase()}s: ${items.length}/${totalCount}`);
        }

        if (!data.TotalRecordCount || items.length >= data.TotalRecordCount) {
          console.log(`[Jellyfin] Finished fetching ${itemType}s: ${items.length} total`);
          break;
        }
        startIndex += limit;
      } catch (err) {
        console.error(`[Jellyfin] Failed to fetch ${itemType}s at page ${pageCount}:`, err);
        break;
      }
    }

    return items;
  }

  // ─── Library Access ───────────────────────────────────

  getLibraryItems(): JellyfinItem[] {
    if (this.libraryItems.size === 0) {
      // Load from cache
      const server = this.getActiveServer();
      if (server) {
        const cached = queries.getCachedLibrary(this.db, server.id) as JellyfinItem[];
        for (const item of cached) {
          this.libraryItems.set(item.Id, item);
        }
      }
    }
    return Array.from(this.libraryItems.values());
  }

  getItem(id: string): JellyfinItem | undefined {
    return this.libraryItems.get(id);
  }

  /**
   * Get item details (e.g. Overview) by ID. Uses cache first, then fetches from Jellyfin if needed.
   */
  async getItemDetails(itemId: string): Promise<{ overview: string | null; genres?: string[] }> {
    const cached = this.libraryItems.get(itemId);
    if (cached) {
      return {
        overview: cached.Overview ?? null,
        genres: cached.Genres ?? undefined,
      };
    }
    const api = this.getApi();
    const itemsApi = getItemsApi(api);
    const userId = this.getUserId();
    try {
      const response = await itemsApi.getItems({
        userId,
        ids: [itemId],
        fields: ['Overview', 'Genres'],
      });
      const item = response.data.Items?.[0] as JellyfinItem | undefined;
      if (!item) {
        return { overview: null };
      }
      return {
        overview: item.Overview ?? null,
        genres: item.Genres ?? undefined,
      };
    } catch (err) {
      console.error('[Jellyfin] getItemDetails failed:', err);
      return { overview: null };
    }
  }

  getItemsByGenre(genre: string): JellyfinItem[] {
    return this.getLibraryItems().filter(
      item => item.Genres?.some(g => g.toLowerCase() === genre.toLowerCase())
    );
  }

  getGenres(): Map<string, JellyfinItem[]> {
    const genres = new Map<string, JellyfinItem[]>();
    for (const item of this.getLibraryItems()) {
      // Use only the lead (first) genre for genre-channel assignment
      // This prevents the same item from appearing on multiple genre channels
      const leadGenre = (item.Genres || [])[0];
      if (!leadGenre) continue;
      const existing = genres.get(leadGenre) || [];
      existing.push(item);
      genres.set(leadGenre, existing);
    }
    return genres;
  }

  getItemDurationMs(item: JellyfinItem): number {
    return item.RunTimeTicks ? ticksToMs(item.RunTimeTicks) : 0;
  }

  // ─── Collections ───────────────────────────────────────

  /**
   * Fetch all collections (BoxSets) from the library with their items
   */
  async getCollections(): Promise<{ id: string; name: string; items: JellyfinItem[] }[]> {
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
              .map(item => item as JellyfinItem);

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

  // ─── Playback Session ──────────────────────────────────

  /**
   * Get playback info including a PlaySessionId for streaming.
   * Uses a device profile that prefers direct play / direct stream (no transcoding) when possible.
   */
  async getPlaybackInfo(itemId: string): Promise<PlaybackInfoResponse> {
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
  async getHlsStreamUrl(itemId: string, startPositionTicks?: number): Promise<{ url: string; playSessionId: string }> {
    const playbackInfo = await this.getPlaybackInfo(itemId);
    const playSessionId = playbackInfo.PlaySessionId || randomUUID();
    const mediaSource = playbackInfo.MediaSources?.[0];
    const mediaSourceId = mediaSource?.Id || itemId;

    const baseUrl = this.getServerUrl();
    const accessToken = this.getAccessToken();

    const params = new URLSearchParams({
      api_key: accessToken,
      DeviceId: this.deviceId,
      MediaSourceId: mediaSourceId,
      PlaySessionId: playSessionId,
      VideoCodec: 'h264',
      AudioCodec: 'aac',
      MaxStreamingBitrate: '20000000',
      TranscodingMaxAudioChannels: '2',
      SegmentContainer: 'ts',
      MinSegments: '2',
      BreakOnNonKeyFrames: 'true',
    });

    if (startPositionTicks) {
      params.set('StartTimeTicks', startPositionTicks.toString());
    }

    const url = `${baseUrl}/Videos/${itemId}/master.m3u8?${params}`;
    return { url, playSessionId };
  }

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
