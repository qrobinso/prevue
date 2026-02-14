import { Router } from 'express';
import type { Request, Response } from 'express';
import * as queries from '../db/queries.js';

export const settingsRoutes = Router();

/** Known setting keys the app uses. Reject anything not in this set. */
const ALLOWED_SETTINGS_KEYS = new Set([
  'selected_presets',
  'max_channels',
  'preferred_audio_language',
  'preferred_subtitle_index',
  'share_playback_progress',
  'metrics_enabled',
  'preview_bg',
  'separate_content_types',
  'schedule_auto_update_enabled',
  'schedule_auto_update_hours',
  'channel_count',
  'visible_channels',
]);

// GET /api/settings - Get all settings
settingsRoutes.get('/', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const settings = queries.getAllSettings(db);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/settings - Update settings
settingsRoutes.put('/', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const updates = req.body;

    if (typeof updates !== 'object' || updates === null) {
      res.status(400).json({ error: 'Request body must be an object' });
      return;
    }

    // Reject unknown keys
    const unknownKeys = Object.keys(updates).filter(k => !ALLOWED_SETTINGS_KEYS.has(k));
    if (unknownKeys.length > 0) {
      res.status(400).json({ error: `Unknown setting key(s): ${unknownKeys.join(', ')}` });
      return;
    }

    for (const [key, value] of Object.entries(updates)) {
      queries.setSetting(db, key, value);
    }

    const settings = queries.getAllSettings(db);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/settings/:key - Get a specific setting
settingsRoutes.get('/:key', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const key = req.params.key as string;
    if (!ALLOWED_SETTINGS_KEYS.has(key)) {
      res.status(400).json({ error: `Unknown setting key: ${key}` });
      return;
    }
    const value = queries.getSetting(db, key);
    if (value === undefined) {
      res.status(404).json({ error: 'Setting not found' });
      return;
    }
    res.json({ key, value });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/settings/factory-reset - Reset all data to factory defaults
settingsRoutes.post('/factory-reset', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    queries.factoryReset(db);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
