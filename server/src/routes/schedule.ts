import { Router } from 'express';
import type { Request, Response } from 'express';
import * as queries from '../db/queries.js';
import type { MediaProvider } from '../services/MediaProvider.js';
import type { ScheduleEngine } from '../services/ScheduleEngine.js';
import type { IconicSceneService } from '../services/IconicSceneService.js';
import { AIService } from '../services/AIService.js';
import type { ScheduleBlockParsed } from '../types/index.js';
import { broadcast } from '../websocket/index.js';
import { decrypt } from '../utils/crypto.js';

const aiService = new AIService();

// In-flight dedup for catch-up LLM calls (prevents duplicate requests for the same movie/bucket)
const catchUpInFlight = new Map<string, Promise<string>>();

/** Enrich schedule blocks with iconic scene data from the cache. */
function enrichBlocksWithIconicScenes(blocks: ScheduleBlockParsed[], iconicSceneService: IconicSceneService): void {
  // Collect all unique movie media_item_ids
  const movieIds: string[] = [];
  for (const block of blocks) {
    for (const prog of block.programs) {
      if (prog.content_type === 'movie') {
        movieIds.push(prog.media_item_id);
      }
    }
  }
  if (movieIds.length === 0) return;

  const scenesMap = iconicSceneService.getScenesForItems([...new Set(movieIds)]);

  // Attach to programs
  for (const block of blocks) {
    for (const prog of block.programs) {
      if (prog.content_type === 'movie') {
        const scenes = scenesMap.get(prog.media_item_id);
        if (scenes && scenes.length > 0) {
          prog.iconic_scenes = scenes;
        }
      }
    }
  }
}

export const scheduleRoutes = Router();

// ── Item details cache (TTL 5 minutes) ──────────────
const ITEM_CACHE_TTL_MS = 5 * 60 * 1000;
const itemDetailsCache = new Map<string, { data: unknown; expiresAt: number }>();

function getCachedItem(itemId: string): unknown | null {
  const entry = itemDetailsCache.get(itemId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    itemDetailsCache.delete(itemId);
    return null;
  }
  return entry.data;
}

function setCachedItem(itemId: string, data: unknown): void {
  itemDetailsCache.set(itemId, { data, expiresAt: Date.now() + ITEM_CACHE_TTL_MS });
  // Evict stale entries periodically (keep cache bounded)
  if (itemDetailsCache.size > 500) {
    const now = Date.now();
    for (const [key, entry] of itemDetailsCache) {
      if (now > entry.expiresAt) itemDetailsCache.delete(key);
    }
  }
}

