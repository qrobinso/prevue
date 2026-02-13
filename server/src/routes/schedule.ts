import { Router } from 'express';
import type { Request, Response } from 'express';
import * as queries from '../db/queries.js';
import type { JellyfinClient } from '../services/JellyfinClient.js';
import type { ScheduleEngine } from '../services/ScheduleEngine.js';

export const scheduleRoutes = Router();

// GET /api/schedule/item/:itemId - Get program/item details (overview, genres) for guide modal
scheduleRoutes.get('/item/:itemId', async (req: Request, res: Response) => {
  try {
    const { jellyfinClient } = req.app.locals;
    const itemId = req.params.itemId as string;
    if (!itemId) {
      res.status(400).json({ error: 'itemId required' });
      return;
    }
    const details = await (jellyfinClient as JellyfinClient).getItemDetails(itemId);
    res.json(details);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/schedule - Get full schedule for all channels
scheduleRoutes.get('/', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const now = new Date().toISOString();
    const channels = queries.getAllChannels(db);

    const schedule: Record<number, unknown> = {};
    for (const ch of channels) {
      const blocks = queries.getCurrentAndNextBlocks(db, ch.id, now);
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
    const { db } = req.app.locals;
    const channelId = parseInt(req.params.channelId as string, 10);
    const now = new Date().toISOString();

    const blocks = queries.getCurrentAndNextBlocks(db, channelId, now);
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

// POST /api/schedule/regenerate - Force regeneration
scheduleRoutes.post('/regenerate', async (req: Request, res: Response) => {
  try {
    const { scheduleEngine } = req.app.locals;
    await (scheduleEngine as ScheduleEngine).generateAllSchedules();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
