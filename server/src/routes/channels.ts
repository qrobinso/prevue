import { Router } from 'express';
import type { Request, Response } from 'express';
import * as queries from '../db/queries.js';
import type { ChannelManager } from '../services/ChannelManager.js';
import type { ScheduleEngine } from '../services/ScheduleEngine.js';
import { AIService, DEFAULT_AI_MODEL } from '../services/AIService.js';
import type { JellyfinClient } from '../services/JellyfinClient.js';
import { broadcast } from '../websocket/index.js';
import { encrypt, decrypt } from '../utils/crypto.js';

export const channelRoutes = Router();
const aiService = new AIService();

/** Read user-configured OpenRouter API key from settings (decrypted). */
function getUserAIKey(db: import('better-sqlite3').Database): string | undefined {
  const encrypted = queries.getSetting(db, 'openrouter_api_key') as string | undefined;
  if (!encrypted) return undefined;
  try {
    return decrypt(encrypted);
  } catch {
    return undefined;
  }
}

/** Read user-configured OpenRouter model from settings. */
function getUserAIModel(db: import('better-sqlite3').Database): string | undefined {
  return (queries.getSetting(db, 'openrouter_model') as string) || undefined;
}

// GET /api/channels - List all channels with current program info
channelRoutes.get('/', (req: Request, res: Response) => {
  try {
    const { db, scheduleEngine } = req.app.locals;
    const channels = queries.getAllChannels(db);

    const result = channels.map(ch => {
      const current = (scheduleEngine as ScheduleEngine).getCurrentProgram(ch.id);
      return {
        ...ch,
        current_program: current?.program || null,
        next_program: current?.next || null,
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/channels - Create a custom channel
channelRoutes.post('/', (req: Request, res: Response) => {
  try {
    const { channelManager, wss } = req.app.locals;
    const { name, item_ids } = req.body;

    if (!name || !item_ids || !Array.isArray(item_ids)) {
      res.status(400).json({ error: 'name and item_ids are required' });
      return;
    }

    const channel = (channelManager as ChannelManager).createCustomChannel(name, item_ids);
    broadcast(wss, { type: 'channel:added', payload: channel });
    res.status(201).json(channel);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/channels/ai - Create channel via AI prompt
channelRoutes.post('/ai', async (req: Request, res: Response) => {
  try {
    const { channelManager, jellyfinClient, wss, db } = req.app.locals;

    const userKey = getUserAIKey(db);
    const userModel = getUserAIModel(db);

    if (!aiService.isAvailableWith(userKey)) {
      res.status(503).json({ error: 'AI service not configured. Add your OpenRouter API key in Settings > Channels > AI Create.' });
      return;
    }

    const { prompt } = req.body;

    if (!prompt) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    const libraryItems = (jellyfinClient as JellyfinClient).getLibraryItems();
    const aiResult = await aiService.createChannelFromPrompt(prompt, libraryItems, {
      apiKey: userKey,
      model: userModel,
    });

    const channel = (channelManager as ChannelManager).createCustomChannel(
      aiResult.name,
      aiResult.item_ids,
      prompt
    );

    broadcast(wss, { type: 'channel:added', payload: channel });
    res.status(201).json({ channel, ai_description: aiResult.description });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/channels/:id/ai-refresh - Re-run AI prompt to update channel items from latest library
channelRoutes.put('/:id/ai-refresh', async (req: Request, res: Response) => {
  try {
    const { db, jellyfinClient, scheduleEngine } = req.app.locals;
    const id = parseInt(req.params.id as string, 10);
    if (Number.isNaN(id) || id < 1) { res.status(400).json({ error: 'Invalid channel id' }); return; }

    const channel = queries.getChannelById(db, id);
    if (!channel) { res.status(404).json({ error: 'Channel not found' }); return; }
    if (!channel.ai_prompt) { res.status(400).json({ error: 'Channel has no AI prompt' }); return; }

    const userKey = getUserAIKey(db);
    const userModel = getUserAIModel(db);
    if (!aiService.isAvailableWith(userKey)) {
      res.status(503).json({ error: 'AI service not configured' });
      return;
    }

    const libraryItems = (jellyfinClient as JellyfinClient).getLibraryItems();
    const aiResult = await aiService.createChannelFromPrompt(channel.ai_prompt, libraryItems, {
      apiKey: userKey,
      model: userModel,
    });

    // Update channel items with fresh AI results
    const updated = queries.updateChannel(db, id, { item_ids: aiResult.item_ids });
    (scheduleEngine as ScheduleEngine).regenerateForChannel(id);

    res.json({ channel: updated, ai_description: aiResult.description });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/channels/:id - Update channel
channelRoutes.put('/:id', (req: Request, res: Response) => {
  try {
    const { db, scheduleEngine } = req.app.locals;
    const id = parseInt(req.params.id as string, 10);
    if (Number.isNaN(id) || id < 1) { res.status(400).json({ error: 'Invalid channel id' }); return; }
    const { name, item_ids, sort_order } = req.body;

    const channel = queries.updateChannel(db, id, { name, item_ids, sort_order });
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    // Regenerate schedule if items changed
    if (item_ids) {
      (scheduleEngine as ScheduleEngine).regenerateForChannel(id);
    }

    res.json(channel);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/channels/:id - Delete a channel (any type: auto, preset, or custom)
channelRoutes.delete('/:id', (req: Request, res: Response) => {
  try {
    const { db, wss } = req.app.locals;
    const id = parseInt(req.params.id as string, 10);
    if (Number.isNaN(id) || id < 1) { res.status(400).json({ error: 'Invalid channel id' }); return; }

    const channel = queries.getChannelById(db, id);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    queries.deleteChannel(db, id);
    broadcast(wss, { type: 'channel:removed', payload: { id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/channels/ai/suggestions - Generate sample prompts based on library
channelRoutes.get('/ai/suggestions', (req: Request, res: Response) => {
  try {
    const { jellyfinClient } = req.app.locals;
    const items = (jellyfinClient as JellyfinClient).getLibraryItems();

    if (items.length === 0) {
      res.json({ suggestions: [] });
      return;
    }

    // Gather library metadata
    const genreCounts = new Map<string, number>();
    const decadeCounts = new Map<number, number>();
    const seriesNames = new Set<string>();
    const directorCounts = new Map<string, number>();
    const actorCounts = new Map<string, number>();

    for (const item of items) {
      for (const g of (item.Genres || [])) genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
      if (item.ProductionYear) {
        const decade = Math.floor(item.ProductionYear / 10) * 10;
        decadeCounts.set(decade, (decadeCounts.get(decade) || 0) + 1);
      }
      if (item.Type === 'Episode' && item.SeriesName) seriesNames.add(item.SeriesName);
      if (item.People) {
        for (const p of item.People) {
          if (p.Type === 'Director' && p.Name) directorCounts.set(p.Name, (directorCounts.get(p.Name) || 0) + 1);
          if (p.Type === 'Actor' && p.Name) actorCounts.set(p.Name, (actorCounts.get(p.Name) || 0) + 1);
        }
      }
    }

    // Sort by count and pick top entries
    const topGenres = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(e => e[0]);
    const topDecades = [...decadeCounts.entries()].filter(e => e[1] >= 5).sort((a, b) => b[1] - a[1]).map(e => e[0]);
    const topSeries = [...seriesNames].slice(0, 30);
    const topDirectors = [...directorCounts.entries()].filter(e => e[1] >= 2).sort((a, b) => b[1] - a[1]).slice(0, 15).map(e => e[0]);
    const topActors = [...actorCounts.entries()].filter(e => e[1] >= 3).sort((a, b) => b[1] - a[1]).slice(0, 15).map(e => e[0]);

    // Build a pool of prompt templates, each referencing actual library data
    const pool: string[] = [];
    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

    // Genre-based
    if (topGenres.length >= 2) {
      pool.push(`${pick(topGenres)} movies and shows`);
      pool.push(`Best of ${pick(topGenres)} and ${pick(topGenres)}`);
      pool.push(`Late night ${pick(topGenres).toLowerCase()} marathon`);
    }
    if (topGenres.length >= 1) {
      pool.push(`Family-friendly ${pick(topGenres).toLowerCase()} channel`);
      pool.push(`The best ${pick(topGenres).toLowerCase()} in my library`);
    }

    // Decade-based
    if (topDecades.length >= 1) {
      const d = pick(topDecades);
      pool.push(`${d}s nostalgia channel`);
      pool.push(`Classic ${d}s movies and TV`);
    }

    // Genre + decade combos
    if (topGenres.length >= 1 && topDecades.length >= 1) {
      pool.push(`${pick(topDecades)}s ${pick(topGenres).toLowerCase()}`);
    }

    // Series-based
    if (topSeries.length >= 2) {
      pool.push(`TV marathon: ${pick(topSeries)} and similar shows`);
      pool.push(`Shows like ${pick(topSeries)}`);
    }

    // Director-based
    if (topDirectors.length >= 1) {
      pool.push(`Films directed by ${pick(topDirectors)}`);
    }

    // Actor-based
    if (topActors.length >= 1) {
      pool.push(`Everything starring ${pick(topActors)}`);
    }

    // Mood / vibe prompts using library genres
    const moods = ['Cozy rainy day', 'Date night', 'Weekend binge', 'Feel-good', 'Edge of your seat'];
    if (topGenres.length >= 1) {
      pool.push(`${pick(moods)} ${pick(topGenres).toLowerCase()}`);
    }
    pool.push(`${pick(moods)} vibes`);

    // Shuffle pool and pick 4 unique
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const suggestions = pool.slice(0, 4);

    res.json({ suggestions });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/channels/ai/status - Check AI availability
channelRoutes.get('/ai/status', (req: Request, res: Response) => {
  const { db } = req.app.locals;
  const userKey = getUserAIKey(db);
  res.json({ available: aiService.isAvailableWith(userKey) });
});

// GET /api/channels/ai/config - Get AI configuration (never exposes raw key)
channelRoutes.get('/ai/config', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const userKey = getUserAIKey(db);
    const userModel = getUserAIModel(db);
    res.json({
      hasKey: !!(userKey || aiService.isAvailable()),
      hasUserKey: !!userKey,
      hasEnvKey: aiService.isAvailable(),
      model: userModel || DEFAULT_AI_MODEL,
      defaultModel: DEFAULT_AI_MODEL,
      available: aiService.isAvailableWith(userKey),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/channels/ai/config - Update AI configuration
channelRoutes.put('/ai/config', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const { apiKey, model } = req.body;

    if (apiKey !== undefined) {
      if (apiKey === '' || apiKey === null) {
        // Clear the key
        queries.setSetting(db, 'openrouter_api_key', '');
      } else {
        // Encrypt and store
        queries.setSetting(db, 'openrouter_api_key', encrypt(apiKey));
      }
    }

    if (model !== undefined) {
      queries.setSetting(db, 'openrouter_model', model || '');
    }

    // Return updated config
    const userKey = getUserAIKey(db);
    const userModel = getUserAIModel(db);
    res.json({
      hasKey: !!(userKey || aiService.isAvailable()),
      hasUserKey: !!userKey,
      hasEnvKey: aiService.isAvailable(),
      model: userModel || DEFAULT_AI_MODEL,
      defaultModel: DEFAULT_AI_MODEL,
      available: aiService.isAvailableWith(userKey),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/channels/regenerate - Regenerate channels (presets or auto/genre-based)
channelRoutes.post('/regenerate', async (req: Request, res: Response) => {
  try {
    const { channelManager, scheduleEngine, wss, db } = req.app.locals;

    // Check if we have saved preset selections
    const selectedPresets = queries.getSetting(db, 'selected_presets') as string[] | undefined;

    let channels;
    if (selectedPresets && selectedPresets.length > 0) {
      // Use preset-based generation
      channels = await (channelManager as ChannelManager).generateChannelsFromPresets(selectedPresets);
    } else {
      // Fall back to genre-based auto generation
      channels = await (channelManager as ChannelManager).autoGenerateChannels();
    }

    await (scheduleEngine as ScheduleEngine).generateAllSchedules();
    broadcast(wss, { type: 'channels:regenerated', payload: { count: channels.length } });
    res.json({ channels_created: channels.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/channels/genres - Get available genres
channelRoutes.get('/genres', (req: Request, res: Response) => {
  try {
    const { channelManager } = req.app.locals;
    const genres = (channelManager as ChannelManager).getAvailableGenres();
    res.json(genres);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/channels/ratings - Get available content ratings from library
channelRoutes.get('/ratings', (req: Request, res: Response) => {
  try {
    const { channelManager } = req.app.locals;
    const ratings = (channelManager as ChannelManager).getAvailableRatings();
    res.json(ratings);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/channels/search - Search library items
channelRoutes.get('/search', (req: Request, res: Response) => {
  try {
    const { channelManager } = req.app.locals;
    const query = req.query.q as string;
    if (!query) {
      res.json([]);
      return;
    }
    const items = (channelManager as ChannelManager).searchLibrary(query);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/channels/presets - Get all available channel presets
channelRoutes.get('/presets', (req: Request, res: Response) => {
  try {
    const { channelManager } = req.app.locals;
    const presets = (channelManager as ChannelManager).getChannelPresets();
    res.json(presets);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/channels/presets/:id/preview - Preview preset content
channelRoutes.get('/presets/:id/preview', async (req: Request, res: Response) => {
  try {
    const { channelManager } = req.app.locals;
    const presetId = req.params.id as string;
    const preview = await (channelManager as ChannelManager).previewPreset(presetId);
    res.json(preview);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/channels/presets/:id - Create a channel from a preset
channelRoutes.post('/presets/:id', (req: Request, res: Response) => {
  try {
    const { channelManager, wss } = req.app.locals;
    const presetId = req.params.id as string;
    const channel = (channelManager as ChannelManager).createPresetChannel(presetId);
    broadcast(wss, { type: 'channel:added', payload: channel });
    res.status(201).json(channel);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/channels/selected-presets - Get currently selected presets
channelRoutes.get('/selected-presets', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const selectedPresets = queries.getSetting(db, 'selected_presets') ?? [];
    res.json(selectedPresets);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/channels/generate - Generate channels from selected presets
channelRoutes.post('/generate', async (req: Request, res: Response) => {
  try {
    const { channelManager, scheduleEngine, wss, db, jellyfinClient } = req.app.locals;
    const { preset_ids, force_sync = false } = req.body;

    if (!preset_ids || !Array.isArray(preset_ids)) {
      res.status(400).json({ error: 'preset_ids array is required' });
      return;
    }

    // Save selected presets so they persist across page reloads
    queries.setSetting(db, 'selected_presets', preset_ids);

    // If empty array, just delete all preset channels
    if (preset_ids.length === 0) {
      broadcast(wss, { type: 'generation:progress', payload: { step: 'deleting', message: 'Removing existing channels...' } });
      queries.deletePresetChannels(db);
      await (scheduleEngine as ScheduleEngine).generateAllSchedules();
      broadcast(wss, { type: 'channels:regenerated', payload: { count: 0 } });
      res.json({ channels_created: 0, channels: [] });
      return;
    }

    // Step 1: Check if library needs sync (only sync if empty or force_sync requested)
    const jf = jellyfinClient as JellyfinClient;
    const existingItems = jf.getLibraryItems();

    if (existingItems.length === 0 || force_sync) {
      // No library data or force sync requested
      const reason = force_sync ? 'Force sync requested' : 'No library data';
      broadcast(wss, { type: 'generation:progress', payload: { step: 'syncing', message: 'Syncing library from Jellyfin...' } });
      console.log(`[Channels] ${reason} - syncing from Jellyfin...`);
      await jf.syncLibrary((message) => {
        broadcast(wss, { type: 'generation:progress', payload: { step: 'syncing', message } });
      });
    } else {
      // Library already loaded - skip sync for faster regeneration
      console.log(`[Channels] Using cached library (${existingItems.length} items)`);
      broadcast(wss, { type: 'generation:progress', payload: { step: 'syncing', message: `Using cached library (${existingItems.length} items)` } });
    }

    // Step 2: Generate channels (with progress callback)
    broadcast(wss, { type: 'generation:progress', payload: { step: 'generating', message: 'Generating channels...' } });
    const channels = await (channelManager as ChannelManager).generateChannelsFromPresets(preset_ids, (progress) => {
      broadcast(wss, { type: 'generation:progress', payload: progress });
    });

    // Step 3: Generate schedules
    broadcast(wss, { type: 'generation:progress', payload: { step: 'scheduling', message: 'Building schedules...' } });
    await (scheduleEngine as ScheduleEngine).generateAllSchedules();

    // Done
    broadcast(wss, { type: 'generation:progress', payload: { step: 'complete', message: `Created ${channels.length} channels` } });
    broadcast(wss, { type: 'channels:regenerated', payload: { count: channels.length } });
    res.json({ channels_created: channels.length, channels });
  } catch (err) {
    const { wss: wssError } = req.app.locals;
    broadcast(wssError, { type: 'generation:progress', payload: { step: 'error', message: (err as Error).message } });
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/channels/settings - Get channel generation settings
channelRoutes.get('/settings', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const maxChannels = queries.getSetting(db, 'max_channels') ?? 200;
    const selectedPresets = queries.getSetting(db, 'selected_presets') ?? [];
    res.json({ max_channels: maxChannels, selected_presets: selectedPresets });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/channels/settings - Update channel generation settings
channelRoutes.put('/settings', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const { max_channels, selected_presets } = req.body;

    if (max_channels !== undefined) {
      queries.setSetting(db, 'max_channels', max_channels);
    }
    if (selected_presets !== undefined) {
      queries.setSetting(db, 'selected_presets', selected_presets);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