// GET /api/schedule/item/:itemId - Get program/item details (overview, genres) for guide modal
scheduleRoutes.get('/item/:itemId', async (req: Request, res: Response) => {
  try {
    const { mediaProvider } = req.app.locals;
    const itemId = req.params.itemId as string;
    if (!itemId) {
      res.status(400).json({ error: 'itemId required' });
      return;
    }

    // Serve from cache if available
    const cached = getCachedItem(itemId);
    if (cached) {
      res.json(cached);
      return;
    }

    const details = await (mediaProvider as MediaProvider).getItemDetails(itemId);
    setCachedItem(itemId, details);
    res.json(details);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/schedule - Get full schedule for all channels
scheduleRoutes.get('/', (req: Request, res: Response) => {
  try {
    const { db, iconicSceneService } = req.app.locals;
    const now = new Date().toISOString();
    const channels = queries.getAllChannels(db);

    const schedule: Record<number, unknown> = {};
    for (const ch of channels) {
      const blocks = queries.getCurrentAndNextBlocks(db, ch.id, now);
      if (iconicSceneService) enrichBlocksWithIconicScenes(blocks, iconicSceneService as IconicSceneService);
      schedule[ch.id] = {
        channel: ch,
        blocks,
      };
    }

    res.json(schedule);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/schedule/:channelId - Get schedule for a specific channel
scheduleRoutes.get('/:channelId', (req: Request, res: Response) => {
  try {
    const { db, iconicSceneService } = req.app.locals;
    const channelId = parseInt(req.params.channelId as string, 10);
    if (Number.isNaN(channelId) || channelId < 1) { res.status(400).json({ error: 'Invalid channel id' }); return; }
    const now = new Date().toISOString();

    const blocks = queries.getCurrentAndNextBlocks(db, channelId, now);
    if (iconicSceneService) enrichBlocksWithIconicScenes(blocks, iconicSceneService as IconicSceneService);
    res.json(blocks);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/schedule/:channelId/now - Get currently airing program
scheduleRoutes.get('/:channelId/now', (req: Request, res: Response) => {
  try {
    const { scheduleEngine } = req.app.locals;
    const channelId = parseInt(req.params.channelId as string, 10);
    if (Number.isNaN(channelId) || channelId < 1) { res.status(400).json({ error: 'Invalid channel id' }); return; }

    const current = (scheduleEngine as ScheduleEngine).getCurrentProgram(channelId);
    if (!current) {
      res.status(404).json({ error: 'No program currently airing' });
      return;
    }

    res.json(current);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/schedule/iconic-scenes/status - Get last refreshed timestamp
scheduleRoutes.get('/iconic-scenes/status', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const lastRefreshed = queries.getIconicScenesLastRefreshed(db);
    res.json({ lastRefreshed });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/schedule/iconic-scenes/refresh - Clear cache and regenerate iconic scenes
scheduleRoutes.post('/iconic-scenes/refresh', async (req: Request, res: Response) => {
  try {
    const { db, iconicSceneService } = req.app.locals;
    if (!iconicSceneService) {
      res.status(400).json({ error: 'Iconic scene service not available. Configure an AI API key first.' });
      return;
    }

    // Clear existing cache
    queries.clearAllIconicScenes(db);

    // Gather all movies from current schedule
    const channels = queries.getAllChannels(db);
    const now = new Date().toISOString();
    const movies: { mediaItemId: string; title: string; year: number | null; durationMinutes: number }[] = [];
    const seen = new Set<string>();

    for (const channel of channels) {
      const blocks = queries.getCurrentAndNextBlocks(db, channel.id, now);
      for (const block of blocks) {
        for (const prog of block.programs) {
          if (prog.content_type === 'movie' && !seen.has(prog.media_item_id)) {
            seen.add(prog.media_item_id);
            movies.push({
              mediaItemId: prog.media_item_id,
              title: prog.title,
              year: prog.year,
              durationMinutes: Math.round(prog.duration_ms / 60000),
            });
          }
        }
      }
    }

    if (movies.length === 0) {
      res.json({ success: true, count: 0 });
      return;
    }

    // Resolve AI options from encrypted settings
    const encrypted = queries.getSetting(db, 'openrouter_api_key') as string | undefined;
    let apiKey: string | undefined;
    if (encrypted) {
      try { apiKey = decrypt(encrypted); } catch { /* ignore */ }
    }
    const model = (queries.getSetting(db, 'openrouter_model') as string) || undefined;

    await (iconicSceneService as IconicSceneService).generateForMovies(movies, { apiKey, model });
    const lastRefreshed = queries.getIconicScenesLastRefreshed(db);
    res.json({ success: true, count: movies.length, lastRefreshed });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/schedule/catch-up - Generate a catch-up summary for a movie in progress
scheduleRoutes.post('/catch-up', async (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const { mediaItemId, title, year, elapsedMinutes, durationMinutes } = req.body;

    if (!mediaItemId || !title || typeof elapsedMinutes !== 'number' || typeof durationMinutes !== 'number') {
      res.status(400).json({ error: 'Missing required fields: mediaItemId, title, elapsedMinutes, durationMinutes' });
      return;
    }

    // Resolve AI credentials
    const encrypted = queries.getSetting(db, 'openrouter_api_key') as string | undefined;
    let apiKey: string | undefined;
    if (encrypted) {
      try { apiKey = decrypt(encrypted); } catch { /* ignore */ }
    }
    const model = (queries.getSetting(db, 'openrouter_model') as string) || undefined;

    if (!aiService.isAvailableWith(apiKey)) {
      res.status(503).json({ error: 'AI service not configured' });
      return;
    }

    // Check cache using 10-minute time buckets
    const timeBucket = Math.floor(elapsedMinutes / 10) * 10;
    const cached = queries.getCatchUpSummary(db, mediaItemId, timeBucket);
    if (cached) {
      res.json({ summary: cached });
      return;
    }

    // Generate via LLM (with in-flight dedup)
    const flightKey = `${mediaItemId}:${timeBucket}`;
    let promise = catchUpInFlight.get(flightKey);
    if (!promise) {
      promise = aiService.generateCatchUpSummary(title, year ?? null, elapsedMinutes, durationMinutes, { apiKey, model })
        .then(summary => {
          queries.setCatchUpSummary(db, mediaItemId, timeBucket, summary);
          return summary;
        })
        .finally(() => catchUpInFlight.delete(flightKey));
      catchUpInFlight.set(flightKey, promise);
    }
    const summary = await promise;
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/schedule/regenerate - Force regeneration
scheduleRoutes.post('/regenerate', async (req: Request, res: Response) => {
  try {
    const { scheduleEngine, wss, triggerIconicSceneGeneration: triggerIconic } = req.app.locals;
    await (scheduleEngine as ScheduleEngine).generateAllSchedules();
    broadcast(wss, { type: 'channels:regenerated', payload: {} });
    // Regenerate iconic scenes for any new movies in the updated schedule
    if (typeof triggerIconic === 'function') triggerIconic();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
