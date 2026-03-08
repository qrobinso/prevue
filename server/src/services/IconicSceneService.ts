import type Database from 'better-sqlite3';
import type { IconicScene } from '../types/index.js';
import type { AIService } from './AIService.js';
import { getIconicScenes, upsertIconicScenes, getIconicScenesForItems } from '../db/queries.js';

interface AIRequestOptions {
  apiKey?: string;
  model?: string;
}

export class IconicSceneService {
  private db: Database.Database;
  private aiService: AIService;

  constructor(db: Database.Database, aiService: AIService) {
    this.db = db;
    this.aiService = aiService;
  }

  /**
   * Batch lookup cached scenes for multiple media items (no generation).
   */
  getScenesForItems(mediaItemIds: string[]): Map<string, IconicScene[]> {
    return getIconicScenesForItems(this.db, mediaItemIds);
  }

  /**
   * Generate iconic scenes for a batch of movies in a single LLM call.
   * Skips already-cached movies. Caches results in SQLite.
   */
  async generateForMovies(
    movies: { mediaItemId: string; title: string; year: number | null; durationMinutes: number }[],
    options?: AIRequestOptions
  ): Promise<void> {
    // Filter out already-cached movies
    const uncached = movies.filter(m => getIconicScenes(this.db, m.mediaItemId) === null);
    if (uncached.length === 0) return;

    try {
      const batchInput = uncached.map(m => ({
        key: m.mediaItemId,
        title: m.title,
        year: m.year,
        durationMinutes: m.durationMinutes,
      }));

      const results = await this.aiService.generateBatchIconicScenes(batchInput, options);

      // Cache each result in SQLite
      for (const movie of uncached) {
        const scenes = results[movie.mediaItemId] ?? [];
        upsertIconicScenes(this.db, movie.mediaItemId, scenes);
      }
    } catch (err) {
      console.error('[IconicScenes] Batch generation failed:', (err as Error).message);
      // Cache empty arrays for all uncached movies to avoid retrying
      for (const movie of uncached) {
        upsertIconicScenes(this.db, movie.mediaItemId, []);
      }
    }
  }
}
