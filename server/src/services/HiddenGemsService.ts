import type Database from 'better-sqlite3';
import type { HiddenGem } from '../types/index.js';
import type { AIService } from './AIService.js';
import type { MediaProvider } from './MediaProvider.js';
import {
  getAllHiddenGems,
  getHiddenGemIds as queryGemIds,
  upsertHiddenGem,
  clearAllHiddenGems,
  getHiddenGemsLastRefreshed,
} from '../db/queries.js';
import { getTopShows, getTopSeries, getHourlyActivity } from '../db/queries.js';

interface AIRequestOptions {
  apiKey?: string;
  model?: string;
}

export class HiddenGemsService {
  private db: Database.Database;
  private aiService: AIService;

  constructor(db: Database.Database, aiService: AIService) {
    this.db = db;
    this.aiService = aiService;
  }

  /** Get the set of all hidden gem media_item_ids (for fast schedule enrichment). */
  getGemIds(): Set<string> {
    return queryGemIds(this.db);
  }

  /** Get all cached hidden gems ordered by score. */
  getAllGems(): HiddenGem[] {
    return getAllHiddenGems(this.db);
  }

  /** Get the last refresh timestamp. */
  getLastRefreshed(): string | null {
    return getHiddenGemsLastRefreshed(this.db);
  }

  /**
   * Generate hidden gems: build user profile from metrics, filter library to
   * candidates, call AI, and cache results.
   */
  async generateGems(
    mediaProvider: MediaProvider,
    options?: AIRequestOptions,
  ): Promise<number> {
    // 1. Build user profile from watch metrics (last 90 days)
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const topShows = getTopShows(this.db, since, 50);
    const topSeries = getTopSeries(this.db, since, 20);
    const hourly = getHourlyActivity(this.db, since);

    // Derive top genres from watched items
    const genreCounts = new Map<string, number>();
    const recentFavorites: string[] = [];
    for (const show of topShows.slice(0, 20)) {
      const item = mediaProvider.getItem(show.item_id);
      if (item?.Genres) {
        for (const g of item.Genres) {
          genreCounts.set(g, (genreCounts.get(g) || 0) + show.total_seconds);
        }
      }
      if (recentFavorites.length < 10) {
        recentFavorites.push(show.title);
      }
    }
    const topGenres = [...genreCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([g]) => g);

    // Peak viewing hours (top 3 by watch seconds)
    const peakHours = hourly
      .sort((a, b) => b.total_seconds - a.total_seconds)
      .slice(0, 3)
      .map(h => h.hour);

    const userProfile = {
      topGenres,
      topSeries: topSeries.slice(0, 10).map(s => s.series_name),
      recentFavorites,
      peakHours,
    };

    // 2. Filter library to candidates: unwatched/underwatched + rated 6+
    const library = mediaProvider.getLibraryItems();
    const watchedIds = new Set(topShows.map(s => s.item_id));

    // Group series to avoid duplicates
    const seenSeries = new Set<string>();
    const candidates: {
      key: string;
      id: string;
      title: string;
      type: string;
      year: number | null;
      genres: string[];
      rating: number | null;
      directors: string[];
      contentType: string | null;
    }[] = [];

    let idx = 0;
    for (const item of library) {
      // Only movies and episodes
      if (item.Type !== 'Movie' && item.Type !== 'Episode') continue;

      // Must be unwatched or barely watched
      if (item.UserData?.Played) continue;
      if (item.UserData?.PlayedPercentage && item.UserData.PlayedPercentage >= 10) continue;

      // Skip items already in top-watched
      if (watchedIds.has(item.Id)) continue;

      // Quality floor
      if (!item.CommunityRating || item.CommunityRating < 6.0) continue;

      // For episodes, group by series (one entry per series)
      if (item.Type === 'Episode') {
        const seriesKey = item.SeriesId || item.SeriesName || item.Id;
        if (seenSeries.has(seriesKey)) continue;
        seenSeries.add(seriesKey);
      }

      const directors = (item.People || [])
        .filter(p => p.Type === 'Director')
        .map(p => p.Name);

      candidates.push({
        key: `C${idx}`,
        id: item.Id,
        title: item.Type === 'Episode' ? (item.SeriesName || item.Name) : item.Name,
        type: item.Type,
        year: item.ProductionYear || null,
        genres: item.Genres || [],
        rating: item.CommunityRating,
        directors,
        contentType: item.Type === 'Movie' ? 'movie' : item.Type === 'Episode' ? 'episode' : null,
      });
      idx++;

      // Cap to avoid sending too many tokens
      if (idx >= 300) break;
    }

    if (candidates.length === 0) {
      clearAllHiddenGems(this.db);
      return 0;
    }

    // 3. Call AI
    const aiCandidates = candidates.map(c => ({
      key: c.key,
      title: c.title,
      type: c.type,
      year: c.year,
      genres: c.genres,
      rating: c.rating,
      directors: c.directors,
    }));

    try {
      const results = await this.aiService.generateHiddenGems(userProfile, aiCandidates, options);

      // 4. Map keys back to real IDs and cache
      const keyToCandidate = new Map(candidates.map(c => [c.key, c]));
      clearAllHiddenGems(this.db);

      let count = 0;
      for (const gem of results) {
        const candidate = keyToCandidate.get(gem.key);
        if (!candidate) continue;
        upsertHiddenGem(
          this.db,
          candidate.id,
          candidate.title,
          candidate.contentType,
          gem.reason,
          gem.score,
        );
        count++;
      }
      return count;
    } catch (err) {
      console.error('[HiddenGems] Generation failed:', (err as Error).message);
      return 0;
    }
  }
}
