import { Router } from 'express';
import type { Request, Response } from 'express';
import * as queries from '../db/queries.js';
import type { ScheduleEngine } from '../services/ScheduleEngine.js';
import type { MediaProvider } from '../services/MediaProvider.js';
import type { MediaItem, ScheduleProgram } from '../types/index.js';
import { AIService } from '../services/AIService.js';
import { decrypt } from '../utils/crypto.js';

export const tickerRoutes = Router();
const aiService = new AIService();

function getUserAIKey(db: import('better-sqlite3').Database): string | undefined {
  const encrypted = queries.getSetting(db, 'openrouter_api_key') as string | undefined;
  if (!encrypted) return undefined;
  try { return decrypt(encrypted); } catch { return undefined; }
}

function getUserAIModel(db: import('better-sqlite3').Database): string | undefined {
  return (queries.getSetting(db, 'openrouter_model') as string) || undefined;
}

interface TickerItem {
  id: string;
  text: string;
  category: 'now' | 'upcoming' | 'primetime' | 'new';
  channel_number?: number;
}

interface BadgeOptions {
  year: boolean;
  rating: boolean;
  resolution: boolean;
  hdr: boolean;
}

interface TickerCache {
  items: TickerItem[];
  generated_at: string;
  cacheKey: string;
}

let cache: TickerCache | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Format a program title with optional metadata badges. */
function formatProgramLabel(title: string, prog: { year?: number | null; rating?: string | null; resolution?: string | null; is_hdr?: boolean | null }, badges: BadgeOptions): string {
  const meta: string[] = [];
  if (badges.year && prog.year) meta.push(String(prog.year));
  if (badges.rating && prog.rating) meta.push(prog.rating);
  if (badges.resolution && prog.resolution) meta.push(prog.resolution);
  if (badges.hdr && prog.is_hdr) meta.push('HDR');
  if (meta.length > 0) return `${title} (${meta.join(', ')})`;
  return title;
}

