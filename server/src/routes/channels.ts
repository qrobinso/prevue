import { Router } from 'express';
import type { Request, Response } from 'express';
import * as queries from '../db/queries.js';
import type { ChannelManager } from '../services/ChannelManager.js';
import type { ScheduleEngine } from '../services/ScheduleEngine.js';
import { AIService } from '../services/AIService.js';
import type { JellyfinClient } from '../services/JellyfinClient.js';
import { broadcast } from '../websocket/index.js';

export const channelRoutes = Router();
const aiService = new AIService();

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
    if (!aiService.isAvailable()) {
      res.status(503).json({ error: 'AI service not configured. Set OPENROUTER_API_KEY.' });
      return;
    }

    const { channelManager, jellyfinClient, wss } = req.app.locals;
    const { prompt } = req.body;

    if (!prompt) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    const libraryItems = (jellyfinClient as JellyfinClient).getLibraryItems();
    const aiResult = await aiService.createChannelFromPrompt(prompt, libraryItems);

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

// PUT /api/channels/:id - Update channel
channelRoutes.put('/:id', (req: Request, res: Response) => {
  try {
    const { db, scheduleEngine } = req.app.locals;
    const id = parseInt(req.params.id as string, 10);
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

// GET /api/channels/ai/status - Check AI availability
channelRoutes.get('/ai/status', (_req: Request, res: Response) => {
  res.json({ available: aiService.isAvailable() });
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
    const maxChannels = queries.getSetting(db, 'max_channels') ?? 100;
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