// GET /api/ticker?tzOffset=-300&year=1&rating=1&resolution=1&hdr=1
tickerRoutes.get('/', (req: Request, res: Response) => {
  try {
    const { db, scheduleEngine, mediaProvider } = req.app.locals;
    const tzOffset = parseInt(req.query.tzOffset as string) || 0;
    const badges: BadgeOptions = {
      year: req.query.year === '1',
      rating: req.query.rating === '1',
      resolution: req.query.resolution === '1',
      hdr: req.query.hdr === '1',
    };

    const cacheKey = `${tzOffset}:${badges.year}:${badges.rating}:${badges.resolution}:${badges.hdr}`;
    const now = Date.now();
    if (cache && (now - cacheTime) < CACHE_TTL_MS && cache.cacheKey === cacheKey) {
      return res.json({ items: cache.items, generated_at: cache.generated_at });
    }

    const items: TickerItem[] = [];
    const seen = new Set<string>(); // shared across sections to avoid duplicates

    // 1. Currently airing across all channels
    const nowItems = getCurrentlyAiring(db, tzOffset, badges, seen);
    items.push(...nowItems);

    // 2. Coming up next (within 2 hours)
    const upcomingItems = getUpcoming(db, tzOffset, badges, seen);
    items.push(...upcomingItems);

    // 3. Primetime highlights — programs airing between 7PM and 11PM tonight
    const primetimeItems = getPrimetimeHighlights(db, scheduleEngine as ScheduleEngine, tzOffset, badges, seen);
    items.push(...primetimeItems);

    // 4. Recently added to library
    const recentItems = getRecentlyAdded(mediaProvider as MediaProvider, badges);
    items.push(...recentItems);

    // Fallback if nothing is scheduled
    if (items.length === 0) {
      items.push({
        id: 'fallback',
        text: 'Welcome to Prevue Guide — your personal TV experience',
        category: 'now',
      });
    }

    const generated_at = new Date().toISOString();
    cache = { items, generated_at, cacheKey };
    cacheTime = now;

    res.json({ items, generated_at });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Program Facts (AI-powered, SQLite-cached) ──────────────────────

// POST /api/ticker/facts/batch — single LLM call for all currently airing programs
tickerRoutes.post('/facts/batch', async (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const { programs } = req.body as {
      programs: { media_item_id: string; title: string; year?: number | null; content_type?: string | null; series_name?: string | null }[];
    };

    if (!Array.isArray(programs) || programs.length === 0) {
      return res.status(400).json({ error: 'programs array required' });
    }

    // Build deduplicated list: movies by media_item_id, series by series_name
    const allKeys = new Set<string>();
    const batchItems: { key: string; label: string }[] = [];

    for (const prog of programs) {
      let key: string;
      let label: string;

      if (prog.content_type === 'episode' && prog.series_name) {
        key = `series:${prog.series_name}`;
        label = `"${prog.series_name}" (TV Series)`;
      } else {
        key = prog.media_item_id;
        const yearStr = prog.year ? ` (${prog.year})` : '';
        label = `"${prog.title}"${yearStr} (Movie)`;
      }

      if (allKeys.has(key)) continue;
      allKeys.add(key);
      batchItems.push({ key, label });
    }

    // Check SQLite cache for all keys
    const cachedMap = queries.getProgramFactsForKeys(db, [...allKeys]);
    const result: Record<string, string[]> = {};
    const uncached: { key: string; label: string }[] = [];

    for (const item of batchItems) {
      const cached = cachedMap.get(item.key);
      if (cached) {
        result[item.key] = cached;
      } else {
        uncached.push(item);
      }
    }

    // If there are uncached items, call the LLM once
    if (uncached.length > 0) {
      const userKey = getUserAIKey(db);
      const userModel = getUserAIModel(db);
      if (!aiService.isAvailableWith(userKey)) {
        return res.json({ facts: result }); // Return cached results only
      }

      const batchResult = await aiService.getBatchProgramFacts(uncached, {
        apiKey: userKey,
        model: userModel,
      });

      // Persist each result to SQLite
      for (const [key, facts] of Object.entries(batchResult)) {
        queries.upsertProgramFacts(db, key, facts);
        result[key] = facts;
      }

      // Also cache empty arrays for items the LLM didn't return (avoid retrying)
      for (const item of uncached) {
        if (!(item.key in result)) {
          queries.upsertProgramFacts(db, item.key, []);
          result[item.key] = [];
        }
      }
    }

    res.json({ facts: result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

function getPrimetimeHighlights(
  db: import('better-sqlite3').Database,
  scheduleEngine: ScheduleEngine,
  tzOffset: number,
  badges: BadgeOptions,
  seen: Set<string>
): TickerItem[] {
  const items: TickerItem[] = [];
  try {
    // Calculate tonight's primetime window in UTC
    // tzOffset is minutes from UTC (e.g., EST = 300, PST = 480)
    const now = new Date();
    const clientNow = new Date(now.getTime() - tzOffset * 60 * 1000);
    const clientToday = new Date(clientNow);
    clientToday.setUTCHours(19, 0, 0, 0); // 7 PM client time
    const clientTonightEnd = new Date(clientNow);
    clientTonightEnd.setUTCHours(23, 0, 0, 0); // 11 PM client time

    // If it's past 11 PM, show tomorrow's primetime
    if (clientNow.getUTCHours() >= 23) {
      clientToday.setUTCDate(clientToday.getUTCDate() + 1);
      clientTonightEnd.setUTCDate(clientTonightEnd.getUTCDate() + 1);
    }

    // Convert back to UTC for DB query
    const primetimeStartUTC = new Date(clientToday.getTime() + tzOffset * 60 * 1000).toISOString();
    const primetimeEndUTC = new Date(clientTonightEnd.getTime() + tzOffset * 60 * 1000).toISOString();

    const blocks = queries.getAllScheduleBlocksInRange(db, primetimeStartUTC, primetimeEndUTC);
    const channels = queries.getAllChannels(db);
    const channelMap = new Map(channels.map(ch => [ch.id, ch]));
    const candidates: { program: ScheduleProgram; channelName: string; channelNumber: number; hour: number }[] = [];

    for (const block of blocks) {
      const channel = channelMap.get(block.channel_id);
      if (!channel) continue;

      for (const prog of block.programs) {
        if (prog.type === 'interstitial') continue;
        if (seen.has(prog.media_item_id)) continue;

        const startTime = new Date(prog.start_time);
        const startUTC = startTime.getTime();
        const primeStart = new Date(primetimeStartUTC).getTime();
        const primeEnd = new Date(primetimeEndUTC).getTime();

        if (startUTC >= primeStart && startUTC < primeEnd) {
          seen.add(prog.media_item_id);
          // Convert start time to client local hour
          const clientStart = new Date(startUTC - tzOffset * 60 * 1000);
          const hour = clientStart.getUTCHours();
          candidates.push({ program: prog, channelName: channel.name, channelNumber: channel.number, hour });
        }
      }
    }

    // Pick one random primetime candidate
    if (candidates.length > 0) {
      const c = candidates[Math.floor(Math.random() * candidates.length)];
      const hourLabel = c.hour > 12 ? `${c.hour - 12}` : `${c.hour}`;
      const ampm = c.hour >= 12 ? 'PM' : 'AM';
      const label = formatProgramLabel(c.program.title, c.program, badges);
      items.push({
        id: `prime-${c.program.media_item_id}`,
        text: `TONIGHT AT ${hourLabel} ${ampm}: ${label} on ${c.channelName}`,
        category: 'primetime',
        channel_number: c.channelNumber,
      });
    }
  } catch {
    // Schedule may not be generated yet — skip primetime
  }
  return items;
}

function getRecentlyAdded(mediaProvider: MediaProvider, badges: BadgeOptions): TickerItem[] {
  const items: TickerItem[] = [];
  try {
    const allItems = mediaProvider.getLibraryItems();
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const recent = allItems.filter((item: MediaItem) => {
      if (!item.DateCreated) return false;
      return new Date(item.DateCreated).getTime() > sevenDaysAgo;
    });

    if (recent.length > 0) {
      const item = recent[Math.floor(Math.random() * recent.length)];
      const title = item.Type === 'Episode' && item.SeriesName
        ? `${item.SeriesName}: ${item.Name}`
        : item.Name;
      const label = formatProgramLabel(title, {
        year: item.ProductionYear ?? null,
        rating: item.OfficialRating ?? null,
        resolution: null,
        is_hdr: null,
      }, badges);
      items.push({
        id: `new-${item.Id}`,
        text: `NEW: ${label} added to your library`,
        category: 'new',
      });
    }
  } catch {
    // Library may not be synced yet
  }
  return items;
}

function getCurrentlyAiring(
  db: import('better-sqlite3').Database,
  tzOffset: number,
  badges: BadgeOptions,
  seen: Set<string>
): TickerItem[] {
  const items: TickerItem[] = [];
  try {
    const now = new Date();
    // Query a window around now to find blocks containing current programs
    const windowStart = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
    const windowEnd = new Date(now.getTime() + 1 * 60 * 60 * 1000).toISOString();

    const blocks = queries.getAllScheduleBlocksInRange(db, windowStart, windowEnd);
    const channels = queries.getAllChannels(db);
    const channelMap = new Map(channels.map(ch => [ch.id, ch]));
    const candidates: { program: ScheduleProgram; channelName: string; channelNumber: number }[] = [];

    for (const block of blocks) {
      const channel = channelMap.get(block.channel_id);
      if (!channel) continue;

      for (const prog of block.programs) {
        if (prog.type === 'interstitial') continue;
        if (seen.has(prog.media_item_id)) continue;

        const startMs = new Date(prog.start_time).getTime();
        const endMs = new Date(prog.end_time).getTime();
        const nowMs = now.getTime();

        if (nowMs >= startMs && nowMs < endMs) {
          seen.add(prog.media_item_id);
          candidates.push({ program: prog, channelName: channel.name, channelNumber: channel.number });
        }
      }
    }

    // Pick up to 3 random currently airing programs
    shuffle(candidates);
    for (let i = 0; i < Math.min(3, candidates.length); i++) {
      const c = candidates[i];
      const label = formatProgramLabel(c.program.title, c.program, badges);
      items.push({
        id: `now-${c.program.media_item_id}`,
        text: `NOW PLAYING: ${label} on ${c.channelName}`,
        category: 'now',
        channel_number: c.channelNumber,
      });
    }
  } catch {
    // Schedule may not be generated yet
  }
  return items;
}

function getUpcoming(
  db: import('better-sqlite3').Database,
  tzOffset: number,
  badges: BadgeOptions,
  seen: Set<string>
): TickerItem[] {
  const items: TickerItem[] = [];
  try {
    const now = new Date();
    const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    const blocks = queries.getAllScheduleBlocksInRange(db, now.toISOString(), twoHoursLater.toISOString());
    const channels = queries.getAllChannels(db);
    const channelMap = new Map(channels.map(ch => [ch.id, ch]));

    const candidates: { program: ScheduleProgram; channelName: string; channelNumber: number; minutesUntil: number }[] = [];

    for (const block of blocks) {
      const channel = channelMap.get(block.channel_id);
      if (!channel) continue;

      for (const prog of block.programs) {
        if (prog.type === 'interstitial') continue;
        if (seen.has(prog.media_item_id)) continue;

        const startMs = new Date(prog.start_time).getTime();
        const nowMs = now.getTime();

        // Only future starts (not currently airing)
        if (startMs > nowMs && startMs <= twoHoursLater.getTime()) {
          seen.add(prog.media_item_id);
          const minutesUntil = Math.round((startMs - nowMs) / 60000);
          candidates.push({ program: prog, channelName: channel.name, channelNumber: channel.number, minutesUntil });
        }
      }
    }

    // Pick up to 3 random upcoming programs
    shuffle(candidates);
    for (let i = 0; i < Math.min(3, candidates.length); i++) {
      const c = candidates[i];
      const label = formatProgramLabel(c.program.title, c.program, badges);
      const timeLabel = c.minutesUntil < 60
        ? `IN ${c.minutesUntil} MIN`
        : `IN ${Math.round(c.minutesUntil / 60)}h`;
      items.push({
        id: `up-${c.program.media_item_id}`,
        text: `COMING UP ${timeLabel}: ${label} on ${c.channelName}`,
        category: 'upcoming',
        channel_number: c.channelNumber,
      });
    }
  } catch {
    // Schedule may not be generated yet
  }
  return items;
}

/** Fisher-Yates shuffle in-place. */
function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
